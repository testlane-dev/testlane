import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSession, SESSION_FORMATS } from "../src/session/format.js";
import { getPath } from "../src/strategies/form-post.js";
import { getStrategy } from "../src/strategies/index.js";
import { validateStrategyOptions } from "../src/strategies/options.js";
import { SignInError, type Profile, type SessionArtifact } from "../src/types.js";
import { startFakeFormApp, type FakeFormApp, type FakeFormAppOptions } from "./helpers/fake-form-app.js";

/** Throwaway secret generated per test; includes "$&" and "+" to prove literal substitution. */
const throwaway = (): string => `${randomBytes(12).toString("base64url")}$&+ %`;

const EMAIL = "agent-form@example.invalid";
const strategy = getStrategy("form-post");
const FIELDS = JSON.stringify({ user: "{{email}}", pass: "{{secret}}", remember: "1" });

const servers: FakeFormApp[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
});

async function app(password: string, extra: Omit<FakeFormAppOptions, "users"> = {}): Promise<FakeFormApp> {
  const s = await startFakeFormApp({
    users: [{ email: EMAIL, password, name: "Form Tester", role: "Sales" }],
    ...extra,
  });
  servers.push(s);
  return s;
}

function profileFor(baseUrl: string, options: Record<string, string> = {}): Profile {
  return {
    name: "demo:local:form",
    app: "demo",
    environment: "sandbox",
    baseUrl,
    strategy: "form-post",
    account: { email: EMAIL, role: "Sales" },
    session: { ttlMinutes: 30 },
    options: { loginPath: "/login", fields: FIELDS, sessionCookieName: "sid", ...options },
  };
}

async function expectSignInError(p: Promise<unknown>): Promise<SignInError> {
  const caught = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(SignInError);
  return caught as SignInError;
}

/** The ways a secret can appear on the wire: raw, URL-encoded, form-encoded, JSON-escaped. */
function secretForms(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ v: secret }).toString().slice(2),
    JSON.stringify(secret).slice(1, -1),
  ];
}

function expectNoSecret(err: SignInError, ...secrets: string[]): void {
  for (const secret of secrets) {
    for (const form of secretForms(secret)) {
      expect(err.message).not.toContain(form);
      expect(String(err.stack)).not.toContain(form);
      expect(JSON.stringify(err)).not.toContain(form);
    }
  }
}

describe("form-post options schema", () => {
  it("accepts the documented keys and rejects unknown or unsafe ones", () => {
    expect(
      validateStrategyOptions("form-post", {
        loginPath: "/login",
        fields: FIELDS,
        sessionCookieName: "sid",
        primeCookies: "true",
        successPath: "/dashboard",
        mePath: "/me",
        roleField: "user.role",
        emailField: "user.email",
      }).success,
    ).toBe(true);
    expect(
      validateStrategyOptions("form-post", {
        loginPath: "/api/auth/sign-in/email",
        bodyFormat: "json",
        fields: JSON.stringify({ email: "{{email}}", password: "{{secret}}" }),
        sessionCookieName: "acme_session_token",
        successBodyField: "acmeLocalSessionToken",
        mePath: "/api/auth/workspaces",
        roleField: "workspaces.0.role",
        emailField: "email",
      }).success,
    ).toBe(true);
    expect(validateStrategyOptions("form-post", { bodyFormat: "form" }).success).toBe(true);
    for (const bad of [
      { loginPath: "https://attacker.example.net/login" },
      { mePath: "//attacker.example.net/me" },
      { primeCookies: "yes" },
      { sessionCookieName: "bad name" },
      { roleField: "a..b" },
      { fields: "[1]" },
      { passwordField: "pass" },
      { bodyFormat: "xml" },
      { bodyFormat: "JSON" },
      { successBodyField: "a..b" },
      { roleField: "workspaces.[0].role" },
    ]) {
      expect(validateStrategyOptions("form-post", bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("form-post strategy", () => {
  it("primes cookies, posts the form, follows the redirect chain and captures the session", async () => {
    const password = throwaway();
    const s = await app(password, { requireCsrfCookie: true });
    const profile = profileFor(s.baseUrl, { primeCookies: "true", successPath: "/dashboard" });
    const artifact = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });

    expect(artifact.strategy).toBe("form-post");
    expect(artifact.profile).toBe("demo:local:form");
    const sid = artifact.cookies.find((c) => c.name === "sid");
    expect(sid?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(sid).toMatchObject({ domain: "127.0.0.1", path: "/", httpOnly: true });
    // The priming cookie travels along (apps often need it on later requests).
    expect(artifact.cookies.map((c) => c.name).sort()).toEqual(["csrf", "sid"]);

    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /login",
      "POST /login",
      "GET /step-1",
      "GET /dashboard",
    ]);
    const post = s.requests[1];
    expect(post?.cookieNames).toContain("csrf");
    expect(post?.fieldNames.sort()).toEqual(["pass", "remember", "user"]);
    // Redirect hops carry the jar, including the fresh session cookie.
    expect(s.requests[2]?.cookieNames).toContain("sid");
    expect(s.requests[3]?.cookieNames).toContain("sid");
    // Redirects are followed with GET only: the secret is posted exactly once.
    expect(s.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("captures a session cookie set on the last redirect hop", async () => {
    const password = throwaway();
    const s = await app(password, { setCookieOnFinalHop: true, chain: ["/a", "/b", "/c", "/home"] });
    const artifact = await strategy.signIn({ profile: profileFor(s.baseUrl), secret: password, ttlMinutes: 30 });
    expect(artifact.cookies.some((c) => c.name === "sid")).toBe(true);
    expect(s.requests.map((r) => r.path)).toEqual(["/login", "/a", "/b", "/c", "/home"]);
  });

  it("posts application/x-www-form-urlencoded by default and with bodyFormat form", async () => {
    for (const extra of [{}, { bodyFormat: "form" }]) {
      const password = throwaway();
      const s = await app(password, { noRedirect: true });
      const artifact = await strategy.signIn({ profile: profileFor(s.baseUrl, extra), secret: password, ttlMinutes: 30 });
      expect(artifact.cookies.map((c) => c.name)).toEqual(["sid"]);
      expect(s.requests[0]?.contentType).toBe("application/x-www-form-urlencoded");
      expect(s.requests[0]?.origin).toBeUndefined();
      expect(s.requests[0]?.fieldNames.sort()).toEqual(["pass", "remember", "user"]);
    }
  });

  it("succeeds without a redirect when the POST itself sets the cookie", async () => {
    const password = throwaway();
    const s = await app(password, { noRedirect: true });
    const artifact = await strategy.signIn({ profile: profileFor(s.baseUrl), secret: password, ttlMinutes: 30 });
    expect(artifact.cookies.map((c) => c.name)).toEqual(["sid"]);
  });

  it("fails without a session cookie (wrong password) and never leaks either secret", async () => {
    const password = throwaway();
    const wrong = throwaway();
    const s = await app(password);
    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const err = await expectSignInError(
      strategy.signIn({ profile: profileFor(s.baseUrl), secret: wrong, ttlMinutes: 30 }),
    );
    expect(err.message).toContain("did not set the session cookie (expected sid");
    expectNoSecret(err, password, wrong);
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("does not count a session cookie set only by the priming GET", async () => {
    const password = throwaway();
    const wrong = throwaway();
    // No redirect after the POST: the only session cookie is the anonymous one from GET /login.
    const s = await app(password, { sessionCookieOnPrime: true, requireCsrfCookie: true, noRedirect: true });
    const profile = profileFor(s.baseUrl, { primeCookies: "true" });
    const err = await expectSignInError(strategy.signIn({ profile, secret: wrong, ttlMinutes: 30 }));
    expect(err.message).toContain("did not set the session cookie");
    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /login", "POST /login"]);
    // The right password still works in the same setup.
    const ok = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });
    expect(ok.cookies.find((c) => c.name === "sid")?.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports the CSRF refusal when priming is off", async () => {
    const password = throwaway();
    const s = await app(password, { requireCsrfCookie: true });
    const err = await expectSignInError(
      strategy.signIn({ profile: profileFor(s.baseUrl), secret: password, ttlMinutes: 30 }),
    );
    expect(err.message).toBe(`credentials rejected by ${new URL(s.baseUrl).host}`);
    expect(err.status).toBe(403);
  });

  it("uses successPath to reject a failure that lands on a page setting an anonymous session cookie", async () => {
    const password = throwaway();
    const wrong = throwaway();
    // A failed POST redirects to /login?error=1, whose GET sets a fresh anonymous "sid".
    const s = await app(password, { sessionCookieOnPrime: true });
    const profile = profileFor(s.baseUrl, { successPath: "/dashboard" });
    const err = await expectSignInError(strategy.signIn({ profile, secret: wrong, ttlMinutes: 30 }));
    expect(err.message).toContain("did not end under successPath");
    expectNoSecret(err, password, wrong);
    const ok = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });
    expect(ok.cookies.find((c) => c.name === "sid")?.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires the final page to be under successPath when configured", async () => {
    const password = throwaway();
    const s = await app(password, { chain: ["/step-1", "/dashboardish"] });
    const err = await expectSignInError(
      strategy.signIn({ profile: profileFor(s.baseUrl, { successPath: "/dashboard" }), secret: password, ttlMinutes: 30 }),
    );
    expect(err.message).toContain("did not end under successPath");
    expectNoSecret(err, password);
  });

  it("resolves successPath below a baseUrl path prefix (like loginPath)", async () => {
    const password = throwaway();
    const baseUrl = "http://prefix.example.invalid/app";
    /** Stub app mounted under /app: POST /app/login sets sid and redirects to `landing`. */
    const stub = (landing: string) =>
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (init?.method === "POST" && url.pathname === "/app/login") {
          return new Response(null, {
            status: 302,
            headers: [
              ["Location", landing],
              ["Set-Cookie", `sid=${randomBytes(32).toString("hex")}; Path=/; HttpOnly`],
            ],
          });
        }
        return new Response("page", { status: 200 });
      });
    const profile = profileFor(baseUrl, { successPath: "/dashboard" });

    const okFetch = stub("/app/dashboard");
    const ok = await strategy.signIn({ profile, secret: password, ttlMinutes: 30, fetchImpl: okFetch });
    expect(ok.cookies.find((c) => c.name === "sid")?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(okFetch.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual(["/app/login", "/app/dashboard"]);

    // Landing on /dashboard (outside the /app prefix) is not under successPath.
    const err = await expectSignInError(
      strategy.signIn({ profile, secret: password, ttlMinutes: 30, fetchImpl: stub("/dashboard") }),
    );
    expect(err.message).toContain("did not end under successPath");
    expectNoSecret(err, password);
  });

  it("refuses an off-origin redirect without following it", async () => {
    const password = throwaway();
    const other = await app(throwaway());
    const s = await app(password, { redirectTo: `${other.baseUrl}/collect` });
    const err = await expectSignInError(
      strategy.signIn({ profile: profileFor(s.baseUrl), secret: password, ttlMinutes: 30 }),
    );
    expect(err.message).toContain("redirected off the profile origin; refusing to follow");
    expect(err.message).not.toContain(other.baseUrl);
    expect(other.requests).toHaveLength(0);
    expectNoSecret(err, password);
  });

  it("stops after 5 redirects", async () => {
    const password = throwaway();
    const s = await app(password, { redirectTo: "/loop" });
    const err = await expectSignInError(
      strategy.signIn({ profile: profileFor(s.baseUrl), secret: password, ttlMinutes: 30 }),
    );
    expect(err.message).toContain("redirected more than 5 times");
    expect(s.requests.filter((r) => r.path === "/loop")).toHaveLength(5);
  });

  it("refuses missing or unsafe options before any request (injected past profile validation)", async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ loginPath: undefined }, "loginPath is required"],
      [{ fields: undefined }, "fields is required"],
      [{ sessionCookieName: undefined }, "sessionCookieName is required"],
      [{ loginPath: "https://attacker.example.net/login" }, "loginPath"],
      [{ loginPath: "//attacker.example.net/login" }, "loginPath"],
      [{ mePath: "/a\\@attacker.example.net" }, "mePath"],
      [{ successPath: "HTTPS://attacker.example.net/" }, "successPath"],
      [{ fields: JSON.stringify({ user: "{{email}}" }) }, "{{secret}} placeholder"],
      [{ fields: "not json" }, "fields must be a JSON object"],
      [{ fields: JSON.stringify({ "bad name": "{{secret}}" }) }, "fields must be a JSON object"],
      [{ primeCookies: "yes" }, "primeCookies"],
      [{ bodyFormat: "xml" }, 'bodyFormat must be "form" or "json"'],
      [{ successBodyField: "a..b" }, "successBodyField must be a dot path"],
    ];
    for (const [patch, expected] of cases) {
      const fetchSpy = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
      const base = profileFor("http://127.0.0.1:9");
      const options: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...base.options, ...patch })) if (v !== undefined) options[k] = v;
      const secret = throwaway();
      const err = await expectSignInError(
        strategy.signIn({ profile: { ...base, options }, secret, ttlMinutes: 30, fetchImpl: fetchSpy }),
      );
      expect(err.message, JSON.stringify(patch)).toContain(expected);
      expect(err.message).not.toContain("attacker");
      expectNoSecret(err, secret);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("bounds expiresAt by ttlMinutes and caps every cookie", async () => {
    const password = throwaway();
    const s = await app(password, { requireCsrfCookie: true });
    const artifact = await strategy.signIn({
      profile: profileFor(s.baseUrl, { primeCookies: "true" }),
      secret: password,
      ttlMinutes: 5,
    });
    const expires = Date.parse(artifact.expiresAt);
    expect(expires - Date.parse(artifact.issuedAt)).toBe(5 * 60_000);
    for (const c of artifact.cookies) expect(c.expires).toBe(Math.floor(expires / 1000));
  });

  it("never puts the secret into the artifact or any session output format", async () => {
    const password = throwaway();
    const s = await app(password, { requireCsrfCookie: true });
    const artifact: SessionArtifact = await strategy.signIn({
      profile: profileFor(s.baseUrl, { primeCookies: "true" }),
      secret: password,
      ttlMinutes: 30,
    });
    const outputs = [JSON.stringify(artifact), ...SESSION_FORMATS.map((f) => formatSession(artifact, f))];
    for (const out of outputs) {
      expect(out).not.toContain(password);
      expect(out).not.toContain(encodeURIComponent(password));
    }
  });

  it("whoami reads email and role from the configured dot paths and strips token-like keys", async () => {
    const password = throwaway();
    const s = await app(password);
    const profile = profileFor(s.baseUrl, { mePath: "/me", roleField: "user.role", emailField: "user.email" });
    const artifact = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });
    const who = await strategy.whoami!(artifact, undefined, profile);
    expect(who).toMatchObject({ email: EMAIL, role: "Sales", name: "Form Tester" });
    expect(who.raw).toEqual({ user: { email: EMAIL, name: "Form Tester", role: "Sales" } });
    const json = JSON.stringify(who);
    expect(json).not.toContain(password);
    expect(json).not.toContain(artifact.cookies.find((c) => c.name === "sid")?.value ?? "<none>");
  });

  it("whoami refuses without mePath, and fails for a dead session", async () => {
    const password = throwaway();
    const s = await app(password);
    const profile = profileFor(s.baseUrl, { mePath: "/me" });
    const artifact = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });
    await expect(strategy.whoami!(artifact, undefined, profileFor(s.baseUrl))).rejects.toThrow(
      "without profile option mePath",
    );
    const forged: SessionArtifact = {
      ...artifact,
      cookies: artifact.cookies.map((c) => ({ ...c, value: randomBytes(32).toString("hex") })),
    };
    const err = await expectSignInError(strategy.whoami!(forged, undefined, profile));
    expect(err.status).toBe(401);
  });
});

describe("getPath", () => {
  const doc = {
    email: "a@example.invalid",
    workspaces: [
      { id: "w1", role: "owner" },
      { id: "w2", role: "viewer" },
    ],
    nested: { list: [["x", "y"]] },
  };

  it("follows object keys and numeric array indexes", () => {
    expect(getPath(doc, "email")).toBe("a@example.invalid");
    expect(getPath(doc, "workspaces.0.role")).toBe("owner");
    expect(getPath(doc, "workspaces.1.id")).toBe("w2");
    expect(getPath(doc, "nested.list.0.1")).toBe("y");
    expect(getPath([{ role: "r" }], "0.role")).toBe("r");
  });

  it("returns undefined for out-of-range, non-numeric or inherited segments", () => {
    expect(getPath(doc, "workspaces.2.role")).toBeUndefined();
    expect(getPath(doc, "workspaces.role")).toBeUndefined();
    expect(getPath(doc, "workspaces.01.role")).toBeUndefined();
    expect(getPath(doc, "workspaces.length")).toBeUndefined();
    expect(getPath(doc, "email.0")).toBeUndefined();
    expect(getPath(doc, "__proto__")).toBeUndefined();
    expect(getPath(doc, "constructor")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });
});

describe("form-post with bodyFormat json", () => {
  const COOKIE = "acme_session_token";
  const JSON_FIELDS = JSON.stringify({ email: "{{email}}", password: "{{secret}}" });
  /** A throwaway secret that also needs JSON escaping (quote and backslash). */
  const jsonThrowaway = (): string => `${throwaway()}"\\`;

  async function jsonApp(password: string, extra: Omit<FakeFormAppOptions, "users"> = {}): Promise<FakeFormApp> {
    const s = await startFakeFormApp({
      users: [{ email: EMAIL, password, name: "Json Tester", role: "owner" }],
      sessionCookieName: COOKIE,
      ...extra,
    });
    servers.push(s);
    return s;
  }

  function jsonProfile(baseUrl: string, options: Record<string, string> = {}): Profile {
    return {
      ...profileFor(baseUrl),
      name: "acme:local:operator",
      account: { email: EMAIL, role: "owner" },
      options: {
        loginPath: "/api/auth/sign-in/email",
        bodyFormat: "json",
        fields: JSON_FIELDS,
        sessionCookieName: COOKIE,
        mePath: "/api/auth/workspaces",
        emailField: "email",
        roleField: "workspaces.0.role",
        ...options,
      },
    };
  }

  it("posts a JSON body once, accepts a 200 JSON answer with the session cookie, and reads an array-index role", async () => {
    const password = jsonThrowaway();
    const s = await jsonApp(password);
    const profile = jsonProfile(s.baseUrl);
    const artifact = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });

    expect(artifact.cookies.map((c) => c.name)).toEqual([COOKIE]);
    expect(artifact.cookies[0]?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/auth/sign-in/email"]);
    const post = s.requests[0];
    expect(post?.contentType).toBe("application/json");
    expect(post?.origin).toBe(s.baseUrl);
    expect(post?.fieldNames.sort()).toEqual(["email", "password"]);

    const who = await strategy.whoami!(artifact, undefined, profile);
    expect(who).toMatchObject({ email: EMAIL, role: "owner" });
    expect(who.raw).toMatchObject({
      userId: "user_test_1",
      workspaces: [{ id: "ws_primary", role: "owner" }, { id: "ws_other" }],
    });
    // Other indexes work too.
    const second = await strategy.whoami!(artifact, undefined, jsonProfile(s.baseUrl, { roleField: "workspaces.1.role" }));
    expect(second.role).toBe("viewer");
  });

  it("accepts a 201 answer", async () => {
    const password = jsonThrowaway();
    const s = await jsonApp(password, { jsonSuccessStatus: 201 });
    const artifact = await strategy.signIn({ profile: jsonProfile(s.baseUrl), secret: password, ttlMinutes: 30 });
    expect(artifact.cookies.map((c) => c.name)).toEqual([COOKIE]);
  });

  it("maps a 401 wrong-password answer (no cookie) to a SignInError without either secret", async () => {
    const password = jsonThrowaway();
    const wrong = jsonThrowaway();
    const s = await jsonApp(password);
    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const err = await expectSignInError(
      strategy.signIn({ profile: jsonProfile(s.baseUrl), secret: wrong, ttlMinutes: 30 }),
    );
    expect(err.message).toBe(`credentials rejected by ${new URL(s.baseUrl).host}`);
    expect(err.status).toBe(401);
    expectNoSecret(err, password, wrong);
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    expect(s.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("form mode against a JSON-only endpoint fails cleanly (bodyFormat really switches the encoding)", async () => {
    const password = jsonThrowaway();
    const s = await jsonApp(password);
    const profile = jsonProfile(s.baseUrl, { bodyFormat: "form" });
    const err = await expectSignInError(strategy.signIn({ profile, secret: password, ttlMinutes: 30 }));
    expect(err.message).toContain("returned 415");
    expect(s.requests[0]?.contentType).toBe("application/x-www-form-urlencoded");
    expectNoSecret(err, password);
  });

  it("successBodyField requires a non-empty string in the login JSON and never exposes it", async () => {
    const password = jsonThrowaway();
    const s = await jsonApp(password);
    const profile = jsonProfile(s.baseUrl, { successBodyField: "sessionToken" });
    const ok = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });
    expect(ok.cookies.map((c) => c.name)).toEqual([COOKIE]);
    expect(JSON.stringify(ok)).not.toContain("sessionToken");

    const missing = await jsonApp(password, { jsonOmitToken: true });
    const err = await expectSignInError(
      strategy.signIn({
        profile: jsonProfile(missing.baseUrl, { successBodyField: "sessionToken" }),
        secret: password,
        ttlMinutes: 30,
      }),
    );
    expect(err.message).toContain("did not include successBodyField");
    expectNoSecret(err, password);

    // A non-JSON final page also fails the check (form mode, HTML answer).
    const html = await app(password, { noRedirect: true });
    const err2 = await expectSignInError(
      strategy.signIn({ profile: profileFor(html.baseUrl, { successBodyField: "token" }), secret: password, ttlMinutes: 30 }),
    );
    expect(err2.message).toContain("did not include successBodyField");
  });

  it("never puts the secret into the artifact, any session output format or whoami", async () => {
    const password = jsonThrowaway();
    const s = await jsonApp(password);
    const profile = jsonProfile(s.baseUrl, { successBodyField: "sessionToken" });
    const artifact = await strategy.signIn({ profile, secret: password, ttlMinutes: 30 });
    const who = await strategy.whoami!(artifact, undefined, profile);
    const outputs = [
      JSON.stringify(artifact),
      JSON.stringify(who),
      ...SESSION_FORMATS.map((f) => formatSession(artifact, f)),
    ];
    for (const out of outputs) {
      for (const form of secretForms(password)) expect(out).not.toContain(form);
    }
  });
});
