import { randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAuditTail } from "../src/audit.js";
import type { CommandDeps } from "../src/commands.js";
import { MemoryNonceStore, verifyHandoffCode } from "../src/handoff.js";
import {
  DEFAULT_PORT,
  DROPPED_HEADERS_HEADER,
  MAX_BODY_BYTES,
  httpTokenPath,
  logPath,
  startServer,
  type RunningServer,
} from "../src/serve.js";
import { assertValidStoreKey, type SecretStore } from "../src/store/index.js";
import type { Profile, ProfileRegistry } from "../src/types.js";
import { putProfileSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";
import { createDeviceExchangeRoutes } from "./helpers/fake-device-exchange.js";

/** In-memory SecretStore; keys validated like the real adapters. Never logs values. */
class InMemoryStore implements SecretStore {
  readonly kind = "memory";
  readonly #data = new Map<string, string>();
  gets = 0;
  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    this.gets += 1;
    return this.#data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    assertValidStoreKey(key);
    this.#data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    assertValidStoreKey(key);
    return this.#data.delete(key);
  }
  async list(): Promise<string[]> {
    return [...this.#data.keys()].sort();
  }
}

interface Reply {
  status: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

interface CallOptions {
  method?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  /** false = omit the Authorization header; a string = use that bearer. Default: the server token. */
  bearer?: string | false;
  /** Send the body chunked (no Content-Length). */
  chunked?: boolean;
}

const ENV_KEYS = ["TESTLANE_HOME", "TESTLANE_PROFILES", "TESTLANE_REQUESTER"] as const;
const EMAIL = "agent.sandbox@fake.test";
const SANDBOX = "fake:sandbox";
const NOSECRET = "fake:nosecret";
const PROD = "fake:prod";
const HANDOFF = "fake:handoff";

let savedEnv: Record<string, string | undefined> = {};
let home = "";
let password = "";
let handoffSecret = "";
let store: InMemoryStore;
let fake: FakeNextAuth;
let registry: ProfileRegistry;
let server: RunningServer | null = null;
let logLines: string[] = [];

function profile(name: string, overrides: Partial<Profile>): Profile {
  return {
    name,
    app: "fake-app",
    environment: "sandbox",
    baseUrl: fake.baseUrl,
    strategy: "nextauth-credentials",
    account: { email: EMAIL, role: "Declared-Role" },
    session: { ttlMinutes: 60 },
    ...overrides,
  };
}

function must(name: string): Profile {
  const p = registry.profiles[name];
  if (p === undefined) throw new Error(`fixture: ${name}`);
  return p;
}

async function boot(extra: { token?: string } = {}): Promise<RunningServer> {
  const deps = async (): Promise<CommandDeps> => ({ store, registry, requester: "http" });
  const opts: Parameters<typeof startServer>[0] = { port: 0, deps, log: (line) => void logLines.push(line) };
  if (extra.token !== undefined) opts.token = extra.token;
  server = await startServer(opts);
  return server;
}

function call(srv: RunningServer, urlPath: string, opts: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { Host: `127.0.0.1:${srv.port}`, ...opts.headers };
  const bearer = opts.bearer === undefined ? srv.token : opts.bearer;
  if (bearer !== false) headers["Authorization"] = `Bearer ${bearer}`;
  const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
  if (body !== undefined && opts.chunked !== true) headers["Content-Length"] = String(body.length);
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: srv.port, path: urlPath, method: opts.method ?? "GET", headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      if (opts.chunked === true) {
        // Several writes so the server sees the overflow mid-stream.
        const step = 16 * 1024;
        for (let i = 0; i < body.length; i += step) req.write(body.subarray(i, i + step));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

function postJson(srv: RunningServer, urlPath: string, json: unknown, opts: CallOptions = {}): Promise<Reply> {
  return call(srv, urlPath, {
    ...opts,
    method: "POST",
    body: JSON.stringify(json),
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
}

function json(r: Reply): Record<string, unknown> {
  return JSON.parse(r.body) as Record<string, unknown>;
}

function everything(r: Reply): string {
  return `${r.status} ${r.statusMessage}\n${r.rawHeaders.join("\n")}\n${r.body}`;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-serve-"));
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
  delete process.env["TESTLANE_REQUESTER"];

  password = randomBytes(18).toString("base64url");
  handoffSecret = randomBytes(24).toString("base64url");
  store = new InMemoryStore();
  logLines = [];
  fake = await startFakeNextAuth({ users: [{ email: EMAIL, password, role: "App-Role" }] });

  const entries = [
    profile(SANDBOX, {}),
    profile(NOSECRET, {}),
    profile(PROD, {
      environment: "production",
      baseUrl: "https://prod.example.test",
    }),
    profile(HANDOFF, {
      strategy: "app-handoff",
      baseUrl: "https://sandbox.handoff.test",
    }),
  ];
  registry = { version: 1, profiles: Object.fromEntries(entries.map((p) => [p.name, p])), sources: ["inline"] };
  await putProfileSecret(store, must(SANDBOX), password);
  await putProfileSecret(store, must(HANDOFF), handoffSecret);
});

afterEach(async () => {
  if (server !== null) await server.close();
  server = null;
  await fake.close();
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("serve: binding and token file", () => {
  it("binds to 127.0.0.1 and writes the token file, removed on close", async () => {
    const srv = await boot();
    // Port 0 binds a free (non-default) port, so the token file is per port.
    expect(srv.port).not.toBe(DEFAULT_PORT);
    expect(srv.tokenFile).toBe(path.join(home, `http-token-${srv.port}`));
    expect(srv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await fs.readFile(srv.tokenFile, "utf8")).toBe(srv.token);
    if (process.platform !== "win32") {
      expect((await fs.stat(srv.tokenFile)).mode & 0o777).toBe(0o600);
    }

    // The server answers on 127.0.0.1 with the bearer.
    const r = await call(srv, "/healthz");
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: true });
    expect(r.headers["cache-control"]).toBe("no-store");

    await srv.close();
    server = null;
    await expect(fs.stat(srv.tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a 127.0.0.1 socket address", async () => {
    const srv = await boot();
    const local = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: srv.port,
          path: "/healthz",
          headers: { Authorization: `Bearer ${srv.token}` },
          agent: false,
        },
        (res) => {
          const addr = res.socket.remoteAddress ?? "";
          res.resume();
          res.on("end", () => resolve(addr));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(local).toBe("127.0.0.1");
  });

  it("uses http-token for the default port and http-token-<port> otherwise", () => {
    expect(httpTokenPath()).toBe(path.join(home, "http-token"));
    expect(httpTokenPath(DEFAULT_PORT)).toBe(path.join(home, "http-token"));
    expect(httpTokenPath(5000)).toBe(path.join(home, "http-token-5000"));
  });

  it("generates a fresh token per boot", async () => {
    const a = await boot();
    const first = a.token;
    await a.close();
    const b = await boot();
    expect(b.token).not.toBe(first);
  });
});

describe("serve: request guards", () => {
  it("401 without a bearer, with a wrong bearer, and with a wrong-length bearer; the app is never contacted", async () => {
    const srv = await boot();
    const wrongSameLength = srv.token.slice(0, -1) + (srv.token.endsWith("A") ? "B" : "A");
    for (const bearer of [false, wrongSameLength, "short", `${srv.token}x`] as const) {
      const r = await postJson(srv, "/session", { profile: SANDBOX }, { bearer });
      expect(r.status).toBe(401);
      expect(json(r)).toEqual({ error: "unauthorized" });
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    const noScheme = await call(srv, "/profiles", { bearer: false, headers: { Authorization: srv.token } });
    expect(noScheme.status).toBe(401);
    expect(fake.requests).toHaveLength(0);
    expect(store.gets).toBe(0);
  });

  it("403 for any request carrying an Origin header, even with the bearer", async () => {
    const srv = await boot();
    for (const origin of [`http://127.0.0.1:${srv.port}`, "https://evil.example", "null"]) {
      const r = await postJson(srv, "/session", { profile: SANDBOX }, { headers: { Origin: origin } });
      expect(r.status).toBe(403);
      expect(json(r)).toEqual({ error: "forbidden" });
    }
    const pre = await call(srv, "/session", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(pre.status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it("403 for a foreign Host header (DNS rebinding), accepts localhost and bare hosts", async () => {
    const srv = await boot();
    for (const host of ["evil.example", `evil.example:${srv.port}`, "127.0.0.1:1", "[::1]", `0.0.0.0:${srv.port}`]) {
      const r = await call(srv, "/profiles", { headers: { Host: host } });
      expect(r.status).toBe(403);
      expect(json(r)).toEqual({ error: "forbidden" });
    }
    for (const host of ["localhost", `localhost:${srv.port}`, "127.0.0.1", `LOCALHOST:${srv.port}`]) {
      const r = await call(srv, "/healthz", { headers: { Host: host } });
      expect(r.status).toBe(200);
    }
  });

  it("413 for an oversized body (declared and chunked)", async () => {
    const srv = await boot();
    const big = JSON.stringify({ profile: SANDBOX, pad: "x".repeat(MAX_BODY_BYTES + 10) });
    const declared = await call(srv, "/session", {
      method: "POST",
      body: big,
      headers: { "Content-Type": "application/json" },
    });
    expect(declared.status).toBe(413);
    expect(json(declared)).toMatchObject({ code: 1 });

    const chunked = await call(srv, "/session", {
      method: "POST",
      body: big,
      chunked: true,
      headers: { "Content-Type": "application/json" },
    });
    expect(chunked.status).toBe(413);
    expect(fake.requests).toHaveLength(0);
  });

  it("415 for a non-JSON content type and 400 for malformed JSON or an invalid body", async () => {
    const srv = await boot();
    const text = await call(srv, "/session", {
      method: "POST",
      body: `profile=${SANDBOX}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(text.status).toBe(415);
    const none = await call(srv, "/check", { method: "POST", body: "{}" });
    expect(none.status).toBe(415);

    const bad = await call(srv, "/session", {
      method: "POST",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
    expect(json(bad)).toMatchObject({ code: 1 });

    const unknownKey = await postJson(srv, "/session", { profile: SANDBOX, password: "hunter2-x" });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body).not.toContain("hunter2-x");
    const badFormat = await postJson(srv, "/session", { profile: SANDBOX, format: "evil-format" });
    expect(badFormat.status).toBe(400);
    expect(badFormat.body).not.toContain("evil-format");
    expect(fake.requests).toHaveLength(0);
  });

  it("404 for /store, /store/set and unknown routes; never a store operation", async () => {
    const srv = await boot();
    for (const p of ["/store", "/store/set", "/store/delete", "/store/list"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const r =
          method === "GET"
            ? await call(srv, p)
            : await call(srv, p, {
                method,
                body: JSON.stringify({ profile: SANDBOX, secret: "never-stored" }),
                headers: { "Content-Type": "application/json" },
              });
        expect(r.status).toBe(404);
        expect(r.headers["cache-control"]).toBe("no-store");
      }
    }
    expect((await call(srv, "/nope")).status).toBe(404);
    expect((await call(srv, "/session")).status).toBe(404); // GET on a POST route
    expect(await store.list()).toEqual([`agent-auth/${HANDOFF}`, `agent-auth/${SANDBOX}`]);
  });
});

describe("serve: routes", () => {
  it("GET /profiles lists profiles and sources", async () => {
    const srv = await boot();
    const r = await call(srv, "/profiles");
    expect(r.status).toBe(200);
    const body = json(r) as { profiles: { name: string }[]; sources: string[] };
    expect(body.profiles.map((p) => p.name)).toEqual([HANDOFF, NOSECRET, PROD, SANDBOX]);
    expect(body.sources).toEqual(["inline"]);
  });

  it("POST /session returns the cookie header as text/plain and audits it; the password never appears", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: SANDBOX });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    expect(r.headers["x-agent-auth-profile"]).toBe(SANDBOX);
    expect(r.headers["x-agent-auth-format"]).toBe("cookie");
    expect(Number.isNaN(Date.parse(String(r.headers["x-agent-auth-expires"])))).toBe(false);

    const all = everything(r);
    expect(all).not.toContain(password);
    expect(all).not.toContain("[REDACTED]");

    const { rows } = await readAuditTail(10);
    const row = rows.find((x) => x.event === "session");
    expect(row).toMatchObject({ event: "session", profile: SANDBOX, ok: true, format: "cookie", requester: "http" });

    // The request log carries method, path, status and ms only.
    const line = logLines.find((l) => l.includes("/session"));
    expect(line).toMatch(/^testlane serve: POST \/session 200 \d+(\.\d+)?ms\n$/);
    for (const l of logLines) {
      expect(l).not.toContain(password);
      expect(l).not.toContain(srv.token);
      expect(l).not.toContain("session-token");
    }
  });

  it("logs only the pathname: never the host, userinfo or query of an absolute-form target", async () => {
    expect(logPath("http://someone:hunter@evil.example.test/x/y?token=abc")).toBe("/x/y");
    expect(logPath("//someone:hunter@evil.example.test/x?q=1")).toBe("/x");
    expect(logPath("/healthz?token=abc#frag")).toBe("/healthz");
    expect(logPath(undefined)).toBe("/");

    const srv = await boot();
    const marker = randomBytes(6).toString("hex");
    const r = await call(srv, `http://user${marker}:pw${marker}@127.0.0.1:${srv.port}/healthz?q=${marker}`);
    expect(r.status).toBe(200);
    const line = logLines.find((l) => l.includes("/healthz"));
    expect(line).toMatch(/^testlane serve: GET \/healthz 200 \d+(\.\d+)?ms\n$/);
    for (const l of logLines) expect(l).not.toContain(marker);
  });

  it("POST /session honours format and ttlMinutes", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: SANDBOX, format: "storage-state", ttlMinutes: 5 });
    expect(r.status).toBe(200);
    expect(r.headers["x-agent-auth-format"]).toBe("storage-state");
    const state = JSON.parse(r.body) as { cookies: unknown[] };
    expect(state.cookies).toHaveLength(1);
    expect(everything(r)).not.toContain(password);

    const tooLong = await postJson(srv, "/session", { profile: SANDBOX, ttlMinutes: 10_000 });
    expect(tooLong.status).toBe(403);
    expect(json(tooLong)).toMatchObject({ code: 2 });
  });

  it("POST /session format json returns application/json with a documented, stable shape; audits like other formats", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: SANDBOX, format: "json" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-agent-auth-format"]).toBe("json");
    expect(r.headers[DROPPED_HEADERS_HEADER.toLowerCase()]).toBeUndefined();
    const body = json(r) as {
      profile: string;
      format: string;
      expiresAt: string;
      headers: Record<string, string>;
      droppedHeaders: string[];
    };
    expect(Object.keys(body).sort()).toEqual(["droppedHeaders", "expiresAt", "format", "headers", "profile"]);
    expect(body.profile).toBe(SANDBOX);
    expect(body.format).toBe("json");
    expect(body.expiresAt).toBe(r.headers["x-agent-auth-expires"]);
    expect(body.droppedHeaders).toEqual([]);
    expect(Object.keys(body.headers)).toEqual(["Cookie"]);
    expect(body.headers["Cookie"]).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    expect(everything(r)).not.toContain(password);

    const { rows } = await readAuditTail(10);
    const row = rows.find((x) => x.event === "session");
    expect(row).toMatchObject({ event: "session", profile: SANDBOX, ok: true, format: "json", requester: "http" });
  });

  it("POST /session for a production profile is refused with 403 code 2, no request, audit 'refused'", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: PROD });
    expect(r.status).toBe(403);
    const body = json(r);
    expect(body["code"]).toBe(2);
    expect(String(body["error"])).toContain("production");
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(fake.requests).toHaveLength(0);
    expect(store.gets).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "refused", profile: PROD, ok: false, reason: "production-refused" });
  });

  it("POST /session with no stored secret is 409 code 4", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: NOSECRET });
    expect(r.status).toBe(409);
    expect(json(r)).toMatchObject({ code: 4 });
    expect(fake.requests).toHaveLength(0);
  });

  it("POST /session for an unknown profile is 403 code 2", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: "fake:unknown" });
    expect(r.status).toBe(403);
    expect(json(r)).toMatchObject({ code: 2 });
  });

  it("POST /session with a wrong password is 502 code 3 without leaking it", async () => {
    await putProfileSecret(store, must(SANDBOX), `${password}-wrong`);
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: SANDBOX });
    expect(r.status).toBe(502);
    expect(json(r)).toMatchObject({ code: 3 });
    expect(everything(r)).not.toContain(password);
    expect(r.body).not.toMatch(/stack|at .*\.ts:/);
  });

  it("POST /session with a secret bound to another origin is 409 code 6", async () => {
    registry.profiles[SANDBOX] = { ...must(SANDBOX), baseUrl: fake.baseUrl.replace("127.0.0.1", "localhost") };
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: SANDBOX });
    expect(r.status).toBe(409);
    expect(json(r)).toMatchObject({ code: 6 });
    expect(fake.requests).toHaveLength(0);
  });

  it("POST /check reports identity only", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/check", { profile: SANDBOX });
    expect(r.status).toBe(200);
    const body = json(r);
    expect(body).toMatchObject({ profile: SANDBOX, ok: true, email: EMAIL });
    expect(r.body).not.toContain("session-token");
    expect(everything(r)).not.toContain(password);
  });

  it("POST /handoff returns a one-time URL whose code verifies with the same secret", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/handoff", { profile: HANDOFF });
    expect(r.status).toBe(200);
    const body = json(r) as { url: string; expiresAt: string; profile: string };
    expect(body.profile).toBe(HANDOFF);
    expect(body.url.startsWith("https://sandbox.handoff.test/api/auth/agent-handoff?code=")).toBe(true);
    expect(everything(r)).not.toContain(handoffSecret);

    const code = new URL(body.url).searchParams.get("code") ?? "";
    const res = await verifyHandoffCode({ code, secret: handoffSecret, nonceStore: new MemoryNonceStore() });
    expect(res.ok && res.profileName).toBe(HANDOFF);

    const { rows } = await readAuditTail(10);
    expect(rows.some((x) => x.event === "handoff" && x.profile === HANDOFF && x.ok)).toBe(true);
  });

  it("resolves deps fresh per request", async () => {
    let calls = 0;
    const srv = await startServer({
      port: 0,
      deps: async () => {
        calls += 1;
        return { store, registry, requester: "http" };
      },
      log: () => undefined,
    });
    server = srv;
    await call(srv, "/profiles");
    await call(srv, "/profiles");
    expect(calls).toBe(2);
  });
});

describe("serve: exchange-credential artifacts and identity mismatch", () => {
  const SERVICE = "fake:service";
  const EXCHANGE = "fake:exchange";
  const EXCHANGE_ODD = "fake:exchange-odd";
  const SERVICE_EMAIL = "service@example.invalid";
  const WORKER_EMAIL = "member@example.invalid";
  let exchangeFake: FakeNextAuth;
  let servicePassword = "";
  let credential = "";

  beforeEach(async () => {
    servicePassword = randomBytes(18).toString("base64url");
    credential = Array.from({ length: 8 }, () => String(randomInt(0, 10))).join("");
    const exchange = createDeviceExchangeRoutes({
      users: [
        { subject: "member-qa", credential, name: "Test Member", role: "Member", email: WORKER_EMAIL },
        { subject: "member-other", credential, name: "Odd Agent", role: "Member", email: "someone.else@example.invalid" },
      ],
      isDependency: (cookie) => exchangeFake.sessionUserFor(cookie)?.permissions?.includes("EXCHANGE_ACCESS") === true,
    });
    exchangeFake = await startFakeNextAuth({
      users: [{ email: SERVICE_EMAIL, password: servicePassword, name: "Service", role: "Service", permissions: ["EXCHANGE_ACCESS"] }],
      extraRoutes: (req, res, url) => exchange.handle(req, res, url),
    });
    const exchangeProfile = (name: string, subject: string): Profile =>
      profile(name, {
        baseUrl: exchangeFake.baseUrl,
        strategy: "dependent-token",
        account: { email: WORKER_EMAIL, role: "Member", identifier: subject },
        options: {
          dependsOn: SERVICE,
          tokenPath: "/api/device/exchange",
          fields: '{"subject":"{{identifier}}","credential":"{{secret}}"}',
          tokenField: "accessToken",
          tokenHeader: "x-device-access",
          expiresAtField: "expiresAt",
          mePath: "/api/device/identity",
          emailField: "subject.email",
          roleField: "subject.role",
        },
      });
    const extra = [
      profile(SERVICE, { baseUrl: exchangeFake.baseUrl, account: { email: SERVICE_EMAIL, role: "Service" } }),
      exchangeProfile(EXCHANGE, "member-qa"),
      exchangeProfile(EXCHANGE_ODD, "member-other"),
    ];
    registry = { ...registry, profiles: { ...registry.profiles, ...Object.fromEntries(extra.map((p) => [p.name, p])) } };
    await putProfileSecret(store, must(SERVICE), servicePassword);
    await putProfileSecret(store, must(EXCHANGE), credential);
    await putProfileSecret(store, must(EXCHANGE_ODD), credential);
  });

  afterEach(async () => {
    await exchangeFake.close();
  });

  it("names dropped artifact headers (never values) for cookie-only formats", async () => {
    const srv = await boot();
    for (const format of ["cookie", "storage-state", "curl"]) {
      const r = await postJson(srv, "/session", { profile: EXCHANGE, format });
      expect(r.status).toBe(200);
      expect(r.headers[DROPPED_HEADERS_HEADER.toLowerCase()]).toBe("x-device-access");
      expect(r.body).not.toContain("x-device-access");
      // No exchange token (48 hex) anywhere once the service cookie value is set aside.
      expect(everything(r).replace(/[0-9a-f]{64}/g, "")).not.toMatch(/[0-9a-f]{48}/);
      expect(everything(r)).not.toContain(servicePassword);
    }
    const h = await postJson(srv, "/session", { profile: EXCHANGE, format: "headers" });
    expect(h.status).toBe(200);
    expect(h.headers[DROPPED_HEADERS_HEADER.toLowerCase()]).toBeUndefined();
    expect(h.body).toMatch(/^x-device-access: [0-9a-f]{48}$/m);

    // A cookie-only artifact carries no such header.
    const plain = await postJson(srv, "/session", { profile: SANDBOX });
    expect(plain.headers[DROPPED_HEADERS_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("format json carries the extra header too (no dropped-headers response header), like --format headers", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/session", { profile: EXCHANGE, format: "json" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers[DROPPED_HEADERS_HEADER.toLowerCase()]).toBeUndefined();
    const body = json(r) as { headers: Record<string, string>; droppedHeaders: string[] };
    expect(Object.keys(body.headers)).toEqual(["Cookie", "x-device-access"]);
    expect(body.headers["x-device-access"]).toMatch(/^[0-9a-f]{48}$/);
    expect(body.droppedHeaders).toEqual([]);
    expect(everything(r)).not.toContain(servicePassword);
    expect(everything(r)).not.toContain(credential);
  });

  it("POST /check with an identity mismatch is 502 { error, code: 3 }", async () => {
    const srv = await boot();
    const r = await postJson(srv, "/check", { profile: EXCHANGE_ODD });
    expect(r.status).toBe(502);
    const body = json(r);
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(body["code"]).toBe(3);
    expect(String(body["error"])).toContain(`different identity (expected ${WORKER_EMAIL})`);
    expect(String(body["error"])).not.toContain("someone.else");
    expect(everything(r)).not.toContain(credential);

    const ok = await postJson(srv, "/check", { profile: EXCHANGE });
    expect(ok.status).toBe(200);
    expect(json(ok)).toMatchObject({ ok: true, email: WORKER_EMAIL });
  });
});

describe("serve: app-handoff session and check (the broker consumes the handoff URL)", () => {
  const LIVE = "fake:handoff-live";
  const REFUSED = "fake:handoff-refused";
  let handoffFake: FakeNextAuth;
  let liveSecret = "";

  beforeEach(async () => {
    liveSecret = randomBytes(32).toString("base64url");
    handoffFake = await startFakeNextAuth({
      users: [{ email: EMAIL, password: randomBytes(18).toString("base64url"), role: "App-Role" }],
      handoff: { secret: liveSecret, profiles: { [LIVE]: EMAIL, [REFUSED]: EMAIL } },
    });
    const handoffProfile = (name: string): Profile =>
      profile(name, {
        baseUrl: handoffFake.baseUrl,
        strategy: "app-handoff",
        options: { mePath: "/api/auth/session", emailField: "user.email" },
      });
    const extra = [handoffProfile(LIVE), handoffProfile(REFUSED)];
    registry = { ...registry, profiles: { ...registry.profiles, ...Object.fromEntries(extra.map((p) => [p.name, p])) } };
    await putProfileSecret(store, must(LIVE), liveSecret);
    // A secret the app does not share: its route answers the bare 404.
    await putProfileSecret(store, must(REFUSED), randomBytes(32).toString("base64url"));
  });

  afterEach(async () => {
    await handoffFake.close();
  });

  function expectNoHandoffMaterial(text: string): void {
    expect(text).not.toContain(liveSecret);
    expect(text).not.toContain("code=");
    expect(text).not.toContain("agent-handoff");
    for (const code of handoffFake.handoffCodes) expect(text).not.toContain(code);
  }

  it("POST /session returns the handoff route's session cookie, never the URL; POST /check confirms the identity", async () => {
    const srv = await boot();
    for (const format of ["cookie", "headers"]) {
      const r = await postJson(srv, "/session", { profile: LIVE, format });
      expect(r.status).toBe(200);
      expect(r.body).toMatch(/next-auth\.session-token=[0-9a-f]{64}$/);
      expect(r.headers["x-agent-auth-profile"]).toBe(LIVE);
      expect(r.headers[DROPPED_HEADERS_HEADER.toLowerCase()]).toBeUndefined();
      expectNoHandoffMaterial(everything(r));
    }
    const c = await postJson(srv, "/check", { profile: LIVE });
    expect(c.status).toBe(200);
    expect(json(c)).toMatchObject({ profile: LIVE, ok: true, email: EMAIL });
    expect(c.body).not.toContain("session-token");
    expect(handoffFake.handoffOutcomes).toEqual(["ok", "ok", "ok"]);
    for (const line of logLines) expectNoHandoffMaterial(line);

    const { rows } = await readAuditTail(20);
    expect(rows.map((x) => [x.event, x.profile, x.requester, x.reason ?? null])).toEqual([
      ["handoff", LIVE, "http", "consumed-by-broker"],
      ["session", LIVE, "http", null],
      ["handoff", LIVE, "http", "consumed-by-broker"],
      ["session", LIVE, "http", null],
      ["handoff", LIVE, "http", "consumed-by-broker"],
      ["check", LIVE, "http", null],
    ]);
  });

  it("a route that refuses the code is 502 { error, code: 3 } for /session and /check", async () => {
    const srv = await boot();
    for (const route of ["/session", "/check"]) {
      const r = await postJson(srv, route, { profile: REFUSED });
      expect(r.status).toBe(502);
      expect(json(r)).toMatchObject({ code: 3 });
      expect(String(json(r)["error"])).toContain("answered 404 instead of a redirect");
      expectNoHandoffMaterial(everything(r));
    }
  });
});

describe("serve: GET /status", () => {
  it("returns per-profile metadata and alerts, never a value; production is not read", async () => {
    const srv = await boot();
    store.gets = 0;
    const r = await call(srv, "/status");
    expect(r.status).toBe(200);
    const body = json(r) as { alerting: boolean; profiles: Array<Record<string, unknown> & { profile: string }> };
    const by = Object.fromEntries(body.profiles.map((p) => [p.profile, p]));
    expect(by[SANDBOX]).toMatchObject({ hasSecret: true, ageDays: 0, alerts: [] });
    expect(by[NOSECRET]).toMatchObject({ hasSecret: false, alerts: ["no-secret"] });
    expect(by[PROD]).toMatchObject({ hasSecret: false, alerts: [] });
    expect(body.alerting).toBe(true);
    // SANDBOX, NOSECRET and HANDOFF are read; PROD never is.
    expect(store.gets).toBe(3);
    expect(everything(r)).not.toContain(password);
    expect(everything(r)).not.toContain(handoffSecret);
    expect(fake.requests).toHaveLength(0);
  });

  it("accepts ?maxAgeDays=n and refuses other or invalid query parameters without echoing them", async () => {
    const srv = await boot();
    const ok = await call(srv, "/status?maxAgeDays=30");
    expect(ok.status).toBe(200);
    const probe = `zz${randomBytes(6).toString("hex")}`;
    for (const q of [`?maxAgeDays=${probe}`, "?maxAgeDays=0", "?maxAgeDays=1&maxAgeDays=2", `?${probe}=1`]) {
      const r = await call(srv, `/status${q}`);
      expect(r.status).toBe(400);
      expect(json(r)["code"]).toBe(1);
      expect(r.body).not.toContain(probe);
    }
    // The request log never carries the query string.
    expect(logLines.join("")).not.toContain("maxAgeDays");
  });

  it("a store read error for one profile becomes a store-error alert without detail (200, not 500)", async () => {
    const failing = new (class extends InMemoryStore {
      override async get(key: string): Promise<string | null> {
        if (key.endsWith(NOSECRET)) throw new Error("simulated store failure at C:\\private\\path");
        return super.get(key);
      }
    })();
    for (const k of await store.list()) {
      const v = await store.get(k);
      if (v !== null) await failing.set(k, v);
    }
    store = failing;
    const srv = await boot();
    const r = await call(srv, "/status");
    expect(r.status).toBe(200);
    const body = json(r) as { profiles: Array<{ profile: string; alerts: string[] }> };
    expect(body.profiles.find((p) => p.profile === NOSECRET)?.alerts).toEqual(["store-error"]);
    expect(body.profiles.find((p) => p.profile === SANDBOX)?.alerts).toEqual([]);
    expect(r.body).not.toContain("simulated");
    expect(r.body).not.toContain("private");
  });

  it("has no rotate endpoint", async () => {
    const srv = await boot();
    for (const [method, p] of [["POST", "/rotate"], ["GET", "/rotate"]] as const) {
      const r = await call(srv, p, { method });
      expect(r.status).toBe(404);
    }
  });
});
