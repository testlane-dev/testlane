/**
 * Real-tool tests for the OS keychain adapters. Opt-in: they run only when
 * TESTLANE_REAL_KEYCHAIN=1 (or the legacy AGENT_AUTH_REAL_KEYCHAIN=1; the `keychain` CI jobs set it) and otherwise
 * skip cleanly, so a developer machine's real keychain is never touched by
 * `npm test`.
 *
 *  - darwin: KeychainMacosStore against /usr/bin/security, targeting a
 *    TEMPORARY keychain created (and deleted) by this file, never the login
 *    keychain.
 *  - linux:  SecretServiceStore against the real `secret-tool`, which needs a
 *    session D-Bus and an unlocked Secret Service keyring. CI recipe:
 *      dbus-run-session -- bash -c \
 *        'echo -n "<random>" | gnome-keyring-daemon --unlock --components=secrets \
 *         && TESTLANE_REAL_KEYCHAIN=1 npx vitest run tests/store-real-keychain.test.ts'
 *  - all:    EncryptedFileStore keyed by keychainKeyProvider over the
 *    platform store (DPAPI on win32).
 *
 * Every value is a throwaway generated at test time. Keys carry a random run
 * id and are deleted in afterAll. The "tool contract" blocks probe the raw
 * tool behaviour each adapter relies on, so a failure names the assumption
 * that broke rather than just "round trip failed".
 *
 * The last block always runs (fake spawn, any OS): it covers the adapter
 * pieces the real suites depend on (the macOS `keychain` option, index
 * serialization under concurrent set/delete).
 */
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";
import { DpapiStore, type SpawnLike } from "../src/store/dpapi.js";
import { EncryptedFileStore, keychainKeyProvider } from "../src/store/encrypted-file.js";
import { secretKeyFor, type SecretStore } from "../src/store/index.js";
import {
  KEYCHAIN_PATH_RE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_VALUE_PREFIX,
  KeychainMacosStore,
  SECURITY_PATH,
} from "../src/store/keychain-macos.js";
import { SECRET_SERVICE_ATTR, SECRET_TOOL_MAX_VALUE_BYTES, SecretServiceStore } from "../src/store/secret-service.js";

/** TESTLANE_REAL_KEYCHAIN=1, or the pre-rename AGENT_AUTH_REAL_KEYCHAIN=1 (src/env.ts fallback). */
const REAL = readEnv("TESTLANE_REAL_KEYCHAIN") === "1";
const DARWIN = process.platform === "darwin";
const LINUX = process.platform === "linux";
const WIN32 = process.platform === "win32";
const TIMEOUT = 60_000;

/** Random id shared by every key and probe item of this run. */
const RUN = randomBytes(5).toString("hex");

function hex(n: number): string {
  return randomBytes(n).toString("hex");
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** A valid store key `agent-auth/ci-<run>:<suffix>`; suffix may use ':' '.' '-'. */
function ciKey(suffix: string): string {
  return secretKeyFor(`ci-${RUN}:${suffix}`);
}

function note(message: string): void {
  // Observations only (exit codes, streams, lengths). Never a value.
  console.info(`[real-keychain ${process.platform}] ${message}`);
}

// ---------------------------------------------------------------------------
// Spawn recording and raw tool runner
// ---------------------------------------------------------------------------

interface Spawned {
  command: string;
  args: string[];
}

/** Real child_process.spawn, recording command + argv exactly as the adapter passed them. */
function recordingSpawn(log: Spawned[]): SpawnLike {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    log.push({ command, args: [...args] });
    return nodeSpawn(command, [...args], options);
  };
}

interface Raw {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a tool directly (no shell), feeding `input` on stdin. Probes only; values are throwaways. */
function runRaw(command: string, args: string[], input = ""): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    const child = nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Every argv element of every recorded spawn must be free of every value (and its base64). */
function expectNoValueOnArgv(spawned: Spawned[], values: Iterable<string>): void {
  expect(spawned.length).toBeGreaterThan(0);
  const argv = spawned.flatMap((s) => [s.command, ...s.args]);
  for (const v of values) {
    const needles = [v, b64(v)].filter((n) => n.trim().length >= 8);
    for (const arg of argv) {
      for (const n of needles) expect(arg.includes(n), "a secret value appeared on a spawned argv").toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared store contract
// ---------------------------------------------------------------------------

function sampleValues(): Record<string, string> {
  return {
    ascii: `throwaway-${hex(8)}`,
    unicode: `throwaway-${hex(4)}-ünïcødé-日本語-\u{1F511}`,
    spaces: `  throwaway ${hex(4)} with  inner   spaces  `,
    quotes: `throwaway-${hex(4)}-"double"-'single'-\`back\``,
    backslashes: `throwaway-${hex(4)}-\\path\\to\\x\\\\-\\n-not-a-newline`,
    "command-like": `throwaway-${hex(4)}; add-generic-password -a x -w y $HOME && echo "z"`,
    "embedded-newline": `throwaway-${hex(4)}\nsecond line`,
    "trailing-newline": `throwaway-${hex(4)}\n`,
  };
}

interface ContractOptions {
  /** Largest value (UTF-8 bytes) the adapter accepts; undefined = no cap. */
  maxValueBytes?: number;
}

/**
 * Registers the adapter-level contract tests inside the current describe.
 * `getStore` is called lazily (inside tests) so beforeAll setup can run first.
 */
function storeContract(
  getStore: () => SecretStore,
  getSpawned: () => Spawned[],
  opts: ContractOptions = {},
): { usedKeys: Set<string>; usedValues: Set<string> } {
  const usedKeys = new Set<string>();
  const usedValues = new Set<string>();
  const key = (suffix: string): string => {
    const k = ciKey(suffix);
    usedKeys.add(k);
    return k;
  };
  const val = (v: string): string => {
    usedValues.add(v);
    return v;
  };

  it("list() works on the namespace before anything is written", async () => {
    const keys = await getStore().list();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.filter((k) => k.includes(`ci-${RUN}:`))).toEqual([]);
  });

  it("missing key: get -> null, delete -> false", async () => {
    const store = getStore();
    const k = key("missing.never-set");
    expect(await store.get(k)).toBeNull();
    expect(await store.delete(k)).toBe(false);
  });

  it("round trips throwaway values: unicode, spaces, quotes, backslashes, newlines", async () => {
    const store = getStore();
    for (const [name, v] of Object.entries(sampleValues())) {
      const k = key(`rt:${name}`);
      await store.set(k, val(v));
      expect(await store.get(k), `round trip of the ${name} value`).toBe(v);
    }
  });

  it("round trips profile-style keys containing ':' '.' '-'", async () => {
    const store = getStore();
    const keys = [key("acme:side-by-side:local"), key("globex.portal-v2:sandbox.operator"), key("a-b.c:d-e.f:g")];
    for (const k of keys) {
      const v = val(`throwaway-${hex(8)}`);
      await store.set(k, v);
      expect(await store.get(k)).toBe(v);
    }
  });

  it("a 3000-character value round trips, or is refused cleanly when over the adapter cap", async () => {
    const store = getStore();
    const k = key("long.3000");
    const v = val(`throwaway-${hex(1500)}`.slice(0, 3000));
    expect(v).toHaveLength(3000);
    if (opts.maxValueBytes === undefined || opts.maxValueBytes >= 3000) {
      await store.set(k, v);
      expect(await store.get(k)).toBe(v);
    } else {
      await expect(store.set(k, v)).rejects.toThrow(/too long/);
      expect(await store.get(k)).toBeNull();
    }
  });

  it("overwrite replaces the value and keeps a single list entry", async () => {
    const store = getStore();
    const k = key("overwrite");
    const first = val(`throwaway-first-${hex(6)}`);
    const second = val(`throwaway-second-${hex(6)}`);
    await store.set(k, first);
    await store.set(k, second);
    expect(await store.get(k)).toBe(second);
    expect((await store.list()).filter((x) => x === k)).toHaveLength(1);
  });

  it("concurrent set of two keys: both stored and both listed", async () => {
    const store = getStore();
    const k1 = key("concurrent:one");
    const k2 = key("concurrent:two");
    const v1 = val(`throwaway-c1-${hex(6)}`);
    const v2 = val(`throwaway-c2-${hex(6)}`);
    await Promise.all([store.set(k1, v1), store.set(k2, v2)]);
    expect(await store.get(k1)).toBe(v1);
    expect(await store.get(k2)).toBe(v2);
    const listed = await store.list();
    expect(listed).toContain(k1);
    expect(listed).toContain(k2);
  });

  it("list returns keys only, sorted, never values", async () => {
    const store = getStore();
    const listed = await store.list();
    expect([...listed].sort()).toEqual(listed);
    for (const k of usedKeys) {
      if (k.includes(":missing.") || k.endsWith(":long.3000")) continue;
      expect(listed, `list should contain ${k}`).toContain(k);
    }
    const text = JSON.stringify(listed);
    for (const v of usedValues) if (v.trim().length >= 8) expect(text.includes(v)).toBe(false);
  });

  it("delete -> true, then get -> null, delete -> false, not listed", async () => {
    const store = getStore();
    const k = key("delete-me");
    await store.set(k, val(`throwaway-${hex(6)}`));
    expect(await store.delete(k)).toBe(true);
    expect(await store.get(k)).toBeNull();
    expect(await store.delete(k)).toBe(false);
    expect(await store.list()).not.toContain(k);
  });

  it("no spawned argv ever contained a value", () => {
    expectNoValueOnArgv(getSpawned(), usedValues);
  });

  return { usedKeys, usedValues };
}

async function deleteAll(store: SecretStore | undefined, keys: Iterable<string>): Promise<void> {
  if (!store) return;
  for (const k of keys) await store.delete(k).catch(() => undefined);
}

// ---------------------------------------------------------------------------

describe.runIf(REAL)("real OS keychain (TESTLANE_REAL_KEYCHAIN=1)", { timeout: TIMEOUT }, () => {
  let tmp = "";
  /** darwin only: the temporary keychain every macOS store targets. */
  let keychain = "";

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "testlane-real-kc-")));
    if (DARWIN) {
      keychain = path.join(tmp, `testlane-ci-${RUN}.keychain-db`);
      expect(keychain, "temp keychain path must be a single interactive token").toMatch(KEYCHAIN_PATH_RE);
      const pw = hex(16); // throwaway password for a throwaway keychain
      execFileSync(SECURITY_PATH, ["create-keychain", "-p", pw, keychain], { stdio: "pipe" });
      expect(existsSync(keychain), "security create-keychain did not create the requested path").toBe(true);
      execFileSync(SECURITY_PATH, ["unlock-keychain", "-p", pw, keychain], { stdio: "pipe" });
      // No -t: never auto-lock during the run.
      execFileSync(SECURITY_PATH, ["set-keychain-settings", keychain], { stdio: "pipe" });
      note(`temporary keychain created`);
    }
  }, TIMEOUT);

  afterAll(async () => {
    if (DARWIN && keychain !== "") {
      try {
        execFileSync(SECURITY_PATH, ["delete-keychain", keychain], { stdio: "pipe" });
      } catch {
        // already gone
      }
    }
    if (tmp !== "") await fs.rm(tmp, { recursive: true, force: true });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // macOS
  // -------------------------------------------------------------------------
  describe.runIf(DARWIN)("KeychainMacosStore (darwin, temporary keychain)", () => {
    const spawned: Spawned[] = [];
    let store: KeychainMacosStore | undefined;
    const getStore = (): KeychainMacosStore => {
      store ??= new KeychainMacosStore({ dir: path.join(tmp, "macos-index"), keychain, spawn: recordingSpawn(spawned) });
      return store;
    };
    const stripPrompts = (s: string): string => s.split("security> ").join("").trim();
    const probeService = `testlane-ci-probe-${RUN}`;

    describe("tool contract: /usr/bin/security", () => {
      it("security -i: a successful command exits 0 at end of input and leaves only prompts on stderr", async () => {
        const v = `throwaway-${hex(8)}`;
        const r = await runRaw(
          SECURITY_PATH,
          ["-i"],
          `add-generic-password -U -s ${probeService} -a ok -w ${v} ${keychain}\n`,
        );
        note(
          `security -i success: exit=${String(r.code)} promptOnStdout=${r.stdout.includes("security> ")} ` +
            `promptOnStderr=${r.stderr.includes("security> ")} stderrAfterPrompts=${JSON.stringify(stripPrompts(r.stderr).slice(0, 200))}`,
        );
        expect(r.code).toBe(0);
        expect(stripPrompts(r.stderr)).toBe("");
        const found = await runRaw(SECURITY_PATH, ["find-generic-password", "-s", probeService, "-a", "ok", "-w", keychain]);
        expect(found.code).toBe(0);
        expect(found.stdout).toBe(`${v}\n`);
      });

      it("security -i: a failing command is visible as a non-zero exit or non-prompt stderr", async () => {
        const r = await runRaw(
          SECURITY_PATH,
          ["-i"],
          `find-generic-password -s ${probeService} -a never-${hex(4)} ${keychain}\n`,
        );
        note(
          `security -i failure: exit=${String(r.code)} stderrAfterPrompts=${JSON.stringify(stripPrompts(r.stderr).slice(0, 200))}`,
        );
        expect(r.code !== 0 || stripPrompts(r.stderr) !== "").toBe(true);
      });

      it("find-generic-password -w exits 44 (errSecItemNotFound) for a missing item", async () => {
        const r = await runRaw(SECURITY_PATH, [
          "find-generic-password",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          ciKey("raw.missing"),
          "-w",
          keychain,
        ]);
        expect(r.code).toBe(44);
        expect(r.stdout).toBe("");
      });

      it("delete-generic-password exits 44 for a missing item", async () => {
        const r = await runRaw(SECURITY_PATH, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ciKey("raw.missing"), keychain]);
        expect(r.code).toBe(44);
      });

      it("security -i keeps a key with '/' ':' '.' '-' as one token (raw argv lookup finds the item)", async () => {
        const k = ciKey("tok/en:iz.er-check");
        // Not a valid store key ('/' inside the name), so drive security directly.
        const v = `throwaway-${hex(8)}`;
        const add = await runRaw(SECURITY_PATH, ["-i"], `add-generic-password -U -s ${probeService} -a ${k} -w ${v} ${keychain}\n`);
        expect(add.code).toBe(0);
        const found = await runRaw(SECURITY_PATH, ["find-generic-password", "-s", probeService, "-a", k, "-w", keychain]);
        expect(found.code).toBe(0);
        expect(found.stdout).toBe(`${v}\n`);
      });

      it("the stored item is exactly agent-auth-b64:<base64 UTF-8> and -w prints it plus one newline", async () => {
        const k = ciKey("raw.b64-format");
        const v = `throwaway-${hex(4)}-ünïcødé-\u{1F511} "q" \\b`;
        await getStore().set(k, v);
        const r = await runRaw(SECURITY_PATH, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", k, "-w", keychain]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`${KEYCHAIN_VALUE_PREFIX}${b64(v)}\n`);
        expect(await getStore().delete(k)).toBe(true);
      });

      it("the largest value under the adapter's line cap round trips untruncated", async () => {
        const store = getStore();
        const k = ciKey("long.at-cap");
        let accepted = -1;
        for (let len = 3000; len > 0; len--) {
          const v = hex(len).slice(0, len);
          try {
            await store.set(k, v); // refused before any spawn when over the cap
            accepted = len;
            expect(await store.get(k)).toBe(v);
            break;
          } catch (err) {
            if (!/too long/.test(String(err))) throw err;
          }
        }
        note(`largest accepted ASCII value: ${accepted} bytes`);
        expect(accepted).toBeGreaterThan(2500);
        expect(await store.delete(k)).toBe(true);
      });

      it("informational: a raw ~4095-byte interactive line (beyond the adapter cap)", async () => {
        const acct = `cap-${hex(4)}`;
        const head = `add-generic-password -U -s ${probeService} -a ${acct} -w `;
        const tail = ` ${keychain}\n`;
        const fill = 4095 - Buffer.byteLength(head + tail);
        const v = "x".repeat(Math.max(fill, 1));
        const r = await runRaw(SECURITY_PATH, ["-i"], `${head}${v}${tail}`);
        const found = await runRaw(SECURITY_PATH, ["find-generic-password", "-s", probeService, "-a", acct, "-w", keychain]);
        note(
          `4095-byte line: add exit=${String(r.code)} stderrAfterPrompts=${JSON.stringify(stripPrompts(r.stderr).slice(0, 120))} ` +
            `find exit=${String(found.code)} storedLength=${found.stdout.replace(/\n$/, "").length} expected=${v.length}`,
        );
        expect(true).toBe(true);
      });

      it("a failed add (nonexistent keychain) makes set() reject without echoing the value", async () => {
        const bad = new KeychainMacosStore({
          dir: path.join(tmp, "macos-bad-index"),
          keychain: path.join(tmp, `does-not-exist-${RUN}.keychain-db`),
          timeoutMs: 15_000,
        });
        const v = `throwaway-${hex(8)}`;
        const err = await bad.set(ciKey("bad-keychain"), v).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        note(`set on missing keychain: ${message.slice(0, 200)}`);
        expect(message).not.toContain(v);
        expect(message).not.toContain(b64(v));
      });
    });

    describe("adapter contract", () => {
      const used = storeContract(getStore, () => spawned, { maxValueBytes: 2900 });
      afterAll(async () => {
        await deleteAll(store, used.usedKeys);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Linux
  // -------------------------------------------------------------------------
  describe.runIf(LINUX)("SecretServiceStore (linux, real secret-tool)", () => {
    const spawned: Spawned[] = [];
    let store: SecretServiceStore | undefined;
    const getStore = (): SecretServiceStore => {
      store ??= new SecretServiceStore({ spawn: recordingSpawn(spawned) });
      return store;
    };
    const probeAttr = `testlane-ci-probe-${RUN}`;

    afterAll(async () => {
      for (const k of ["exact", "clear", "big"]) {
        await runRaw("secret-tool", ["clear", "service", probeAttr, "key", k]).catch(() => undefined);
      }
    });

    describe("tool contract: secret-tool", () => {
      it("store reads stdin exactly (no newline stripping) and lookup adds no newline on a pipe", async () => {
        const v = `  throwaway ${hex(6)} \\ "q"\n\n`;
        const st = await runRaw("secret-tool", ["store", "--label=probe", "service", probeAttr, "key", "exact"], v);
        expect(st.code).toBe(0);
        const lk = await runRaw("secret-tool", ["lookup", "service", probeAttr, "key", "exact"]);
        expect(lk.code).toBe(0);
        expect(lk.stdout).toBe(v);
      });

      it("lookup of a missing item exits 1 with no stdout and no stderr", async () => {
        const r = await runRaw("secret-tool", ["lookup", "service", probeAttr, "key", `never-${hex(4)}`]);
        note(`lookup missing: exit=${String(r.code)} stdoutLen=${r.stdout.length} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr.trim()).toBe("");
      });

      it("clear exits 0 for an existing item and 1 with no output for a missing one", async () => {
        const st = await runRaw("secret-tool", ["store", "--label=probe", "service", probeAttr, "key", "clear"], `throwaway-${hex(6)}`);
        expect(st.code).toBe(0);
        const hit = await runRaw("secret-tool", ["clear", "service", probeAttr, "key", "clear"]);
        expect(hit.code).toBe(0);
        const gone = await runRaw("secret-tool", ["lookup", "service", probeAttr, "key", "clear"]);
        expect(gone.code).toBe(1);
        const miss = await runRaw("secret-tool", ["clear", "service", probeAttr, "key", "clear"]);
        note(`clear missing: exit=${String(miss.code)}`);
        // Observed on ubuntu-latest (2026-09-25): exit 1, no stdout, no stderr.
        expect(miss.code).toBe(1);
        expect(miss.stdout.length).toBe(0);
        expect(miss.stderr.trim()).toBe("");
      });

      it("search --all prints `attribute.key = <key>` lines (stdout or stderr) for matching items", async () => {
        const k = ciKey("raw.search");
        await getStore().set(k, `throwaway-${hex(6)}`);
        const r = await runRaw("secret-tool", ["search", "--all", "service", SECRET_SERVICE_ATTR]);
        const line = `attribute.key = ${k}`;
        const onOut = r.stdout.split(/\r?\n/).includes(line);
        const onErr = r.stderr.split(/\r?\n/).includes(line);
        note(
          `search --all: exit=${String(r.code)} attrOnStdout=${onOut} attrOnStderr=${onErr} ` +
            `secretLineOnStdout=${/^secret = /m.test(r.stdout)} labelOnStdout=${/^label = /m.test(r.stdout)}`,
        );
        expect(r.code).toBe(0);
        expect(onOut || onErr).toBe(true);
        expect(await getStore().delete(k)).toBe(true);
      });

      it("search --all with no match: exit 0, or exit 1 with no output (the adapter's 'nothing' case)", async () => {
        const r = await runRaw("secret-tool", ["search", "--all", "service", `testlane-ci-none-${RUN}`]);
        note(`search no match: exit=${String(r.code)} stdoutLen=${r.stdout.length} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
        const nothing = r.code === 1 && r.stdout.trim() === "" && r.stderr.trim() === "";
        expect(r.code === 0 || nothing).toBe(true);
        expect(r.stdout).not.toMatch(/^attribute\.key = /m);
      });

      it("informational: raw store of a 9000-byte value (secret-tool's 8 KiB stdin buffer)", async () => {
        const v = "y".repeat(9000);
        const st = await runRaw("secret-tool", ["store", "--label=probe", "service", probeAttr, "key", "big"], v);
        const lk = await runRaw("secret-tool", ["lookup", "service", probeAttr, "key", "big"]);
        note(
          `9000-byte store: exit=${String(st.code)} stderr=${JSON.stringify(st.stderr.slice(0, 120))} ` +
            `lookup exit=${String(lk.code)} storedLength=${lk.stdout.length}`,
        );
        expect(true).toBe(true);
      });

      it("a value at the adapter cap round trips exactly; one byte more is refused before spawning", async () => {
        const store = getStore();
        const k = ciKey("long.at-cap");
        const v = hex(SECRET_TOOL_MAX_VALUE_BYTES).slice(0, SECRET_TOOL_MAX_VALUE_BYTES);
        await store.set(k, v);
        expect(await store.get(k)).toBe(v);
        const before = spawned.length;
        await expect(store.set(k, `${v}z`)).rejects.toThrow(/too long/);
        expect(spawned.length).toBe(before);
        expect(await store.get(k)).toBe(v);
        expect(await store.delete(k)).toBe(true);
      });
    });

    describe("adapter contract", () => {
      const used = storeContract(getStore, () => spawned, { maxValueBytes: SECRET_TOOL_MAX_VALUE_BYTES });
      afterAll(async () => {
        await deleteAll(store, used.usedKeys);
      });
    });
  });

  // -------------------------------------------------------------------------
  // All platforms: encrypted-file keyed from the platform keychain
  // -------------------------------------------------------------------------
  describe.runIf(DARWIN || LINUX || WIN32)("EncryptedFileStore over keychainKeyProvider(platform store)", () => {
    const spawned: Spawned[] = [];
    const dataKeyName = ciKey("encrypted-file.data-key");
    let inner: SecretStore | undefined;
    let store: EncryptedFileStore | undefined;

    const makeInner = (log: Spawned[]): SecretStore => {
      const spawn = recordingSpawn(log);
      if (DARWIN) return new KeychainMacosStore({ dir: path.join(tmp, "enc-inner-index"), keychain, spawn });
      if (LINUX) return new SecretServiceStore({ spawn });
      return new DpapiStore({ dir: path.join(tmp, "enc-inner-dpapi"), spawn });
    };
    const getStore = (): EncryptedFileStore => {
      if (!store) {
        inner = makeInner(spawned);
        store = new EncryptedFileStore({ dir: path.join(tmp, "enc"), keyProvider: keychainKeyProvider(inner, dataKeyName) });
      }
      return store;
    };

    const used = storeContract(getStore, () => spawned);

    it("the data key lives in the platform store as 32 bytes of base64 and a fresh provider reuses it", async () => {
      const k = ciKey("enc.reopen");
      const v = `throwaway-${hex(8)}`;
      await getStore().set(k, v);
      const stored = await (inner as SecretStore).get(dataKeyName);
      expect(stored).not.toBeNull();
      expect(Buffer.from((stored as string).trim(), "base64")).toHaveLength(32);
      const reopened = new EncryptedFileStore({
        dir: path.join(tmp, "enc"),
        keyProvider: keychainKeyProvider(makeInner([]), dataKeyName),
      });
      expect(await reopened.get(k)).toBe(v);
      expectNoValueOnArgv(spawned, [stored as string, v]);
      await getStore().delete(k);
    });

    afterAll(async () => {
      await deleteAll(store, used.usedKeys);
      await deleteAll(inner, [dataKeyName]);
    });
  });
});

// ---------------------------------------------------------------------------
// Always runs (any OS, fake spawn): the `keychain` option and in-process index
// serialization that the real suites above depend on.
// ---------------------------------------------------------------------------

interface FakeCall {
  args: string[];
  stdin: string;
}

/** Minimal `security` emulator: items keyed by account; honours -i, find -w, delete. */
function fakeSecurity(calls: FakeCall[]): SpawnLike {
  const items = new Map<string, string>();
  return (_command: string, args: readonly string[]): ChildProcess => {
    const call: FakeCall = { args: [...args], stdin: "" };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, kill: () => true });
    const chunks: Buffer[] = [];
    stdin.on("data", (c: Buffer) => chunks.push(c));
    stdin.on("end", () => {
      call.stdin = Buffer.concat(chunks).toString("utf8");
      let code = 0;
      const argOf = (list: string[], flag: string): string => list[list.indexOf(flag) + 1] ?? "";
      if (args[0] === "-i") {
        const tokens = call.stdin.trim().split(" ");
        items.set(argOf(tokens, "-a"), argOf(tokens, "-w"));
      } else if (args[0] === "find-generic-password") {
        const v = items.get(argOf(call.args, "-a"));
        if (v === undefined) code = 44;
        else stdout.write(`${v}\n`);
      } else if (args[0] === "delete-generic-password") {
        code = items.delete(argOf(call.args, "-a")) ? 0 : 44;
      }
      // Let the adapter's data listeners drain before close.
      setImmediate(() => {
        stdout.end();
        stderr.end();
        child.emit("close", code, null);
      });
    });
    return child as unknown as ChildProcess;
  };
}

describe("KeychainMacosStore keychain option and index serialization (fake spawn)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-kc-opt-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends the keychain path as the trailing operand of every command, never the value", async () => {
    const calls: FakeCall[] = [];
    const kc = "/tmp/testlane-ci.keychain-db";
    const store = new KeychainMacosStore({ dir, keychain: kc, spawn: fakeSecurity(calls), allowAnyPlatform: true });
    const k = secretKeyFor("acme:side-by-side:local");
    const v = `throwaway-${hex(8)}`;
    await store.set(k, v);
    expect(await store.get(k)).toBe(v);
    expect(await store.delete(k)).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual([
      "-i",
      "find-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ]);
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.stdin).toBe(
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${k} -w ${KEYCHAIN_VALUE_PREFIX}${b64(v)} ${kc}\n`,
    );
    for (const c of calls.slice(1)) expect(c.args.at(-1)).toBe(kc);
    expectNoValueOnArgv(
      calls.map((c) => ({ command: SECURITY_PATH, args: c.args })),
      [v],
    );
  });

  it("without the option the argv is unchanged (no trailing operand)", async () => {
    const calls: FakeCall[] = [];
    const store = new KeychainMacosStore({ dir, spawn: fakeSecurity(calls), allowAnyPlatform: true });
    const k = secretKeyFor("plain");
    await store.set(k, `throwaway-${hex(8)}`);
    expect(calls[1]?.args).toEqual(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", k, "-w"]);
    expect(calls[0]?.stdin).toMatch(/ -w agent-auth-b64:[A-Za-z0-9+/]+={0,2}\n$/);
    await store.delete(k);
    expect(calls.at(-1)?.args).toEqual(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", k]);
  });

  it("refuses a keychain path that is not a single safe absolute token", () => {
    for (const bad of ["relative.keychain-db", "/tmp/with space.keychain-db", "/tmp/q\"uote", "/tmp/back\\slash", ""]) {
      expect(() => new KeychainMacosStore({ dir, keychain: bad, allowAnyPlatform: true })).toThrow(/keychain must be/);
    }
  });

  it("concurrent set() calls on one index file never lose a key", async () => {
    const calls: FakeCall[] = [];
    const spawn = fakeSecurity(calls);
    const a = new KeychainMacosStore({ dir: path.join(dir, "race"), spawn, allowAnyPlatform: true });
    const b = new KeychainMacosStore({ dir: path.join(dir, "race"), spawn, allowAnyPlatform: true });
    const keys = Array.from({ length: 8 }, (_, i) => secretKeyFor(`race:k${i}`));
    await Promise.all(keys.map((k, i) => (i % 2 === 0 ? a : b).set(k, `throwaway-${hex(6)}`)));
    expect(await a.list()).toEqual([...keys].sort());
    await Promise.all(keys.slice(0, 4).map((k) => b.delete(k)));
    expect(await a.list()).toEqual(keys.slice(4).sort());
  });
});
