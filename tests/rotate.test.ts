/**
 * Phase 4: two-phase rotation (`rotate`), sign-in fallback to a pending
 * secret, and `status` expiry alerts. Every credential is generated per test;
 * the fake NextAuth server changes passwords in memory only.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAuditTail } from "../src/audit.js";
import { buildProgram, EXIT_CODES } from "../src/cli.js";
import { issueSession, RotationError, rotateProfile, type CommandDeps } from "../src/commands.js";
import { rotateLockPath } from "../src/lock.js";
import { getProfile, loadProfiles, parseRegistry } from "../src/profiles.js";
import { secretKeyFor } from "../src/store/index.js";
import { nextAuthCredentialsStrategy } from "../src/strategies/nextauth-credentials.js";
import { PolicyError, SignInError, type Profile } from "../src/types.js";
import { getProfileSecrets, putProfileSecret, setPendingSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeNextAuth, type FakeNextAuthOptions } from "./helpers/fake-nextauth.js";
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

/**
 * Records every key read, so tests can prove a production entry is never read;
 * reads of a key in `failKeys` throw (a broken store entry).
 */
class KeyLoggingStore extends MemoryStore {
  readonly readKeys: string[] = [];
  readonly failKeys = new Set<string>();
  override async get(key: string): Promise<string | null> {
    this.readKeys.push(key);
    if (this.failKeys.has(key)) throw new Error(`simulated store failure at C:\\secret\\path for ${key}`);
    return super.get(key);
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ENV_KEYS = ["TESTLANE_HOME", "TESTLANE_PROFILES", "TESTLANE_REQUESTER"] as const;
const ADMIN_EMAIL = "agent.admin@fake.test";
const USER_EMAIL = "agent.user@fake.test";
const SALES_EMAIL = "agent.sales@fake.test";
const ROTATE_PATH = "/api/admin/password";
const ROTATE_BODY = JSON.stringify({ email: "{{email}}", password: "{{newSecret}}" });
const DAY = 24 * 60 * 60 * 1000;

let savedEnv: Record<string, string | undefined> = {};
let home = "";
let profilesFile = "";
let adminPassword = "";
let userPassword = "";
let salesPassword = "";
let store: KeyLoggingStore;
let fake: FakeNextAuth | null = null;
/** Every secret value a test created or read back; none may ever reach output. */
let secretsSeen: string[] = [];

const gen = (): string => {
  const v = randomBytes(18).toString("base64url");
  secretsSeen.push(v);
  return v;
};

async function startFake(extra: Partial<FakeNextAuthOptions> = {}): Promise<FakeNextAuth> {
  fake = await startFakeNextAuth({
    users: [
      { email: ADMIN_EMAIL, password: adminPassword, role: "Administrator" },
      { email: USER_EMAIL, password: userPassword, role: "Sales" },
      { email: SALES_EMAIL, password: salesPassword, role: "Sales" },
    ],
    rotateEndpoint: true,
    ...extra,
  });
  await writeRegistry(fake.baseUrl);
  return fake;
}

async function writeRegistry(baseUrl: string, extraProfiles: Record<string, unknown> = {}): Promise<void> {
  const entry = (email: string, role: string, options?: Record<string, string>): Record<string, unknown> => {
    const e: Record<string, unknown> = {
      app: "fake-app",
      environment: "sandbox",
      baseUrl,
      strategy: "nextauth-credentials",
      account: { email, role },
      session: { ttlMinutes: 60 },
    };
    if (options !== undefined) e["options"] = options;
    return e;
  };
  const rotate = { rotatePath: ROTATE_PATH, rotateMethod: "PUT", rotateBody: ROTATE_BODY };
  await fs.writeFile(
    profilesFile,
    JSON.stringify({
      version: 1,
      profiles: {
        "fake:admin": entry(ADMIN_EMAIL, "Administrator", rotate),
        "fake:user": entry(USER_EMAIL, "Sales", { ...rotate, rotateVia: "fake:admin", rotateEveryDays: "30" }),
        "fake:user-bad-via": entry(SALES_EMAIL, "Sales", { ...rotate, rotateVia: "fake:user" }),
        "fake:norotate": entry(SALES_EMAIL, "Sales"),
        "fake:prod": { ...entry("", ""), environment: "production", baseUrl: "https://prod.example.test" },
        ...extraProfiles,
      },
    }),
    "utf8",
  );
}

async function profileOf(name: string): Promise<Profile> {
  return getProfile(await loadProfiles({ cwd: home, repoFile: profilesFile }), name);
}

async function seed(name: string, secret: string, at?: Date): Promise<void> {
  await putProfileSecret(store, await profileOf(name), secret, at);
}

async function secretsOf(name: string): Promise<Awaited<ReturnType<typeof getProfileSecrets>>> {
  const s = await getProfileSecrets(store, await profileOf(name));
  if (s !== null) {
    secretsSeen.push(s.secret);
    if (s.pendingSecret !== undefined) secretsSeen.push(s.pendingSecret);
  }
  return s;
}

interface RunOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const deps: NonNullable<Parameters<typeof buildProgram>[0]>["deps"] = { store, cwd: home };
  if (opts.fetchImpl !== undefined) deps.fetchImpl = opts.fetchImpl;
  if (opts.now !== undefined) deps.now = opts.now;
  const program = buildProgram({
    deps,
    stdin: Readable.from([]),
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

/** No secret seen in this test reached the output, not even as a redaction marker. */
function expectNoSecrets(...results: RunResult[]): void {
  for (const r of results) {
    for (const text of [r.stdout, r.stderr]) {
      for (const s of secretsSeen) expect(text).not.toContain(s);
      expect(text).not.toContain("[REDACTED]");
    }
  }
}

function pathOf(input: Parameters<typeof fetch>[0]): string {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url).pathname;
}

/** A fetch that fails the rotation request with a network error, before or after the app saw it. */
function flakyFetch(when: "before" | "after"): typeof fetch {
  return async (input, init) => {
    if (pathOf(input) === ROTATE_PATH) {
      if (when === "after") {
        const res = await fetch(input, init);
        await res.body?.cancel();
      }
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }
    return fetch(input, init);
  };
}

async function signsIn(name: string, secret: string): Promise<boolean> {
  try {
    await nextAuthCredentialsStrategy.signIn({ profile: await profileOf(name), secret, ttlMinutes: 5 });
    return true;
  } catch (err) {
    if (err instanceof SignInError && err.credentialsRejected) return false;
    throw err;
  }
}

function callbackCount(): number {
  return (fake?.requests ?? []).filter((r) => r.path === "/api/auth/callback/credentials").length;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-rotate-"));
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
  delete process.env["TESTLANE_REQUESTER"];
  profilesFile = path.join(home, "testlane.profiles.json");
  store = new KeyLoggingStore();
  secretsSeen = [];
  adminPassword = gen();
  userPassword = gen();
  salesPassword = gen();
});

afterEach(async () => {
  if (fake !== null) await fake.close();
  fake = null;
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// rotate: success paths
// ---------------------------------------------------------------------------

describe("rotate: success", () => {
  it("rotates through the rotateVia admin session: new 43-char secret stored, old one dead, audited, never printed", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);

    const r = await run(["rotate", "fake:user"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^rotated fake:user via fake:admin: the app answered HTTP 200 and a sign-in with the new secret succeeded; stored \d{4}-/,
    );
    expect(app.passwordChanges).toBe(1);

    const s = await secretsOf("fake:user");
    expect(s?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s?.secret).not.toBe(userPassword);
    expect(s?.pendingSecret).toBeUndefined();
    expect(await signsIn("fake:user", userPassword)).toBe(false);
    expect(await signsIn("fake:user", s?.secret ?? "")).toBe(true);
    // The admin's own secret is untouched.
    expect((await secretsOf("fake:admin"))?.secret).toBe(adminPassword);

    const session = await run(["session", "fake:user"]);
    expect(session.code).toBe(0);
    expect(session.stderr).toBe("");
    expectNoSecrets(r, session);

    const { rows } = await readAuditTail(50);
    expect(rows).toContainEqual(
      expect.objectContaining({ event: "session", profile: "fake:admin", ok: true, format: "internal:rotate:for=fake:user" }),
    );
    const rotateRows = rows.filter((row) => row.event === "rotate");
    expect(rotateRows).toHaveLength(1);
    expect(rotateRows[0]).toMatchObject({ profile: "fake:user", ok: true });
    expect(rotateRows[0]?.reason).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain(s?.secret ?? "x");
  });

  it("without rotateVia signs in as the profile itself (audited internal:rotate:for=<self>) and --json prints the outcome", async () => {
    const app = await startFake();
    await seed("fake:admin", adminPassword);
    const r = await run(["--json", "rotate", "fake:admin"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ profile: "fake:admin", rotated: true, via: null, status: 200 });
    expect(Object.keys(out).sort()).toEqual(["profile", "rotated", "status", "storedAt", "via"]);
    expect(app.passwordChanges).toBe(1);
    const s = await secretsOf("fake:admin");
    expect(s?.secret).not.toBe(adminPassword);
    expect(out["storedAt"]).toBe(s?.storedAt);
    expectNoSecrets(r);
    const { rows } = await readAuditTail(50);
    expect(rows).toContainEqual(
      expect.objectContaining({ event: "session", profile: "fake:admin", format: "internal:rotate:for=fake:admin" }),
    );
  });
});

// ---------------------------------------------------------------------------
// rotate: the app refuses
// ---------------------------------------------------------------------------

describe("rotate: refused by the app", () => {
  it("401: exit 3, pending dropped, the old secret is still stored and still works", async () => {
    const app = await startFake({ rotateFailStatus: 401 });
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);

    const r = await run(["rotate", "fake:user"]);
    expect(r.code).toBe(EXIT_CODES.signIn);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("refused by");
    expect(r.stderr).toContain("HTTP 401");
    expect(app.passwordChanges).toBe(0);
    // Admin sign-in, then the CURRENT secret (which succeeds): no failed login with the new value.
    expect(callbackCount()).toBe(2);
    const s = await secretsOf("fake:user");
    expect(s?.secret).toBe(userPassword);
    expect(s?.pendingSecret).toBeUndefined();
    expect((await run(["session", "fake:user"])).code).toBe(0);
    expectNoSecrets(r);
    const { rows } = await readAuditTail(50);
    expect(rows).toContainEqual(expect.objectContaining({ event: "rotate", profile: "fake:user", ok: false, reason: "app-rejected-401" }));
  });

  it("403 (rotateVia is not an admin): same outcome", async () => {
    const app = await startFake();
    await seed("fake:user-bad-via", salesPassword);
    await seed("fake:user", userPassword);
    const r = await run(["rotate", "fake:user-bad-via"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("HTTP 403");
    expect(app.passwordChanges).toBe(0);
    expect(await secretsOf("fake:user-bad-via")).toMatchObject({ secret: salesPassword });
    expect((await secretsOf("fake:user-bad-via"))?.pendingSecret).toBeUndefined();
    expectNoSecrets(r);
  });

  it("500 not applied: settled by sign-in (new rejected, old works) -> pending dropped, exit 3", async () => {
    await startFake({ rotateFailStatus: 500 });
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    const r = await run(["rotate", "fake:user"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("HTTP 500");
    const s = await secretsOf("fake:user");
    expect(s?.secret).toBe(userPassword);
    expect(s?.pendingSecret).toBeUndefined();
    expectNoSecrets(r);
    const { rows } = await readAuditTail(50);
    expect(rows.at(-1)).toMatchObject({ event: "rotate", ok: false, reason: "app-rejected-500" });
  });

  for (const status of [409, 502]) {
    it(`the app applied the change but answered ${status}: the new secret signs in, so it is promoted (exit 0)`, async () => {
      const app = await startFake({ rotateStatusAfterApply: status });
      await seed("fake:user", userPassword);
      await seed("fake:admin", adminPassword);
      const r = await run(["rotate", "fake:user"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`HTTP ${status}`);
      expect(app.passwordChanges).toBe(1);
      const s = await secretsOf("fake:user");
      expect(s?.secret).not.toBe(userPassword);
      expect(s?.pendingSecret).toBeUndefined();
      expect(await signsIn("fake:user", s?.secret ?? "")).toBe(true);
      expectNoSecrets(r);
      const { rows } = await readAuditTail(50);
      expect(rows.at(-1)).toMatchObject({ event: "rotate", ok: true, reason: `applied-despite-${status}` });
    });
  }

  it("2xx but the new secret does not sign in: a 2xx never drops it; it stays pending (exit 3) and session warns", async () => {
    await startFake({ rotateIgnore: true });
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    const r = await run(["rotate", "fake:user"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("does not sign in");
    expect(r.stderr).toContain("pending rotation unresolved for fake:user");
    const s = await secretsOf("fake:user");
    expect(s?.secret).toBe(userPassword);
    expect(s?.pendingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await readAuditTail(50);
    expect(rows.at(-1)).toMatchObject({ event: "rotate", ok: false, reason: "unknown-outcome-after-2xx" });
    const session = await run(["session", "fake:user"]);
    expect(session.code).toBe(0);
    expect(session.stderr).toContain("pending rotation unresolved");
    expectNoSecrets(r, session);
  });

  it("2xx from an app that applies the change late: kept as pending, then the next session promotes it", async () => {
    const app = await startFake({ rotateApplyDelayMs: 300 });
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    const r = await run(["rotate", "fake:user"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("pending rotation unresolved");
    const pending = await secretsOf("fake:user");
    expect(pending?.pendingSecret).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(app.passwordChanges).toBe(1);
    const session = await run(["session", "fake:user"]);
    expect(session.code).toBe(0);
    expect(session.stderr).toBe("");
    const s = await secretsOf("fake:user");
    expect(s?.secret).toBe(pending?.pendingSecret);
    expect(s?.pendingSecret).toBeUndefined();
    expectNoSecrets(r, session);
  });
});

// ---------------------------------------------------------------------------
// rotate: unknown outcome (network failure) never loses a credential
// ---------------------------------------------------------------------------

describe("rotate: unknown outcome", () => {
  it("network failure before the app saw it: pending kept; session keeps it with a warning; the next rotate settles it", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);

    const r = await run(["rotate", "fake:user"], { fetchImpl: flakyFetch("before") });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("outcome for fake:user is unknown");
    expect(r.stderr).toContain("ECONNRESET");
    expect(r.stderr).toContain("next session or check");
    expect(app.passwordChanges).toBe(0);
    const pending = await secretsOf("fake:user");
    expect(pending?.secret).toBe(userPassword);
    expect(pending?.pendingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await readAuditTail(50);
    expect(rows.at(-1)).toMatchObject({ event: "rotate", ok: false, reason: "unknown-outcome" });

    // The old secret still signs in: the pending value stays (only rotate decides) and a warning is printed.
    const session = await run(["session", "fake:user"]);
    expect(session.code).toBe(0);
    expect(session.stderr).toContain("pending rotation unresolved for fake:user");
    expect((await secretsOf("fake:user"))?.pendingSecret).toBe(pending?.pendingSecret);
    const check = await run(["check", "fake:user"]);
    expect(check.code).toBe(0);
    expect(check.stderr).toContain("pending rotation unresolved");
    const afterSession = await readAuditTail(50);
    expect(afterSession.rows).toContainEqual(expect.objectContaining({ event: "rotate", reason: "pending-unresolved" }));

    // The next rotate first settles the stale pending value (not live -> dropped), then rotates.
    const again = await run(["rotate", "fake:user"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("was not live and has been dropped first");
    expect(app.passwordChanges).toBe(1);
    const final = await secretsOf("fake:user");
    expect(final?.pendingSecret).toBeUndefined();
    expect(final?.secret).not.toBe(userPassword);
    expect(final?.secret).not.toBe(pending?.pendingSecret);
    expect(await signsIn("fake:user", final?.secret ?? "")).toBe(true);
    expectNoSecrets(r, session, check, again);
  });

  it("network failure after the app applied it: the next session falls back to the pending value and promotes it", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);

    const r = await run(["rotate", "fake:user"], { fetchImpl: flakyFetch("after") });
    expect(r.code).toBe(3);
    expect(app.passwordChanges).toBe(1);
    const pending = await secretsOf("fake:user");
    expect(pending?.secret).toBe(userPassword);
    expect(pending?.pendingSecret).toBeDefined();

    const before = callbackCount();
    const session = await run(["session", "fake:user"]);
    expect(session.code).toBe(0);
    expect(session.stderr).toBe("");
    expect(callbackCount() - before).toBe(2);
    const promoted = await secretsOf("fake:user");
    expect(promoted?.secret).toBe(pending?.pendingSecret);
    expect(promoted?.pendingSecret).toBeUndefined();
    expectNoSecrets(r, session);
    const { rows } = await readAuditTail(50);
    expect(rows).toContainEqual(expect.objectContaining({ event: "rotate", profile: "fake:user", ok: true, reason: "promoted-pending" }));
  });

  it("an interrupted rotation whose value WAS applied is promoted by the next rotate before it rotates again", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    expect((await run(["rotate", "fake:user"], { fetchImpl: flakyFetch("after") })).code).toBe(3);
    const again = await run(["rotate", "fake:user"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("was live and has been promoted first");
    expect(app.passwordChanges).toBe(2);
    const s = await secretsOf("fake:user");
    expect(await signsIn("fake:user", s?.secret ?? "")).toBe(true);
    expectNoSecrets(again);
  });
});

// ---------------------------------------------------------------------------
// sign-in with a pending secret (no rotate involved)
// ---------------------------------------------------------------------------

describe("sign-in with a pending secret", () => {
  it("falls back to the pending secret when the app's password changed, and promotes it", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    const next = gen();
    await setPendingSecret(store, await profileOf("fake:user"), next);
    app.setPassword(USER_EMAIL, next); // the app changed it mid-test

    const deps: CommandDeps = {
      store,
      registry: await loadProfiles({ cwd: home, repoFile: profilesFile }),
      requester: "vitest",
    };
    const { warnings } = await issueSession(deps, "fake:user", { format: "cookie" });
    expect(warnings).toEqual([]);
    expect(callbackCount()).toBe(2);
    expect(await secretsOf("fake:user")).toMatchObject({ secret: next });
    expect((await secretsOf("fake:user"))?.pendingSecret).toBeUndefined();
  });

  it("never makes more than two attempts; when both are rejected both values are kept", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    const pending = gen();
    await setPendingSecret(store, await profileOf("fake:user"), pending);
    app.setPassword(USER_EMAIL, gen());

    const r = await run(["session", "fake:user"]);
    expect(r.code).toBe(3);
    expect(callbackCount()).toBe(2);
    const s = await secretsOf("fake:user");
    expect(s?.secret).toBe(userPassword);
    expect(s?.pendingSecret).toBe(pending);
    expectNoSecrets(r);
  });

  it("does not try the pending secret for a failure that is not a credential rejection", async () => {
    await startFake();
    await seed("fake:user", userPassword);
    await setPendingSecret(store, await profileOf("fake:user"), gen());
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const r = await run(["session", "fake:user"], { fetchImpl: down });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("could not reach");
    expect((await secretsOf("fake:user"))?.pendingSecret).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// rotate: refusals before anything changes
// ---------------------------------------------------------------------------

describe("rotate: refusals", () => {
  it("refuses a production profile before touching the store or the network (exit 2)", async () => {
    const app = await startFake();
    const r = await run(["rotate", "fake:prod"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("production");
    expect(store.readKeys).toEqual([]);
    expect(app.requests).toHaveLength(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toEqual([expect.objectContaining({ event: "refused", profile: "fake:prod", reason: "production-refused" })]);
  });

  it("refuses a profile without options.rotatePath (exit 2, audit rotate-not-configured), before the store", async () => {
    const app = await startFake();
    await seed("fake:norotate", salesPassword);
    store.readKeys.length = 0;
    const r = await run(["rotate", "fake:norotate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("rotatePath");
    expect(store.readKeys).toEqual([]);
    expect(app.requests).toHaveLength(0);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", profile: "fake:norotate", reason: "rotate-not-configured" });
  });

  it("no stored secret: exit 4, nothing sent", async () => {
    const app = await startFake();
    const r = await run(["rotate", "fake:user"]);
    expect(r.code).toBe(4);
    expect(app.requests).toHaveLength(0);
  });

  it("the rotateVia session failing leaves the vault untouched (no pending written)", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    // fake:admin has no secret stored.
    const r = await run(["rotate", "fake:user"]);
    expect(r.code).toBe(4);
    expect(app.passwordChanges).toBe(0);
    expect((await secretsOf("fake:user"))?.pendingSecret).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rotate: the per-profile lock and changes underneath a rotation
// ---------------------------------------------------------------------------

describe("rotate: exclusive lock and concurrent changes", () => {
  async function depsNow(fetchImpl?: typeof fetch): Promise<CommandDeps> {
    const deps: CommandDeps = {
      store,
      registry: await loadProfiles({ cwd: home, repoFile: profilesFile }),
      requester: "vitest",
    };
    if (fetchImpl !== undefined) deps.fetchImpl = fetchImpl;
    return deps;
  }

  const lockExists = async (name: string): Promise<boolean> =>
    fs.stat(rotateLockPath(name)).then(
      () => true,
      () => false,
    );

  it("two concurrent rotations of one profile: exactly one runs, the other is refused (exit 2 class)", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    const deps = await depsNow();
    const results = await Promise.allSettled([rotateProfile(deps, "fake:user"), rotateProfile(deps, "fake:user")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(PolicyError);
    expect((refused[0]?.reason as PolicyError).code).toBe("rotation-in-progress");
    expect(String((refused[0]?.reason as Error).message)).toContain("already in progress");
    expect(app.passwordChanges).toBe(1);
    const s = await secretsOf("fake:user");
    expect(s?.pendingSecret).toBeUndefined();
    expect(await signsIn("fake:user", s?.secret ?? "")).toBe(true);
    expect(await lockExists("fake:user")).toBe(false);
    const { rows } = await readAuditTail(50);
    expect(rows).toContainEqual(expect.objectContaining({ event: "refused", profile: "fake:user", reason: "rotation-in-progress" }));
  });

  it("a fresh lock file refuses (exit 2) and is left alone; a stale one (> 15 min) is replaced; locks are released", async () => {
    const app = await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    const file = rotateLockPath("fake:user");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const fresh = JSON.stringify({ pid: 1, ts: new Date(Date.now() - 60_000).toISOString(), token: "x" });
    await fs.writeFile(file, fresh);
    const refused = await run(["rotate", "fake:user"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("already in progress");
    expect(await fs.readFile(file, "utf8")).toBe(fresh);
    expect(app.requests).toHaveLength(0);

    await fs.writeFile(file, JSON.stringify({ pid: 1, ts: new Date(Date.now() - 20 * 60_000).toISOString(), token: "x" }));
    const ok = await run(["rotate", "fake:user"]);
    expect(ok.code).toBe(0);
    expect(await lockExists("fake:user")).toBe(false);

    // Released after a failed rotation too.
    const failing = await run(["rotate", "fake:user"], { fetchImpl: flakyFetch("before") });
    expect(failing.code).toBe(3);
    expect(await lockExists("fake:user")).toBe(false);
    expectNoSecrets(refused, ok, failing);
  });

  it("a store set between the pending write and the promote: RotationError (exit 3), nothing lost, never rotated:true", async () => {
    await startFake();
    await seed("fake:user", userPassword);
    await seed("fake:admin", adminPassword);
    const human = gen();
    const userProfile = await profileOf("fake:user");
    // The app applies the change; meanwhile a human re-seeds the vault.
    const racing: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (pathOf(input) === ROTATE_PATH) await putProfileSecret(store, userProfile, human);
      return res;
    };
    const err = await rotateProfile(await depsNow(racing), "fake:user").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RotationError);
    expect((err as RotationError).outcome).toBe("pending-changed");
    expect((err as Error).message).toContain("changed underneath");
    const s = await secretsOf("fake:user");
    expect(s?.secret).toBe(human); // the human's value was not overwritten
    expect(s?.pendingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/); // the applied value was parked, not lost
    const { rows } = await readAuditTail(50);
    expect(rows.at(-1)).toMatchObject({ event: "rotate", ok: false, reason: "pending-changed" });
    expect(rows.some((r) => r.event === "rotate" && r.ok)).toBe(false);

    // The app now uses the rotated value: the next session falls back to it and promotes it.
    const session = await run(["session", "fake:user"]);
    expect(session.code).toBe(0);
    expect((await secretsOf("fake:user"))?.secret).toBe(s?.pendingSecret);
    expectNoSecrets(session);
  });

  it("rotateVia must be on the same origin, not just the same host:port (scheme differs -> exit 2, nothing sent)", async () => {
    const app = await startFake();
    const httpsSameHost = app.baseUrl.replace(/^http:/, "https:");
    await writeRegistry(app.baseUrl, {
      "fake:admin-https": {
        app: "fake-app",
        environment: "sandbox",
        baseUrl: httpsSameHost,
        strategy: "nextauth-credentials",
        account: { email: ADMIN_EMAIL, role: "Administrator" },
        session: { ttlMinutes: 60 },
      },
      "fake:user-cross-origin": {
        app: "fake-app",
        environment: "sandbox",
        baseUrl: app.baseUrl,
        strategy: "nextauth-credentials",
        account: { email: USER_EMAIL, role: "Sales" },
        session: { ttlMinutes: 60 },
        options: { rotatePath: ROTATE_PATH, rotateBody: ROTATE_BODY, rotateVia: "fake:admin-https" },
      },
    });
    await seed("fake:user-cross-origin", userPassword);
    await seed("fake:admin-https", adminPassword);
    const r = await run(["rotate", "fake:user-cross-origin"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("same origin");
    expect(app.requests.filter((q) => q.path === ROTATE_PATH)).toHaveLength(0);
    expect((await secretsOf("fake:user-cross-origin"))?.pendingSecret).toBeUndefined();
    const { rows } = await readAuditTail(50);
    expect(rows).toContainEqual(expect.objectContaining({ event: "refused", reason: "origin-not-allowed" }));
  });
});

// ---------------------------------------------------------------------------
// rotate* option validation
// ---------------------------------------------------------------------------

describe("rotate* options", () => {
  const entry = (options: Record<string, string>, strategy = "nextauth-credentials"): Record<string, unknown> => ({
    app: "a",
    environment: "sandbox",
    baseUrl: "https://sandbox.demo.test",
    strategy,
    account: { email: "a@b.test", role: "r" },
    session: { ttlMinutes: 5 },
    options,
  });
  const parse = (options: Record<string, string>, strategy?: string) =>
    parseRegistry({ version: 1, profiles: { "demo:x": entry(options, strategy) } }, "t.json");
  const refused = (options: Record<string, string>, strategy?: string): string => {
    try {
      parse(options, strategy);
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyError);
      return (err as Error).message;
    }
    throw new Error("expected a refusal");
  };

  it("accepts a complete rotation config on nextauth-credentials and form-post", () => {
    const ok = {
      rotatePath: "/api/me/password",
      rotateMethod: "PATCH",
      rotateBodyFormat: "form",
      rotateBody: JSON.stringify({ current: "{{secret}}", next: "{{newSecret}}", who: "{{email}}" }),
      rotateVia: "demo:admin",
      rotateEveryDays: "30",
    };
    expect(parse(ok).profiles["demo:x"]?.options).toEqual(ok);
    expect(parse({ ...ok, loginPath: "/login" }, "form-post").profiles["demo:x"]?.options?.["rotatePath"]).toBe("/api/me/password");
  });

  it("rejects unsafe or malformed rotate options, naming the key", () => {
    expect(refused({ rotatePath: "https://evil.test/pw" })).toContain("rotatePath");
    expect(refused({ rotatePath: "//evil.test/pw" })).toContain("rotatePath");
    expect(refused({ rotateMethod: "DELETE" })).toContain("rotateMethod");
    expect(refused({ rotateBodyFormat: "xml" })).toContain("rotateBodyFormat");
    expect(refused({ rotateBody: JSON.stringify({ password: "{{secret}}" }) })).toContain("{{newSecret}}");
    expect(refused({ rotateBody: JSON.stringify({ password: "{{newsecret}}" }) })).toContain("placeholders");
    expect(refused({ rotateBody: "[1]" })).toContain("rotateBody");
    expect(refused({ rotateBody: JSON.stringify({ password: 1 }) })).toContain("rotateBody");
    expect(refused({ rotateVia: "Not A Profile" })).toContain("rotateVia");
    for (const days of ["0", "-1", "1.5", "x", "99999"]) expect(refused({ rotateEveryDays: days })).toContain("rotateEveryDays");
  });

  it("dependent-token and app-handoff profiles cannot carry rotate options", () => {
    expect(refused({ dependsOn: "demo:service", rotatePath: "/pw" }, "dependent-token")).toContain("rotatePath");
    expect(refused({ rotatePath: "/pw" }, "app-handoff")).toContain("rotatePath");
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

interface StatusJson {
  generatedAt: string;
  alerting: boolean;
  profiles: Array<Record<string, unknown> & { profile: string; alerts: string[] }>;
}

describe("status", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const clock = (): Date => now;
  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  async function seedFleet(): Promise<void> {
    await writeRegistry("http://127.0.0.1:9", {
      "fake:legacy": {
        app: "fake-app",
        environment: "testing",
        baseUrl: "http://127.0.0.1:9",
        strategy: "nextauth-credentials",
        account: { email: "legacy@fake.test", role: "r" },
        session: { ttlMinutes: 60 },
      },
      "fake:moved": {
        app: "fake-app",
        environment: "sandbox",
        baseUrl: "http://127.0.0.1:9",
        strategy: "nextauth-credentials",
        account: { email: "moved@fake.test", role: "r" },
        session: { ttlMinutes: 60 },
      },
    });
    await seed("fake:user", gen(), ago(40 * DAY)); // rotateEveryDays 30 -> overdue
    await seed("fake:admin", gen(), ago(10 * DAY)); // default 90 -> ok
    await setPendingSecret(store, await profileOf("fake:admin"), gen(), ago(2 * 60 * 60 * 1000)); // 2 h -> alert
    await seed("fake:user-bad-via", gen(), ago(1 * DAY));
    await setPendingSecret(store, await profileOf("fake:user-bad-via"), gen(), ago(10 * 60 * 1000)); // 10 min -> no alert
    const legacy = await profileOf("fake:legacy");
    await store.set(
      secretKeyFor(legacy),
      JSON.stringify({ v: 2, origin: "http://127.0.0.1:9", environment: "testing", secret: gen() }),
    );
    const moved = await profileOf("fake:moved");
    await store.set(
      secretKeyFor(moved),
      JSON.stringify({ v: 3, origin: "http://127.0.0.1:10", environment: "sandbox", secret: gen(), storedAt: now.toISOString() }),
    );
    store.readKeys.length = 0;
  }

  it("--json: per-profile shape and alerts; production listed but never read; values never printed", async () => {
    await seedFleet();
    const r = await run(["status", "--json"], { now: clock });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as StatusJson;
    expect(report.generatedAt).toBe(now.toISOString());
    expect(report.alerting).toBe(true);
    const by = Object.fromEntries(report.profiles.map((p) => [p.profile, p]));
    expect(report.profiles.map((p) => p.profile)).toEqual([
      "fake:admin",
      "fake:legacy",
      "fake:moved",
      "fake:norotate",
      "fake:prod",
      "fake:user",
      "fake:user-bad-via",
    ]);
    expect(by["fake:user"]).toEqual({
      profile: "fake:user",
      environment: "sandbox",
      strategy: "nextauth-credentials",
      hasSecret: true,
      storedAt: ago(40 * DAY).toISOString(),
      ageDays: 40,
      pendingRotation: false,
      pendingSince: null,
      override: false,
      rotateEveryDays: 30,
      maxAgeDays: 30,
      alerts: ["rotation-overdue"],
    });
    expect(by["fake:admin"]).toMatchObject({
      ageDays: 10,
      maxAgeDays: 90,
      rotateEveryDays: null,
      pendingRotation: true,
      pendingSince: ago(2 * 60 * 60 * 1000).toISOString(),
      alerts: ["pending-rotation"],
    });
    expect(by["fake:user-bad-via"]).toMatchObject({ pendingRotation: true, alerts: [] });
    expect(by["fake:legacy"]).toMatchObject({ hasSecret: true, storedAt: null, ageDays: null, alerts: ["legacy-envelope"] });
    expect(by["fake:moved"]).toMatchObject({ hasSecret: true, refused: "origin-mismatch", alerts: ["secret-refused"] });
    expect(by["fake:norotate"]).toMatchObject({ hasSecret: false, storedAt: null, alerts: ["no-secret"] });
    expect(by["fake:prod"]).toEqual({
      profile: "fake:prod",
      environment: "production",
      strategy: "nextauth-credentials",
      hasSecret: false,
      storedAt: null,
      ageDays: null,
      pendingRotation: false,
      pendingSince: null,
      override: false,
      rotateEveryDays: null,
      maxAgeDays: 90,
      alerts: [],
    });
    expect(store.readKeys).not.toContain(secretKeyFor("fake:prod"));
    expect(store.readKeys).toHaveLength(6);
    expectNoSecrets(r);
    // status writes no audit rows and makes no request.
    expect((await readAuditTail(10)).rows).toEqual([]);
  });

  it("--alert exits 7 when a non-production profile has an alert, 0 otherwise; the table never prints values", async () => {
    await seedFleet();
    const table = await run(["status"], { now: clock });
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/^PROFILE\s+ENV\s+STRATEGY\s+SECRET\s+STORED\s+AGE\s+LIMIT\s+PENDING\s+ALERTS$/m);
    expect(table.stdout).toMatch(/^fake:prod\s+production\s+.*\(production: never read\)$/m);
    expect(table.stdout).toMatch(/^fake:user\s+sandbox\s+nextauth-credentials\s+yes\s+\S+\s+40d\s+30d \(rotateEveryDays\)\s+-\s+rotation-overdue$/m);
    expect(table.stdout).toMatch(/^fake:moved\s+.*refused \(origin-mismatch\).*secret-refused$/m);
    expect(table.stdout).toContain("alerts: 5 profile(s) need attention");
    const alert = await run(["status", "--alert"], { now: clock });
    expect(alert.code).toBe(EXIT_CODES.alert);
    expect(alert.code).toBe(7);
    expectNoSecrets(table, alert);

    // A healthy registry (a fresh secret, plus a production entry that is never read): exit 0.
    await fs.writeFile(
      profilesFile,
      JSON.stringify({
        version: 1,
        profiles: {
          "fake:fresh": {
            app: "fake-app",
            environment: "sandbox",
            baseUrl: "http://127.0.0.1:9",
            strategy: "nextauth-credentials",
            account: { email: "fresh@fake.test", role: "r" },
            session: { ttlMinutes: 60 },
          },
          "fake:prod": {
            app: "fake-app",
            environment: "production",
            baseUrl: "https://prod.example.test",
            strategy: "nextauth-credentials",
            account: { email: "", role: "" },
            session: { ttlMinutes: 0 },
          },
        },
      }),
    );
    await seed("fake:fresh", gen(), ago(DAY));
    const ok = await run(["status", "--alert"], { now: clock });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("no alerts");
  });

  it("--max-age-days replaces the 90-day default (not an explicit rotateEveryDays); the global --json works too", async () => {
    await seedFleet();
    const r = await run(["--json", "status", "--max-age-days", "5"], { now: clock });
    expect(r.code).toBe(0);
    const by = Object.fromEntries((JSON.parse(r.stdout) as StatusJson).profiles.map((p) => [p.profile, p]));
    expect(by["fake:admin"]).toMatchObject({ maxAgeDays: 5, alerts: ["rotation-overdue", "pending-rotation"] });
    expect(by["fake:user"]).toMatchObject({ maxAgeDays: 30 });
    expect(by["fake:user-bad-via"]).toMatchObject({ maxAgeDays: 5, alerts: [] });
    for (const bad of ["0", "-3", "abc", "1.5"]) {
      const b = await run(["status", "--max-age-days", bad], { now: clock });
      expect(b.code).toBe(1);
      expect(b.stderr).not.toContain(`'${bad}'`);
    }
  });

  it("a store read error for one profile is a per-profile store-error alert (no detail), not a failed report", async () => {
    await seedFleet();
    store.failKeys.add(secretKeyFor("fake:user"));
    const r = await run(["status", "--json"], { now: clock });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as StatusJson;
    const by = Object.fromEntries(report.profiles.map((p) => [p.profile, p]));
    expect(by["fake:user"]).toMatchObject({ hasSecret: false, storedAt: null, alerts: ["store-error"] });
    expect(by["fake:admin"]).toMatchObject({ hasSecret: true, alerts: ["pending-rotation"] });
    expect(r.stdout).not.toContain("simulated");
    expect(r.stdout).not.toContain("secret\\\\path");
    const table = await run(["status"], { now: clock });
    expect(table.stdout).toMatch(/^fake:user\s+sandbox\s+nextauth-credentials\s+error\s+.*store-error$/m);
    expect(table.stderr).toBe("");
    // Only the store error: --alert still exits 7.
    await fs.writeFile(
      profilesFile,
      JSON.stringify({
        version: 1,
        profiles: {
          "fake:user": {
            app: "fake-app",
            environment: "sandbox",
            baseUrl: "http://127.0.0.1:9",
            strategy: "nextauth-credentials",
            account: { email: USER_EMAIL, role: "r" },
            session: { ttlMinutes: 60 },
          },
        },
      }),
    );
    const alert = await run(["status", "--alert"], { now: clock });
    expect(alert.code).toBe(7);
    expect(alert.stdout + alert.stderr).not.toContain("simulated");
  });

  it("marks an account override", async () => {
    await seedFleet();
    await fs.writeFile(
      path.join(home, "testlane.overrides.json"),
      JSON.stringify({ version: 1, overrides: { "fake:user": { account: { email: "other@fake.test" } } } }),
    );
    const r = await run(["status", "--json"], { now: clock });
    const by = Object.fromEntries((JSON.parse(r.stdout) as StatusJson).profiles.map((p) => [p.profile, p]));
    expect(by["fake:user"]).toMatchObject({ override: true });
    expect(by["fake:admin"]).toMatchObject({ override: false });
    const table = await run(["status"], { now: clock });
    expect(table.stdout).toMatch(/^fake:user \(override\)\s+sandbox/m);
  });
});
