import { randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditTail } from "../src/audit.js";
import { resolveCommandDeps } from "../src/deps.js";
import { MemoryNonceStore, verifyHandoffCode } from "../src/handoff.js";
import { createMcpServer, MCP_TOOL_NAMES, routeConsoleToStderr, STDOUT_CONSOLE_METHODS } from "../src/mcp.js";
import { getProfile, loadProfiles } from "../src/profiles.js";
import { assertValidStoreKey, type SecretStore } from "../src/store/index.js";
import { putProfileSecret, setPendingSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";
import { createDeviceExchangeRoutes } from "./helpers/fake-device-exchange.js";

/** Tiny in-memory SecretStore; keys validated like the real adapters. */
class TinyStore implements SecretStore {
  readonly kind = "memory";
  readonly #data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
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
    return [...this.#data.keys()];
  }
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const ENV_KEYS = ["TESTLANE_HOME", "TESTLANE_PROFILES", "TESTLANE_REQUESTER"] as const;
const EMAIL = "agent.sandbox@fake.test";
const SANDBOX = "fake:sandbox";
const PROD = "fake:prod";
const HANDOFF = "demo:handoff";

let savedEnv: Record<string, string | undefined> = {};
let home = "";
let profilesFile = "";
let password = "";
let handoffSecret = "";
let store: TinyStore;
let fake: FakeNextAuth;
let client: Client;
let fetchImpl: typeof fetch | undefined;
let depsFailure: Error | undefined;
/** Every JSON-RPC message the server sent, serialized: "every byte of the response". */
let wire: string[] = [];

async function seed(name: string, secret: string): Promise<void> {
  const reg = await loadProfiles({ cwd: home, repoFile: profilesFile });
  await putProfileSecret(store, getProfile(reg, name), secret);
}

async function call(name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  const params: { name: string; arguments?: Record<string, unknown> } = { name };
  if (args !== undefined) params.arguments = args;
  return (await client.callTool(params)) as ToolResult;
}

function text(r: ToolResult): string {
  const first = r.content[0];
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text content item");
  }
  return first.text;
}

function expectNoPassword(): void {
  const all = wire.join("\n");
  for (const form of [
    password,
    Buffer.from(password, "utf8").toString("base64"),
    Buffer.from(password, "utf8").toString("base64url"),
    handoffSecret,
  ]) {
    expect(all).not.toContain(form);
  }
  expect(all).not.toContain("[REDACTED]");
}

function expectNoStack(s: string): void {
  expect(s).not.toMatch(/\n\s+at\s/);
  expect(s).not.toMatch(/\.(?:ts|js):\d+:\d+/);
  expect(s).not.toContain("node_modules");
}

async function writeRegistry(extra: Record<string, unknown> = {}): Promise<void> {
  const base = {
    app: "fake-app",
    strategy: "nextauth-credentials",
    account: { email: EMAIL, role: "Declared-Role" },
    session: { ttlMinutes: 60 },
  };
  await fs.writeFile(
    profilesFile,
    JSON.stringify({
      version: 1,
      profiles: {
        [SANDBOX]: { ...base, environment: "sandbox", baseUrl: fake.baseUrl },
        [PROD]: { ...base, environment: "production", baseUrl: "https://prod.example.test" },
        [HANDOFF]: {
          ...base,
          app: "demo-app",
          environment: "sandbox",
          baseUrl: "https://sandbox.demo.test",
          strategy: "app-handoff",
        },
        ...extra,
      },
    }),
    "utf8",
  );
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-mcp-"));
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
  delete process.env["TESTLANE_REQUESTER"];

  password = randomBytes(18).toString("base64url");
  handoffSecret = randomBytes(24).toString("base64url");
  store = new TinyStore();
  fake = await startFakeNextAuth({ users: [{ email: EMAIL, password }] });
  profilesFile = path.join(home, "testlane.profiles.json");
  await writeRegistry();

  fetchImpl = undefined;
  depsFailure = undefined;
  const server = createMcpServer({
    deps: async () => {
      if (depsFailure) throw depsFailure;
      const deps = await resolveCommandDeps({ profilesFile, cwd: home, requester: "mcp", store });
      if (fetchImpl) deps.fetchImpl = fetchImpl;
      return deps;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  wire = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    wire.push(JSON.stringify(message));
    return send(message, options);
  };
  client = new Client({ name: "mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await fake.close();
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("tools/list", () => {
  it("exposes exactly the seven tools and no store or rotate tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(names).toEqual([
      "check",
      "handoff",
      "list_profiles",
      "release_session_file",
      "session",
      "session_file",
      "status",
    ]);
    expect(names.some((n) => /store|secret|rotate/i.test(n))).toBe(false);
    // check signs in and may create a server-side session despite returning no reusable value.
    expect(tools.find((tool) => tool.name === "check")?.annotations?.readOnlyHint).toBe(false);
    // Plain names every MCP client accepts (Claude Code exposes mcp__testlane__session).
    for (const n of names) expect(n).toMatch(/^[a-z][a-z_]*$/);
    expect(client.getServerVersion()?.name).toBe("testlane");
    expect(client.getInstructions()).toMatch(/no tool to store/i);
  });
});

describe("pre-rename tool names", () => {
  it("are not registered: agent_auth.session is refused and issues nothing", async () => {
    const r: unknown = await call("agent_auth.session", { profile: SANDBOX }).catch((e: unknown) => e);
    if (r instanceof Error) expect(r.message).toMatch(/not found/i);
    else expect((r as ToolResult).isError).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/cookie/i);
  });
});

describe("list_profiles", () => {
  it("returns all three profiles and sees registry edits on the next call", async () => {
    const r = await call("list_profiles");
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r)) as { profiles: Array<{ name: string }>; sources: string[] };
    expect(body.profiles.map((p) => p.name).sort()).toEqual([HANDOFF, PROD, SANDBOX].sort());
    expect(body.sources).toHaveLength(1);
    expect(r.structuredContent).toEqual(body);

    await writeRegistry({
      "fake:extra": {
        app: "fake-app",
        environment: "testing",
        baseUrl: fake.baseUrl,
        strategy: "nextauth-credentials",
        account: { email: EMAIL, role: "R" },
        session: { ttlMinutes: 30 },
      },
    });
    const again = JSON.parse(text(await call("list_profiles"))) as { profiles: Array<{ name: string }> };
    expect(again.profiles.map((p) => p.name)).toContain("fake:extra");
  });
});

describe("session", () => {
  it("returns a cookie header for the sandbox profile and never the password", async () => {
    await seed(SANDBOX, password);
    const r = await call("session", { profile: SANDBOX });
    expect(r.isError).toBeFalsy();
    const out = text(r);
    expect(out).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    expect(r.structuredContent).toMatchObject({ profile: SANDBOX, format: "cookie" });
    expect(typeof r.structuredContent?.["expiresAt"]).toBe("string");
    expectNoPassword();

    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "session", profile: SANDBOX, ok: true, requester: "mcp", format: "cookie" });
  });

  it("returns storage-state JSON when asked", async () => {
    await seed(SANDBOX, password);
    const r = await call("session", { profile: SANDBOX, format: "storage-state", ttlMinutes: 15 });
    expect(r.isError).toBeFalsy();
    const state = JSON.parse(text(r)) as { cookies: Array<{ name: string }> };
    expect(state.cookies.map((c) => c.name)).toContain("next-auth.session-token");
    expectNoPassword();
  });

  it("refuses the production profile before any network request, with a refused audit row", async () => {
    await seed(SANDBOX, password);
    const r = await call("session", { profile: PROD });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^refused: /);
    expect(r.structuredContent).toMatchObject({ code: 2, reason: "production-refused" });
    expectNoStack(text(r));
    expect(fake.requests).toHaveLength(0);

    const { rows } = await readAuditTail(10);
    expect(rows.some((row) => row.event === "refused" && row.profile === PROD && !row.ok)).toBe(true);
  });

  it("reports a missing secret as code 4", async () => {
    const r = await call("session", { profile: SANDBOX });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 4, reason: "missing-secret" });
    expect(text(r)).toContain(`testlane store set ${SANDBOX}`);
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects invalid input (missing profile) without a stack", async () => {
    const r = await call("session", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/profile/i);
    expectNoStack(text(r));
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects unknown keys such as a password field, without echoing the key or value", async () => {
    const value = `not-a-real-secret-${randomBytes(6).toString("hex")}`;
    const key = `password${randomBytes(3).toString("hex")}`;
    const r = await call("session", { profile: SANDBOX, [key]: value });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("invalid input: (unknown field)");
    expectNoStack(text(r));
    expect(wire.join("\n")).not.toContain(value);
    expect(wire.join("\n")).not.toContain(key);
    expect(fake.requests).toHaveLength(0);
  });

  it("maps validation errors to field names only (an invalid enum value is not echoed)", async () => {
    const random = randomBytes(8).toString("hex");
    const r = await call("session", { profile: SANDBOX, format: `ZZ${random}`, ttlMinutes: -1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("invalid input: format, ttlMinutes");
    expect(r.structuredContent).toEqual({ code: 1, error: "invalid input: format, ttlMinutes" });
    expect(wire.join("\n")).not.toContain(random);
    expect(fake.requests).toHaveLength(0);

    const h = await call("handoff", { profile: 42 });
    expect(text(h)).toBe("invalid input: profile");
  });

  it("names headers a cookie-only format dropped (exchange-credential), never their values", async () => {
    const servicePassword = randomBytes(18).toString("base64url");
    const credential = Array.from({ length: 8 }, () => String(randomInt(0, 10))).join("");
    const workerEmail = "member@example.invalid";
    let exchangeFake: FakeNextAuth | undefined;
    const exchange = createDeviceExchangeRoutes({
      users: [{ subject: "member-qa", credential, name: "Test Member", role: "Member", email: workerEmail }],
      isDependency: (cookie) => exchangeFake?.sessionUserFor(cookie)?.permissions?.includes("EXCHANGE_ACCESS") === true,
    });
    exchangeFake = await startFakeNextAuth({
      users: [{ email: "service@example.invalid", password: servicePassword, role: "Service", permissions: ["EXCHANGE_ACCESS"] }],
      extraRoutes: (req, res, url) => exchange.handle(req, res, url),
    });
    try {
      const common = { app: "fake-app", environment: "sandbox", baseUrl: exchangeFake.baseUrl, session: { ttlMinutes: 60 } };
      await writeRegistry({
        "fake:service": { ...common, strategy: "nextauth-credentials", account: { email: "service@example.invalid", role: "Service" } },
        "fake:exchange": {
          ...common,
          strategy: "dependent-token",
          account: { email: workerEmail, role: "Member", identifier: "member-qa" },
          options: {
            dependsOn: "fake:service",
            tokenPath: "/api/device/exchange",
            fields: '{"subject":"{{identifier}}","credential":"{{secret}}"}',
            tokenField: "accessToken",
            tokenHeader: "x-device-access",
            expiresAtField: "expiresAt",
            mePath: "/api/device/identity",
            emailField: "subject.email",
            roleField: "subject.role",
          },
        },
      });
      await seed("fake:service", servicePassword);
      await seed("fake:exchange", credential);

      const r = await call("session", { profile: "fake:exchange", format: "cookie" });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ profile: "fake:exchange", format: "cookie", droppedHeaders: ["x-device-access"] });
      expect(text(r)).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
      // The exchange token (48 hex) never travels; set the service cookie value aside first.
      expect(wire.join("\n").replace(/[0-9a-f]{64}/g, "")).not.toMatch(/[0-9a-f]{48}/);

      const h = await call("session", { profile: "fake:exchange", format: "headers" });
      expect(h.structuredContent?.["droppedHeaders"]).toBeUndefined();
      expect(text(h)).toMatch(/^x-device-access: [0-9a-f]{48}$/m);

      const plain = await call("session", { profile: "fake:service" });
      expect(plain.structuredContent?.["droppedHeaders"]).toBeUndefined();
      expect(wire.join("\n")).not.toContain(servicePassword);
    } finally {
      await exchangeFake.close();
    }
  });
});

describe("session_file and release_session_file", () => {
  it("delivers usable local state while keeping session and password values off the wire and audit", async () => {
    await seed(SANDBOX, password);
    const result = await call("session_file", { profile: SANDBOX });
    expect(result.isError).toBeFalsy();
    const receipt = result.structuredContent as { id: string; path: string; profile: string; format: string; expiresAt: string };
    expect(receipt).toMatchObject({ profile: SANDBOX, format: "storage-state" });
    expect(JSON.parse(text(result))).toEqual(receipt);
    const state = JSON.parse(await fs.readFile(receipt.path, "utf8")) as { cookies: Array<{ value: string }> };
    const token = state.cookies[0]!.value;
    expect(fake.sessionUserFor(`next-auth.session-token=${token}`)?.email).toBe(EMAIL);
    for (const value of [token, Buffer.from(token).toString("base64"), encodeURIComponent(token)]) {
      expect(wire.join("\n")).not.toContain(value);
      expect(await fs.readFile(path.join(home, "audit.ndjson"), "utf8")).not.toContain(value);
    }
    expectNoPassword();
    expect((await call("release_session_file", { id: receipt.id })).structuredContent).toEqual({ released: true });
    expect((await call("release_session_file", { id: receipt.id })).structuredContent).toEqual({ released: false });
    await expect(fs.access(receipt.path)).rejects.toThrow();
  });

  it("does not forward arbitrary setup error text that could contain a live token", async () => {
    const reflectedToken = randomBytes(24).toString("base64url");
    depsFailure = new Error(`setup failed with ${reflectedToken}`);
    const result = await call("session_file", { profile: SANDBOX });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.["code"]).toBe(1);
    expect(wire.join("\n")).not.toContain(reflectedToken);
    expectNoStack(text(result));
    expect(fake.requests).toHaveLength(0);
  });

  it.each(["cancellation", "disconnect"] as const)("aborts broker network work on session-file request %s", async (ending) => {
    await seed(SANDBOX, password);
    const marker = randomBytes(24).toString("base64url");
    let started!: () => void;
    let cancelled!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    fetchImpl = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      signal!.addEventListener("abort", () => { cancelled(); reject(new Error(marker)); }, { once: true });
      started();
    }));
    const controller = new AbortController();
    const pending = client.callTool({ name: "session_file", arguments: { profile: SANDBOX } }, undefined, { signal: controller.signal });
    const failure = expect(pending).rejects.toThrow();
    await fetching;
    if (ending === "cancellation") controller.abort();
    else await client.close();
    await failure;
    await stopped;
    // Let the shared command's safe failure audit finish before removing its home.
    await vi.waitFor(async () => {
      const { rows } = await readAuditTail(10);
      expect(rows.some(row => row.event === "session" && !row.ok)).toBe(true);
    });
    expect(fake.requests).toHaveLength(0);
    expect(fake.sessionTokens).toHaveLength(0);
    expect(wire.join("\n")).not.toContain(marker);
    expect(wire.join("\n")).not.toContain("testlane-session-files-");
    expectNoPassword();
  });

  it("removes delivered state when the MCP connection closes", async () => {
    await seed(SANDBOX, password);
    const result = await call("session_file", { profile: SANDBOX, format: "curl" });
    const receipt = result.structuredContent as { path: string };
    await client.close();
    await vi.waitFor(async () => expect(await fs.stat(receipt.path).catch(() => null)).toBeNull());
    await vi.waitFor(async () => expect(await fs.stat(path.dirname(receipt.path)).catch(() => null)).toBeNull());
  });

  it("rejects paths and unknown fields without echoing caller values", async () => {
    const value = randomBytes(24).toString("base64url");
    const release = await call("release_session_file", { id: `../${value}` });
    expect(release.isError).toBe(true);
    expect(text(release)).toBe("invalid input: id");
    const file = await call("session_file", { profile: SANDBOX, outputPath: value });
    expect(file.isError).toBe(true);
    expect(wire.join("\n")).not.toContain(value);
    expect(fake.requests).toHaveLength(0);
  });

  it("preserves policy/missing-secret codes and never issues an unaudited file", async () => {
    expect((await call("session_file", { profile: PROD })).structuredContent?.["code"]).toBe(2);
    expect((await call("session_file", { profile: SANDBOX })).structuredContent?.["code"]).toBe(4);
    expect(fake.requests).toHaveLength(0);
    await seed(SANDBOX, password);
    await fs.unlink(path.join(home, "audit.ndjson"));
    await fs.mkdir(path.join(home, "audit.ndjson"));
    const result = await call("session_file", { profile: SANDBOX });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.["path"]).toBeUndefined();
    expect(result.structuredContent?.["code"]).toBe(1);
    expectNoPassword();
  });
});

describe("check", () => {
  it("signs in and reports the email", async () => {
    await seed(SANDBOX, password);
    const r = await call("check", { profile: SANDBOX });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r)) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, profile: SANDBOX, email: EMAIL, role: "Declared-Role", roleSource: "declared" });
    expect(typeof body["expiresAt"]).toBe("string");
    expect(text(r)).not.toContain("session-token");
    expectNoPassword();
  });
});

describe("handoff", () => {
  it("returns a one-time URL whose code verifies with the stored secret, and audits it", async () => {
    await seed(HANDOFF, handoffSecret);
    const r = await call("handoff", { profile: HANDOFF });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r)) as { url: string; expiresAt: string; profile: string };
    expect(body.profile).toBe(HANDOFF);
    const url = new URL(body.url);
    expect(url.origin).toBe("https://sandbox.demo.test");
    expect(url.pathname).toBe("/api/auth/agent-handoff");
    const code = url.searchParams.get("code");
    expect(code).not.toBeNull();

    const verified = await verifyHandoffCode({
      code: code ?? "",
      secret: handoffSecret,
      nonceStore: new MemoryNonceStore(),
    });
    expect(verified).toMatchObject({ ok: true, profileName: HANDOFF });
    expectNoPassword();

    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "handoff", profile: HANDOFF, ok: true, requester: "mcp" });
  });

  it("refuses a non-app-handoff profile with code 2", async () => {
    const r = await call("handoff", { profile: SANDBOX });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^refused: /);
    expect(r.structuredContent).toMatchObject({ code: 2, reason: "invalid-profile" });
  });
});

describe("session / check on an app-handoff profile", () => {
  const LIVE = "fake:handoff-live";

  async function withHandoffApp(
    stored: "shared" | "other",
    body: (app: FakeNextAuth, secret: string) => Promise<void>,
  ): Promise<void> {
    const liveSecret = randomBytes(32).toString("base64url");
    const app = await startFakeNextAuth({
      users: [{ email: EMAIL, password: randomBytes(18).toString("base64url") }],
      handoff: { secret: liveSecret, profiles: { [LIVE]: EMAIL } },
    });
    try {
      await writeRegistry({
        [LIVE]: {
          app: "fake-app",
          environment: "sandbox",
          baseUrl: app.baseUrl,
          strategy: "app-handoff",
          account: { email: EMAIL, role: "Declared-Role" },
          session: { ttlMinutes: 60 },
          options: { mePath: "/api/auth/session", emailField: "user.email" },
        },
      });
      const storedSecret = stored === "shared" ? liveSecret : randomBytes(32).toString("base64url");
      await seed(LIVE, storedSecret);
      await body(app, storedSecret);
    } finally {
      await app.close();
    }
  }

  function expectNoHandoffMaterial(app: FakeNextAuth, secret: string): void {
    const all = wire.join("\n");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("code=");
    expect(all).not.toContain("agent-handoff");
    for (const code of app.handoffCodes) expect(all).not.toContain(code);
    expect(all).not.toContain("[REDACTED]");
  }

  it("session returns the cookies the handoff route set (never the URL); check confirms the identity", async () => {
    await withHandoffApp("shared", async (app, secret) => {
      const r = await call("session", { profile: LIVE, format: "storage-state" });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ profile: LIVE, format: "storage-state" });
      expect(r.structuredContent?.["droppedHeaders"]).toBeUndefined();
      const state = JSON.parse(text(r)) as { cookies: Array<{ name: string; value: string }> };
      expect(state.cookies.map((c) => c.name)).toEqual(["next-auth.session-token"]);
      expect(app.sessionUserFor(`next-auth.session-token=${state.cookies[0]?.value ?? ""}`)?.email).toBe(EMAIL);

      const c = await call("check", { profile: LIVE });
      expect(c.isError).toBeFalsy();
      expect(JSON.parse(text(c))).toMatchObject({ ok: true, profile: LIVE, email: EMAIL });
      expect(text(c)).not.toContain("session-token");

      expect(app.handoffOutcomes).toEqual(["ok", "ok"]);
      expectNoHandoffMaterial(app, secret);
      const { rows } = await readAuditTail(10);
      expect(rows.map((x) => [x.event, x.requester, x.reason ?? null])).toEqual([
        ["handoff", "mcp", "consumed-by-broker"],
        ["session", "mcp", null],
        ["handoff", "mcp", "consumed-by-broker"],
        ["check", "mcp", null],
      ]);
    });
  });

  it("a refused code is an isError result with code 3, leaking nothing", async () => {
    await withHandoffApp("other", async (app, secret) => {
      for (const tool of ["session", "check"]) {
        const r = await call(tool, { profile: LIVE });
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toMatchObject({ code: 3 });
        expect(text(r)).toContain("answered 404 instead of a redirect");
        expectNoStack(text(r));
      }
      expect(app.handoffOutcomes).toEqual(["bad-signature", "bad-signature"]);
      expectNoHandoffMaterial(app, secret);
    });
  });
});

describe("status", () => {
  it("reports metadata and alerts, never a value; production is listed but not read", async () => {
    await seed(SANDBOX, password);
    const r = await call("status");
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r)) as {
      alerting: boolean;
      profiles: Array<{ profile: string; hasSecret: boolean; alerts: string[]; ageDays: number | null }>;
    };
    expect(r.structuredContent).toEqual(body);
    const by = Object.fromEntries(body.profiles.map((p) => [p.profile, p]));
    expect(by[SANDBOX]).toMatchObject({ hasSecret: true, ageDays: 0, alerts: [] });
    expect(by[HANDOFF]).toMatchObject({ hasSecret: false, alerts: ["no-secret"] });
    expect(by[PROD]).toMatchObject({ hasSecret: false, alerts: [] });
    expect(body.alerting).toBe(true);
    expectNoPassword();
    expect(fake.requests).toHaveLength(0);
  });

  it("session reports an unresolved pending rotation in structuredContent.warnings (the text stays the bare artifact)", async () => {
    await seed(SANDBOX, password);
    const reg = await loadProfiles({ cwd: home, repoFile: profilesFile });
    await setPendingSecret(store, getProfile(reg, SANDBOX), randomBytes(18).toString("base64url"));
    const r = await call("session", { profile: SANDBOX });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    const warnings = r.structuredContent?.["warnings"] as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pending rotation unresolved");
    const status = JSON.parse(text(await call("status"))) as { profiles: Array<{ profile: string; pendingRotation: boolean }> };
    expect(status.profiles.find((p) => p.profile === SANDBOX)?.pendingRotation).toBe(true);
    expectNoPassword();
  });

  it("a store read error for one profile becomes a store-error alert without detail", async () => {
    await seed(SANDBOX, password);
    const failing = new (class extends TinyStore {
      override async get(key: string): Promise<string | null> {
        if (key.endsWith(HANDOFF)) throw new Error("simulated store failure at C:\\private\\path");
        return super.get(key);
      }
    })();
    for (const k of await store.list()) {
      const v = await store.get(k);
      if (v !== null) await failing.set(k, v);
    }
    const server = createMcpServer({
      deps: () => resolveCommandDeps({ profilesFile, cwd: home, requester: "mcp", store: failing }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "mcp-test-2", version: "0.0.0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
    try {
      const r = (await c.callTool({ name: "status", arguments: {} })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const body = JSON.parse(text(r)) as { alerting: boolean; profiles: Array<{ profile: string; alerts: string[] }> };
      expect(body.profiles.find((p) => p.profile === HANDOFF)?.alerts).toEqual(["store-error"]);
      expect(body.profiles.find((p) => p.profile === SANDBOX)?.alerts).toEqual([]);
      expect(body.alerting).toBe(true);
      expect(text(r)).not.toContain("simulated");
      expect(text(r)).not.toContain("private");
    } finally {
      await c.close();
    }
  });

  it("accepts maxAgeDays and refuses anything else by field name", async () => {
    await seed(SANDBOX, password);
    const ok = await call("status", { maxAgeDays: 7 });
    expect(ok.isError).toBeFalsy();
    const bad = await call("status", { maxAgeDays: 0 });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe("invalid input: maxAgeDays");
    const extra = await call("status", { profile: SANDBOX });
    expect(extra.isError).toBe(true);
    expect(text(extra)).toBe("invalid input: (unknown field)");
  });
});

describe("routeConsoleToStderr", () => {
  class Capture extends Writable {
    text = "";
    override _write(chunk: unknown, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
      this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      cb();
    }
  }

  it("routes every stdout-writing console method to the given stderr stream, and restores them", () => {
    const originals = STDOUT_CONSOLE_METHODS.map((m) => (console as unknown as Record<string, unknown>)[m]);
    const stdoutWrites: unknown[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const err = new Capture();
    const restore = routeConsoleToStderr(err);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      stdoutWrites.push(chunk);
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      console.log("m-log");
      console.info("m-info");
      console.debug("m-debug");
      console.dir({ m: "dir" });
      console.table([{ m: "table" }]);
      console.count("m-count");
      console.countReset("m-count");
      console.group("m-group");
      console.groupEnd();
      console.time("m-time");
      console.timeLog("m-time");
      console.timeEnd("m-time");
    } finally {
      process.stdout.write = realWrite;
      restore();
    }
    expect(stdoutWrites).toEqual([]);
    for (const marker of ["m-log", "m-info", "m-debug", "dir", "table", "m-count", "m-group", "m-time"]) {
      expect(err.text).toContain(marker);
    }
    STDOUT_CONSOLE_METHODS.forEach((m, i) => {
      expect((console as unknown as Record<string, unknown>)[m]).toBe(originals[i]);
    });
  });
});
