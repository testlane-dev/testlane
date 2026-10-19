/**
 * macOS secret store backed by the login keychain via `/usr/bin/security`.
 *
 * Items are generic passwords with service "agent-auth" and account = the store
 * key (`agent-auth/<profile name>`).
 *
 * Secret transport:
 *  - set: `/usr/bin/security -i` (interactive mode, commands read from stdin)
 *    is spawned with no other arguments, and the single line
 *    `add-generic-password -U -s agent-auth -a <key> -w <encoded value>` is
 *    written to its stdin. The key and the value therefore travel over stdin
 *    ONLY; neither appears on any process argv or in the environment.
 *  - get: `security find-generic-password -s agent-auth -a <key> -w` (the key
 *    is on argv, which is fine: it is a profile name, not a secret); the value
 *    comes back ONLY over stdout. Exit 44 (errSecItemNotFound) means absent.
 *  - delete: `security delete-generic-password -s agent-auth -a <key>`.
 *
 * Value encoding: the stored password is `agent-auth-b64:<base64 of the UTF-8
 * value>`. This keeps the interactive command line free of whitespace, quotes,
 * backslashes and newlines (so a value can never be parsed as a second
 * `security -i` command, and no quoting rules of the interactive tokenizer are
 * relied on), and it sidesteps `find-generic-password -w` printing non-ASCII
 * passwords as hex. Items without the prefix (written by other tools) are
 * returned as printed, minus one trailing newline.
 *
 * Listing: `security dump-keychain` is too noisy (and touches every item), so
 * this adapter keeps a NON-SECRET index file `<dir>/keychain-macos.index.json`
 * (a sorted JSON array of keys), updated on set/delete. Limitation: items
 * added or removed outside this adapter (Keychain Access, another `security`
 * call) are not reflected in list(), and concurrent writers may race on the
 * index (within one process, index updates are serialized per index file).
 * get/set/delete always go to the keychain itself.
 *
 * Keychain: by default every command uses the user's default keychain search
 * list. The optional `keychain` option (an absolute path such as a temporary
 * `.keychain-db` created for CI) is appended as the trailing keychain operand
 * of every command, including the interactive line; it must therefore be a
 * single whitespace-, quote- and backslash-free token.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { storeDir } from "../paths.js";
import { sanitizeStderr, type SpawnLike } from "./dpapi.js";
import { assertValidStoreKey, isValidStoreKey, type SecretStore } from "./index.js";

export interface KeychainMacosStoreOptions {
  /** Directory holding the non-secret index file. Defaults to storeDir(). */
  dir?: string;
  /** Test hook: replaces child_process.spawn. Never used to pass data. */
  spawn?: SpawnLike;
  /** Milliseconds before a `security` child is killed. Default 30 s. */
  timeoutMs?: number;
  /** Test hook: skip the darwin platform guard (only meaningful with a fake spawn). */
  allowAnyPlatform?: boolean;
  /**
   * Absolute path of a specific keychain file to use instead of the default
   * search list (e.g. a temporary keychain in CI). Must match
   * KEYCHAIN_PATH_RE. Default: unset (default keychain behaviour unchanged).
   */
  keychain?: string;
}

export const SECURITY_PATH = "/usr/bin/security";
/**
 * Keychain service name. Stable storage identifier: kept as "agent-auth" after
 * the rename to Testlane for compatibility (existing items are found by it).
 */
export const KEYCHAIN_SERVICE = "agent-auth";
export const KEYCHAIN_INDEX_FILE = "keychain-macos.index.json";
/** Prefix marking a value this adapter encoded. Stable storage identifier (see KEYCHAIN_SERVICE). */
export const KEYCHAIN_VALUE_PREFIX = "agent-auth-b64:";
/** errSecItemNotFound, as returned by `security` when no item matches. */
const EXIT_NOT_FOUND = 44;
/** Conservative cap on the one interactive command line (security's line buffer is finite). */
export const KEYCHAIN_MAX_COMMAND_LINE = 4000;
/** Allowed `keychain` option: an absolute path that is one token of the interactive tokenizer. */
export const KEYCHAIN_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
/** Per-index-file promise chains serializing index updates within this process. */
const indexLocks = new Map<string, Promise<void>>();
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Shared child runner (also used by secret-service.ts). Candidate to move into
// a shared src/store/exec.ts once dpapi.ts can be refactored onto it.
// ---------------------------------------------------------------------------

export interface ToolRunOptions {
  spawn: SpawnLike;
  command: string;
  /** Fixed arguments. Callers must never put a secret here. */
  args: readonly string[];
  /** Bytes written to stdin, then stdin is closed. Zeroed after the child exits. */
  input?: Buffer;
  timeoutMs: number;
  /** Prefix for error messages, e.g. "keychain-macos get". */
  label: string;
}

export interface ToolResult {
  code: number | null;
  /** Raw stdout. The caller must zero it (fill(0)) once done. */
  stdout: Buffer;
  stderr: string;
}

/**
 * Spawn `command args` without a shell, feed `input` over stdin, collect
 * stdout/stderr. Rejects only when the child could not be started or timed
 * out; a non-zero exit resolves so the caller can interpret it. Rejection
 * messages carry the tool's basename and an errno code, never data.
 */
export function runTool(opts: ToolRunOptions): Promise<ToolResult> {
  const tool = path.posix.basename(opts.command.replace(/\\/g, "/"));
  return new Promise<ToolResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const wipe = (): void => {
      opts.input?.fill(0);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const c of outChunks) c.fill(0);
      wipe();
      reject(new Error(`${opts.label} failed: ${message}`));
    };

    let child: ChildProcess;
    try {
      child = opts.spawn(opts.command, opts.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      fail(`could not start ${tool} (${errCode(err)})`);
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      fail(`${tool} timed out after ${opts.timeoutMs} ms`);
    }, opts.timeoutMs);

    child.stdout?.on("data", (c: Buffer | string) => outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")));
    child.stderr?.on("data", (c: Buffer | string) => errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")));
    child.on("error", (err) => fail(`could not run ${tool} (${errCode(err)})`));
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      wipe();
      const stdout = Buffer.concat(outChunks);
      for (const c of outChunks) c.fill(0);
      resolve({ code, stdout, stderr: Buffer.concat(errChunks).toString("utf8") });
    });

    // Swallow EPIPE if the child dies before reading; the close handler reports it.
    child.stdin?.on("error", () => undefined);
    if (opts.input) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Error for a non-zero exit, with sanitized stderr only (never stdin, never stdout). */
export function toolError(label: string, result: ToolResult, sensitive: readonly string[]): Error {
  return new Error(`${label} failed (exit ${String(result.code)}): ${sanitizeStderr(result.stderr, sensitive)}`);
}

export function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
  }
  return "unknown error";
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

// ---------------------------------------------------------------------------

export class KeychainMacosStore implements SecretStore {
  readonly kind = "keychain-macos";
  readonly dir: string;
  readonly indexFile: string;
  private readonly spawnFn: SpawnLike;
  private readonly timeoutMs: number;
  /** Trailing keychain operand ([] for the default search list). */
  private readonly keychainArgs: readonly string[];

  constructor(opts: KeychainMacosStoreOptions = {}) {
    if (process.platform !== "darwin" && opts.allowAnyPlatform !== true) {
      throw new Error(
        `KeychainMacosStore requires macOS (/usr/bin/security); this platform is ${process.platform}. Use selectStore() to pick the platform's secret store.`,
      );
    }
    this.dir = opts.dir ?? storeDir();
    this.indexFile = path.join(this.dir, KEYCHAIN_INDEX_FILE);
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnLike);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (opts.keychain !== undefined && !KEYCHAIN_PATH_RE.test(opts.keychain)) {
      throw new Error(
        "KeychainMacosStore keychain must be an absolute path of letters, digits, '.', '_', '-' and '/' only",
      );
    }
    this.keychainArgs = opts.keychain === undefined ? [] : [opts.keychain];
  }

  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    const result = await this.run("get", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      key,
      "-w",
      ...this.keychainArgs,
    ]);
    try {
      if (result.code === EXIT_NOT_FOUND) return null;
      if (result.code !== 0) throw toolError("keychain-macos get", result, [result.stdout.toString("utf8")]);
      return decodeStored(result.stdout);
    } finally {
      result.stdout.fill(0);
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertValidStoreKey(key);
    if (typeof value !== "string") throw new Error("keychain-macos set failed: value must be a string");
    const plain = Buffer.from(value, "utf8");
    const valueB64 = plain.toString("base64");
    plain.fill(0);
    const encoded = `${KEYCHAIN_VALUE_PREFIX}${valueB64}`;
    const trailer = this.keychainArgs.map((k) => ` ${k}`).join("");
    const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${key} -w ${encoded}${trailer}\n`;
    if (Buffer.byteLength(line, "utf8") > KEYCHAIN_MAX_COMMAND_LINE) {
      throw new Error("keychain-macos set failed: value too long for the keychain adapter");
    }
    const sensitive = [value, valueB64, encoded];
    const result = await this.run("set", ["-i"], Buffer.from(line, "utf8"));
    result.stdout.fill(0);
    // Interactive mode may not reflect a failed command in its exit code, so
    // any stderr output (other than a prompt) also counts as failure.
    const stderr = result.stderr.split("security> ").join("").trim();
    if (result.code !== 0 || stderr !== "") throw toolError("keychain-macos set", result, sensitive);

    // Verify the item really holds the new value (catches silent failures and truncation).
    const stored = await this.get(key);
    if (stored !== value) {
      throw new Error("keychain-macos set failed: the keychain did not return the value just written");
    }
    await this.updateIndex((keys) => keys.add(key));
  }

  async delete(key: string): Promise<boolean> {
    assertValidStoreKey(key);
    const result = await this.run("delete", [
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      key,
      ...this.keychainArgs,
    ]);
    result.stdout.fill(0);
    let deleted: boolean;
    if (result.code === 0) deleted = true;
    else if (result.code === EXIT_NOT_FOUND) deleted = false;
    else throw toolError("keychain-macos delete", result, []);
    await this.updateIndex((keys) => keys.delete(key));
    return deleted;
  }

  /** Keys from the non-secret index (see the module comment for the limitation). */
  async list(): Promise<string[]> {
    return [...(await this.readIndex())].sort();
  }

  private run(op: string, args: readonly string[], input?: Buffer): Promise<ToolResult> {
    return runTool({
      spawn: this.spawnFn,
      command: SECURITY_PATH,
      args,
      ...(input === undefined ? {} : { input }),
      timeoutMs: this.timeoutMs,
      label: `keychain-macos ${op}`,
    });
  }

  private async readIndex(): Promise<Set<string>> {
    let text: string;
    try {
      text = await fs.readFile(this.indexFile, "utf8");
    } catch (err) {
      if (isErrno(err, "ENOENT")) return new Set();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`keychain-macos index is corrupt (not JSON): ${this.indexFile}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`keychain-macos index is corrupt (not an array): ${this.indexFile}`);
    return new Set(parsed.filter((k): k is string => typeof k === "string" && isValidStoreKey(k)));
  }

  /**
   * Read-modify-write of the index, serialized per index file within this
   * process so concurrent set()/delete() calls cannot lose each other's keys.
   */
  private async updateIndex(mutate: (keys: Set<string>) => void): Promise<void> {
    const file = this.indexFile;
    const prev = indexLocks.get(file) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    indexLocks.set(file, tail);
    await prev;
    try {
      await this.writeIndex(mutate);
    } finally {
      release();
      if (indexLocks.get(file) === tail) indexLocks.delete(file);
    }
  }

  private async writeIndex(mutate: (keys: Set<string>) => void): Promise<void> {
    const keys = await this.readIndex();
    mutate(keys);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexFile}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify([...keys].sort(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, this.indexFile);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

/** Decode `find-generic-password -w` output (one trailing newline stripped). */
function decodeStored(stdout: Buffer): string {
  let text = stdout.toString("utf8");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (!text.startsWith(KEYCHAIN_VALUE_PREFIX)) return text;
  const b64 = text.slice(KEYCHAIN_VALUE_PREFIX.length);
  if (!BASE64_RE.test(b64)) throw new Error("keychain-macos get failed: stored item for this key is corrupt");
  const plain = Buffer.from(b64, "base64");
  try {
    return plain.toString("utf8");
  } finally {
    plain.fill(0);
  }
}
