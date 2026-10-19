/**
 * Windows secret store backed by DPAPI (CurrentUser scope).
 *
 * Each key is kept in `<dir>/<encodeKeyForFile(key)>.dpapi`, whose contents are
 * the base64 of the DPAPI ciphertext. Only the same Windows user on the same
 * machine can decrypt it.
 *
 * Encryption and decryption run in a short-lived `powershell.exe` child using
 * System.Security.Cryptography.ProtectedData. The PowerShell scripts are fixed
 * constants passed via -EncodedCommand; the secret (as base64 of its UTF-8
 * bytes) travels ONLY over the child's stdin, and the result comes back ONLY
 * over its stdout. Nothing secret is ever placed on argv or in the environment,
 * and error messages carry sanitized stderr only.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { storeDir } from "../paths.js";
import {
  assertValidStoreKey,
  decodeKeyFromFile,
  encodeKeyForFile,
  isValidStoreKey,
  type SecretStore,
} from "./index.js";

/** Minimal spawn signature, injectable so tests can observe argv/env of every child. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface DpapiStoreOptions {
  /** Directory holding the `.dpapi` files. Defaults to storeDir(). */
  dir?: string;
  /** Test hook: replaces child_process.spawn. Never used to pass data. */
  spawn?: SpawnLike;
  /** Milliseconds before a PowerShell child is killed. Default 30 s. */
  timeoutMs?: number;
}

const FILE_SUFFIX = ".dpapi";
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/*
 * Optional entropy for ProtectedData: the UTF-8 bytes of the constant string
 * "agent-auth-vault/v1". It is NOT a secret and does not bind ciphertexts to
 * this tool in any security sense: any process running as the same Windows
 * user can read this constant and call Unprotect. It only namespaces the
 * ciphertexts (a blob protected by another program with different or no
 * entropy will not decrypt here, and vice versa) and versions the format.
 * Changing it makes every existing .dpapi file unreadable. Stable storage
 * identifier: kept verbatim after the rename to Testlane for compatibility.
 */
const ENTROPY_LABEL = "agent-auth-vault/v1";

function buildScript(op: "Protect" | "Unprotect"): string {
  // Reads base64 from stdin, writes base64 to stdout as raw ASCII bytes.
  // Never echoes its input; the catch block reports only the exception type/message.
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$inBytes = $null",
    "$outBytes = $null",
    "try {",
    "  Add-Type -AssemblyName System.Security",
    "  $inText = [Console]::In.ReadToEnd()",
    "  $inBytes = [Convert]::FromBase64String($inText.Trim())",
    "  $inText = $null",
    `  $entropy = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY_LABEL}')`,
    `  $outBytes = [System.Security.Cryptography.ProtectedData]::${op}($inBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "  $ascii = [System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($outBytes))",
    "  $stdout = [Console]::OpenStandardOutput()",
    "  $stdout.Write($ascii, 0, $ascii.Length)",
    "  $stdout.Flush()",
    "  exit 0",
    "} catch {",
    `  [Console]::Error.WriteLine('DPAPI ${op} failed: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message)`,
    "  exit 1",
    "} finally {",
    "  if ($null -ne $inBytes) { [Array]::Clear($inBytes, 0, $inBytes.Length) }",
    "  if ($null -ne $outBytes) { [Array]::Clear($outBytes, 0, $outBytes.Length) }",
    "}",
  ].join("\n");
}

function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const ENCODED_SCRIPTS = {
  Protect: encodeCommand(buildScript("Protect")),
  Unprotect: encodeCommand(buildScript("Unprotect")),
} as const;

/** Absolute path to Windows PowerShell 5.1 when resolvable (avoids PATH hijack); else the bare name. */
function powershellPath(): string {
  const root = process.env["SystemRoot"] ?? process.env["windir"];
  if (root && root.trim() !== "") {
    return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  return "powershell.exe";
}

/**
 * Remove anything resembling a base64 blob from child stderr, plus any exact
 * sensitive strings we know about, and cap its length.
 */
export function sanitizeStderr(stderr: string, sensitive: readonly string[] = []): string {
  let text = stderr;
  for (const s of sensitive) {
    if (s.length > 0) text = text.split(s).join("[redacted]");
  }
  text = text.replace(/[A-Za-z0-9+/=_-]{16,}/g, (run) =>
    /[0-9+/=_-]/.test(run) || run.length >= 32 ? "[redacted]" : run,
  );
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 500) text = `${text.slice(0, 500)}...`;
  return text === "" ? "(no stderr)" : text;
}

export class DpapiStore implements SecretStore {
  readonly kind = "dpapi";
  readonly dir: string;
  private readonly spawnFn: SpawnLike;
  private readonly timeoutMs: number;

  constructor(opts: DpapiStoreOptions = {}) {
    if (process.platform !== "win32") {
      throw new Error(
        `DpapiStore requires Windows (DPAPI); this platform is ${process.platform}. Use selectStore() to pick the platform's secret store.`,
      );
    }
    this.dir = opts.dir ?? storeDir();
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnLike);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private fileFor(key: string): string {
    // Only `agent-auth/<profile name>` keys are accepted (get, set and delete all come through here).
    assertValidStoreKey(key);
    return path.join(this.dir, `${encodeKeyForFile(key)}${FILE_SUFFIX}`);
  }

  async get(key: string): Promise<string | null> {
    const file = this.fileFor(key);
    let stored: string;
    try {
      stored = await fs.readFile(file, "ascii");
    } catch (err) {
      if (isErrno(err, "ENOENT")) return null;
      throw err;
    }
    const cipherB64 = stored.trim();
    if (!BASE64_RE.test(cipherB64) || cipherB64 === "") {
      throw new Error(`DPAPI store file for this key is corrupt (not base64): ${path.basename(file)}`);
    }
    const plainB64 = await this.run("Unprotect", cipherB64);
    const plain = Buffer.from(plainB64, "base64");
    try {
      return plain.toString("utf8");
    } finally {
      plain.fill(0);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.fileFor(key);
    const plain = Buffer.from(value, "utf8");
    let plainB64: string;
    try {
      plainB64 = plain.toString("base64");
    } finally {
      plain.fill(0);
    }
    const cipherB64 = await this.run("Protect", plainB64, [value]);

    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, cipherB64, { encoding: "ascii", mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const file = this.fileFor(key);
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
    const keys: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const stem = name.slice(0, -FILE_SUFFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(stem)) continue;
      const key = decodeKeyFromFile(stem);
      // Skip stems that are not a canonical encoding of their decoded key.
      if (encodeKeyForFile(key) !== stem) continue;
      if (!isValidStoreKey(key)) continue;
      keys.push(key);
    }
    return keys.sort();
  }

  /**
   * Run the fixed Protect/Unprotect script, sending `inputB64` over stdin.
   * `extraSensitive` lists additional strings to scrub from any error text.
   */
  private run(op: "Protect" | "Unprotect", inputB64: string, extraSensitive: readonly string[] = []): Promise<string> {
    // No -ExecutionPolicy override: execution policy governs script files and
    // is not consulted for a -EncodedCommand string.
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPTS[op]];
    const sensitive = [inputB64, ...extraSensitive];

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (err: Error | null, out?: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(out ?? "");
      };

      let child: ChildProcess;
      try {
        child = this.spawnFn(powershellPath(), args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        });
      } catch (err) {
        finish(new Error(`DPAPI ${op} failed: could not start powershell.exe (${errCode(err)})`));
        return;
      }

      timer = setTimeout(() => {
        child.kill();
        finish(new Error(`DPAPI ${op} failed: powershell.exe timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
      child.stderr?.on("data", (c: Buffer) => errChunks.push(c));

      child.on("error", (err) => {
        finish(new Error(`DPAPI ${op} failed: could not run powershell.exe (${errCode(err)})`));
      });

      child.on("close", (code) => {
        const stdout = Buffer.concat(outChunks);
        const stderr = Buffer.concat(errChunks).toString("utf8");
        if (code !== 0) {
          stdout.fill(0);
          finish(new Error(`DPAPI ${op} failed (exit ${String(code)}): ${sanitizeStderr(stderr, sensitive)}`));
          return;
        }
        let text = stdout.toString("ascii");
        stdout.fill(0);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        text = text.replace(/(\r?\n)+$/, "").trim();
        if (!BASE64_RE.test(text) || text === "") {
          finish(new Error(`DPAPI ${op} failed: powershell.exe returned unexpected output`));
          return;
        }
        finish(null, text);
      });

      // Swallow EPIPE if the child dies before reading; the close handler reports the failure.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(Buffer.from(`${inputB64}\n`, "ascii"));
    });
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
  }
  return "unknown error";
}
