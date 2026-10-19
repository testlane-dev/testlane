import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAuditTail } from "../src/audit.js";
import { buildProgram } from "../src/cli.js";
import { accountOverridesPath } from "../src/paths.js";
import { getProfile, loadProfiles } from "../src/profiles.js";
import { secretKeyFor } from "../src/store/index.js";
import { getProfileSecret, putProfileSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";
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
const DECLARED_ROLE = "Declared-Role";
const APP_ROLE = "App-Role";

let savedEnv: Record<string, string | undefined> = {};
let home = "";
let profilesFile = "";
let password = "";
let store: MemoryStore;
let fake: FakeNextAuth;
let fakeWithRole: FakeNextAuth;

/** Store `secret` for `name` the way `store set` does (origin-bound envelope). */
async function seed(name: string, secret: string, file = profilesFile): Promise<void> {
  const reg = await loadProfiles({ cwd: home, repoFile: file });
  await putProfileSecret(store, getProfile(reg, name), secret);
}

async function run(args: string[], stdin?: string | Readable, file = profilesFile): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const input = typeof stdin === "string" ? Readable.from([stdin]) : (stdin ?? Readable.from([]));
  const program = buildProgram({
    deps: { store, cwd: home },
    stdin: input,
    stdout,
    stderr,
    isTTY: false,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  });
  let code = 0;
  try {
    await program.parseAsync(["--profiles", file, ...args], { from: "user" });
  } catch (err) {
    if (err instanceof ExitCalled) code = err.code;
    else if (err instanceof CommanderError) code = err.exitCode;
    else throw err;
  }
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Assert the throwaway password never reached output, not even as a redaction marker. */
function expectNoSecret(r: RunResult, secret = password): void {
  for (const text of [r.stdout, r.stderr]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain("[REDACTED]");
  }
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-cli-"));
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
  delete process.env["TESTLANE_REQUESTER"];

  password = randomBytes(18).toString("base64url");
  store = new MemoryStore();
  fake = await startFakeNextAuth({ users: [{ email: EMAIL, password, role: APP_ROLE }] });
  fakeWithRole = await startFakeNextAuth({
    users: [{ email: EMAIL, password, role: APP_ROLE }],
    includeRoleInSession: true,
  });

  const entry = (baseUrl: string, environment: string): Record<string, unknown> => ({
    app: "fake-app",
    environment,
    baseUrl,
    strategy: "nextauth-credentials",
    account: { email: EMAIL, role: DECLARED_ROLE },
    session: { ttlMinutes: 60 },
  });
  profilesFile = path.join(home, "testlane.profiles.json");
  await fs.writeFile(
    profilesFile,
    JSON.stringify({
      version: 1,
      profiles: {
        "fake:sandbox": entry(fake.baseUrl, "sandbox"),
        "fake:role": entry(fakeWithRole.baseUrl, "sandbox"),
        "fake:prod": entry("https://prod.example.test", "production"),
      },
    }),
    "utf8",
  );
});

afterEach(async () => {
  await fake.close();
  await fakeWithRole.close();
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("profiles", () => {
  it("lists every profile in a table with sources", async () => {
    const r = await run(["profiles"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+ENV\s+STRATEGY\s+EMAIL\s+ROLE\s+TTL\s+BASEURL$/);
    expect(r.stdout).toContain("fake:sandbox");
    expect(r.stdout).toContain("fake:prod");
    expect(r.stdout).toMatch(/fake:prod\s+production\s+nextauth-credentials/);
    expect(lines.at(-1)).toBe(`sources: ${profilesFile}`);
  });

  it("--json parses", async () => {
    const r = await run(["--json", "profiles"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as { profiles: { name: string }[]; sources: string[] };
    expect(json.profiles.map((p) => p.name)).toEqual(["fake:prod", "fake:role", "fake:sandbox"]);
    expect(json.sources).toEqual([profilesFile]);
  });
});

describe("policy refusals", () => {
  it("refuses a production profile before touching the store or the network", async () => {
    const r = await run(["session", "fake:prod"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("refused");
    expect(r.stderr).toContain("production");
    expect(store.gets).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(fakeWithRole.requests).toHaveLength(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "refused", profile: "fake:prod", ok: false, reason: "production-refused" });
  });

  it("refuses --ttl above the profile ttl with exit 2", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["session", "fake:sandbox", "--ttl", "61"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^refused: /);
    expect(r.stderr).toContain("exceeds");
    expect(fake.requests).toHaveLength(0);
    expectNoSecret(r);
  });
});

describe("store set", () => {
  it("refuses an extra positional before reading stdin (exit 5)", async () => {
    let read = false;
    const stdin = new Readable({
      read(): void {
        read = true;
        this.push(null);
      },
    });
    const extra = randomBytes(10).toString("hex");
    const r = await run(["store", "set", "fake:sandbox", extra], stdin);
    expect(r.code).toBe(5);
    expect(read).toBe(false);
    expect(store.size).toBe(0);
    expect(r.stderr).toContain("never pass it as an argument");
    expect(r.stdout + r.stderr).not.toContain(extra);
  });

  it("refuses --password=... anywhere on the command line (exit 5) without echoing it", async () => {
    const value = randomBytes(10).toString("hex");
    for (const args of [
      ["store", "set", "fake:sandbox", `--password=${value}`],
      [`--password=${value}`, "store", "set", "fake:sandbox"],
      ["store", "set", "fake:sandbox", "--SECRET", value],
    ]) {
      const r = await run(args, `${randomBytes(8).toString("hex")}\n`);
      expect(r.code).toBe(5);
      expect(r.stdout + r.stderr).not.toContain(value);
    }
    expect(store.size).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(0);
  });

  it("fails closed on --pw=x, -p=x and --passw0rd=x after store set (exit 5, stdin unread, no echo)", async () => {
    for (const make of [(v: string) => `--pw=${v}`, (v: string) => `-p=${v}`, (v: string) => `--passw0rd=${v}`]) {
      const value = `fake-${randomBytes(6).toString("hex")}`;
      let read = false;
      const stdin = new Readable({
        read(): void {
          read = true;
          this.push(null);
        },
      });
      const r = await run(["store", "set", "fake:sandbox", make(value)], stdin);
      expect(r.code).toBe(5);
      expect(read).toBe(false);
      expect(r.stderr).toContain("never pass it as an argument");
      expect(r.stdout + r.stderr).not.toContain(value);
    }
    // Value-taking global options after `store set` are refused too (their value could be anything).
    const r = await run(["store", "set", "fake:sandbox", "--requester", `x${randomBytes(6).toString("hex")}`]);
    expect(r.code).toBe(5);
    expect(store.size).toBe(0);
  });

  it("refuses even the boolean --json flag after store set (global options go before the subcommand)", async () => {
    let read = false;
    const stdin = new Readable({
      read(): void {
        read = true;
        this.push(null);
      },
    });
    const r = await run(["store", "set", "fake:sandbox", "--json"], stdin);
    expect(r.code).toBe(5);
    expect(read).toBe(false);
    expect(store.size).toBe(0);
    // Before the subcommand it is fine.
    const ok = await run(["--json", "store", "set", "fake:sandbox"], `${password}\n`);
    expect(ok.code).toBe(0);
    expect(store.size).toBe(1);
    expectNoSecret(ok);
  });

  it("an unknown --flag=value on any command is refused before commander sees it (exit 5)", async () => {
    const value = `fake-${randomBytes(6).toString("hex")} with space'quote`;
    for (const args of [
      ["session", "fake:sandbox", `--pw=${value}`],
      ["session", "fake:sandbox", `-p=${value}`],
      ["check", "fake:sandbox", `--passw0rd=${value}`],
      [`--x=${value}`, "profiles"],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe("");
      // Outside `store set` the refusal is generic (the value need not be a secret).
      expect(r.stderr).toBe(
        "unknown option with an inline value is refused; write options before the subcommand and never pass secrets on the command line\n",
      );
      expect(r.stdout + r.stderr).not.toContain(value);
      expect(r.stdout + r.stderr).not.toContain("with space");
      expect(fake.requests).toHaveLength(0);
    }
    // After `store set` it names the secret rule.
    const r = await run(["store", "set", "fake:sandbox", `--x=${value}`]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("never pass it as an argument");
    expect(r.stderr).not.toContain("with space");
  });

  it("a known --flag=value still works (exit code is not 5)", async () => {
    const r = await run(["session", "fake:sandbox", "--format=cookie"]);
    expect(r.code).toBe(4); // no secret stored; the flag itself was accepted
  });

  it("stores from piped stdin; session then prints a cookie and never the password", async () => {
    const set = await run(["store", "set", "fake:sandbox"], `${password}\n`);
    expect(set.code).toBe(0);
    expect(set.stdout).toBe("stored secret for fake:sandbox in memory store\n");
    const stored = JSON.parse((await store.get(secretKeyFor("fake:sandbox"))) ?? "null") as unknown;
    expect(stored).toEqual({
      v: 3,
      origin: new URL(fake.baseUrl).origin,
      environment: "sandbox",
      secret: password,
      storedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    const reg = await loadProfiles({ cwd: home, repoFile: profilesFile });
    expect(await getProfileSecret(store, getProfile(reg, "fake:sandbox"))).toBe(password);
    expectNoSecret(set);

    const list = await run(["store", "list"]);
    expect(list.stdout).toBe("fake:sandbox\n");

    const session = await run(["session", "fake:sandbox", "--format", "cookie"]);
    expect(session.code).toBe(0);
    expect(session.stdout).toMatch(/^next-auth\.session-token=[0-9a-f]{64}\n$/);
    expect(session.stderr).toBe("");
    expectNoSecret(session);
  });

  it("refuses to store a secret for a production profile, before reading stdin (exit 2)", async () => {
    const r = await run(["store", "set", "fake:prod"], `${password}\n`);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("refused");
    expect(r.stderr).toContain("production");
    expect(store.size).toBe(0);
    expectNoSecret(r);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "refused", profile: "fake:prod", ok: false, reason: "production-refused" });
  });

  it("refuses a stored secret whose environment tag has since changed (exit 6), without contacting the app", async () => {
    await seed("fake:sandbox", password);
    // Same profile name and baseUrl, but re-tagged in the registry after the secret was stored.
    const original = JSON.parse(await fs.readFile(profilesFile, "utf8")) as {
      version: 1;
      profiles: Record<string, Record<string, unknown>>;
    };
    original.profiles["fake:sandbox"] = { ...original.profiles["fake:sandbox"], environment: "testing" };
    await fs.writeFile(profilesFile, JSON.stringify(original));
    const r = await run(["session", "fake:sandbox"]);
    expect(r.code).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("environment-mismatch");
    expect(fake.requests).toHaveLength(0);
    expectNoSecret(r);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", profile: "fake:sandbox", ok: false, reason: "environment-mismatch" });
  });

  it("audits a missing secret as a refusal", async () => {
    const r = await run(["session", "fake:sandbox"]);
    expect(r.code).toBe(4);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", profile: "fake:sandbox", ok: false, reason: "missing-secret" });
  });

  it("does not echo an ill-formed profile name back", async () => {
    const junk = `Bad Name ${randomBytes(4).toString("hex")}`;
    const r = await run(["store", "set", junk], `${password}\n`);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(junk);
    expect(r.stderr).toContain("not a valid profile name");
    expect(store.size).toBe(0);
  });

  it("store delete removes the secret", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["store", "delete", "fake:sandbox"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("deleted secret for fake:sandbox\n");
    expect(store.size).toBe(0);
  });
});

describe("global options only before the subcommand", () => {
  it("session p --profiles x fails with exit 1 and never echoes the path; no registry is loaded from it", async () => {
    await seed("fake:sandbox", password);
    const marker = `evil-${randomBytes(6).toString("hex")}`;
    const other = path.join(home, `${marker}.json`);
    await fs.writeFile(other, JSON.stringify({ version: 1, profiles: {} }), "utf8");
    for (const args of [
      ["session", "fake:sandbox", "--profiles", other],
      ["session", "fake:sandbox", `--profiles=${other}`],
      ["check", "fake:sandbox", "--requester", marker],
      ["profiles", "--json"],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/unknown option '--(profiles|requester|json)/);
      expect(r.stderr).not.toContain(marker);
    }
    expect(fake.requests).toHaveLength(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(0);
  });

  it("the same options before the subcommand work", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["--requester", "before-sub", "--json", "check", "fake:sandbox"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ profile: "fake:sandbox", ok: true });
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "check", requester: "before-sub" });
  });
});

describe("commander errors never echo received values", () => {
  it("an invalid --format choice does not echo the value (both spellings)", async () => {
    const random = randomBytes(8).toString("hex");
    for (const args of [
      ["session", "fake:sandbox", `--format=ZZ${random}`],
      ["session", "fake:sandbox", "--format", `ZZ${random}`],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("argument is invalid. Allowed choices are cookie, storage-state, curl, headers, json.");
      expect(r.stdout + r.stderr).not.toContain(random);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("invalid --ttl, --tail and --port values are refused without echoing them", async () => {
    const random = randomBytes(6).toString("hex");
    const cases: [string[], string][] = [
      [["session", "fake:sandbox", "--ttl", `9x${random}`], "must be a whole number of minutes"],
      [["audit", "--tail", `t${random}`], "must be a whole number"],
      [["serve", "--port", `p${random}`], "must be an integer between 0 and 65535"],
    ];
    for (const [args, message] of cases) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(message);
      expect(r.stdout + r.stderr).not.toContain(random);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("an unknown command name is not echoed", async () => {
    const random = `x${randomBytes(6).toString("hex")}`;
    const r = await run([random]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command");
    expect(r.stdout + r.stderr).not.toContain(random);
  });
});

describe("origin binding (exit 6)", () => {
  /**
   * Rewrite the registry in place so fake:sandbox's baseUrl points at another
   * origin (a second file would collide with the same names, because the test
   * home doubles as the user-level registry location).
   */
  async function movedRegistry(): Promise<string> {
    const json = JSON.parse(await fs.readFile(profilesFile, "utf8")) as {
      profiles: Record<string, { baseUrl: string }>;
    };
    const moved = json.profiles["fake:sandbox"];
    if (moved === undefined) throw new Error("fixture missing fake:sandbox");
    moved.baseUrl = fakeWithRole.baseUrl; // same host, different port: a different origin
    await fs.writeFile(profilesFile, JSON.stringify(json), "utf8");
    return profilesFile;
  }

  it("refuses a secret stored for origin X when the profile now points at origin Y; no request is sent", async () => {
    const set = await run(["store", "set", "fake:sandbox"], `${password}\n`);
    expect(set.code).toBe(0);
    const moved = await movedRegistry();
    expect(new URL(fake.baseUrl).origin).not.toBe(new URL(fakeWithRole.baseUrl).origin);

    for (const cmd of [["session", "fake:sandbox"], ["check", "fake:sandbox"]]) {
      const r = await run(cmd, undefined, moved);
      expect(r.code).toBe(6);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("origin-mismatch");
      expect(r.stderr).toContain(new URL(fake.baseUrl).origin);
      expect(r.stderr).toContain(new URL(fakeWithRole.baseUrl).origin);
      expect(r.stderr).toContain("testlane store set fake:sandbox");
      expectNoSecret(r);
    }
    expect(fake.requests).toHaveLength(0);
    expect(fakeWithRole.requests).toHaveLength(0);

    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => r.event)).toEqual(["store.set", "refused", "refused"]);
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({ profile: "fake:sandbox", ok: false, reason: "origin-mismatch" });
      expect(JSON.stringify(row)).not.toContain(password);
    }
    expect(rows[1]).toMatchObject({ format: "cookie" });
  });

  it("refuses a legacy (pre-envelope) stored value as origin-unknown with exit 6", async () => {
    await store.set(secretKeyFor("fake:sandbox"), password);
    const r = await run(["session", "fake:sandbox"]);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain("origin-unknown");
    expect(r.stderr).toContain("testlane store set fake:sandbox");
    expect(r.stdout + r.stderr).not.toContain(password);
    expect(fake.requests).toHaveLength(0);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", ok: false, reason: "origin-unknown" });
  });

  it("documents exit code 6 in --help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Exit codes:");
    expect(r.stdout).toMatch(/6\s+stored secret refused \(origin or environment mismatch, or older format\)/);
  });
});

describe("audit failure (fail closed)", () => {
  /** Point TESTLANE_HOME below a regular file so every audit append fails. */
  async function breakAuditHome(): Promise<void> {
    const blocker = path.join(home, "not-a-directory");
    await fs.writeFile(blocker, "", "utf8");
    process.env["TESTLANE_HOME"] = path.join(blocker, "testlane-home");
  }

  it("emits no session on stdout when the session audit row cannot be written", async () => {
    await seed("fake:sandbox", password);
    await breakAuditHome();
    const r = await run(["session", "fake:sandbox"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // Sign-in itself succeeded (the callback POST happened); only the audit append failed.
    expect(fake.requests.some((q) => q.method === "POST")).toBe(true);
    expect(r.stderr).toMatch(/E(NOTDIR|EXIST|NOENT)/);
    expect(r.stdout + r.stderr).not.toMatch(/session-token/);
    expectNoSecret(r);
  });

  it("writes no --out file when the session audit row cannot be written", async () => {
    await seed("fake:sandbox", password);
    await breakAuditHome();
    const file = path.join(home, "session.txt");
    const r = await run(["session", "fake:sandbox", "--out", file]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("session", () => {
  it("exits 4 and names `store set` when no secret is stored", async () => {
    const r = await run(["session", "fake:sandbox"]);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("testlane store set fake:sandbox");
    expect(fake.requests).toHaveLength(0);
  });

  it("--format storage-state prints parseable JSON", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["session", "fake:sandbox", "--format", "storage-state"]);
    expect(r.code).toBe(0);
    const state = JSON.parse(r.stdout) as { cookies: { name: string }[]; origins: unknown[] };
    expect(state.cookies.map((c) => c.name)).toContain("next-auth.session-token");
    expectNoSecret(r);
  });

  it("--out writes the file and stdout carries no cookie value", async () => {
    await seed("fake:sandbox", password);
    const file = path.join(home, "session.txt");
    const r = await run(["session", "fake:sandbox", "--out", file]);
    expect(r.code).toBe(0);
    const content = await fs.readFile(file, "utf8");
    const m = /^next-auth\.session-token=([0-9a-f]{64})\n$/.exec(content);
    expect(m).not.toBeNull();
    const value = m?.[1] ?? "missing";
    expect(r.stdout).not.toContain(value);
    expect(r.stdout).toMatch(
      new RegExp(`^wrote cookie session for fake:sandbox to .+session\\.txt \\(expires \\d{4}-\\d{2}-\\d{2}T[^)]+\\)\\n$`),
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    expectNoSecret(r);
  });

  it("--out never overwrites an existing file (checked before sign-in); --force replaces it", async () => {
    await seed("fake:sandbox", password);
    const file = path.join(home, "existing.txt");
    const original = `keep-${randomBytes(6).toString("hex")}`;
    await fs.writeFile(file, original, "utf8");

    const r = await run(["session", "fake:sandbox", "--out", file]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `refusing to overwrite existing file ${file}; choose a new --out path or pass --force to replace it\n`,
    );
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(fake.requests).toHaveLength(0); // no session issued only to be discarded
    expect((await readAuditTail(10)).rows).toHaveLength(0);

    const forced = await run(["session", "fake:sandbox", "--out", file, "--force"]);
    expect(forced.code).toBe(0);
    expect(await fs.readFile(file, "utf8")).toMatch(/^next-auth\.session-token=[0-9a-f]{64}\n$/);
    expectNoSecret(forced);
  });

  it("wrong stored password exits 3 and never prints it", async () => {
    const wrong = randomBytes(18).toString("base64url");
    await seed("fake:sandbox", wrong);
    const r = await run(["session", "fake:sandbox"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("credentials rejected");
    expectNoSecret(r, wrong);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "session", ok: false });
  });
});

describe("check", () => {
  it("prints ok with the declared role when the app reports none", async () => {
    await seed("fake:sandbox", password);
    const r = await run(["check", "fake:sandbox"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(`^ok  fake:sandbox  ${EMAIL.replace(/\./g, "\\.")}  role=${DECLARED_ROLE} \\(declared\\)  expires=\\S+\\n$`),
    );
    expect(r.stdout).not.toContain("session-token");
    expectNoSecret(r);
  });

  it("prints the app role when the session carries one", async () => {
    await seed("fake:role", password);
    const r = await run(["check", "fake:role"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`role=${APP_ROLE} (app)`);
    expect(r.stdout).not.toContain("session-token");
    expectNoSecret(r);
  });

  it("wrong password prints FAIL and exits 3", async () => {
    const wrong = randomBytes(18).toString("base64url");
    await seed("fake:sandbox", wrong);
    const r = await run(["check", "fake:sandbox"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^FAIL  fake:sandbox  /);
    expectNoSecret(r, wrong);
  });
});

describe("audit", () => {
  it("records store.set, session and check with the requester, and --tail limits lines", async () => {
    const req = ["--requester", "test-suite"];
    expect((await run([...req, "store", "set", "fake:sandbox"], `${password}\n`)).code).toBe(0);
    expect((await run([...req, "session", "fake:sandbox"])).code).toBe(0);
    expect((await run([...req, "check", "fake:sandbox"])).code).toBe(0);

    const { rows, malformed } = await readAuditTail(50);
    expect(malformed).toBe(0);
    expect(rows.map((r) => r.event)).toEqual(["store.set", "session", "check"]);
    for (const row of rows) {
      expect(row.requester).toBe("test-suite");
      expect(row.ok).toBe(true);
      expect(JSON.stringify(row)).not.toContain(password);
    }
    expect(rows[1]).toMatchObject({ format: "cookie", profile: "fake:sandbox" });

    await run([...req, "session", "fake:prod"]);
    const tail = await run(["audit", "--tail", "3"]);
    expect(tail.code).toBe(0);
    const lines = tail.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("refused");
    expect(lines[2]).toContain("REF");

    const json = await run(["--json", "audit", "--tail", "2"]);
    const parsed = JSON.parse(json.stdout) as { rows: unknown[]; malformed: number };
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.malformed).toBe(0);
  });
});

describe("account overrides (account set | clear | list)", () => {
  const ROTATED = `operator+${randomBytes(4).toString("hex")}@fake.test`;
  let rotated: FakeNextAuth | undefined;

  /** Add "fake:rotating" (registry email = the stale EMAIL) on a server that only knows ROTATED. */
  async function addRotatingProfile(): Promise<void> {
    const server = await startFakeNextAuth({ users: [{ email: ROTATED, password }] });
    rotated = server;
    const json = JSON.parse(await fs.readFile(profilesFile, "utf8")) as {
      profiles: Record<string, Record<string, unknown>>;
    };
    json.profiles["fake:rotating"] = { ...json.profiles["fake:sandbox"], baseUrl: server.baseUrl };
    await fs.writeFile(profilesFile, JSON.stringify(json), "utf8");
  }

  afterEach(async () => {
    await rotated?.close();
    rotated = undefined;
  });

  it("account set -> profiles marks the override; session/check sign in as the new email without re-running store set; clear restores", async () => {
    await addRotatingProfile();
    const set = await run(["store", "set", "fake:rotating"], `${password}\n`);
    expect(set.code).toBe(0);
    const storedBefore = await store.get(secretKeyFor("fake:rotating"));

    // The registry's (stale) email is rejected by the app.
    expect((await run(["session", "fake:rotating"])).code).toBe(3);

    const r = await run(["account", "set", "fake:rotating", "--email", ROTATED]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`account override for fake:rotating: email=${ROTATED}\n`);
    expect(r.stderr).toBe("");
    const file = accountOverridesPath();
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      version: 1,
      overrides: { "fake:rotating": { account: { email: ROTATED } } },
    });
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const table = await run(["profiles"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(new RegExp(`fake:rotating\\s+sandbox\\s+nextauth-credentials\\s+${ROTATED.replace(/[.+]/g, "\\$&")} \\(override\\)\\s+${DECLARED_ROLE}`));
    expect(table.stdout).toMatch(/fake:sandbox\s+sandbox\s+nextauth-credentials\s+agent\.sandbox@fake\.test\s+Declared-Role/);
    expect(table.stdout.trimEnd().split("\n").at(-1)).toBe(`sources: ${profilesFile}, ${file}`);

    const json = await run(["--json", "profiles"]);
    const parsed = JSON.parse(json.stdout) as { profiles: { name: string; email: string; overridden?: boolean }[]; sources: string[] };
    expect(parsed.profiles.find((p) => p.name === "fake:rotating")).toMatchObject({ email: ROTATED, overridden: true });
    expect(parsed.profiles.find((p) => p.name === "fake:sandbox")).not.toHaveProperty("overridden");
    expect(parsed.sources).toEqual([profilesFile, file]);

    // Same stored secret (no store set in between) now signs in as the override email.
    const session = await run(["session", "fake:rotating"]);
    expect(session.code).toBe(0);
    expect(session.stdout).toMatch(/^next-auth\.session-token=[0-9a-f]{64}\n$/);
    expectNoSecret(session);
    const check = await run(["check", "fake:rotating"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain(`ok  fake:rotating  ${ROTATED}  `);
    expect(await store.get(secretKeyFor("fake:rotating"))).toBe(storedBefore);
    const { rows } = await readAuditTail(20);
    expect(rows.filter((row) => row.event === "store.set")).toHaveLength(1);

    const clear = await run(["account", "clear", "fake:rotating"]);
    expect(clear.code).toBe(0);
    expect(clear.stdout).toBe("cleared account override for fake:rotating\n");
    const restored = await run(["--json", "profiles"]);
    const back = JSON.parse(restored.stdout) as { profiles: { name: string; email: string; overridden?: boolean }[]; sources: string[] };
    expect(back.profiles.find((p) => p.name === "fake:rotating")).toMatchObject({ email: EMAIL });
    expect(back.profiles.find((p) => p.name === "fake:rotating")).not.toHaveProperty("overridden");
    expect(back.sources).toEqual([profilesFile]);
    expect((await run(["session", "fake:rotating"])).code).toBe(3);

    const again = await run(["account", "clear", "fake:rotating"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("no account override for fake:rotating\n");
  });

  it("account list shows overrides as text and with the global --json", async () => {
    const none = await run(["account", "list"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toBe("");
    expect(none.stderr).toBe("no account overrides\n");

    expect((await run(["account", "set", "fake:sandbox", "--email", ROTATED, "--identifier", "member-9"])).stdout).toBe(
      `account override for fake:sandbox: email=${ROTATED} identifier=member-9\n`,
    );
    const list = await run(["account", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toBe(`fake:sandbox  email=${ROTATED}  identifier=member-9\nfile: ${accountOverridesPath()}\n`);
    const json = await run(["--json", "account", "list"]);
    expect(JSON.parse(json.stdout)).toEqual({
      file: accountOverridesPath(),
      overrides: { "fake:sandbox": { email: ROTATED, identifier: "member-9" } },
      unusedHere: [],
    });
    // Global options go before the subcommand here too.
    expect((await run(["account", "list", "--json"])).code).toBe(1);
  });

  it("an override for a profile not in this registry is ignored with one warning per invocation, never fatal", async () => {
    const file = accountOverridesPath();
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        overrides: {
          "other-repo:operator": { account: { email: ROTATED } },
          "fake:sandbox": { account: { email: EMAIL } },
        },
      }),
    );
    const warning = 'warning: account override for "other-repo:operator" matches no profile in this registry\n';

    const profiles = await run(["profiles"]);
    expect(profiles.code).toBe(0);
    expect(profiles.stderr).toBe(warning);
    expect(profiles.stdout).toContain("fake:sandbox");
    expect(profiles.stdout).not.toContain("other-repo");

    await seed("fake:sandbox", password);
    const session = await run(["session", "fake:sandbox"]);
    expect(session.code).toBe(0);
    expect(session.stdout).toMatch(/^next-auth\.session-token=[0-9a-f]{64}\n$/);
    expect(session.stderr).toBe(warning);
    expectNoSecret(session);

    const check = await run(["check", "fake:sandbox"]);
    expect(check.code).toBe(0);
    expect(check.stderr).toBe(warning);

    // handoff warns too, even when it then refuses (fake:sandbox is not app-handoff).
    const handoff = await run(["handoff", "fake:sandbox"]);
    expect(handoff.code).toBe(2);
    expect(handoff.stderr.startsWith(warning)).toBe(true);
    expect(handoff.stderr.split(warning)).toHaveLength(2);

    const list = await run(["account", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toBe(
      `fake:sandbox         email=${EMAIL}\nother-repo:operator  email=${ROTATED}  (unused here)\nfile: ${file}\n`,
    );
    const listJson = await run(["--json", "account", "list"]);
    expect(JSON.parse(listJson.stdout)).toMatchObject({ unusedHere: ["other-repo:operator"] });

    // account set still requires the profile to exist in the current registry.
    const set = await run(["account", "set", "other-repo:operator", "--email", ROTATED]);
    expect(set.code).toBe(2);
    expect(set.stderr).toContain('Unknown profile "other-repo:operator"');
  });

  it("refuses production and unknown profiles with exit 2 and writes nothing", async () => {
    const prod = await run(["account", "set", "fake:prod", "--email", ROTATED]);
    expect(prod.code).toBe(2);
    expect(prod.stdout).toBe("");
    expect(prod.stderr).toMatch(/^refused: /);
    expect(prod.stderr).toContain("production");

    const unknown = await run(["account", "set", "fake:nope", "--email", ROTATED]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown profile "fake:nope"');

    const junk = `Bad Name ${randomBytes(4).toString("hex")}`;
    const bad = await run(["account", "set", junk, "--email", ROTATED]);
    expect(bad.code).toBe(2);
    expect(bad.stdout + bad.stderr).not.toContain(junk);
    await expect(fs.stat(accountOverridesPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a hand-written override on a production profile makes every command refuse (exit 2); clear still works", async () => {
    await fs.writeFile(
      accountOverridesPath(),
      JSON.stringify({ version: 1, overrides: { "fake:prod": { account: { email: ROTATED } } } }),
    );
    const r = await run(["profiles"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("production");
    const clear = await run(["account", "clear", "fake:prod"]);
    expect(clear.code).toBe(0);
    expect((await run(["profiles"])).code).toBe(0);
  });

  it("refuses secret-looking flags (exit 5) and invalid emails (exit 1) without echoing them", async () => {
    const value = `v${randomBytes(8).toString("hex")}`;
    for (const args of [
      ["account", "set", "fake:sandbox", "--email", ROTATED, "--password", value],
      ["account", "set", "fake:sandbox", "--email", ROTATED, `--token=${value}`],
      ["account", "set", "fake:sandbox", `--secret=${value}`],
      ["account", "set", "fake:sandbox", "--email", ROTATED, `--pw=${value}`],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe("");
      expect(r.stdout + r.stderr).not.toContain(value);
    }
    for (const email of [`has space${value}@x.test`, "", `${value}\u2028@x.test`, `${"a".repeat(250)}${value}@x.test`]) {
      const r = await run(["account", "set", "fake:sandbox", "--email", email]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("must be a non-empty string without whitespace");
      expect(r.stdout + r.stderr).not.toContain(value);
    }
    const missing = await run(["account", "set", "fake:sandbox"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--email");
    // --email=value (a declared option) is accepted.
    expect((await run(["account", "set", "fake:sandbox", `--email=${ROTATED}`])).code).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(0);
  });
});


describe("doctor", () => {
  it("supports structured output without loading a stored credential", async () => {
    await seed("fake:sandbox", password);
    const reads = store.gets;
    const result = await run(["doctor", "--json"]);
    const report = JSON.parse(result.stdout) as { schemaVersion: number; checks: { id: string; code: string }[] };
    expect(report.schemaVersion).toBe(1);
    expect(report.checks.find(c => c.id === "authentication")?.code).toBe("authentication.not_requested");
    expect(store.gets).toBe(reads);
    expectNoSecret(result);
  });

  it("only signs in when --check is supplied and preserves missing-secret exit 4", async () => {
    const missing = await run(["doctor", "--json", "--check", "fake:sandbox"]);
    expect(missing.code).toBe(4);
    await seed("fake:sandbox", password);
    const checked = await run(["doctor", "--json", "--check", "fake:sandbox"]);
    const report = JSON.parse(checked.stdout) as { checks: { id: string; code: string }[] };
    expect(report.checks.find(c => c.id === "authentication")?.code).toBe("authentication.verified");
    expectNoSecret(checked);
  });

  it("refuses production before loading a secret, with a structured diagnostic", async () => {
    const reads = store.gets;
    const result = await run(["doctor", "--json", "--check", "fake:prod"]);
    expect(result.code).toBe(2);
    expect(store.gets).toBe(reads);
    expect(JSON.parse(result.stdout).checks.some((c: { id: string }) => c.id === "authentication")).toBe(true);
    expectNoSecret(result);
  });
});


describe("workflow command input boundaries", () => {
  it("requires explicit manifests and a feature receipt before running anything", async () => {
    expect((await run(["workflow", "smoke"])).code).toBe(1);
    expect((await run(["workflow", "feature", "--manifest", "reviewed.json"])).code).toBe(1);
    expect(store.gets).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses broker overrides and registry replacement after the workflow command", async () => {
    const value = randomBytes(24).toString("base64url");
    for (const flag of ["--broker-cli", "--profiles", "--password"]) {
      const result = await run(["workflow", "smoke", "--manifest", "reviewed.json", flag, value]);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(value);
    }
    expect(store.gets).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});
