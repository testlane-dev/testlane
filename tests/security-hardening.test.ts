/**
 * Pre-release security review findings (W2): redaction on every output path,
 * canonical allowedHosts, production overlap on the merged registry and in
 * `store set`, the *.localhost exemption, and control characters.
 *
 * Everything here uses acme:* profile names and *.test hosts. Every secret is
 * generated at test time; the "app" is a fetch double, never a real host.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAuditRow, readAuditTail } from "../src/audit.js";
import { buildProgram } from "../src/cli.js";
import { assertStorable, storeSet, type CommandDeps } from "../src/commands.js";
import { resolveCommandDeps } from "../src/deps.js";
import { CookieJar, parseSetCookie } from "../src/http/cookie-jar.js";
import { createMcpServer } from "../src/mcp.js";
import { assertAllowed, canonicalHostEntry, hostnameOf, isAllowedHost } from "../src/policy.js";
import { loadProfiles, parseRegistry, productionHosts } from "../src/profiles.js";
import { redactor, redactValue } from "../src/redact.js";
import { startServer, type RunningServer } from "../src/serve.js";
import { SESSION_FORMATS, type SessionFormat } from "../src/session/format.js";
import type { SecretStore } from "../src/store/index.js";
import { toCurlJar } from "../src/session/curl-jar.js";
import { PolicyError, type AuditRow, type Profile, type ProfileRegistry } from "../src/types.js";
import { putProfileSecret } from "../src/vault.js";
import { MemoryStore } from "./helpers/memory-store.js";

const EMAIL = "agent@acme.test";
const APP = "https://app.acme.test";
const SANDBOX = "acme:sandbox:echo";

const savedHome = process.env["TESTLANE_HOME"];
const savedProfiles = process.env["TESTLANE_PROFILES"];
let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-hardening-"));
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  if (savedProfiles === undefined) delete process.env["TESTLANE_PROFILES"];
  else process.env["TESTLANE_PROFILES"] = savedProfiles;
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catchPolicy(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return err as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

async function catchPolicyAsync(p: Promise<unknown>): Promise<PolicyError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return err as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "acme:sandbox:x",
    app: "acme-app",
    environment: "sandbox",
    baseUrl: "https://sandbox.acme.test",
    strategy: "form-post",
    account: { email: EMAIL, role: "Member" },
    session: { ttlMinutes: 60 },
    ...overrides,
  };
}

function productionProfile(overrides: Partial<Profile> = {}): Profile {
  return profile({
    name: "acme:production",
    environment: "production",
    baseUrl: "https://prod.acme.test",
    account: { email: "", role: "" },
    session: { ttlMinutes: 0 },
    ...overrides,
  });
}

function registryOf(...profiles: Profile[]): ProfileRegistry {
  return { version: 1, profiles: Object.fromEntries(profiles.map((p) => [p.name, p])), sources: ["inline"] };
}

/** A registry-file entry (JSON shape). */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: "acme-app",
    environment: "sandbox",
    baseUrl: "https://sandbox.acme.test",
    strategy: "form-post",
    account: { email: EMAIL, role: "Member" },
    session: { ttlMinutes: 60 },
    ...overrides,
  };
}

function prodEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return entry({
    environment: "production",
    baseUrl: "https://prod.acme.test",
    account: { email: "", role: "" },
    session: { ttlMinutes: 0 },
    ...overrides,
  });
}

async function writeJson(file: string, value: unknown): Promise<string> {
  await fs.writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

class Capture extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    cb();
  }
  get text(): string {
    return this.chunks.join("");
  }
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  deps: { store?: SecretStore; fetchImpl?: typeof fetch },
  stdin?: string | Readable,
): Promise<CliResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const injected: Partial<CommandDeps> & { cwd?: string } = { cwd: home };
  if (deps.store !== undefined) injected.store = deps.store;
  if (deps.fetchImpl !== undefined) injected.fetchImpl = deps.fetchImpl;
  const program = buildProgram({
    deps: injected,
    stdin: stdin instanceof Readable ? stdin : Readable.from(stdin === undefined ? [] : [stdin]),
    stdout,
    stderr,
    isTTY: false,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  });
  let code = 0;
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (err instanceof ExitCalled) code = err.code;
    else if (err instanceof CommanderError) code = err.exitCode;
    else throw err;
  }
  return { code, stdout: stdout.text, stderr: stderr.text };
}

// ---------------------------------------------------------------------------
// 1. Redaction on every output path
// ---------------------------------------------------------------------------

/**
 * An app that "remembers" the user by echoing the submitted password back in a
 * cookie, and reflects it in /me. `fetchImpl` is the whole network.
 */
function echoApp(password: string, opts: { roleIsPassword?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/login" && init?.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("password") !== password) return new Response("no", { status: 401 });
      const headers = new Headers();
      headers.append("set-cookie", `sid=${randomBytes(16).toString("hex")}; Path=/; Secure; HttpOnly`);
      headers.append("set-cookie", `remember=${password}; Path=/; Secure`);
      return new Response("ok", { status: 200, headers });
    }
    if (url.pathname === "/me") {
      return Response.json({ email: EMAIL, role: opts.roleIsPassword === true ? password : "Member" });
    }
    return new Response("not found", { status: 404 });
  };
}

function secretForms(secret: string): string[] {
  return [
    secret,
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
    encodeURIComponent(secret),
  ];
}

function expectNoSecret(text: string, secret: string): void {
  for (const form of secretForms(secret)) expect(text).not.toContain(form);
}

describe("redaction on every output path", () => {
  let password = "";
  let store: MemoryStore;
  let profilesFile = "";

  async function setup(overrides: { role?: string } = {}): Promise<void> {
    password = randomBytes(18).toString("base64url");
    store = new MemoryStore();
    profilesFile = await writeJson(path.join(home, "repo.profiles.json"), {
      version: 1,
      profiles: {
        [SANDBOX]: entry({
          baseUrl: APP,
          account: { email: EMAIL, role: overrides.role ?? "Member" },
          options: {
            loginPath: "/login",
            fields: '{"email":"{{email}}","password":"{{secret}}"}',
            sessionCookieName: "sid",
            primeCookies: "false",
            mePath: "/me",
          },
        }),
      },
    });
    const reg = await loadProfiles({ cwd: home, repoFile: profilesFile });
    const p = reg.profiles[SANDBOX];
    if (p === undefined) throw new Error("fixture");
    await putProfileSecret(store, p, password);
  }

  const cliRun = (fetchImpl: typeof fetch, args: string[]): Promise<CliResult> =>
    runCli(["--profiles", profilesFile, ...args], { store, fetchImpl });

  async function mcpCall(
    fetchImpl: typeof fetch,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; structured: unknown; wire: string }> {
    const server = createMcpServer({
      deps: () => resolveCommandDeps({ profilesFile, cwd: home, requester: "mcp", store, fetchImpl }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const wire: string[] = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, options) => {
      wire.push(JSON.stringify(message));
      return send(message, options);
    };
    const client = new Client({ name: "hardening-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
      };
      return { text: r.content[0]?.text ?? "", structured: r.structuredContent, wire: wire.join("\n") };
    } finally {
      await client.close();
    }
  }

  interface HttpReply {
    status: number;
    body: string;
    headers: string;
  }
  interface HttpClient {
    get(p: string): Promise<HttpReply>;
    post(p: string, body: unknown): Promise<HttpReply>;
  }

  async function withHttp(fetchImpl: typeof fetch, run: (http: HttpClient) => Promise<void>): Promise<void> {
    const srv: RunningServer = await startServer({
      port: 0,
      log: () => undefined,
      deps: () => resolveCommandDeps({ profilesFile, cwd: home, requester: "http", store, fetchImpl }),
    });
    const call = async (method: string, p: string, body?: unknown): Promise<HttpReply> => {
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${srv.token}`, "Content-Type": "application/json" },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(`http://127.0.0.1:${srv.port}${p}`, init);
      const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      return { status: res.status, body: await res.text(), headers };
    };
    try {
      await run({ get: (p) => call("GET", p), post: (p, body) => call("POST", p, body) });
    } finally {
      await srv.close();
    }
  }

  it.each(SESSION_FORMATS)(
    "a secret echoed in a cookie is [REDACTED] on CLI stdout, --out, MCP and HTTP (%s)",
    async (format: SessionFormat) => {
      await setup();
      const fetchImpl = echoApp(password);
      const outFile = path.join(home, `session.${format}`);

      const stdout = await cliRun(fetchImpl, ["session", SANDBOX, "--format", format]);
      expect(stdout.code).toBe(0);
      expect(stdout.stdout).toContain("[REDACTED]");
      expectNoSecret(stdout.stdout + stdout.stderr, password);

      const written = await cliRun(fetchImpl, ["session", SANDBOX, "--format", format, "--out", outFile]);
      expect(written.code).toBe(0);
      const fileText = await fs.readFile(outFile, "utf8");
      expect(fileText).toContain("[REDACTED]");
      expectNoSecret(fileText, password);
      expectNoSecret(written.stdout + written.stderr, password);

      const mcp = await mcpCall(fetchImpl, "session", { profile: SANDBOX, format });
      expect(mcp.text).toContain("[REDACTED]");
      expectNoSecret(mcp.text, password);
      expectNoSecret(JSON.stringify(mcp.structured), password);
      expectNoSecret(mcp.wire, password);

      await withHttp(fetchImpl, async ({ post }) => {
        const r = await post("/session", { profile: SANDBOX, format });
        expect(r.status).toBe(200);
        expect(r.body).toContain("[REDACTED]");
        expectNoSecret(r.body, password);
        expectNoSecret(r.headers, password);
      });
    },
  );

  it("keeps the redacted json and storage-state artifacts parseable on every surface", async () => {
    await setup();
    const fetchImpl = echoApp(password);
    const outFile = path.join(home, "session.json.out");

    await cliRun(fetchImpl, ["session", SANDBOX, "--format", "json", "--out", outFile]);
    const fromFile = JSON.parse(await fs.readFile(outFile, "utf8")) as { headers: { Cookie: string } };
    expect(fromFile.headers.Cookie).toMatch(/; remember=\[REDACTED\]$/);

    const mcp = await mcpCall(fetchImpl, "session", { profile: SANDBOX, format: "storage-state" });
    const state = JSON.parse(mcp.text) as { cookies: Array<{ name: string; value: string }> };
    expect(state.cookies.find((c) => c.name === "remember")?.value).toBe("[REDACTED]");

    await withHttp(fetchImpl, async ({ post }) => {
      const r = await post("/session", { profile: SANDBOX, format: "json" });
      expect(r.headers).toMatch(/content-type: application\/json/);
      const body = JSON.parse(r.body) as { headers: { Cookie: string } };
      expect(body.headers.Cookie).toMatch(/; remember=\[REDACTED\]$/);
      const curl = await post("/session", { profile: SANDBOX, format: "curl" });
      expect(curl.body).toMatch(/\tremember\t\[REDACTED\]\n/);
    });
  });

  const DEVICE = "acme:sandbox:device";
  const WORKER = "acme:sandbox:worker";

  /** A device (form-post) profile plus a dependent-token worker; both secrets are stored. Returns the worker's key. */
  async function setupDependent(): Promise<string> {
    password = randomBytes(18).toString("base64url");
    const key = randomBytes(32).toString("hex");
    store = new MemoryStore();
    profilesFile = await writeJson(path.join(home, "dependent.profiles.json"), {
      version: 1,
      profiles: {
        [DEVICE]: entry({
          baseUrl: APP,
          options: {
            loginPath: "/login",
            fields: '{"email":"{{email}}","password":"{{secret}}"}',
            sessionCookieName: "sid",
            primeCookies: "false",
          },
        }),
        [WORKER]: entry({
          baseUrl: APP,
          strategy: "dependent-token",
          options: {
            dependsOn: DEVICE,
            tokenPath: "/token",
            fields: '{"key":"{{secret}}"}',
            tokenField: "token",
            expiresAtField: "expiresAt",
            mePath: "/me",
            emailField: "email",
            roleField: "role",
          },
        }),
      },
    });
    const reg = await loadProfiles({ cwd: home, repoFile: profilesFile });
    for (const [name, secret] of [
      [DEVICE, password],
      [WORKER, key],
    ] as const) {
      const p = reg.profiles[name];
      if (p === undefined) throw new Error("fixture");
      await putProfileSecret(store, p, secret);
    }
    return key;
  }

  /** The token endpoint answers `token` for the right key; /me reports `role` (default "Member"). */
  function dependentApp(key: string, token: string, role = "Member"): typeof fetch {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/login" && init?.method === "POST") {
        const headers = new Headers({ "set-cookie": `sid=${randomBytes(16).toString("hex")}; Path=/; Secure; HttpOnly` });
        return new Response("ok", { status: 200, headers });
      }
      if (url.pathname === "/token" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { key?: string };
        if (body.key !== key) return new Response("no", { status: 401 });
        return Response.json({ token, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (url.pathname === "/me") return Response.json({ email: EMAIL, role });
      return new Response("not found", { status: 404 });
    };
  }

  it.each(["headers", "json"] as const)(
    "a dependent-token exchange whose tokenField echoes the stored key is [REDACTED] on every surface (%s)",
    async (format) => {
      const key = await setupDependent();
      const worker = WORKER;
      // The token endpoint answers with the key it was given: the exchange "echoes" it.
      const fetchImpl = dependentApp(key, key);
      const outFile = path.join(home, "worker.out");

      const stdout = await cliRun(fetchImpl, ["session", worker, "--format", format]);
      expect(stdout.code).toBe(0);
      expect(stdout.stdout).toMatch(/Authorization: Bearer \[REDACTED\]|"Authorization": "Bearer \[REDACTED\]"/);
      expectNoSecret(stdout.stdout + stdout.stderr, key);

      expect((await cliRun(fetchImpl, ["session", worker, "--format", format, "--out", outFile])).code).toBe(0);
      const fileText = await fs.readFile(outFile, "utf8");
      expect(fileText).toContain("Bearer [REDACTED]");
      expectNoSecret(fileText, key);

      const mcp = await mcpCall(fetchImpl, "session", { profile: worker, format });
      expect(mcp.text).toContain("Bearer [REDACTED]");
      expectNoSecret(mcp.text + mcp.wire, key);

      await withHttp(fetchImpl, async ({ post }) => {
        const r = await post("/session", { profile: worker, format });
        expect(r.status).toBe(200);
        expect(r.body).toContain("Bearer [REDACTED]");
        expectNoSecret(r.body + r.headers, key);
      });
    },
  );

  it("an app that reflects the secret as the account role never gets it through check", async () => {
    await setup();
    const fetchImpl = echoApp(password, { roleIsPassword: true });

    const cli = await cliRun(fetchImpl, ["check", SANDBOX]);
    expect(cli.code).toBe(0);
    expectNoSecret(cli.stdout + cli.stderr, password);

    const mcp = await mcpCall(fetchImpl, "check", { profile: SANDBOX });
    expectNoSecret(mcp.text, password);
    expectNoSecret(JSON.stringify(mcp.structured), password);
    expectNoSecret(mcp.wire, password);

    await withHttp(fetchImpl, async ({ post }) => {
      const r = await post("/check", { profile: SANDBOX });
      expect(r.status).toBe(200);
      expectNoSecret(r.body, password);
    });
  });

  describe("check keeps session material off the process-wide redactor", () => {
    /**
     * An app that sets a random session cookie next to ordinary, stable cookies
     * (a callback URL, a locale); every session cookie it issues goes into `issued`.
     * With `roleFromSession`, /me reports the caller's session cookie as the role.
     */
    function plainCookieApp(pw: string, issued: string[], opts: { roleFromSession?: boolean } = {}): typeof fetch {
      return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/login" && init?.method === "POST") {
          if (new URLSearchParams(String(init.body)).get("password") !== pw) return new Response("no", { status: 401 });
          const sid = randomBytes(16).toString("hex");
          issued.push(sid);
          const headers = new Headers();
          headers.append("set-cookie", `sid=${sid}; Path=/; Secure; HttpOnly`);
          headers.append("set-cookie", `callback-url=${APP}; Path=/; Secure`);
          headers.append("set-cookie", "locale=en-GB; Path=/; Secure");
          return new Response("ok", { status: 200, headers });
        }
        if (url.pathname === "/me") {
          const cookie = new Headers(init?.headers).get("cookie") ?? "";
          const sid = /(?:^|; )sid=([^;]+)/.exec(cookie)?.[1] ?? "none";
          return Response.json({ email: EMAIL, role: opts.roleFromSession === true ? sid : "Member" });
        }
        return new Response("not found", { status: 404 });
      };
    }

    it("after a check, later session artifacts and the profiles list keep ordinary cookie values and the baseUrl", async () => {
      await setup();
      const fetchImpl = plainCookieApp(password, []);
      const expected = /sid=[0-9a-f]{32}; callback-url=https:\/\/app\.acme\.test; locale=en-GB/;

      await withHttp(fetchImpl, async ({ get, post }) => {
        expect((await post("/check", { profile: SANDBOX })).status).toBe(200);
        const session = await post("/session", { profile: SANDBOX });
        expect(session.body).toMatch(expected);
        const profiles = JSON.parse((await get("/profiles")).body) as { profiles: Array<{ baseUrl: string }> };
        expect(profiles.profiles[0]?.baseUrl).toBe(APP);
      });
      expect((await mcpCall(fetchImpl, "session", { profile: SANDBOX })).text).toMatch(expected);
      expect((await cliRun(fetchImpl, ["session", SANDBOX])).stdout).toMatch(expected);
      expect((await cliRun(fetchImpl, ["profiles"])).stdout).toContain(APP);
      expect(redactor.redact(`${APP} en-GB`)).toBe(`${APP} en-GB`);
    });

    it("repeated checks do not grow the registered set", async () => {
      await setup();
      const fetchImpl = plainCookieApp(password, []);
      expect((await cliRun(fetchImpl, ["check", SANDBOX])).code).toBe(0);
      const before = redactor.count;
      for (let i = 0; i < 3; i++) await mcpCall(fetchImpl, "check", { profile: SANDBOX });
      await withHttp(fetchImpl, async ({ post }) => {
        for (let i = 0; i < 3; i++) await post("/check", { profile: SANDBOX });
      });
      expect(redactor.count).toBe(before);
    });

    it("a role that echoes the session cookie is still redacted in check output on CLI, MCP and HTTP", async () => {
      await setup();
      const issued: string[] = [];
      const fetchImpl = plainCookieApp(password, issued, { roleFromSession: true });
      const leaked = (text: string): boolean => issued.some((sid) => secretForms(sid).some((f) => text.includes(f)));

      const cli = await cliRun(fetchImpl, ["check", SANDBOX]);
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain("role=[REDACTED] (app)");
      expect(leaked(cli.stdout + cli.stderr)).toBe(false);

      const mcp = await mcpCall(fetchImpl, "check", { profile: SANDBOX });
      expect(mcp.structured).toMatchObject({ ok: true, role: "[REDACTED]", roleSource: "app" });
      expect(leaked(mcp.text + JSON.stringify(mcp.structured) + mcp.wire)).toBe(false);

      await withHttp(fetchImpl, async ({ post }) => {
        const r = await post("/check", { profile: SANDBOX });
        expect(JSON.parse(r.body)).toMatchObject({ ok: true, role: "[REDACTED]", roleSource: "app" });
        expect(leaked(r.body)).toBe(false);
      });
      expect(issued.length).toBeGreaterThanOrEqual(3);
    });

    it("a role that echoes the bearer token is still redacted in check output on CLI, MCP and HTTP", async () => {
      const key = await setupDependent();
      const token = randomBytes(24).toString("hex");
      const fetchImpl = dependentApp(key, token, token);

      const cli = await cliRun(fetchImpl, ["check", WORKER]);
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain("role=[REDACTED] (app)");
      expectNoSecret(cli.stdout + cli.stderr, token);

      const mcp = await mcpCall(fetchImpl, "check", { profile: WORKER });
      expect(mcp.structured).toMatchObject({ ok: true, role: "[REDACTED]", roleSource: "app" });
      expectNoSecret(mcp.text + JSON.stringify(mcp.structured) + mcp.wire, token);

      await withHttp(fetchImpl, async ({ post }) => {
        const r = await post("/check", { profile: WORKER });
        expect(JSON.parse(r.body)).toMatchObject({ ok: true, role: "[REDACTED]", roleSource: "app" });
        expectNoSecret(r.body, token);
      });
    });
  });

  it("redacts JSON bodies and MCP structuredContent as a whole, not only the session text", async () => {
    // Contrived but direct: a registry field that equals a stored secret must not
    // leave the broker on /profiles, whatever route it takes.
    await setup();
    const fetchImpl = echoApp(password);
    await writeJson(profilesFile, {
      version: 1,
      profiles: {
        [SANDBOX]: entry({
          baseUrl: APP,
          account: { email: EMAIL, role: password },
          options: {
            loginPath: "/login",
            fields: '{"email":"{{email}}","password":"{{secret}}"}',
            sessionCookieName: "sid",
          },
        }),
      },
    });
    redactor.register(password);

    await withHttp(fetchImpl, async ({ get }) => {
      const r = await get("/profiles");
      expect(r.status).toBe(200);
      expect(r.body).toContain("[REDACTED]");
      expectNoSecret(r.body, password);
      // Still valid JSON: redaction touched string values only.
      expect(() => JSON.parse(r.body)).not.toThrow();
    });

    const mcp = await mcpCall(fetchImpl, "list_profiles", {});
    expectNoSecret(JSON.stringify(mcp.structured), password);
    expectNoSecret(mcp.text, password);
  });

  it("HTTP error bodies stay redacted", async () => {
    await setup();
    const fetchImpl = echoApp(password);
    const hexHost = randomBytes(12).toString("hex");
    redactor.register(hexHost);
    await withHttp(fetchImpl, async ({ post }) => {
      const r = await post("/session", { profile: SANDBOX, target: `https://${hexHost}.acme.test/` });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain(hexHost);
    });
  });

  it("redactValue redacts string values, never keys, and keeps non-strings intact", () => {
    const secret = randomBytes(12).toString("hex");
    redactor.register(secret);
    const out = redactValue({ [secret]: 1, a: `x ${secret} y`, list: [secret, 2, true, null], n: { deep: secret } });
    expect(out).toEqual({ [secret]: 1, a: "x [REDACTED] y", list: ["[REDACTED]", 2, true, null], n: { deep: "[REDACTED]" } });
  });
});

// ---------------------------------------------------------------------------
// 2. allowedHosts canonicalisation
// ---------------------------------------------------------------------------

describe("allowedHosts are canonicalised like baseUrl hosts", () => {
  it.each([
    ["10.0.0.5", "10.0.0.5"],
    ["[::ffff:10.0.0.5]", "[::ffff:a00:5]"],
    ["[::FFFF:A00:5]:8443", "[::ffff:a00:5]:8443"],
    ["[2001:db8:0:0::1]", "[2001:db8::1]"],
    ["[2001:0db8:0000:0000:0000:0000:0000:0001]", "[2001:db8::1]"],
    ["127.1", "127.0.0.1"],
    ["127.1:3000", "127.0.0.1:3000"],
    ["2130706433", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["APP.Acme.TEST", "app.acme.test"],
    ["app.acme.test.", "app.acme.test"],
    ["app.acme.test:08443", "app.acme.test:8443"],
    ["[::1]:3000", "[::1]:3000"],
  ])("canonicalHostEntry(%s) is %s", (input, expected) => {
    expect(canonicalHostEntry(input)).toBe(expected);
  });

  it.each([
    "",
    "[1.2.3.4]",
    "[:::]",
    "999.1.1.1",
    "1.2.3.4.5",
    "256.1.1.1",
    "app.acme.test:0",
    "app.acme.test:65536",
    "app.acme.test/path",
    "user@app.acme.test",
    "https://app.acme.test",
    "app acme.test",
    "a|b.test",
  ])("canonicalHostEntry(%j) is null", (input) => {
    expect(canonicalHostEntry(input)).toBeNull();
  });

  it("hostnameOf compares canonical forms, folding an IPv4-mapped IPv6 literal onto its IPv4 address", () => {
    expect(hostnameOf("[::ffff:10.0.0.5]:8443")).toBe("10.0.0.5");
    expect(hostnameOf("[::ffff:a00:5]")).toBe("10.0.0.5");
    expect(hostnameOf("[2001:db8:0:0::1]")).toBe("[2001:db8::1]");
    expect(hostnameOf("127.1")).toBe("127.0.0.1");
    expect(hostnameOf("PROD.Acme.Test.")).toBe("prod.acme.test");
    expect(hostnameOf("10.0.0.5")).toBe("10.0.0.5");
  });

  type Side = { baseUrl?: string; allowedHosts?: string[] };
  const overlapping: Array<[string, Side, Side]> = [
    ["IPv4-mapped IPv6, same spelling", { allowedHosts: ["[::ffff:10.0.0.5]"] }, { baseUrl: "https://[::ffff:10.0.0.5]" }],
    ["IPv4-mapped IPv6, hex vs dotted", { allowedHosts: ["[::ffff:10.0.0.5]"] }, { baseUrl: "https://[::ffff:a00:5]/app" }],
    ["IPv4-mapped IPv6 vs the IPv4 address", { baseUrl: "https://10.0.0.5" }, { baseUrl: "https://[::ffff:10.0.0.5]" }],
    ["IPv4 vs IPv4-mapped IPv6 allowedHosts", { baseUrl: "https://10.0.0.5" }, { allowedHosts: ["[::ffff:a00:5]"] }],
    ["IPv4-mapped IPv6 on both allowedHosts", { allowedHosts: ["[::ffff:a00:5]"] }, { allowedHosts: ["[::ffff:10.0.0.5]"] }],
    ["IPv4-mapped IPv6 with other ports", { allowedHosts: ["[::ffff:10.0.0.5]:8443"] }, { baseUrl: "https://[::ffff:a00:5]:9000" }],
    ["compressed vs expanded IPv6", { allowedHosts: ["[2001:db8:0:0::1]"] }, { baseUrl: "https://[2001:db8::1]" }],
    [
      "expanded IPv6 allowedHosts vs compressed baseUrl",
      { baseUrl: "https://[2001:db8::1]" },
      { allowedHosts: ["[2001:0db8:0000:0000:0000:0000:0000:0001]"] },
    ],
    ["127.1 allowedHosts vs a loopback baseUrl", { allowedHosts: ["127.1"] }, { baseUrl: "http://127.0.0.1:3000" }],
    ["a loopback baseUrl vs a 127.1 allowedHosts", { baseUrl: "http://127.0.0.1:8080" }, { allowedHosts: ["127.1"] }],
    ["decimal IPv4 allowedHosts", { baseUrl: "https://192.168.0.1" }, { allowedHosts: ["3232235521"] }],
    ["octal IPv4 allowedHosts", { baseUrl: "https://192.168.0.1" }, { allowedHosts: ["0300.0250.0.1"] }],
    ["uppercase and trailing dot in the baseUrl", { allowedHosts: ["prod.acme.test"] }, { baseUrl: "https://PROD.Acme.TEST./x" }],
  ];

  it.each(overlapping)("a sandbox/production overlap is refused at load: %s", (_what, prod, sandbox) => {
    const err = catchPolicy(() =>
      parseRegistry(
        { version: 1, profiles: { "acme:production": prodEntry(prod), "acme:sandbox:x": entry(sandbox) } },
        "overlap.json",
      ),
    );
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain('belongs to production profile "acme:production"');
  });

  it.each(["[1.2.3.4]", "[:::]", "999.1.1.1", "1.2.3.4.5", "256.1.1.1"])(
    "an allowedHosts entry the URL parser rejects (%s) is refused at load",
    (bad) => {
      const err = catchPolicy(() =>
        parseRegistry({ version: 1, profiles: { "acme:sandbox:x": entry({ allowedHosts: [bad] }) } }, "bad.json"),
      );
      expect(err.code).toBe("invalid-profile");
      expect(err.message).toContain('profiles["acme:sandbox:x"].allowedHosts[0]');
    },
  );

  it.each(["APP.acme.test", "app.acme.test."])("an uppercase or trailing-dot allowedHosts entry (%s) stays invalid", (bad) => {
    expect(() =>
      parseRegistry({ version: 1, profiles: { "acme:sandbox:x": entry({ allowedHosts: [bad] }) } }, "bad.json"),
    ).toThrow(/allowedHosts\[0\]/);
  });

  it("stores the canonical spelling of every accepted entry", () => {
    const reg = parseRegistry(
      {
        version: 1,
        profiles: {
          "acme:sandbox:x": entry({ allowedHosts: ["[2001:db8:0:0::1]", "127.1:3000", "api.acme.test:8443"] }),
        },
      },
      "ok.json",
    );
    expect(reg.profiles["acme:sandbox:x"]?.allowedHosts).toEqual(["[2001:db8::1]", "127.0.0.1:3000", "api.acme.test:8443"]);
  });

  describe("on profiles built without the loader", () => {
    it("assertAllowed refuses a sandbox base that is the production host in another spelling", () => {
      const prod = productionProfile({ allowedHosts: ["[::ffff:10.0.0.5]"] });
      const sandbox = profile({ baseUrl: "https://[::ffff:10.0.0.5]" });
      const hosts = productionHosts(registryOf(prod, sandbox));
      const err = catchPolicy(() => assertAllowed(sandbox, { interactive: false, productionHosts: hosts }));
      expect(err.code).toBe("production-refused");
    });

    it("assertAllowed refuses a target on a production host in another spelling, even one the profile lists", () => {
      const prod = productionProfile({ allowedHosts: ["[2001:db8:0:0::1]:8443"] });
      const sandbox = profile({ allowedHosts: ["[2001:db8::1]:8443"] });
      const hosts = productionHosts(registryOf(prod, sandbox));
      for (const targetUrl of ["https://[2001:db8::1]:8443/x", "https://[2001:0db8::1]:9/x"]) {
        const err = catchPolicy(() => assertAllowed(sandbox, { interactive: false, productionHosts: hosts, targetUrl }));
        expect(err.code).toBe("production-refused");
      }
    });

    it("the allowlist compares canonical forms", () => {
      const p = profile({ allowedHosts: ["[2001:db8:0:0::1]", "127.1:3000", "API.acme.test"] });
      expect(isAllowedHost(p, "[2001:db8::1]")).toBe(true);
      expect(isAllowedHost(p, "127.0.0.1:3000")).toBe(true);
      expect(isAllowedHost(p, "api.acme.test")).toBe(true);
      expect(isAllowedHost(p, "127.0.0.1")).toBe(false);
      expect(isAllowedHost(p, "[2001:db8::2]")).toBe(false);
      const decision = assertAllowed(p, { interactive: false, targetUrl: "https://[2001:db8::1]/x" });
      expect(decision.host).toBe("sandbox.acme.test");
    });
  });

  describe("CLI", () => {
    it.each([
      ["allowedHosts", { allowedHosts: ["[::ffff:10.0.0.5]"] }, { baseUrl: "https://[::ffff:10.0.0.5]" }],
      ["127.1", { allowedHosts: ["127.1"] }, { baseUrl: "http://127.0.0.1:3000" }],
    ] as Array<[string, Side, Side]>)(
      "an overlap through %s is refused at load (exit 2); nothing reaches the store or the network",
      async (_what, prod, sandbox) => {
        const store = new MemoryStore();
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
        const file = await writeJson(path.join(home, "overlap.profiles.json"), {
          version: 1,
          profiles: { "acme:production": prodEntry(prod), "acme:sandbox:x": entry(sandbox) },
        });

        const session = await runCli(["--profiles", file, "session", "acme:sandbox:x"], { store, fetchImpl });
        expect(session.code).toBe(2);
        expect(session.stderr).toContain('belongs to production profile "acme:production"');
        expect(session.stdout).toBe("");

        const stored = await runCli(["--profiles", file, "store", "set", "acme:sandbox:x"], { store, fetchImpl }, `${randomBytes(18).toString("base64url")}\n`);
        expect(stored.code).toBe(2);

        expect(store.gets).toBe(0);
        expect(store.size).toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Production overlap on the merged registry and in `store set`
// ---------------------------------------------------------------------------

describe("production overlap across registry files", () => {
  async function twoFiles(sandbox: Record<string, unknown>): Promise<{ repoFile: string; userFile: string }> {
    const repoFile = await writeJson(path.join(home, "repo.profiles.json"), {
      version: 1,
      profiles: { "acme:production": prodEntry() },
    });
    const userFile = await writeJson(path.join(home, "testlane.profiles.json"), {
      version: 1,
      profiles: { "acme:sandbox:shared": entry(sandbox) },
    });
    return { repoFile, userFile };
  }

  it.each([
    ["baseUrl", { baseUrl: "https://prod.acme.test" }],
    ["baseUrl in another port and case", { baseUrl: "https://PROD.acme.test:8443" }],
    ["allowedHosts", { allowedHosts: ["prod.acme.test"] }],
  ])("a sandbox profile in the user file on a repo production host (%s) fails to load", async (_what, sandbox) => {
    const { repoFile, userFile } = await twoFiles(sandbox);
    const err = await catchPolicyAsync(
      loadProfiles({ cwd: home, repoFile, userFile, overridesFile: path.join(home, "none.json") }),
    );
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain('"acme:sandbox:shared"');
    expect(err.message).toContain('production profile "acme:production"');
    expect(err.message).toContain(repoFile);
    expect(err.message).toContain(userFile);
  });

  it("a merge without an overlap still loads", async () => {
    const { repoFile, userFile } = await twoFiles({ baseUrl: "https://other.acme.test" });
    const reg = await loadProfiles({ cwd: home, repoFile, userFile, overridesFile: path.join(home, "none.json") });
    expect(Object.keys(reg.profiles).sort()).toEqual(["acme:production", "acme:sandbox:shared"]);
  });

  it("the CLI refuses every command (exit 2) and `store set` stores nothing", async () => {
    const { repoFile } = await twoFiles({ baseUrl: "https://prod.acme.test" });
    const store = new MemoryStore();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));

    const stored = await runCli(["--profiles", repoFile, "store", "set", "acme:sandbox:shared"], { store, fetchImpl }, `${randomBytes(18).toString("base64url")}\n`);
    expect(stored.code).toBe(2);
    expect(stored.stderr).toContain("production profile");
    const listed = await runCli(["--profiles", repoFile, "profiles"], { store, fetchImpl });
    expect(listed.code).toBe(2);

    expect(store.size).toBe(0);
    expect(store.gets).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("store set refuses a profile on a production host", () => {
  const secret = (): string => randomBytes(18).toString("base64url");

  // Built by hand: parseRegistry / loadProfiles would reject these, which is the point.
  function deps(store: MemoryStore, ...profiles: Profile[]): CommandDeps {
    return { store, registry: registryOf(...profiles), requester: "vitest" };
  }

  it.each([
    ["baseUrl", { baseUrl: "https://prod.acme.test" }],
    ["baseUrl with another port and case", { baseUrl: "https://PROD.acme.test:8443" }],
    ["allowedHosts", { allowedHosts: ["api.prod.acme.test"] }],
    ["a canonical-form variant", { baseUrl: "https://[::ffff:a00:5]" }],
  ])("%s", async (_what, overrides) => {
    const store = new MemoryStore();
    const prod = productionProfile({ allowedHosts: ["api.prod.acme.test", "[::ffff:10.0.0.5]"] });
    const sandbox = profile({ name: "acme:sandbox:on-prod", ...overrides });
    const d = deps(store, prod, sandbox);

    const err = await catchPolicyAsync(storeSet(d, sandbox.name, secret()));
    expect(err.code).toBe("production-refused");
    expect(err.message).toContain('production profile "acme:production"');
    expect(store.size).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", profile: "acme:sandbox:on-prod", ok: false, reason: "production-refused" });

    await expect(assertStorable(d, sandbox.name)).rejects.toBeInstanceOf(PolicyError);
  });

  it("still stores for a profile that shares no host with a production profile", async () => {
    const store = new MemoryStore();
    const sandbox = profile({ name: "acme:sandbox:fine", allowedHosts: ["api.sandbox.acme.test"] });
    await storeSet(deps(store, productionProfile(), sandbox), sandbox.name, secret());
    expect(store.size).toBe(1);
  });

  it("still refuses the production profile itself by tag", async () => {
    const store = new MemoryStore();
    const err = await catchPolicyAsync(storeSet(deps(store, productionProfile()), "acme:production", secret()));
    expect(err.code).toBe("production-refused");
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. *.localhost
// ---------------------------------------------------------------------------

describe("plain http to a *.localhost name", () => {
  const NAMES = ["http://app.localhost:3000", "http://a.b.localhost", "http://APP.LOCALHOST/x", "http://localhost.localhost:80"];

  it.each(NAMES)("is refused as a baseUrl (%s) and says what to use instead", (baseUrl) => {
    const err = catchPolicy(() => assertAllowed(profile({ baseUrl }), { interactive: false }));
    expect(err.code).toBe("insecure-transport");
    expect(err.message).toMatch(/https/);
    expect(err.message).toMatch(/\*\.localhost/);
    expect(err.message).toMatch(/http:\/\/localhost:<port>/);
    expect(err.message).toMatch(/http:\/\/127\.0\.0\.1:<port>/);
  });

  it("is refused as a target, even when the profile lists it", () => {
    const p = profile({ allowedHosts: ["app.localhost:3000"] });
    const err = catchPolicy(() => assertAllowed(p, { interactive: false, targetUrl: "http://app.localhost:3000/x" }));
    expect(err.code).toBe("insecure-transport");
    expect(err.message).toMatch(/\*\.localhost/);
    expect(err.message).toMatch(/127\.0\.0\.1/);
  });

  it("is fine over https", () => {
    expect(assertAllowed(profile({ baseUrl: "https://app.localhost" }), { interactive: false }).ttlMinutes).toBe(60);
  });

  it.each([
    "http://localhost:3000",
    "http://LOCALHOST",
    "http://127.0.0.1:3000",
    "http://127.1:3000",
    "http://[::1]:3000",
  ])("keeps the exemption for %s", (baseUrl) => {
    expect(assertAllowed(profile({ baseUrl }), { interactive: false }).ttlMinutes).toBe(60);
  });

  it("is not a secure context for the cookie jar either, while loopback still is", () => {
    const setSecure = (url: string): number => {
      const jar = new CookieJar();
      const res = new Response(null, { headers: { "set-cookie": "sid=abc; Path=/; Secure" } });
      jar.addFromResponse(res, new URL(url));
      return jar.all().length;
    };
    expect(setSecure("http://app.localhost:3000/")).toBe(0);
    expect(setSecure("http://a.b.localhost/")).toBe(0);
    for (const url of ["http://localhost:3000/", "http://127.0.0.1:3000/", "http://127.0.0.2/", "http://[::1]:3000/", "https://app.localhost/"]) {
      expect(setSecure(url)).toBe(1);
    }
    const jar = new CookieJar();
    jar.add({ name: "sid", value: "abc", domain: "app.localhost", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" });
    expect(jar.headerFor(new URL("http://app.localhost/"))).toBeUndefined();
    expect(jar.headerFor(new URL("https://app.localhost/"))).toBe("sid=abc");
  });
});

// ---------------------------------------------------------------------------
// 6. Control characters
// ---------------------------------------------------------------------------

describe("control characters in Set-Cookie attributes", () => {
  const URL_ = new URL("https://app.acme.test/");

  it.each([
    ["Path with a tab-separated forgery", "sid=abc; Path=/\tTRUE\t/forged"],
    ["Path with a C0 control", "sid=abc; Path=/\u0001x"],
    ["Path with DEL", "sid=abc; Path=/\u007fx"],
    ["Path with NUL", "sid=abc; Path=/\u0000x"],
    ["Domain with a tab", "sid=abc; Domain=acme\ttest"],
    ["Domain with a C0 control", "sid=abc; Domain=acme.test\u001fx"],
  ])("parseSetCookie rejects a cookie whose %s", (_what, header) => {
    expect(() => parseSetCookie(header, URL_)).toThrow(/control characters/);
  });

  it("does not echo the offending value", () => {
    const marker = randomBytes(6).toString("hex");
    try {
      parseSetCookie(`sid=abc; Path=/${marker}\tTRUE`, URL_);
    } catch (err) {
      expect((err as Error).message).not.toContain(marker);
      return;
    }
    throw new Error("expected a throw");
  });

  it("still accepts ordinary attributes, and ignores a trailing tab like any whitespace", () => {
    const c = parseSetCookie("sid=abc; Domain=.Acme.Test; Path=/app\t; Secure", URL_);
    expect(c).toMatchObject({ domain: ".acme.test", path: "/app", secure: true });
  });

  it("the jar ignores such a cookie, so no forged line reaches a curl jar", () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "forged=1; Path=/\tTRUE\t/x");
    headers.append("set-cookie", "forged2=1; Domain=app.acme.test\u0001");
    headers.append("set-cookie", "good=1; Path=/");
    const parsed = jar.addFromResponse(new Response(null, { headers }), URL_);
    expect(parsed.map((c) => c.name)).toEqual(["good"]);
    const text = toCurlJar({
      profile: "acme:sandbox:x",
      strategy: "form-post",
      baseUrl: URL_.origin,
      cookies: jar.all(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    });
    const lines = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split("\t")).toHaveLength(7);
  });
});

describe("audit rows are printed without control characters", () => {
  const row: AuditRow = {
    ts: "2026-01-01T00:00:00.000Z",
    event: "session",
    profile: "acme:sandbox:x\u0085y",
    host: "app.acme.test",
    environment: "sandbox",
    strategy: "form-post",
    requester: "req\u2028uester\u2029",
    ok: true,
    reason: "a\u001b[31mb\u009b[2Jc\u0007d",
  };

  it("replaces C0, DEL, C1 and the Unicode line separators with spaces", () => {
    const line = formatAuditRow(row);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(line).toContain("acme:sandbox:x y");
    expect(line).toContain("req uester ");
    expect(line.split("\n")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// store set: select the store before the secret is read
// ---------------------------------------------------------------------------

describe("store set selects the store before it reads the secret", () => {
  /** A stdin that records whether anyone consumed it. */
  function watchedStdin(): { stdin: Readable; wasRead: () => boolean } {
    let read = false;
    const stdin = new Readable({
      read() {
        read = true;
        this.push(`${randomBytes(18).toString("base64url")}\n`);
        this.push(null);
      },
    });
    return { stdin, wasRead: () => read };
  }

  async function registry(): Promise<string> {
    return writeJson(path.join(home, "repo.profiles.json"), { version: 1, profiles: { "acme:sandbox:x": entry() } });
  }

  /** A store that records every call, with a `kind` that throws like a failed adapter selection. */
  function storeWith(kind: () => string): { store: SecretStore; calls: string[] } {
    const calls: string[] = [];
    const store: SecretStore = {
      get kind(): string {
        calls.push("kind");
        return kind();
      },
      get: async () => {
        calls.push("get");
        return null;
      },
      set: async () => {
        calls.push("set");
      },
      delete: async () => {
        calls.push("delete");
        return false;
      },
      list: async () => {
        calls.push("list");
        return [];
      },
    };
    return { store, calls };
  }

  it("a store that cannot be selected fails before stdin is touched", async () => {
    const file = await registry();
    const { store, calls } = storeWith(() => {
      throw new Error("no keychain available: test double");
    });
    const { stdin, wasRead } = watchedStdin();

    const r = await runCli(["--profiles", file, "store", "set", "acme:sandbox:x"], { store }, stdin);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no keychain available");
    expect(wasRead()).toBe(false);
    expect(calls).toEqual(["kind"]);
  });

  it("the real selection failing (TESTLANE_STORE names a missing tool) fails before stdin is touched", async () => {
    const file = await registry();
    const emptyBin = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-nobin-"));
    const saved = { store: process.env["TESTLANE_STORE"], path: process.env["PATH"] };
    process.env["TESTLANE_STORE"] = "secret-service";
    process.env["PATH"] = emptyBin;
    const { stdin, wasRead } = watchedStdin();
    try {
      const r = await runCli(["--profiles", file, "store", "set", "acme:sandbox:x"], {}, stdin);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("secret-tool is not on PATH");
      expect(wasRead()).toBe(false);
    } finally {
      for (const [key, value] of [
        ["TESTLANE_STORE", saved.store],
        ["PATH", saved.path],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(emptyBin, { recursive: true, force: true });
    }
  });

  it("still refuses a production profile before touching the store or stdin", async () => {
    const file = await writeJson(path.join(home, "prod.profiles.json"), {
      version: 1,
      profiles: { "acme:production": prodEntry() },
    });
    const { store, calls } = storeWith(() => "spy");
    const { stdin, wasRead } = watchedStdin();
    const r = await runCli(["--profiles", file, "store", "set", "acme:production"], { store }, stdin);
    expect(r.code).toBe(2);
    expect(wasRead()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("an argv secret is still refused (exit 5) before the store is selected or stdin read", async () => {
    const file = await registry();
    const { store, calls } = storeWith(() => "spy");
    const { stdin, wasRead } = watchedStdin();
    const r = await runCli(
      ["--profiles", file, "store", "set", "acme:sandbox:x", `--password=${randomBytes(6).toString("hex")}`],
      { store },
      stdin,
    );
    expect(r.code).toBe(5);
    expect(wasRead()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a usable store still stores the value and names its kind", async () => {
    const file = await registry();
    const store = new MemoryStore();
    const { stdin } = watchedStdin();
    const r = await runCli(["--profiles", file, "store", "set", "acme:sandbox:x"], { store }, stdin);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("stored secret for acme:sandbox:x in memory store\n");
    expect(store.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A reader that closes the pipe early
// ---------------------------------------------------------------------------

describe("a reader that closes the pipe early", () => {
  it("`testlane profiles | head -1` is quiet: no unhandled EPIPE, the command's own exit code", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const file = await writeJson(path.join(home, "pipe.profiles.json"), {
      version: 1,
      profiles: { "acme:sandbox:a": entry(), "acme:sandbox:b": entry({ baseUrl: "https://b.acme.test" }) },
    });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(repoRoot, "src", "cli.ts"), "--profiles", file, "profiles"],
      { cwd: repoRoot, env: { ...process.env, TESTLANE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
    );
    // The reader goes away before the CLI (which needs a moment to start) writes anything.
    child.stdout.destroy();
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(Buffer.concat(stderr).toString("utf8")).not.toMatch(/EPIPE|Unhandled|\n\s+at /);
    expect(code).toBe(0);
  });
});
