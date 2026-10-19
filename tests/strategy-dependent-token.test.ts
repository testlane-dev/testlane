import { randomBytes, randomInt } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExpiry } from "../src/strategies/dependent-token.js";
import { getStrategy, isSignInStrategy, type SignInContext } from "../src/strategies/index.js";
import { validateStrategyOptions } from "../src/strategies/options.js";
import { getProfile, loadProfiles } from "../src/profiles.js";
import { SignInError, type Profile, type SessionArtifact } from "../src/types.js";
import { startFakeDeviceExchange, type FakeDeviceExchange } from "./helpers/fake-device-exchange.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Throwaway digit PIN (default 8 digits so "not in the text" checks cannot collide with ports). */
const throwawayPin = (len = 8): string => Array.from({ length: len }, () => String(randomInt(0, 10))).join("");
/** Throwaway password-like secret with characters that need encoding in a form body. */
const throwawaySecret = (): string => `${randomBytes(18).toString("base64url")}$&+= %`;

async function expectSignInError(p: Promise<unknown>): Promise<SignInError> {
  const caught = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(SignInError);
  return caught as SignInError;
}

/**
 * Whether `stack` mentions `secret` as a token of its own. Stack frames carry
 * `:line:col` positions and bundler chunk hashes, so a short digit PIN such as
 * "547" could appear there by chance; positions are removed and the match must
 * not be glued to other letters or digits.
 */
function stackMentions(stack: string, secret: string): boolean {
  const withoutPositions = stack.replace(/:\d+:\d+/g, ":<pos>");
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`).test(withoutPositions);
}

function expectNoSecret(err: SignInError, ...secrets: string[]): void {
  for (const s of secrets) {
    expect(err.message).not.toContain(s);
    expect(stackMentions(String(err.stack), s), "secret in the stack").toBe(false);
    expect(JSON.stringify(err)).not.toContain(s);
  }
}

function silenceConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
}

// ---------------------------------------------------------------------------
// A generic "service session, then exchange" app on 127.0.0.1
// ---------------------------------------------------------------------------

interface ExchangeUser {
  code: string;
  email: string;
  secret: string;
  name: string;
  role: string;
}

interface ExchangeRequest {
  method: string;
  path: string;
  /** The request carried the dependency session (cookie or header). */
  dependency: boolean;
  contentType?: string;
  /** Body keys only, never values. */
  keys?: string[];
  auth?: "bearer" | "header" | "cookie" | "none";
}

type ExpiresFormat = "iso" | "seconds" | "ms" | "seconds-string" | "none";

interface ExchangeOptions {
  users: ExchangeUser[];
  /** What a successful exchange returns. */
  issue: "token" | "cookie";
  /** Server-side token lifetime; default 90 minutes. */
  tokenTtlSeconds?: number;
  expiresFormat?: ExpiresFormat;
  /** Header name accepted by /api/me besides "Authorization: Bearer". */
  tokenHeader?: string;
  /** Answer the exchange with this status instead. */
  forceStatus?: number;
}

interface FakeExchange {
  baseUrl: string;
  depCookie: { name: string; value: string };
  depHeader: { name: string; value: string };
  requests: ExchangeRequest[];
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

let servers: FakeExchange[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.restoreAllMocks();
});

async function startExchange(opts: ExchangeOptions): Promise<FakeExchange> {
  const depCookie = { name: "svc_session", value: randomBytes(24).toString("hex") };
  const depHeader = { name: "x-svc-key", value: randomBytes(24).toString("hex") };
  const ttl = opts.tokenTtlSeconds ?? 90 * 60;
  const tokens = new Map<string, { user: ExchangeUser; expiresMs: number }>();
  const requests: ExchangeRequest[] = [];
  let baseUrl = "";

  const expiresValue = (ms: number): unknown => {
    switch (opts.expiresFormat ?? "iso") {
      case "iso":
        return new Date(ms).toISOString();
      case "seconds":
        return Math.floor(ms / 1000);
      case "ms":
        return ms;
      case "seconds-string":
        return String(Math.floor(ms / 1000));
      case "none":
        return undefined;
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", baseUrl);
      const dependency =
        cookieValue(req.headers.cookie, depCookie.name) === depCookie.value ||
        req.headers[depHeader.name] === depHeader.value;

      if (req.method === "POST" && url.pathname === "/api/exchange") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        const contentType = String(req.headers["content-type"] ?? "");
        let body: Record<string, string> = {};
        if (contentType.startsWith("application/json")) {
          body = JSON.parse(raw) as Record<string, string>;
        } else {
          body = Object.fromEntries(new URLSearchParams(raw));
        }
        requests.push({ method: "POST", path: url.pathname, dependency, contentType, keys: Object.keys(body).sort() });
        if (opts.forceStatus !== undefined) {
          if (opts.forceStatus >= 300 && opts.forceStatus < 400) {
            res.writeHead(opts.forceStatus, { Location: "/login" });
            res.end();
          } else send(res, opts.forceStatus, { error: "forced" });
          return;
        }
        if (!dependency) return send(res, 401, { error: "service session required" });
        const user = opts.users.find(
          (u) => (body["code"] === u.code || body["email"] === u.email) && body["secret"] === u.secret,
        );
        if (user === undefined) return send(res, 401, { error: "invalid credentials" });
        const token = randomBytes(24).toString("hex");
        const expiresMs = Date.now() + ttl * 1000;
        tokens.set(token, { user, expiresMs });
        const exp = expiresValue(expiresMs);
        if (opts.issue === "token") {
          return send(res, 200, { data: { accessToken: token, ...(exp !== undefined ? { expires: exp } : {}) } });
        }
        return send(res, 200, exp !== undefined ? { expiresAt: exp } : { ok: true }, {
          "Set-Cookie": `user_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}`,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        let token: string | undefined;
        let auth: ExchangeRequest["auth"] = "none";
        const authz = req.headers.authorization;
        if (typeof authz === "string" && authz.startsWith("Bearer ")) {
          token = authz.slice(7);
          auth = "bearer";
        } else if (opts.tokenHeader !== undefined && typeof req.headers[opts.tokenHeader] === "string") {
          token = req.headers[opts.tokenHeader] as string;
          auth = "header";
        } else if (cookieValue(req.headers.cookie, "user_session") !== undefined) {
          token = cookieValue(req.headers.cookie, "user_session");
          auth = "cookie";
        }
        requests.push({ method: "GET", path: url.pathname, dependency, auth });
        const entry = token !== undefined ? tokens.get(token) : undefined;
        if (entry === undefined || entry.expiresMs <= Date.now()) return send(res, 401, { error: "no session" });
        const { user } = entry;
        return send(res, 200, {
          user: { email: user.email, name: user.name, accessToken: token },
          membership: { role: user.role },
        });
      }
      send(res, 404, { error: "not found" });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FakeExchange = {
    baseUrl,
    depCookie,
    depHeader,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  servers.push(fake);
  return fake;
}

const SERVICE = "demo:local:service";
const WORKER = "demo:local:worker";
const CODE = "W-0042";
const EMAIL = "worker@example.test";
const strategy = getStrategy("dependent-token");

const publicExamplePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "testlane.profiles.json");

function depProfile(baseUrl: string, options: Record<string, string> = {}, account: Partial<Profile["account"]> = {}): Profile {
  return {
    name: WORKER,
    app: "demo",
    environment: "sandbox",
    baseUrl,
    strategy: "dependent-token",
    account: { email: EMAIL, role: "Operator", identifier: CODE, ...account },
    session: { ttlMinutes: 60 },
    options: {
      dependsOn: SERVICE,
      tokenPath: "/api/exchange",
      fields: '{"code":"{{identifier}}","secret":"{{secret}}"}',
      tokenField: "data.accessToken",
      expiresAtField: "data.expires",
      mePath: "/api/me",
      emailField: "user.email",
      roleField: "membership.role",
      ...options,
    },
  };
}

function serviceArtifact(
  fake: Pick<FakeExchange, "baseUrl" | "depCookie">,
  opts: { expiresInMs?: number; cookieValue?: string; headers?: Record<string, string>; noCookie?: boolean } = {},
): SessionArtifact {
  const now = Date.now();
  const expiresInMs = opts.expiresInMs ?? 4 * 3600_000;
  const artifact: SessionArtifact = {
    profile: SERVICE,
    strategy: "form-post",
    baseUrl: fake.baseUrl,
    cookies: opts.noCookie
      ? []
      : [
          {
            name: fake.depCookie.name,
            value: opts.cookieValue ?? fake.depCookie.value,
            domain: new URL(fake.baseUrl).hostname,
            path: "/",
            expires: Math.floor((now + expiresInMs) / 1000),
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInMs).toISOString(),
  };
  if (opts.headers !== undefined) artifact.headers = opts.headers;
  return artifact;
}

function ctx(profile: Profile, secret: string, dep: SessionArtifact, extra: Partial<SignInContext> = {}): SignInContext {
  return { profile, secret, ttlMinutes: 60, sessionFor: vi.fn(async () => dep), ...extra };
}

function user(secret: string): ExchangeUser {
  return { code: CODE, email: EMAIL, secret, name: "Line Worker", role: "Operator" };
}

// ---------------------------------------------------------------------------
// Options schema (load time)
// ---------------------------------------------------------------------------

describe("dependent-token options schema", () => {
  const good = {
    dependsOn: SERVICE,
    tokenPath: "/api/exchange",
    bodyFormat: "form",
    fields: '{"code":"{{identifier}}","email":"{{email}}","secret":"{{secret}}","device":"line-3"}',
    secretPattern: "^\\d{4,8}$",
    tokenField: "data.accessToken",
    tokenHeader: "x-worker-token",
    expiresAtField: "data.expires",
    mePath: "/api/me",
    emailField: "user.email",
    roleField: "membership.role",
  };

  it("accepts the documented keys, and sessionCookieName instead of tokenField", () => {
    expect(validateStrategyOptions("dependent-token", good).success).toBe(true);
    const { tokenField: _t, tokenHeader: _h, ...rest } = good;
    void _t;
    void _h;
    expect(validateStrategyOptions("dependent-token", { ...rest, sessionCookieName: "user_session" }).success).toBe(true);
    // Required-to-sign-in keys stay optional at load (like form-post).
    expect(validateStrategyOptions("dependent-token", {}).success).toBe(true);
  });

  it("rejects unknown, unsafe or inconsistent options, naming the key", () => {
    const cases: [Record<string, string>, string][] = [
      [{ unknownOption: SERVICE }, ""],
      [{ dependsOn: "Not A Profile" }, "dependsOn"],
      [{ tokenPath: "https://attacker.example.net/x" }, "tokenPath"],
      [{ tokenPath: "//attacker.example.net/x" }, "tokenPath"],
      [{ mePath: "/me?x=1" }, "mePath"],
      [{ bodyFormat: "xml" }, "bodyFormat"],
      [{ fields: '{"code":"{{identifier}}"}' }, "fields"],
      [{ fields: '{"secret":"{{secret}}","x":"{{newSecret}}"}' }, "fields"],
      [{ fields: '["{{secret}}"]' }, "fields"],
      [{ secretPattern: "([0-9]" }, "secretPattern"],
      [{ secretPattern: "a".repeat(257) }, "secretPattern"],
      [{ tokenField: ".token" }, "tokenField"],
      [{ tokenField: "accessToken", tokenHeader: "Cookie" }, "tokenHeader"],
      [{ tokenField: "accessToken", tokenHeader: "content-length" }, "tokenHeader"],
      [{ tokenField: "accessToken", tokenHeader: "bad header" }, "tokenHeader"],
      [{ tokenHeader: "x-token" }, "tokenHeader"],
      [{ tokenField: "accessToken", sessionCookieName: "sid" }, "sessionCookieName"],
      [{ expiresAtField: "a..b" }, "expiresAtField"],
    ];
    for (const [options, key] of cases) {
      const result = validateStrategyOptions("dependent-token", options);
      expect(result.success, JSON.stringify(options)).toBe(false);
      if (!result.success && key !== "") {
        expect(result.error.issues.map((i) => i.path.join("."))).toContain(key);
      }
    }
  });

  it("is a sign-in strategy", () => {
    expect(isSignInStrategy("dependent-token")).toBe(true);
    expect(getStrategy("dependent-token").name).toBe("dependent-token");
  });
});

describe("parseExpiry (unit autodetection)", () => {
  it("reads ISO strings, unix seconds and unix milliseconds", () => {
    const ms = Date.UTC(2031, 0, 2, 3, 4, 5);
    expect(parseExpiry(new Date(ms).toISOString())).toBe(ms);
    expect(parseExpiry(ms / 1000)).toBe(ms);
    expect(parseExpiry(ms)).toBe(ms);
    expect(parseExpiry(String(ms / 1000))).toBe(ms);
    expect(parseExpiry(String(ms))).toBe(ms);
    expect(parseExpiry(ms / 1000 + 0.5)).toBe(ms + 500);
    for (const bad of [undefined, null, "", "soon", -5, 0, Number.NaN, {}, true]) {
      expect(parseExpiry(bad), String(bad)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

describe("dependent-token sign-in", () => {
  it("JSON body, tokenField -> Authorization: Bearer, with the dependency cookie", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const c = ctx(depProfile(s.baseUrl), secret, serviceArtifact(s));
    const logs = silenceConsole();
    const artifact = await strategy.signIn(c);

    expect(c.sessionFor).toHaveBeenCalledWith(SERVICE);
    expect(artifact.strategy).toBe("dependent-token");
    expect(artifact.profile).toBe(WORKER);
    expect(artifact.headers).toEqual({ Authorization: expect.stringMatching(/^Bearer [0-9a-f]{48}$/) });
    expect(artifact.cookies.map((k) => [k.name, k.value])).toEqual([[s.depCookie.name, s.depCookie.value]]);
    expect(s.requests).toEqual([
      {
        method: "POST",
        path: "/api/exchange",
        dependency: true,
        contentType: "application/json",
        keys: ["code", "secret"],
      },
    ]);
    const span = Date.parse(artifact.expiresAt) - Date.parse(artifact.issuedAt);
    expect(span).toBeLessThanOrEqual(60 * 60_000);
    expect(JSON.stringify(artifact)).not.toContain(secret);
    expect(JSON.stringify(s.requests)).not.toContain(secret);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("form body, tokenHeader carries the raw token under the exact name", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token", tokenHeader: "x-worker-token" });
    const profile = depProfile(s.baseUrl, {
      bodyFormat: "form",
      fields: '{"email":"{{email}}","secret":"{{secret}}"}',
      tokenHeader: "x-worker-token",
    });
    const artifact = await strategy.signIn(ctx(profile, secret, serviceArtifact(s)));
    expect(artifact.headers).toEqual({ "x-worker-token": expect.stringMatching(/^[0-9a-f]{48}$/) });
    expect(s.requests[0]).toMatchObject({ contentType: "application/x-www-form-urlencoded", keys: ["email", "secret"] });

    const who = await strategy.whoami!(artifact, undefined, profile);
    expect(who).toMatchObject({ email: EMAIL, role: "Operator" });
    expect(s.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/me", auth: "header" });
  });

  it("sessionCookieName mode captures the cookie next to the dependency cookie, bounded by its Max-Age", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "cookie", tokenTtlSeconds: 300, expiresFormat: "none" });
    const profile = depProfile(s.baseUrl, { tokenField: "", expiresAtField: "", sessionCookieName: "user_session" });
    const artifact = await strategy.signIn(ctx(profile, secret, serviceArtifact(s)));
    expect(artifact.headers).toBeUndefined();
    expect(artifact.cookies.map((k) => k.name).sort()).toEqual(["svc_session", "user_session"]);
    const span = Date.parse(artifact.expiresAt) - Date.parse(artifact.issuedAt);
    expect(span).toBeLessThanOrEqual(301_000);
    expect(span).toBeGreaterThan(290_000);
    for (const c of artifact.cookies) expect(c.expires).toBe(Math.floor(Date.parse(artifact.expiresAt) / 1000));
    expect(JSON.stringify(artifact)).not.toContain(secret);

    const who = await strategy.whoami!(artifact, undefined, profile);
    expect(who).toMatchObject({ email: EMAIL, name: "Line Worker", role: "Operator" });
    expect(s.requests.at(-1)).toMatchObject({ auth: "cookie" });
  });

  it("sessionCookieName mode fails when the response sets no such cookie", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const profile = depProfile(s.baseUrl, { tokenField: "", sessionCookieName: "user_session" });
    const err = await expectSignInError(strategy.signIn(ctx(profile, secret, serviceArtifact(s))));
    expect(err.message).toContain("did not set the session cookie (expected user_session)");
    expectNoSecret(err, secret);
  });

  for (const format of ["iso", "seconds", "ms", "seconds-string"] as const) {
    it(`bounds expiresAt by expiresAtField given as ${format}`, async () => {
      const secret = throwawaySecret();
      const s = await startExchange({ users: [user(secret)], issue: "token", tokenTtlSeconds: 120, expiresFormat: format });
      const artifact = await strategy.signIn(ctx(depProfile(s.baseUrl), secret, serviceArtifact(s)));
      const span = Date.parse(artifact.expiresAt) - Date.parse(artifact.issuedAt);
      expect(span).toBeLessThanOrEqual(121_000);
      expect(span).toBeGreaterThan(110_000);
    });
  }

  it("expiresAtField also applies in cookie mode, and the dependency session bounds everything", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "cookie", tokenTtlSeconds: 3600, expiresFormat: "seconds" });
    const profile = depProfile(s.baseUrl, { tokenField: "", sessionCookieName: "user_session", expiresAtField: "expiresAt" });
    const dep = serviceArtifact(s, { expiresInMs: 90_000 });
    const artifact = await strategy.signIn(ctx(profile, secret, dep));
    expect(Date.parse(artifact.expiresAt)).toBeLessThanOrEqual(Date.parse(dep.expiresAt));
  });

  it("forwards the dependency's headers (a header-only dependency session works)", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const dep = serviceArtifact(s, {
      noCookie: true,
      headers: { [s.depHeader.name]: s.depHeader.value, Cookie: "ignored=1", "Content-Length": "1" },
    });
    const artifact = await strategy.signIn(ctx(depProfile(s.baseUrl), secret, dep));
    expect(s.requests[0]?.dependency).toBe(true);
    expect(Object.keys(artifact.headers ?? {}).sort()).toEqual(["Authorization", s.depHeader.name]);
    expect(artifact.cookies).toEqual([]);
  });

  it("refuses a secret that does not match secretPattern before any request, without echoing it", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const base = "http://127.0.0.1:9";
    const profile = depProfile(base, { secretPattern: "^\\d{4,8}$" });
    for (const bad of ["123", "123456789", "12a4", " 1234", "", "１２３４", throwawaySecret()]) {
      const c = ctx(profile, bad, serviceArtifact({ baseUrl: base, depCookie: { name: "a", value: "b" } }), {
        fetchImpl: fetchSpy,
      });
      const err = await expectSignInError(strategy.signIn(c));
      expect(err.message).toBe("secret does not match profile option secretPattern");
      if (bad !== "") expectNoSecret(err, bad);
      expect(c.sessionFor).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a secret that matches secretPattern", async () => {
    const credential = throwawayPin(6);
    const s = await startExchange({ users: [user(credential)], issue: "token" });
    const artifact = await strategy.signIn(ctx(depProfile(s.baseUrl, { secretPattern: "^\\d{4,8}$" }), credential, serviceArtifact(s)));
    expect(artifact.headers?.["Authorization"]).toMatch(/^Bearer /);
  });

  it("runs the committed fictional dependent-token example without secret output", async () => {
    const registry = await loadProfiles({
      repoFile: publicExamplePath,
      userFile: path.join(path.dirname(publicExamplePath), ".testlane-public-example-no-user.json"),
      overridesFile: path.join(path.dirname(publicExamplePath), ".testlane-public-example-no-overrides.json"),
    });
    const documented = getProfile(registry, "acme:testing:reader");
    const credential = throwawaySecret();
    const serviceCookie = { name: "next-auth.session-token", value: randomBytes(24).toString("hex") };
    const exchange = await startFakeDeviceExchange({
      users: [
        {
          subject: documented.account.identifier ?? "missing",
          credential,
          name: "Example Test Member",
          role: documented.account.role,
          email: documented.account.email,
        },
      ],
      dependencyCookie: serviceCookie,
    });
    const profile = { ...documented, baseUrl: exchange.baseUrl };
    const dependency = serviceArtifact({ baseUrl: exchange.baseUrl, depCookie: serviceCookie });
    const logs = silenceConsole();
    try {
      const artifact = await strategy.signIn(ctx(profile, credential, dependency));
      expect(artifact.headers?.["x-device-access"]).toMatch(/^[0-9a-f]{48}$/);
      expect(exchange.requests).toEqual([
        { method: "POST", path: "/api/device/exchange", dependency: true, identifier: "subject" },
      ]);
      expect(JSON.stringify(artifact)).not.toContain(credential);

      const who = await strategy.whoami!(artifact, undefined, profile);
      expect(who).toMatchObject({ email: documented.account.email, role: documented.account.role });
      expect(JSON.stringify(who)).not.toContain(artifact.headers?.["x-device-access"] ?? "<none>");
      expect(exchange.requests).toHaveLength(2);
      for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    } finally {
      await exchange.close();
    }
  });

  it("maps a wrong secret (401) to SignInError without echoing either secret or logging", async () => {
    const secret = throwawaySecret();
    const wrong = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const logs = silenceConsole();
    const err = await expectSignInError(strategy.signIn(ctx(depProfile(s.baseUrl), wrong, serviceArtifact(s))));
    expect(err.status).toBe(401);
    expect(err.credentialsRejected).toBe(false);
    expect(err.message).toBe(`token sign-in rejected by ${new URL(s.baseUrl).host} (secret, account or dependency session)`);
    expectNoSecret(err, secret, wrong);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("maps 403, redirects and other errors without the secret", async () => {
    for (const [status, text] of [
      [403, `dependency session for ${SERVICE} may not use tokenPath`],
      [302, "redirected (302); the dependency session is probably not valid"],
      [500, "returned 500"],
    ] as const) {
      const secret = throwawaySecret();
      const s = await startExchange({ users: [user(secret)], issue: "token", forceStatus: status });
      const err = await expectSignInError(strategy.signIn(ctx(depProfile(s.baseUrl), secret, serviceArtifact(s))));
      expect(err.message).toContain(text);
      expect(err.status).toBe(status);
      expectNoSecret(err, secret);
    }
  });

  it("refuses a token that cannot go into a header", async () => {
    const secret = throwawaySecret();
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: { accessToken: "has space\r\nX-Evil: 1" } }), { status: 200 }),
    );
    const base = "http://127.0.0.1:9";
    const err = await expectSignInError(
      strategy.signIn(
        ctx(depProfile(base), secret, serviceArtifact({ baseUrl: base, depCookie: { name: "a", value: "b" } }), {
          fetchImpl,
        }),
      ),
    );
    expect(err.message).toContain("did not return a usable token");
    expect(err.message).not.toContain("Evil");
  });

  it("refuses bad configuration before any request or dependency sign-in", async () => {
    const secret = throwawaySecret();
    const base = "http://127.0.0.1:9";
    const noCode = depProfile(base);
    delete noCode.account.identifier;
    const cases: [Profile, string, "no-sessionFor"?][] = [
      [depProfile(base, { dependsOn: "" }), "dependsOn is required"],
      [depProfile(base, { dependsOn: WORKER }), "must name a different profile"],
      [depProfile(base, { dependsOn: "Bad Name" }), "dependsOn must be a profile name"],
      [depProfile(base, { tokenPath: "" }), "tokenPath is required"],
      [depProfile(base, { tokenPath: "https://attacker.example.net/x" }), "tokenPath"],
      [depProfile(base, { mePath: "//attacker.example.net/me" }), "mePath"],
      [depProfile(base, { fields: "" }), "fields is required"],
      [depProfile(base, { fields: '{"code":"{{identifier}}"}' }), "must contain the {{secret}} placeholder"],
      [depProfile(base, { bodyFormat: "xml" }), "bodyFormat"],
      [depProfile(base, { secretPattern: "([0-9]" }), "secretPattern must be a valid regular expression"],
      [depProfile(base, { sessionCookieName: "sid" }), "mutually exclusive"],
      [depProfile(base, { tokenField: "" }), "exactly one of the profile options tokenField / sessionCookieName"],
      [depProfile(base, { tokenHeader: "Cookie" }), "tokenHeader must be a valid, non-reserved"],
      [depProfile(base, { tokenField: "", tokenHeader: "x-t", sessionCookieName: "sid" }), "tokenHeader requires tokenField"],
      [noCode, "has no account.identifier"],
      [depProfile(base), "no sessionFor provided", "no-sessionFor"],
    ];
    for (const [profile, expected, flag] of cases) {
      const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
      const c = ctx(profile, secret, serviceArtifact({ baseUrl: base, depCookie: { name: "a", value: "b" } }), {
        fetchImpl: fetchSpy,
      });
      if (flag === "no-sessionFor") delete c.sessionFor;
      const err = await expectSignInError(strategy.signIn(c));
      expect(err.message, expected).toContain(expected);
      expect(err.message).not.toContain("attacker");
      expectNoSecret(err, secret);
      expect(fetchSpy).not.toHaveBeenCalled();
      if (c.sessionFor !== undefined) expect(c.sessionFor).not.toHaveBeenCalled();
    }
  });

  it("does not need account.identifier when fields do not use it", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const profile = depProfile(s.baseUrl, { fields: '{"email":"{{email}}","secret":"{{secret}}"}' }, {});
    delete profile.account.identifier;
    const artifact = await strategy.signIn(ctx(profile, secret, serviceArtifact(s)));
    expect(artifact.headers?.["Authorization"]).toBeDefined();
  });

  it("refuses a dependency session from another origin, or one with nothing for this host, without sending the secret", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const elsewhere = serviceArtifact({ baseUrl: "http://localhost:9", depCookie: s.depCookie });
    let err = await expectSignInError(strategy.signIn(ctx(depProfile(s.baseUrl), secret, elsewhere)));
    expect(err.message).toContain("is not on the profile origin");
    err = await expectSignInError(strategy.signIn(ctx(depProfile(s.baseUrl), secret, serviceArtifact(s, { noCookie: true }))));
    expect(err.message).toContain("has no cookie or header for");
    expect(s.requests).toHaveLength(0);
  });

  it("propagates a failure of the dependency session unchanged", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const boom = new SignInError("credentials rejected by dependency host", 401);
    const c = ctx(depProfile(s.baseUrl), secret, serviceArtifact(s), {
      sessionFor: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(strategy.signIn(c)).rejects.toBe(boom);
    expect(s.requests).toHaveLength(0);
  });

  it("whoami reports email, name and role without the token; needs mePath and the token header", async () => {
    const secret = throwawaySecret();
    const s = await startExchange({ users: [user(secret)], issue: "token" });
    const profile = depProfile(s.baseUrl);
    const artifact = await strategy.signIn(ctx(profile, secret, serviceArtifact(s)));
    const who = await strategy.whoami!(artifact, undefined, profile);
    expect(who).toMatchObject({ email: EMAIL, name: "Line Worker", role: "Operator" });
    const token = (artifact.headers?.["Authorization"] ?? "<none>").slice(7);
    expect(JSON.stringify(who)).not.toContain(token);
    expect(who.raw).toEqual({ user: { email: EMAIL, name: "Line Worker" }, membership: { role: "Operator" } });
    expect(s.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/me", auth: "bearer" });

    const { headers: _drop, ...bare } = artifact;
    void _drop;
    await expect(strategy.whoami!(bare, undefined, profile)).rejects.toThrow("no Authorization header");
    await expect(strategy.whoami!(artifact, undefined, depProfile(s.baseUrl, { mePath: "" }))).rejects.toThrow(
      "without profile option mePath",
    );
    await expect(strategy.whoami!(artifact)).rejects.toThrow("without profile option mePath");
  });
});

describe("leak-check helper", () => {
  it("ignores stack positions and chunk hashes but still catches a leaked short PIN", () => {
    expect(stackMentions("SignInError: x\n    at f (file.test.ts:547:23)", "547")).toBe(false);
    expect(stackMentions("SignInError: x\n    at g (chunk-B547aZ.js:12:5)", "547")).toBe(false);
    expect(stackMentions("SignInError: PIN 547 rejected\n    at f (file.test.ts:1:2)", "547")).toBe(true);
    expect(stackMentions("SignInError: credential=547\n    at f (file.test.ts:1:2)", "547")).toBe(true);
    expect(stackMentions("SignInError: secret a$b+c leaked", "a$b+c")).toBe(true);
  });
});
