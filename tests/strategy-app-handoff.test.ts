/**
 * app-handoff as a sign-in strategy: the broker mints the same one-time code
 * `testlane handoff` would, consumes the URL itself against the reference
 * handoff route (tests/helpers/fake-nextauth.ts), captures the cookies and
 * confirms the identity through mePath. Broker-level behaviour (policy,
 * audit, dependencies, surfaces) is in tests/commands-app-handoff.test.ts.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { verifyHandoffCode, MemoryNonceStore } from "../src/handoff.js";
import { appHandoffStrategy, getStrategy, isSignInStrategy, type SignInContext } from "../src/strategies/index.js";
import { validateStrategyOptions } from "../src/strategies/options.js";
import { PolicyError, SignInError, type Profile } from "../src/types.js";
import { startFakeNextAuth, type FakeHandoffRoute, type FakeNextAuth } from "./helpers/fake-nextauth.js";

const PROFILE = "demo:testing:handoff:device";
const DEVICE_EMAIL = "agent.device@example.test";
const OTHER_EMAIL = "someone.else@example.test";
const SESSION_COOKIE = "next-auth.session-token";

it("never echoes an opaque session reflected by the initial identity endpoint", async () => {
  const value = randomBytes(24).toString("hex");
  const h = harness(profileFor("https://app.example.test"), handoffSecretValue());
  h.ctx.probeOrigin = async () => undefined;
  h.ctx.fetchImpl = async (url) => new URL(String(url)).pathname === "/api/auth/agent-handoff"
    ? redirectWith([`${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly`])
    : Response.json({ user: { email: value } });
  const error = await appHandoffStrategy.signIn(h.ctx).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SignInError);
  expect((error as Error).message).not.toContain(value);
  expect((error as Error).message).toContain("belongs to another account");
});

const throwaway = (): string => randomBytes(18).toString("base64url");
/** A handoff secret of the required length (43 characters). */
const handoffSecretValue = (): string => randomBytes(32).toString("base64url");

let apps: FakeNextAuth[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
  vi.restoreAllMocks();
});

async function startApp(secret: string, route: Partial<FakeHandoffRoute> = {}): Promise<FakeNextAuth> {
  const app = await startFakeNextAuth({
    users: [
      { email: DEVICE_EMAIL, password: throwaway(), name: "Exchange Device", role: "Service" },
      { email: OTHER_EMAIL, password: throwaway(), name: "Someone Else", role: "Admin" },
    ],
    includeRoleInSession: true,
    handoff: { secret, profiles: { [PROFILE]: DEVICE_EMAIL }, ...route },
  });
  apps.push(app);
  return app;
}

function profileFor(baseUrl: string, options: Record<string, string> = {}): Profile {
  return {
    name: PROFILE,
    app: "demo",
    environment: "testing",
    baseUrl,
    strategy: "app-handoff",
    account: { email: DEVICE_EMAIL, role: "Service" },
    session: { ttlMinutes: 60 },
    options: { mePath: "/api/auth/session", emailField: "user.email", roleField: "user.role", ...options },
  };
}

type RecordHandoff = NonNullable<SignInContext["recordHandoff"]>;

interface Harness {
  ctx: SignInContext;
  fetchImpl: Mock<typeof fetch>;
  recordHandoff: Mock<RecordHandoff>;
  /** Order of events: "audit" / "audit:no-answer" (recordHandoff) and "GET <path>" (requests). */
  events: string[];
}

function harness(profile: Profile, secret: string, ttlMinutes = 60): Harness {
  const events: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    events.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return fetch(input, init);
  });
  const recordHandoff = vi.fn<RecordHandoff>(async (failure) => {
    events.push(failure === undefined ? "audit" : `audit:${failure.reason}`);
  });
  return { ctx: { profile, secret, ttlMinutes, fetchImpl, recordHandoff }, fetchImpl, recordHandoff, events };
}

/** A synthetic 302 from the handoff route, for Set-Cookie shapes a real server helper cannot stage. */
function redirectWith(setCookies: string[], location = "/"): Response {
  const headers = new Headers({ Location: location });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * A fetchImpl for a profile on https://app.example.test: the handoff route answers `handoff`,
 * the identity endpoint answers the device email. No network (the probe is injected too).
 */
function syntheticApp(handoff: () => Response): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname === "/api/auth/agent-handoff") return handoff();
    return new Response(JSON.stringify({ user: { email: DEVICE_EMAIL } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

/** Nothing of the one-time code, the URL or the cookie values in an error. */
function expectClean(err: unknown, app: FakeNextAuth, ...more: string[]): void {
  const texts = [String((err as Error).message), String((err as Error).stack), JSON.stringify(err)];
  for (const text of texts) {
    expect(text).not.toContain("code=");
    expect(text).not.toContain("agent-handoff?");
    for (const value of [...app.handoffCodes, ...app.sessionTokens, ...more]) expect(text).not.toContain(value);
  }
}

describe("app-handoff options schema", () => {
  it("accepts handoffPath, mePath, emailField and roleField", () => {
    expect(
      validateStrategyOptions("app-handoff", {
        handoffPath: "/api/auth/agent-handoff",
        mePath: "/api/auth/session",
        emailField: "user.email",
        roleField: "user.role",
      }).success,
    ).toBe(true);
    expect(validateStrategyOptions("app-handoff", {}).success).toBe(true);
  });

  it("rejects unknown keys and unsafe values", () => {
    for (const bad of [
      { mePath: "https://attacker.example.net/me" },
      { mePath: "//attacker.example.net/me" },
      { mePath: "/me?x=1" },
      { mePath: "\\\\attacker" },
      { emailField: "user..email" },
      { roleField: "user.[0]" },
      { sessionCookieName: "sid" },
      { tokenPath: "/api/token" },
      { rotatePath: "/pw" },
    ]) {
      expect(validateStrategyOptions("app-handoff", bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is a sign-in strategy now", () => {
    expect(isSignInStrategy("app-handoff")).toBe(true);
    expect(getStrategy("app-handoff")).toBe(appHandoffStrategy);
  });
});

describe("app-handoff signIn", () => {
  it("mints the handoff code, audits it before the request, consumes the URL and captures the cookie", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const h = harness(profileFor(app.baseUrl), secret);

    const artifact = await appHandoffStrategy.signIn(h.ctx);

    expect(h.events).toEqual(["audit", "GET /api/auth/agent-handoff", "GET /api/auth/session"]);
    expect(h.recordHandoff).toHaveBeenCalledTimes(1);
    expect(app.handoffOutcomes).toEqual(["ok"]);
    // The code the route received is exactly what `testlane handoff` mints: it names the profile.
    const code = app.handoffCodes[0] ?? "";
    const replay = await verifyHandoffCode({ code, secret, nonceStore: new MemoryNonceStore() });
    expect(replay).toMatchObject({ ok: true, profileName: PROFILE });
    const [firstCall] = h.fetchImpl.mock.calls;
    const requested = firstCall?.[0] as URL;
    expect(requested.origin).toBe(new URL(app.baseUrl).origin);
    expect(firstCall?.[1]).toMatchObject({ method: "GET", redirect: "manual" });

    expect(artifact).toMatchObject({ profile: PROFILE, strategy: "app-handoff", baseUrl: app.baseUrl });
    expect(artifact.headers).toBeUndefined();
    expect(artifact.cookies.map((c) => c.name)).toEqual([SESSION_COOKIE]);
    expect(artifact.cookies[0]?.value).toBe(app.sessionTokens[0]);
    expect(app.sessionUserFor(`${SESSION_COOKIE}=${artifact.cookies[0]?.value}`)?.email).toBe(DEVICE_EMAIL);
    // The artifact never carries the code, the URL or the secret.
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("agent-handoff");
  });

  it("uses options.handoffPath, like `handoff`", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { path: "/internal/agent-login" });
    const h = harness(profileFor(app.baseUrl, { handoffPath: "/internal/agent-login" }), secret);
    await appHandoffStrategy.signIn(h.ctx);
    expect(h.events).toEqual(["audit", "GET /internal/agent-login", "GET /api/auth/session"]);
  });

  it("caps the expiry at the shortest captured cookie and the TTL", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { maxAgeSeconds: 300 });
    const before = Date.now();
    const artifact = await appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret, 60).ctx);
    const expires = Date.parse(artifact.expiresAt);
    expect(expires).toBeGreaterThan(before + 290_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(artifact.cookies[0]?.expires).toBe(Math.floor(expires / 1000));

    // A long-lived cookie is capped at the TTL instead.
    const app2 = await startApp(secret);
    const ttl = await appHandoffStrategy.signIn(harness(profileFor(app2.baseUrl), secret, 5).ctx);
    expect(Date.parse(ttl.expiresAt)).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(Date.parse(ttl.expiresAt)).toBeGreaterThan(before + 4 * 60_000);

    // An auxiliary short-lived cookie counts too (minimum of every captured cookie).
    const app3 = await startApp(secret, { extraCookies: ["aux=1; Path=/; Max-Age=120"] });
    const aux = await appHandoffStrategy.signIn(harness(profileFor(app3.baseUrl), secret, 60).ctx);
    expect(aux.cookies.map((c) => c.name).sort()).toEqual(["aux", SESSION_COOKIE]);
    expect(Date.parse(aux.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("keeps only cookies for the profile host (a foreign Domain is dropped)", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { extraCookies: ["tracker=abc; Path=/; Domain=elsewhere.example.test"] });
    const artifact = await appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx);
    expect(artifact.cookies.map((c) => c.name)).toEqual([SESSION_COOKIE]);
  });

  it("refuses a session cookie set for a foreign Domain (no cookie left for the profile host)", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { cookieDomain: "elsewhere.example.test" });
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toContain("set no host-only session cookie for the profile host");
    expectClean(err, app, secret);
  });

  it("drops a cookie whose Domain equals the host: host-only cookies only", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { cookieDomain: "127.0.0.1" });
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect((err as Error).message).toContain("set no host-only session cookie");

    const app2 = await startApp(secret, { extraCookies: ["same=1; Path=/; Domain=127.0.0.1", "empty=1; Path=/; Domain="] });
    const artifact = await appHandoffStrategy.signIn(harness(profileFor(app2.baseUrl), secret).ctx);
    expect(artifact.cookies.map((c) => c.name)).toEqual([SESSION_COOKIE]);
  });

  it("drops a parent-domain cookie and keeps the host-only one", async () => {
    const secret = handoffSecretValue();
    const profile = profileFor("https://app.example.test");
    const h = harness(profile, secret);
    h.ctx.fetchImpl = syntheticApp(() =>
      redirectWith([
        "parent=p1; Path=/; Domain=example.test; Secure; HttpOnly",
        "dotted=p2; Path=/; Domain=.example.test; Secure",
        "sid=host-only-value; Path=/; Secure; HttpOnly",
      ]),
    );
    h.ctx.probeOrigin = async () => undefined;
    const artifact = await appHandoffStrategy.signIn(h.ctx);
    expect(artifact.cookies.map((c) => [c.name, c.domain])).toEqual([["sid", "app.example.test"]]);
  });

  it("enforces the __Secure- and __Host- prefix rules on the captured cookies", async () => {
    const secret = handoffSecretValue();
    const profile = profileFor("https://app.example.test");
    const h = harness(profile, secret);
    h.ctx.fetchImpl = syntheticApp(() =>
      redirectWith([
        "__Secure-bad=1; Path=/",
        "__Host-nopath=1; Secure",
        "__Host-subpath=1; Secure; Path=/app",
        "__secure-lower=1; Path=/",
        "__Host-good=1; Secure; Path=/; HttpOnly",
        "__Secure-good=1; Secure; Path=/",
      ]),
    );
    h.ctx.probeOrigin = async () => undefined;
    const artifact = await appHandoffStrategy.signIn(h.ctx);
    expect(artifact.cookies.map((c) => c.name).sort()).toEqual(["__Host-good", "__Secure-good"]);
  });

  it("refuses a redirect off the profile origin", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { location: "https://elsewhere.example.test/welcome" });
    const h = harness(profileFor(app.baseUrl), secret);
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).status).toBe(302);
    expect((err as Error).message).toContain("redirected off the profile origin");
    // Never followed: only the handoff GET went out.
    expect(h.events).toEqual(["audit", "GET /api/auth/agent-handoff"]);
    expectClean(err, app, secret);
  });

  it("refuses a 3xx without a Location", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { status: 303, location: "" });
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect((err as Error).message).toContain("without a Location header");
  });

  it("treats any non-3xx answer as a sign-in failure, even with a cookie", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { status: 200 });
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).status).toBe(200);
    expect((err as SignInError).credentialsRejected).toBe(false);
    expect((err as Error).message).toContain("answered 200 instead of a redirect");
    expectClean(err, app, secret);
  });

  it("treats the route's 404 (here: a secret the app does not share) as a sign-in failure", async () => {
    const app = await startApp(handoffSecretValue());
    const brokerSecret = handoffSecretValue();
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), brokerSecret).ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).status).toBe(404);
    expect(app.handoffOutcomes).toEqual(["bad-signature"]);
    expectClean(err, app, brokerSecret);
  });

  it("refuses a redirect that set no cookie", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { noCookie: true });
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect((err as Error).message).toContain("set no host-only session cookie");
    expectClean(err, app, secret);
  });

  for (const [what, location] of [
    ["a protocol-relative Location", "//elsewhere.example.test/landing-7f3a"],
    ["a port-changing Location", "http://127.0.0.1:9/landing-7f3a"],
    ["an https Location on the same host", "https://127.0.0.1/landing-7f3a"],
  ] as const) {
    it(`refuses ${what}, never follows it and never echoes it`, async () => {
      const secret = handoffSecretValue();
      const app = await startApp(secret, { location });
      const h = harness(profileFor(app.baseUrl), secret);
      const err = await rejection(appHandoffStrategy.signIn(h.ctx));
      expect(err).toBeInstanceOf(SignInError);
      expect((err as Error).message).toContain("redirected off the profile origin");
      expect(h.events).toEqual(["audit", "GET /api/auth/agent-handoff"]);
      expectClean(err, app, secret, location, "landing-7f3a");
    });
  }

  it("a fetch error that quotes the full handoff URL never reaches the error; the no-answer is recorded", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const h = harness(profileFor(app.baseUrl), secret);
    const seen: string[] = [];
    h.ctx.fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const href = String(input);
      seen.push(href);
      throw new TypeError(`fetch failed for ${href}`, { cause: new Error(`connect ECONNRESET ${href}`) });
    });
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe(`could not reach handoff route at ${new URL(app.baseUrl).host}`);
    expect(seen).toHaveLength(1);
    const code = new URL(seen[0] ?? "http://x/").searchParams.get("code") ?? "<none>";
    expectClean(err, app, secret, seen[0] ?? "<none>", code);
    expect(h.events).toEqual(["audit", "audit:no-answer"]);
  });

  it("maps a body that breaks off mid-answer at mePath to a SignInError", async () => {
    const secret = handoffSecretValue();
    const app = await startFakeNextAuth({
      users: [{ email: DEVICE_EMAIL, password: throwaway() }],
      handoff: { secret, profiles: { [PROFILE]: DEVICE_EMAIL } },
      extraRoutes: (_req, res, url) => {
        if (url.pathname !== "/api/broken-me") return false;
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "200" });
        res.write('{"user":{"email":');
        setTimeout(() => res.destroy(), 20);
        return true;
      },
    });
    apps.push(app);
    const h = harness(profileFor(app.baseUrl, { mePath: "/api/broken-me" }), secret);
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe(`identity endpoint at ${new URL(app.baseUrl).host} failed while sending its answer`);
    expectClean(err, app, secret);
  });

  it("refuses when mePath reports another account, without echoing session material", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret, { profiles: { [PROFILE]: OTHER_EMAIL } });
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe(
      `the handoff session at ${new URL(app.baseUrl).host} belongs to another account, but the profile expects ${DEVICE_EMAIL}; refusing the session`,
    );
    expectClean(err, app, secret);
  });

  it("compares the email case-insensitively", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const profile = profileFor(app.baseUrl);
    profile.account = { ...profile.account, email: DEVICE_EMAIL.toUpperCase() };
    const artifact = await appHandoffStrategy.signIn(harness(profile, secret).ctx);
    expect(artifact.cookies).toHaveLength(1);
  });

  it("refuses when mePath reports no email at emailField", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const err = await rejection(
      appHandoffStrategy.signIn(harness(profileFor(app.baseUrl, { emailField: "user.mail" }), secret).ctx),
    );
    expect((err as Error).message).toContain("did not report an email at emailField");
  });

  it("does not echo an odd app-reported email in the mismatch message", async () => {
    const secret = handoffSecretValue();
    const odd = "odd@example.test ok  forged-line";
    const app = await startFakeNextAuth({
      users: [{ email: odd, password: throwaway() }],
      handoff: { secret, profiles: { [PROFILE]: odd } },
    });
    apps.push(app);
    const err = await rejection(appHandoffStrategy.signIn(harness(profileFor(app.baseUrl), secret).ctx));
    expect((err as Error).message).toContain("belongs to another account");
    expect((err as Error).message).not.toContain("forged-line");
  });

  it("refuses without mePath (the opt-in) before the probe, a mint or any request", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const profile = profileFor(app.baseUrl);
    profile.options = { handoffPath: "/api/auth/agent-handoff" };
    const h = harness(profile, secret);
    const probe = vi.fn(async () => undefined);
    h.ctx.probeOrigin = probe;
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toContain("needs profile option mePath");
    expect(probe).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.recordHandoff).not.toHaveBeenCalled();
    expect(app.handoffCodes).toEqual([]);

    const artifact = { profile: PROFILE, strategy: "app-handoff" as const, baseUrl: app.baseUrl, cookies: [], issuedAt: "", expiresAt: "" };
    const err2 = await rejection(appHandoffStrategy.whoami?.(artifact, h.fetchImpl, profile) ?? Promise.resolve());
    expect((err2 as Error).message).toBe("app-handoff cannot confirm the identity without profile option mePath");
  });

  it("checks reachability before minting: a failing probe mints nothing", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const h = harness(profileFor(app.baseUrl), secret);
    h.ctx.probeOrigin = async () => {
      throw new SignInError("could not reach handoff route at somewhere (ENOTFOUND)");
    };
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect((err as Error).message).toContain("ENOTFOUND");
    expect(h.recordHandoff).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(app.handoffCodes).toEqual([]);
  });

  it("whoami reports the identity through mePath", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const profile = profileFor(app.baseUrl);
    const h = harness(profile, secret);
    const artifact = await appHandoffStrategy.signIn(h.ctx);
    const who = await appHandoffStrategy.whoami?.(artifact, h.fetchImpl, profile);
    expect(who).toMatchObject({ email: DEVICE_EMAIL, role: "Service", name: "Exchange Device" });
  });

  it("refuses before minting or any request: short secret, no audit hook, unsafe mePath", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);

    const short = randomBytes(12).toString("hex"); // 24 characters
    const h1 = harness(profileFor(app.baseUrl), short);
    const e1 = await rejection(appHandoffStrategy.signIn(h1.ctx));
    expect((e1 as Error).message).toContain("shorter than 32 characters");
    expect((e1 as Error).message).not.toContain(short);

    const h2 = harness(profileFor(app.baseUrl), secret);
    delete h2.ctx.recordHandoff;
    const e2 = await rejection(appHandoffStrategy.signIn(h2.ctx));
    expect((e2 as Error).message).toContain("no recordHandoff provided");

    const h3 = harness(profileFor(app.baseUrl, { mePath: "https://elsewhere.example.test/me" }), secret);
    const e3 = await rejection(appHandoffStrategy.signIn(h3.ctx));
    expect((e3 as Error).message).toContain("profile option mePath must be a path");

    const h4 = harness(profileFor(app.baseUrl, { handoffPath: "/a//b" }), secret);
    const e4 = await rejection(appHandoffStrategy.signIn(h4.ctx));
    expect(e4).toBeInstanceOf(PolicyError);

    for (const h of [h1, h2, h3, h4]) {
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(h.recordHandoff).not.toHaveBeenCalled();
    }
    expect(app.handoffCodes).toEqual([]);
  });

  it("sends nothing when the audit hook fails", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const h = harness(profileFor(app.baseUrl), secret);
    h.recordHandoff.mockRejectedValueOnce(new Error("audit row refused"));
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect((err as Error).message).toBe("audit row refused");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(app.handoffCodes).toEqual([]);
  });

  it("reports an unreachable app by host only, from the real TCP probe, before any code is minted", async () => {
    const secret = handoffSecretValue();
    const app = await startApp(secret);
    const baseUrl = app.baseUrl;
    await app.close();
    apps = apps.filter((a) => a !== app);
    const h = harness(profileFor(baseUrl), secret);
    const err = await rejection(appHandoffStrategy.signIn(h.ctx));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toMatch(/^could not reach handoff route at 127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/);
    expect(h.recordHandoff).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});
