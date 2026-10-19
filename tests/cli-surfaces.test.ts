/**
 * CLI surfaces added in Phase 1: handoff, session --format headers (and the
 * extra-headers warning), store list filtering, check output hygiene, and the
 * mcp / serve commands. No real `mcp` or `serve` process is started here
 * (tests/mcp.test.ts and tests/serve.test.ts cover those); these tests only
 * check that the commands exist and validate their options.
 */
import { randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAuditTail } from "../src/audit.js";
import { buildProgram, EXIT_CODES_HELP } from "../src/cli.js";
import { MemoryNonceStore, verifyHandoffCode } from "../src/handoff.js";
import { getProfile, loadProfiles } from "../src/profiles.js";
import { ENCRYPTED_FILE_KEY_NAME } from "../src/store/encrypted-file.js";
import { secretKeyFor } from "../src/store/index.js";
import { SESSION_FORMATS } from "../src/session/format.js";
import { putProfileSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";
import { createDeviceExchangeRoutes, type DeviceExchangeRoutes } from "./helpers/fake-device-exchange.js";
import { MemoryStore } from "./helpers/memory-store.js";

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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ENV_KEYS = ["TESTLANE_HOME", "TESTLANE_PROFILES", "TESTLANE_REQUESTER"] as const;
const EMAIL = "agent.sandbox@fake.test";
const SERVICE_EMAIL = "service@example.invalid";
const WORKER_EMAIL = "member@example.invalid";
const SUBJECT = "member-qa";
const ODD_SUBJECT = "member-other";
/** Reported by the fake exchange API for ODD_SUBJECT: not the profile's email, with a line separator. */
const ODD_EMAIL = "someone.else@example.invalid\u2028ok  forged-line";

let savedEnv: Record<string, string | undefined> = {};
let home = "";
let profilesFile = "";
let password = "";
let servicePassword = "";
let credential = "";
let handoffSecret = "";
let store: MemoryStore;
let fake: FakeNextAuth;
let exchange: DeviceExchangeRoutes;

const throwaway = (): string => randomBytes(18).toString("base64url");
/** 8-digit throwaway test credential. */
const throwawayPin = (): string => Array.from({ length: 8 }, () => String(randomInt(0, 10))).join("");

async function seed(name: string, secret: string): Promise<void> {
  const reg = await loadProfiles({ cwd: home, repoFile: profilesFile });
  await putProfileSecret(store, getProfile(reg, name), secret);
}

async function run(args: string[], stdin?: string): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const program = buildProgram({
    deps: { store, cwd: home },
    stdin: Readable.from(stdin === undefined ? [] : [stdin]),
    stdout,
    stderr,
    isTTY: false,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  });
  let code = 0;
  try {
    await program.parseAsync(["--profiles", profilesFile, ...args], { from: "user" });
  } catch (err) {
    if (err instanceof ExitCalled) code = err.code;
    else if (err instanceof CommanderError) code = err.exitCode;
    else throw err;
  }
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function expectNoneOf(r: RunResult, values: string[]): void {
  for (const text of [r.stdout, r.stderr]) {
    expect(text).not.toContain("[REDACTED]");
    for (const v of values) expect(text).not.toContain(v);
  }
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-cli-surfaces-"));
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
  delete process.env["TESTLANE_REQUESTER"];

  password = throwaway();
  servicePassword = throwaway();
  handoffSecret = randomBytes(32).toString("base64url"); // >= HANDOFF_SECRET_MIN_LENGTH
  credential = throwawayPin();
  store = new MemoryStore();
  exchange = createDeviceExchangeRoutes({
    users: [
      { subject: SUBJECT, credential, name: "Test Member", role: "Member", email: WORKER_EMAIL },
      { subject: ODD_SUBJECT, credential, name: "Odd Agent", role: "Member", email: ODD_EMAIL },
    ],
    isDependency: (cookie) => fake.sessionUserFor(cookie)?.permissions?.includes("EXCHANGE_ACCESS") === true,
  });
  fake = await startFakeNextAuth({
    users: [
      { email: EMAIL, password, role: "App-Role" },
      { email: SERVICE_EMAIL, password: servicePassword, name: "Service", role: "Service", permissions: ["EXCHANGE_ACCESS"] },
    ],
    extraRoutes: (req, res, url) => exchange.handle(req, res, url),
    // The reference agent handoff route: the broker consumes it for session / check.
    handoff: { secret: handoffSecret, profiles: { "fake:handoff": EMAIL, "fake:handoff-me": EMAIL } },
  });

  const entry = (strategy: string, email: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    app: "fake-app",
    environment: "sandbox",
    baseUrl: fake.baseUrl,
    strategy,
    account: { email, role: "Declared-Role" },
    session: { ttlMinutes: 60 },
    ...extra,
  });
  const exchangeEntry = (subject: string): Record<string, unknown> =>
    entry("dependent-token", WORKER_EMAIL, {
      account: { email: WORKER_EMAIL, role: "Member", identifier: subject },
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
    });
  profilesFile = path.join(home, "testlane.profiles.json");
  await fs.writeFile(
    profilesFile,
    JSON.stringify({
      version: 1,
      profiles: {
        "fake:sandbox": entry("nextauth-credentials", EMAIL),
        "fake:handoff": entry("app-handoff", EMAIL),
        "fake:handoff-me": entry("app-handoff", EMAIL, {
          options: { mePath: "/api/auth/session", emailField: "user.email" },
        }),
        "fake:apikey": entry("api-key", EMAIL),
        "fake:service": entry("nextauth-credentials", SERVICE_EMAIL),
        "fake:exchange": exchangeEntry(SUBJECT),
        "fake:exchange-odd": exchangeEntry(ODD_SUBJECT),
        "fake:prod": { ...entry("app-handoff", EMAIL), environment: "production", baseUrl: "https://prod.example.test" },
      },
    }),
    "utf8",
  );
});

afterEach(async () => {
  await fake.close();
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("handoff", () => {
  it("prints { url, expiresAt, profile } whose code verifies with the stored secret, and audits it", async () => {
    await seed("fake:handoff", handoffSecret);
    const r = await run(["handoff", "fake:handoff"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const json = JSON.parse(r.stdout) as { url: string; expiresAt: string; profile: string };
    expect(Object.keys(json)).toEqual(["url", "expiresAt", "profile"]);
    expect(r.stdout).toBe(`${JSON.stringify(json, null, 2)}\n`);
    expect(json.profile).toBe("fake:handoff");

    const url = new URL(json.url);
    expect(url.origin).toBe(new URL(fake.baseUrl).origin);
    expect(url.pathname).toBe("/api/auth/agent-handoff");
    const code = url.searchParams.get("code") ?? "";
    const verified = await verifyHandoffCode({ code, secret: handoffSecret, nonceStore: new MemoryNonceStore() });
    expect(verified).toMatchObject({ ok: true, profileName: "fake:handoff" });
    if (verified.ok) expect(verified.expiresAt.toISOString()).toBe(json.expiresAt);
    expectNoneOf(r, [handoffSecret]);
    // No network: the broker only mints the code.
    expect(fake.requests).toHaveLength(0);

    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "handoff", profile: "fake:handoff", strategy: "app-handoff", ok: true });
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("--json prints the same shape", async () => {
    await seed("fake:handoff", handoffSecret);
    const r = await run(["--json", "handoff", "fake:handoff"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["url", "expiresAt", "profile"]);
  });

  it("refuses a production profile with exit 2 before touching the store", async () => {
    const r = await run(["handoff", "fake:prod"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^refused: /);
    expect(r.stderr).toContain("production");
    expect(store.gets).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", profile: "fake:prod", reason: "production-refused" });
  });

  it("refuses a nextauth-credentials profile with exit 2", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["handoff", "fake:sandbox"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("app-handoff");
    expect(store.gets).toBe(0);
    expectNoneOf(r, [password]);
  });

  it("exits 4 when no handoff secret is stored", async () => {
    const r = await run(["handoff", "fake:handoff"]);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("testlane store set fake:handoff");
  });
});

describe("session / check on app-handoff profiles (the broker consumes the handoff URL)", () => {
  /** Everything one-time about the handoff: never on stdout or stderr. */
  const handoffMaterial = (): string[] => [handoffSecret, "code=", "agent-handoff", ...fake.handoffCodes];

  it("session prints the handoff route's session cookie in every format; never the code or URL", async () => {
    await seed("fake:handoff-me", handoffSecret);
    for (const format of SESSION_FORMATS) {
      const r = await run(["session", "fake:handoff-me", "--format", format]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("next-auth.session-token");
      expectNoneOf(r, handoffMaterial());
    }
    expect(fake.handoffOutcomes).toEqual(SESSION_FORMATS.map(() => "ok"));
    const cookie = await run(["session", "fake:handoff-me"]);
    const value = /^next-auth\.session-token=([0-9a-f]{64})\n$/.exec(cookie.stdout)?.[1];
    expect(fake.sessionUserFor(`next-auth.session-token=${value ?? ""}`)?.email).toBe(EMAIL);

    const { rows } = await readAuditTail(20);
    expect(rows.slice(0, 2).map((r) => [r.event, r.profile, r.format, r.reason ?? null, r.ok])).toEqual([
      ["handoff", "fake:handoff-me", "cookie", "consumed-by-broker", true],
      ["session", "fake:handoff-me", "cookie", null, true],
    ]);
    expect(JSON.stringify(rows)).not.toContain(value ?? "<none>");
    for (const code of fake.handoffCodes) expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("session --out writes the artifact and prints only the confirmation", async () => {
    await seed("fake:handoff-me", handoffSecret);
    const out = path.join(home, "handoff-state.json");
    const r = await run(["session", "fake:handoff-me", "--format", "storage-state", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^wrote storage-state session for fake:handoff-me to .* \(expires .*\)\n$/);
    const state = JSON.parse(await fs.readFile(out, "utf8")) as { cookies: Array<{ name: string }> };
    expect(state.cookies.map((c) => c.name)).toEqual(["next-auth.session-token"]);
    expectNoneOf(r, handoffMaterial());
  });

  it("check with mePath: ok, the identity confirmed by the app", async () => {
    await seed("fake:handoff-me", handoffSecret);
    const r = await run(["check", "fake:handoff-me"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^ok {2}fake:handoff-me {2}agent\.sandbox@fake\.test {2}role=Declared-Role \(declared\) {2}expires=\S+\n$/);
    expectNoneOf(r, [...handoffMaterial(), ...fake.sessionTokens]);
  });

  it("without mePath (no opt-in) session and check refuse with exit 2 before the store, as in 0.3.x", async () => {
    await seed("fake:handoff", handoffSecret);
    const before = store.gets;
    for (const cmd of ["session", "check"]) {
      const r = await run([cmd, "fake:handoff"]);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("uses strategy app-handoff without options.mePath, so session and check are off for it");
      expect(r.stderr).toContain("use `testlane handoff fake:handoff`, or opt the profile in by adding options.mePath");
      expectNoneOf(r, handoffMaterial());
    }
    expect(store.gets).toBe(before);
    expect(fake.requests).toHaveLength(0);
    expect(fake.handoffCodes).toHaveLength(0);
    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => [r.event, r.profile, r.reason, r.ok])).toEqual([
      ["refused", "fake:handoff", "strategy-not-supported", false],
      ["refused", "fake:handoff", "strategy-not-supported", false],
    ]);
  });

  it("a route that refuses the code is a sign-in failure: exit 3", async () => {
    // A secret the app does not share: the route answers its bare 404.
    const wrong = randomBytes(32).toString("base64url");
    await seed("fake:handoff-me", wrong);
    for (const cmd of ["session", "check"]) {
      const r = await run([cmd, "fake:handoff-me"]);
      expect(r.code).toBe(3);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("answered 404 instead of a redirect");
      expectNoneOf(r, [wrong, ...handoffMaterial()]);
    }
  });

  it("a production app-handoff profile is still refused (exit 2) before the store", async () => {
    for (const cmd of ["session", "check"]) {
      const r = await run([cmd, "fake:prod"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("production");
    }
    expect(store.gets).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("strategies that cannot sign in (session / check)", () => {
  it("api-key: exit 2 'not implemented yet', audited, the store never read", async () => {
    const r = await run(["session", "fake:apikey"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("strategy api-key is not implemented yet");
    expect(store.gets).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "refused", profile: "fake:apikey", reason: "strategy-not-supported", ok: false });
  });
});

describe("store set for app-handoff", () => {
  it("refuses a handoff secret shorter than 32 characters without echoing it, and suggests openssl", async () => {
    const short = randomBytes(12).toString("hex"); // 24 chars
    const r = await run(["store", "set", "fake:handoff"], `${short}
`);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("at least 32 characters");
    expect(r.stderr).toContain("openssl rand -base64 32");
    expectNoneOf(r, [short]);
    expect(store.size).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", profile: "fake:handoff", reason: "handoff-secret-too-short" });
    expect(JSON.stringify(rows)).not.toContain(short);
  });

  it("stores a 32+ character handoff secret", async () => {
    const r = await run(["store", "set", "fake:handoff"], `${handoffSecret}
`);
    expect(r.code).toBe(0);
    expect(store.size).toBe(1);
    expectNoneOf(r, [handoffSecret]);
  });
});

describe("session --format headers", () => {
  it("prints a Cookie: line for a cookie-only artifact, with no warning", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["session", "fake:sandbox", "--format", "headers"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Cookie: next-auth\.session-token=[0-9a-f]{64}\n$/);
    expect(r.stderr).toBe("");
    expectNoneOf(r, [password]);
  });

  it("exchange-credential: headers carries x-device-access; cookie-only formats warn once with names only", async () => {
    await seed("fake:service", servicePassword);
    await seed("fake:exchange", credential);

    const h = await run(["session", "fake:exchange", "--format", "headers"]);
    expect(h.code).toBe(0);
    expect(h.stderr).toBe("");
    const lines = h.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Cookie: next-auth\.session-token=[0-9a-f]{64}$/);
    expect(lines[1]).toMatch(/^x-device-access: [0-9a-f]{48}$/);
    expectNoneOf(h, [credential, servicePassword]);

    for (const format of ["cookie", "storage-state", "curl"]) {
      const r = await run(["session", "fake:exchange", "--format", format]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe(
        `warning: 1 header(s) (x-device-access) are not representable in format ${format}; use --format headers\n`,
      );
      expect(r.stdout).not.toContain("x-device-access");
      expectNoneOf(r, [credential, servicePassword]);
    }
  });

  it("the warning also accompanies --out and never carries the header value", async () => {
    await seed("fake:service", servicePassword);
    await seed("fake:exchange", credential);
    const file = path.join(home, "cookies.txt");
    const r = await run(["session", "fake:exchange", "--format", "curl", "--out", file]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^warning: 1 header\(s\) \(x-device-access\) are not representable in format curl; /);
    expect(r.stderr).not.toMatch(/[0-9a-f]{48}/);
    expect(r.stdout).toMatch(/^wrote curl session for fake:exchange to /);
  });
});

describe("session --format json", () => {
  it("prints a stable object with the same headers as --format headers, no warning, no dropped headers", async () => {
    await seed("fake:sandbox", password);
    const headers = await run(["session", "fake:sandbox", "--format", "headers"]);
    const j = await run(["session", "fake:sandbox", "--format", "json"]);
    expect(j.code).toBe(0);
    expect(j.stderr).toBe("");
    const body = JSON.parse(j.stdout) as {
      profile: string;
      format: string;
      expiresAt: string;
      headers: Record<string, string>;
      droppedHeaders: string[];
    };
    expect(body.profile).toBe("fake:sandbox");
    expect(body.format).toBe("json");
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
    expect(body.droppedHeaders).toEqual([]);
    expect(Object.keys(body.headers)).toEqual(["Cookie"]);
    expect(body.headers["Cookie"]).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    // Parity: the same header NAMES, in the same order, as --format headers (values
    // differ because each `run` signs in fresh and gets a new token).
    const namesFromLines = headers.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf(": ")));
    expect(Object.keys(body.headers)).toEqual(namesFromLines);
    expectNoneOf(j, [password]);
  });

  it("carries an extra header (x-device-access) that cookie-only formats drop, with no warning", async () => {
    await seed("fake:service", servicePassword);
    await seed("fake:exchange", credential);
    const r = await run(["session", "fake:exchange", "--format", "json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const body = JSON.parse(r.stdout) as { headers: Record<string, string>; droppedHeaders: string[] };
    expect(Object.keys(body.headers)).toEqual(["Cookie", "x-device-access"]);
    expect(body.headers["x-device-access"]).toMatch(/^[0-9a-f]{48}$/);
    expect(body.droppedHeaders).toEqual([]);
    expectNoneOf(r, [credential, servicePassword]);
  });

  it("--out writes create-only, mode 0600, and --force replaces it, same as other formats", async () => {
    await seed("fake:sandbox", password);
    const file = path.join(home, "session.json");
    const r = await run(["session", "fake:sandbox", "--format", "json", "--out", file]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^wrote json session for fake:sandbox to .+session\.json \(expires \S+\)\n$/);
    const content = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(content) as { profile: string; headers: Record<string, string> };
    expect(parsed.profile).toBe("fake:sandbox");
    expect(parsed.headers["Cookie"]).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    expectNoneOf(r, [password]);

    const again = await run(["session", "fake:sandbox", "--format", "json", "--out", file]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("refusing to overwrite existing file");

    const forced = await run(["session", "fake:sandbox", "--format", "json", "--out", file, "--force"]);
    expect(forced.code).toBe(0);
    expectNoneOf(forced, [password]);
  });

  it("audits a json session the same way as other formats", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["session", "fake:sandbox", "--format", "json"]);
    expect(r.code).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "session", ok: true, profile: "fake:sandbox", format: "json" });
    expect(JSON.stringify(rows.at(-1))).not.toContain(password);
  });
});

describe("store list", () => {
  it("hides the encrypted-file data key and unregistered entries; --json lists them as internal", async () => {
    await seed("fake:sandbox", password);
    await store.set(ENCRYPTED_FILE_KEY_NAME, randomBytes(32).toString("base64"));
    await store.set(secretKeyFor("gone:profile"), "{}");

    const r = await run(["store", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("fake:sandbox\n");
    expect(r.stderr).toBe("");

    const j = await run(["--json", "store", "list"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.stdout)).toEqual({ profiles: ["fake:sandbox"], internal: ["encrypted-file.key.v1", "gone:profile"] });
    expectNoneOf(j, [password]);
  });

  it("says so on stderr when only internal entries exist", async () => {
    await store.set(ENCRYPTED_FILE_KEY_NAME, randomBytes(32).toString("base64"));
    const r = await run(["store", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("no secrets stored\n");
  });
});

describe("check output hygiene", () => {
  it("does not echo an ill-formed profile argument", async () => {
    const junk = `Bad Name ${randomBytes(4).toString("hex")}`;
    const r = await run(["check", junk]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stdout + r.stderr).not.toContain(junk);
    expect(r.stderr).toMatch(/^FAIL {2}\(not a valid profile name\) {2}refused: /);
  });

  it("an identity mismatch exits 3 and the app-supplied message cannot forge a line", async () => {
    await seed("fake:service", servicePassword);
    await seed("fake:exchange-odd", credential);
    const r = await run(["check", "fake:exchange-odd"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^FAIL {2}fake:exchange-odd {2}signed in, but the app reported a different identity \(expected /);
    expect(r.stderr).not.toContain("someone.else");
    expect(r.stderr).not.toContain("\u2028");
    expect(r.stderr.split("\n")).toHaveLength(2); // one line plus the trailing newline
    expectNoneOf(r, [credential, servicePassword]);

    const j = await run(["--json", "check", "fake:exchange-odd"]);
    expect(j.code).toBe(3);
    expect(JSON.parse(j.stdout)).toMatchObject({ profile: "fake:exchange-odd", ok: false });
  });
});

describe("mcp and serve commands", () => {
  function commandNames(): string[] {
    return buildProgram({ deps: { store, cwd: home } }).commands.map((c) => c.name());
  }

  it("exist next to the other commands", () => {
    expect(commandNames()).toEqual(
      expect.arrayContaining([
        "profiles",
        "store",
        "account",
        "session",
        "check",
        "handoff",
        "rotate",
        "status",
        "audit",
        "mcp",
        "serve",
      ]),
    );
  });

  it("--help lists handoff, rotate, status, mcp and serve and the updated exit codes", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    for (const name of ["handoff", "rotate", "status", "mcp", "serve"]) {
      expect(r.stdout).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(r.stdout).toContain(EXIT_CODES_HELP);
    expect(r.stdout).toMatch(/6\s+stored secret refused \(origin or environment mismatch, or older format\)/);
    expect(r.stdout).toMatch(/7\s+status --alert: a non-production profile has an alert/);
  });

  it("mcp --help names the tools (without starting a server)", async () => {
    const r = await run(["mcp", "--help"]);
    expect(r.code).toBe(0);
    // Commander wraps help text; compare with whitespace collapsed.
    expect(r.stdout.replace(/\s+/g, " ")).toContain(
      "MCP server over stdio, server name testlane (tools: list_profiles, session, session_file, release_session_file, check, handoff, status)",
    );
  });

  it("serve --help shows --port with default 4711", async () => {
    const r = await run(["serve", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--port <port>.*\(default: 4711\)/s);
  });

  it("serve --port rejects values outside 0..65535 with exit 1 before listening", async () => {
    for (const port of ["65536", "70000", "abc", "1.5", "080x"]) {
      const r = await run(["serve", "--port", port]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("must be an integer between 0 and 65535");
    }
    await expect(fs.stat(path.join(home, "http-token"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
