import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStrategy, type SignInContext } from "../src/strategies/index.js";
import { SignInError, type Profile, type SessionArtifact } from "../src/types.js";
import { startFakeNextAuth, type FakeNextAuth, type FakeNextAuthOptions } from "./helpers/fake-nextauth.js";

/** Throwaway secret generated per test; never a realistic literal. */
const throwaway = (): string => randomBytes(18).toString("base64url");

const EMAIL = "agent-test@example.invalid";
const strategy = getStrategy("nextauth-credentials");

let server: FakeNextAuth | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

function profileFor(baseUrl: string, options?: Record<string, string>): Profile {
  return {
    name: "acme:local:admin",
    app: "acme",
    environment: "sandbox",
    baseUrl,
    strategy: "nextauth-credentials",
    account: { email: EMAIL, role: "Admin" },
    session: { ttlMinutes: 30 },
    ...(options ? { options } : {}),
  };
}

async function setup(
  password: string,
  extra: Omit<FakeNextAuthOptions, "users"> = {},
): Promise<FakeNextAuth> {
  server = await startFakeNextAuth({
    users: [{ email: EMAIL, password, name: "Agent Tester", role: "Admin" }],
    ...extra,
  });
  return server;
}

function ctx(baseUrl: string, secret: string, ttlMinutes = 30): SignInContext {
  return { profile: profileFor(baseUrl), secret, ttlMinutes };
}

async function expectSignInError(p: Promise<SessionArtifact>): Promise<SignInError> {
  let artifact: SessionArtifact | undefined;
  let caught: unknown;
  try {
    artifact = await p;
  } catch (err) {
    caught = err;
  }
  expect(artifact).toBeUndefined();
  expect(caught).toBeInstanceOf(SignInError);
  return caught as SignInError;
}

describe("getStrategy", () => {
  it("returns the nextauth strategy and refuses the rest", () => {
    expect(strategy.name).toBe("nextauth-credentials");
    expect(() => getStrategy("api-key")).toThrow('Strategy "api-key" is not implemented yet (Phase 1).');
  });
});

describe("nextauth-credentials strategy", () => {
  it("captures exactly the session cookie on the happy path", async () => {
    const password = throwaway();
    const s = await setup(password);
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));

    expect(artifact.strategy).toBe("nextauth-credentials");
    expect(artifact.profile).toBe("acme:local:admin");
    expect(artifact.cookies).toHaveLength(1);
    const [cookie] = artifact.cookies;
    expect(cookie).toMatchObject({
      name: "next-auth.session-token",
      httpOnly: true,
      path: "/",
      domain: "127.0.0.1",
      secure: false,
      sameSite: "Lax",
    });
    expect(cookie?.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends the csrf cookie on the callback POST", async () => {
    const password = throwaway();
    const s = await setup(password);
    await strategy.signIn(ctx(s.baseUrl, password));
    const post = s.requests.find((r) => r.method === "POST" && r.path === "/api/auth/callback/credentials");
    expect(post).toBeDefined();
    expect(post?.hasCsrfCookie).toBe(true);
  });

  it("picks up the __Secure- session cookie", async () => {
    const password = throwaway();
    const s = await setup(password, { secureCookie: true });
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));
    expect(artifact.cookies).toHaveLength(1);
    expect(artifact.cookies[0]?.name).toBe("__Secure-next-auth.session-token");
    expect(artifact.cookies[0]?.secure).toBe(true);
  });

  it("handles the 302 callback shape", async () => {
    const password = throwaway();
    const s = await setup(password, { respondWithRedirect: true });
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));
    expect(artifact.cookies[0]?.name).toBe("next-auth.session-token");

    const wrong = throwaway();
    const err = await expectSignInError(strategy.signIn(ctx(s.baseUrl, wrong)));
    expect(err.message).toBe(`credentials rejected by ${new URL(s.baseUrl).host}`);
    expect(err.message).not.toContain(wrong);
  });

  it("rejects a wrong password without leaking either secret", async () => {
    const password = throwaway();
    const wrong = throwaway();
    const s = await setup(password);
    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );

    const err = await expectSignInError(strategy.signIn(ctx(s.baseUrl, wrong)));
    expect(err.message).toContain("credentials rejected by 127.0.0.1");
    for (const secret of [password, wrong]) {
      expect(err.message).not.toContain(secret);
      expect(String(err.stack)).not.toContain(secret);
      expect(JSON.stringify(err)).not.toContain(secret);
    }
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("fails when the CSRF endpoint errors", async () => {
    const password = throwaway();
    const s = await setup(password, { failCsrf: true });
    const err = await expectSignInError(strategy.signIn(ctx(s.baseUrl, password)));
    expect(err.message).toBe("CSRF endpoint returned 500");
    expect(err.status).toBe(500);
    expect(s.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("reports a missing session cookie with the expected name", async () => {
    const password = throwaway();
    const s = await setup(password);
    const profile = profileFor(s.baseUrl, { sessionCookieName: "custom.session" });
    const err = await expectSignInError(strategy.signIn({ profile, secret: password, ttlMinutes: 30 }));
    expect(err.message).toBe("sign-in succeeded but no session cookie was set (expected custom.session)");
  });

  it("bounds expiresAt by ttlMinutes", async () => {
    const password = throwaway();
    const s = await setup(password);
    const artifact = await strategy.signIn(ctx(s.baseUrl, password, 5));
    const issued = Date.parse(artifact.issuedAt);
    const expires = Date.parse(artifact.expiresAt);
    expect(expires - issued).toBe(5 * 60_000);
    expect(artifact.cookies[0]?.expires).toBe(Math.floor(expires / 1000));
  });

  it("bounds expiresAt by a shorter cookie Max-Age", async () => {
    const password = throwaway();
    const s = await setup(password, { sessionMaxAgeSeconds: 60 });
    const artifact = await strategy.signIn(ctx(s.baseUrl, password, 30));
    const issued = Date.parse(artifact.issuedAt);
    const expires = Date.parse(artifact.expiresAt);
    expect(expires - issued).toBeLessThanOrEqual(61_000);
    expect(expires - issued).toBeGreaterThan(55_000);
    expect(artifact.cookies[0]?.expires).toBe(Math.floor(expires / 1000));
  });

  it("refuses a non-positive ttl before any request", async () => {
    const password = throwaway();
    const s = await setup(password);
    await expectSignInError(strategy.signIn(ctx(s.baseUrl, password, 0)));
    expect(s.requests).toHaveLength(0);
  });

  it("whoami returns email and role when the session includes role", async () => {
    const password = throwaway();
    const s = await setup(password, { includeRoleInSession: true });
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));
    const who = await strategy.whoami!(artifact);
    expect(who.email).toBe(EMAIL);
    expect(who.name).toBe("Agent Tester");
    expect(who.role).toBe("Admin");
    expect(who.raw).toMatchObject({ email: EMAIL, tenantSlug: "test-tenant" });
  });

  it("whoami leaves role undefined when the session has none", async () => {
    const password = throwaway();
    const s = await setup(password);
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));
    const who = await strategy.whoami!(artifact);
    expect(who.email).toBe(EMAIL);
    expect(who.role).toBeUndefined();
    expect(JSON.stringify(who)).not.toContain(artifact.cookies[0]?.value ?? "<none>");
  });

  it("whoami fails for an invalid session", async () => {
    const password = throwaway();
    const s = await setup(password);
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));
    const forged: SessionArtifact = {
      ...artifact,
      cookies: artifact.cookies.map((c) => ({ ...c, value: randomBytes(32).toString("hex") })),
    };
    await expect(strategy.whoami!(forged)).rejects.toBeInstanceOf(SignInError);
  });

  it("refuses redirecting path options before any request (injected past profile validation)", async () => {
    for (const [key, value] of [
      ["callbackPath", "https://attacker.example.net/x"],
      ["csrfPath", "//attacker.example.net/csrf"],
      ["sessionPath", "HTTPS://attacker.example.net/s"],
      ["callbackPath", "api/auth/callback/credentials"],
      ["csrfPath", "/a\\@attacker.example.net"],
    ] as const) {
      const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
      const profile = profileFor("http://127.0.0.1:9", { [key]: value });
      const secret = throwaway();
      const err = await expectSignInError(
        strategy.signIn({ profile, secret, ttlMinutes: 30, fetchImpl: fetchSpy }),
      );
      expect(err.message, `${key}=${value}`).toContain(key);
      expect(err.message).not.toContain("attacker");
      expect(err.message).not.toContain(secret);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("whoami refuses a redirecting sessionPath before any request", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const profile = profileFor("http://127.0.0.1:9", { sessionPath: "https://attacker.example.net/s" });
    const artifact: SessionArtifact = {
      profile: profile.name,
      strategy: "nextauth-credentials",
      baseUrl: profile.baseUrl,
      cookies: [],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    };
    await expect(strategy.whoami!(artifact, fetchSpy, profile)).rejects.toBeInstanceOf(SignInError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never puts the secret into the artifact", async () => {
    const password = throwaway();
    const s = await setup(password);
    const artifact = await strategy.signIn(ctx(s.baseUrl, password));
    expect(JSON.stringify(artifact)).not.toContain(password);
  });
});
