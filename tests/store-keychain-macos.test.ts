import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnLike } from "../src/store/dpapi.js";
import { secretKeyFor } from "../src/store/index.js";
import {
  KEYCHAIN_INDEX_FILE,
  KEYCHAIN_VALUE_PREFIX,
  KeychainMacosStore,
  SECURITY_PATH,
} from "../src/store/keychain-macos.js";

/** Throwaway value generated at test time; never a real secret. */
function throwaway(): string {
  return `throwaway-${randomBytes(12).toString("hex")}`;
}

let home = "";
const savedHome = process.env["TESTLANE_HOME"];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-keychain-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// In-process fake ChildProcess built from PassThrough streams. Every spawn is
// recorded exactly as the adapter passed it (command, argv, env), which is
// what the OS would see for a real child.
// ---------------------------------------------------------------------------

interface Reply {
  code: number;
  stdout?: string;
  stderr?: string;
}
type Handler = (args: string[], stdin: Buffer) => Reply | "hang";

interface Call {
  command: string;
  args: string[];
  rawEnv: NodeJS.ProcessEnv | undefined;
  effectiveEnv: Record<string, string | undefined>;
  stdin: string;
  killed: boolean;
}

function fakeSpawn(handler: Handler, calls: Call[]): SpawnLike {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const call: Call = {
      command,
      args: [...args],
      rawEnv: options.env === undefined ? undefined : { ...options.env },
      effectiveEnv: { ...(options.env ?? process.env) },
      stdin: "",
      killed: false,
    };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child["stdin"] = stdin;
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["kill"] = (): boolean => {
      call.killed = true;
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    const chunks: Buffer[] = [];
    stdin.on("data", (c: Buffer) => chunks.push(c));
    stdin.on("end", () => {
      const input = Buffer.concat(chunks);
      call.stdin = input.toString("utf8");
      const reply = handler([...args], input);
      if (reply === "hang") return;
      setImmediate(() => {
        void Promise.all([once(stdout, "end"), once(stderr, "end")]).then(() => child.emit("close", reply.code, null));
        stdout.end(reply.stdout ?? "");
        stderr.end(reply.stderr ?? "");
      });
    });
    return child as unknown as ChildProcess;
  };
}

/** Emulates the parts of /usr/bin/security the adapter uses, backed by `db` (account -> password). */
function securityEmulator(db: Map<string, string>): Handler {
  const NOT_FOUND = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n";
  const runCommand = (tokens: string[]): Reply => {
    const [cmd, ...rest] = tokens;
    const flags = new Map<string, string>();
    let update = false;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i] ?? "";
      if (t === "-U") update = true;
      else if (t === "-w" && (cmd === "find-generic-password")) flags.set("-w", "");
      else if (t.startsWith("-")) {
        flags.set(t, rest[i + 1] ?? "");
        i++;
      }
    }
    if (flags.get("-s") !== "agent-auth") return { code: 1, stderr: "security: unexpected service\n" };
    const account = flags.get("-a") ?? "";
    switch (cmd) {
      case "add-generic-password":
        if (db.has(account) && !update) {
          return { code: 45, stderr: "security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.\n" };
        }
        db.set(account, flags.get("-w") ?? "");
        return { code: 0 };
      case "find-generic-password": {
        const v = db.get(account);
        if (v === undefined) return { code: 44, stderr: NOT_FOUND };
        return { code: 0, stdout: `${v}\n` };
      }
      case "delete-generic-password":
        if (!db.delete(account)) return { code: 44, stderr: NOT_FOUND };
        return { code: 0, stdout: 'keychain: "/Users/x/Library/Keychains/login.keychain-db"\n' };
      default:
        return { code: 2, stderr: `security: unknown command\n` };
    }
  };
  return (args, stdin) => {
    if (args.length === 1 && args[0] === "-i") {
      // Interactive mode: one command per line; exit 0 even when a command fails.
      let stderr = "";
      for (const line of stdin.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        stderr += runCommand(line.trim().split(/\s+/)).stderr ?? "";
      }
      return { code: 0, stderr };
    }
    return runCommand(args);
  };
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function assertNothingSecretSpawned(calls: Call[], value: string): void {
  expect(calls.length).toBeGreaterThan(0);
  const forms = [value, b64(value), `${KEYCHAIN_VALUE_PREFIX}${b64(value)}`];
  for (const call of calls) {
    const argv = [call.command, ...call.args];
    for (const form of forms) {
      for (const a of argv) expect(a).not.toContain(form);
      expect(JSON.stringify(call.effectiveEnv)).not.toContain(form);
      if (call.rawEnv !== undefined) expect(JSON.stringify(call.rawEnv)).not.toContain(form);
    }
  }
}

function newStore(db: Map<string, string>, calls: Call[], extra: { timeoutMs?: number } = {}): KeychainMacosStore {
  return new KeychainMacosStore({ spawn: fakeSpawn(securityEmulator(db), calls), allowAnyPlatform: true, ...extra });
}

describe("KeychainMacosStore platform guard", () => {
  it.skipIf(process.platform === "darwin")("refuses to construct off macOS", () => {
    expect(() => new KeychainMacosStore()).toThrow(/requires macOS/);
  });

  it("constructs anywhere with allowAnyPlatform (fake spawn only)", () => {
    const store = new KeychainMacosStore({ allowAnyPlatform: true, spawn: fakeSpawn(() => ({ code: 0 }), []) });
    expect(store.kind).toBe("keychain-macos");
    expect(store.dir).toBe(path.join(home, "store"));
    expect(store.indexFile).toBe(path.join(home, "store", KEYCHAIN_INDEX_FILE));
  });
});

describe("KeychainMacosStore (fake /usr/bin/security)", () => {
  it("round-trips values exactly and sends them only over stdin", async () => {
    const db = new Map<string, string>();
    const calls: Call[] = [];
    const store = newStore(db, calls);
    const cases = [
      throwaway(),
      `pässwörd ✓ 🔑 ${randomBytes(4).toString("hex")}`,
      `  leading and trailing ${randomBytes(4).toString("hex")}  `,
      `quotes " ' and \\ backslash ${randomBytes(4).toString("hex")}`,
      `two\nlines ${randomBytes(4).toString("hex")}`,
      `{"v":2,"origin":"http://localhost:3000","environment":"sandbox","secret":"${throwaway()}"}`,
    ];
    for (const [i, value] of cases.entries()) {
      const key = secretKeyFor(`test:local:case${i}`);
      calls.length = 0;
      await store.set(key, value);
      expect(await store.get(key)).toBe(value);

      assertNothingSecretSpawned(calls, value);
      for (const call of calls) expect(call.command).toBe(SECURITY_PATH);
      const setCall = calls[0];
      expect(setCall?.args).toEqual(["-i"]);
      // Key and value travel over stdin only, as one add-generic-password line.
      expect(setCall?.stdin).toBe(
        `add-generic-password -U -s agent-auth -a ${key} -w ${KEYCHAIN_VALUE_PREFIX}${b64(value)}\n`,
      );
      expect(calls.at(-1)?.args).toEqual(["find-generic-password", "-s", "agent-auth", "-a", key, "-w"]);
      // What the keychain holds is the encoded form, never the raw value.
      expect(db.get(key)).toBe(`${KEYCHAIN_VALUE_PREFIX}${b64(value)}`);
    }
  });

  it("returns null for a missing key, deletes true/false, lists from the index", async () => {
    const db = new Map<string, string>();
    const calls: Call[] = [];
    const store = newStore(db, calls);
    const a = secretKeyFor("acme:local:admin");
    const b = secretKeyFor("acme:local:sales");
    expect(await store.get(a)).toBeNull();
    expect(await store.list()).toEqual([]);

    const va = throwaway();
    await store.set(b, throwaway());
    await store.set(a, va);
    expect(await store.list()).toEqual([a, b]);

    const indexText = await fs.readFile(path.join(home, "store", KEYCHAIN_INDEX_FILE), "utf8");
    expect(JSON.parse(indexText)).toEqual([a, b]);
    expect(indexText).not.toContain(va);
    expect(indexText).not.toContain(b64(va));

    // Overwrite with -U replaces the value.
    const va2 = throwaway();
    await store.set(a, va2);
    expect(await store.get(a)).toBe(va2);

    expect(await store.delete(a)).toBe(true);
    expect(await store.delete(a)).toBe(false);
    expect(await store.get(a)).toBeNull();
    expect(await store.list()).toEqual([b]);
    expect(calls.some((c) => c.args[0] === "delete-generic-password" && c.args.includes(a))).toBe(true);
  });

  it("list ignores invalid index entries and does not see items added outside the adapter", async () => {
    const db = new Map<string, string>();
    const store = newStore(db, []);
    const key = secretKeyFor("acme:local:admin");
    await fs.mkdir(path.join(home, "store"), { recursive: true });
    await fs.writeFile(
      path.join(home, "store", KEYCHAIN_INDEX_FILE),
      JSON.stringify([key, "other/x", 42, "agent-auth/../x"]),
    );
    db.set(secretKeyFor("acme:local:external"), `${KEYCHAIN_VALUE_PREFIX}${b64(throwaway())}`);
    expect(await store.list()).toEqual([key]);
  });

  it("returns items written by other tools (no prefix) as printed", async () => {
    const db = new Map<string, string>();
    const store = newStore(db, []);
    const key = secretKeyFor("acme:local:legacy");
    const value = throwaway();
    db.set(key, value);
    expect(await store.get(key)).toBe(value);
  });

  it("refuses invalid keys before spawning", async () => {
    const calls: Call[] = [];
    const store = newStore(new Map(), calls);
    for (const key of ["", "agent-auth/", "other/acme:local:admin", "agent-auth/a b", "agent-auth/x\n-w y"]) {
      await expect(store.set(key, throwaway()), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.get(key), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.delete(key), key).rejects.toThrow(/invalid secret store key/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an over-long value before spawning", async () => {
    const calls: Call[] = [];
    const store = newStore(new Map(), calls);
    await expect(store.set(secretKeyFor("acme:local:admin"), "x".repeat(5000))).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(0);
  });
});

describe("KeychainMacosStore error handling", () => {
  it("sanitizes a failing security: no stdin echo, no base64 blob, capped length", async () => {
    const blob = randomBytes(48).toString("base64");
    const calls: Call[] = [];
    const echoing: Handler = (_args, stdin) => ({
      code: 1,
      stderr: `security: bad input <${stdin.toString("utf8")}> ${blob} ${"noise ".repeat(200)}`,
    });
    const store = new KeychainMacosStore({ spawn: fakeSpawn(echoing, calls), allowAnyPlatform: true });
    const key = secretKeyFor("acme:local:admin");
    const value = `  ${throwaway()} ✓ `;
    const err = await store.set(key, value).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    const message = err?.message ?? "";
    expect(message).toMatch(/^keychain-macos set failed \(exit 1\)/);
    expect(message).not.toContain(value.trim());
    expect(message).not.toContain(b64(value));
    expect(message).not.toContain(blob);
    expect(message.length).toBeLessThan(700);
    assertNothingSecretSpawned(calls, value);
    // Nothing was indexed.
    await expect(fs.readFile(path.join(home, "store", KEYCHAIN_INDEX_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats stderr from interactive mode as failure even when the exit code is 0", async () => {
    const db = new Map<string, string>();
    const inner = securityEmulator(db);
    const quietFailure: Handler = (args, stdin) =>
      args[0] === "-i"
        ? { code: 0, stderr: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\n" }
        : inner(args, stdin);
    const store = new KeychainMacosStore({ spawn: fakeSpawn(quietFailure, []), allowAnyPlatform: true });
    await expect(store.set(secretKeyFor("acme:local:admin"), throwaway())).rejects.toThrow(
      /keychain-macos set failed \(exit 0\): .*User interaction is not allowed/,
    );
  });

  it("fails set when the keychain does not return the value just written", async () => {
    const db = new Map<string, string>();
    const inner = securityEmulator(db);
    const lossy: Handler = (args, stdin) => {
      if (args[0] === "-i") return { code: 0 }; // pretends success, stores nothing
      return inner(args, stdin);
    };
    const store = new KeychainMacosStore({ spawn: fakeSpawn(lossy, []), allowAnyPlatform: true });
    await expect(store.set(secretKeyFor("acme:local:admin"), throwaway())).rejects.toThrow(/did not return the value/);
  });

  it("reports a failing get without the stdout content", async () => {
    const partial = throwaway();
    const store = new KeychainMacosStore({
      spawn: fakeSpawn(() => ({ code: 51, stdout: partial, stderr: `security: oops ${partial}` }), []),
      allowAnyPlatform: true,
    });
    const err = await store.get(secretKeyFor("acme:local:admin")).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/keychain-macos get failed \(exit 51\)/);
    expect(err?.message).not.toContain(partial);
  });

  it("rejects a corrupt encoded item", async () => {
    const db = new Map<string, string>();
    const store = newStore(db, []);
    const key = secretKeyFor("acme:local:admin");
    db.set(key, `${KEYCHAIN_VALUE_PREFIX}not base64!!`);
    await expect(store.get(key)).rejects.toThrow(/corrupt/);
  });

  it("kills a hung security and reports a timeout", async () => {
    const calls: Call[] = [];
    const store = new KeychainMacosStore({ spawn: fakeSpawn(() => "hang", calls), allowAnyPlatform: true, timeoutMs: 50 });
    await expect(store.get(secretKeyFor("acme:local:admin"))).rejects.toThrow(/keychain-macos get failed: security timed out after 50 ms/);
    expect(calls[0]?.killed).toBe(true);
  });

  it("reports a spawn failure by errno code only", async () => {
    const throwing: SpawnLike = () => {
      throw Object.assign(new Error("spawn /usr/bin/security ENOENT"), { code: "ENOENT" });
    };
    const store = new KeychainMacosStore({ spawn: throwing, allowAnyPlatform: true });
    await expect(store.set(secretKeyFor("acme:local:admin"), throwaway())).rejects.toThrow(
      /^keychain-macos set failed: could not start security \(ENOENT\)$/,
    );
  });
});
