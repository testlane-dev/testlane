/** Broker-owned temporary session files. No caller-selected paths or recursive deletion. */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactor } from "../redact.js";
import type { SessionFormat } from "./format.js";

export const MAX_SESSION_FILES = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class SessionFileError extends Error {
  constructor(readonly reason: "file-capacity" | "file-closed" | "file-cancelled" | "file-expired" | "file-too-large" | "file-write-failed" | "file-cleanup-failed", message: string) {
    super(message);
    this.name = "SessionFileError";
  }
}

export interface SessionFileSource {
  output: string;
  profile: string;
  format: SessionFormat;
  issuedAt: string;
  expiresAt: string;
  droppedHeaders?: string[];
  warnings?: string[];
}
export interface SessionFileReceipt {
  id: string;
  path: string;
  profile: string;
  format: SessionFormat;
  issuedAt: string;
  expiresAt: string;
  droppedHeaders?: string[];
  warnings?: string[];
}
interface OwnedFile { path: string; expires: number; timer?: NodeJS.Timeout }

export class SessionFiles {
  readonly #files = new Map<string, OwnedFile>();
  readonly #pending = new Set<Promise<SessionFileReceipt>>();
  readonly #waiting = new Set<() => void>();
  #root: Promise<string> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #reserved = 0;

  /** Reserve a bounded slot before issuing a session, including concurrent calls. */
  create(issue: () => Promise<SessionFileSource>, signal?: AbortSignal): Promise<SessionFileReceipt> {
    if (signal?.aborted) return Promise.reject(new SessionFileError("file-cancelled", "Session-file request was cancelled."));
    if (this.#closed) return Promise.reject(new SessionFileError("file-closed", "Session-file service is closed."));
    if (this.#files.size + this.#reserved >= MAX_SESSION_FILES) return Promise.reject(new SessionFileError("file-capacity", "Session-file capacity reached; release an existing file before requesting another."));
    this.#reserved++;
    const pending = this.#create(issue, signal);
    this.#pending.add(pending);
    void pending.finally(() => { this.#reserved--; this.#pending.delete(pending); }).catch(() => {});
    return pending;
  }

  async #directory(): Promise<string> {
    this.#root ??= (async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "testlane-session-files-"));
      try { await chmod(root, 0o700); return root; }
      catch { await rmdir(root).catch(() => {}); throw new SessionFileError("file-write-failed", "Could not protect the temporary session directory."); }
    })();
    return this.#root;
  }

  /** Stop waiting for an issuer on disconnect/cancellation, even if it ignores cancellation. */
  async #issue(issue: () => Promise<SessionFileSource>, signal?: AbortSignal): Promise<SessionFileSource> {
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new SessionFileError(this.#closed ? "file-closed" : "file-cancelled", this.#closed ? "Session-file service is closed." : "Session-file request was cancelled."));
    });
    this.#waiting.add(cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    try { return await Promise.race([issue(), cancelled]); }
    finally { this.#waiting.delete(cancel); signal?.removeEventListener("abort", cancel); }
  }

  #assertOpen(signal?: AbortSignal): void {
    if (this.#closed) throw new SessionFileError("file-closed", "Session-file service is closed.");
    if (signal?.aborted) throw new SessionFileError("file-cancelled", "Session-file request was cancelled.");
  }

  async #create(issue: () => Promise<SessionFileSource>, signal?: AbortSignal): Promise<SessionFileReceipt> {
    const source = await this.#issue(issue, signal);
    const expires = Date.parse(source.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new SessionFileError("file-expired", "Session expired before file delivery; request a fresh session.");
    const output = redactor.redact(source.output);
    if (Buffer.byteLength(output, "utf8") > MAX_FILE_BYTES) throw new SessionFileError("file-too-large", "Session artifact exceeds the file-delivery limit.");
    this.#assertOpen(signal);
    const root = await this.#directory();
    this.#assertOpen(signal);
    const id = randomBytes(24).toString("hex");
    const file = path.join(root, `${id}.${source.format === "storage-state" || source.format === "json" ? "json" : "txt"}`);
    // A random private directory plus wx prevents overwrites, including symlinks.
    let created = false;
    try {
      const handle = await open(file, "wx", 0o600);
      created = true;
      try {
        this.#assertOpen(signal);
        await handle.writeFile(output.endsWith("\n") ? output : `${output}\n`, "utf8");
      }
      finally { await handle.close(); }
      this.#assertOpen(signal);
      if (expires <= Date.now()) throw new SessionFileError("file-expired", "Session expired before file delivery; request a fresh session.");
      const owned: OwnedFile = { path: file, expires };
      this.#files.set(id, owned);
      this.#schedule(id, owned);
      const receipt: SessionFileReceipt = { id, path: file, profile: source.profile, format: source.format, issuedAt: source.issuedAt, expiresAt: source.expiresAt };
      if (source.droppedHeaders?.length) receipt.droppedHeaders = source.droppedHeaders;
      if (source.warnings?.length) receipt.warnings = source.warnings;
      return receipt;
    } catch (error) {
      if (created) {
        // A failed write can still leave credential bytes. Keep ownership until
        // unlink succeeds, so expiry and a later close can retry cleanup.
        const owned = this.#files.get(id) ?? { path: file, expires };
        this.#files.set(id, owned);
        try { await this.release(id); }
        catch {
          if (owned.timer === undefined) this.#schedule(id, owned);
          throw new SessionFileError("file-cleanup-failed", "Session-file delivery failed and temporary-file cleanup was incomplete; inspect testlane-session-files-* in the system temporary directory.");
        }
      }
      if (error instanceof SessionFileError) throw error;
      throw new SessionFileError("file-write-failed", "Could not deliver a private session file; no session value is returned.");
    }
  }

  #schedule(id: string, owned: OwnedFile): void {
    const delay = Math.max(1, Math.min(owned.expires - Date.now(), 2_147_483_647));
    owned.timer = setTimeout(() => {
      if (Date.now() < owned.expires) { this.#schedule(id, owned); return; }
      void this.release(id).catch(() => {
        // Keep ownership so explicit release/shutdown can retry. Never print an OS error.
        process.stderr.write("testlane mcp: automatic session-file cleanup failed; release the file explicitly.\n");
      });
    }, delay);
    owned.timer.unref();
  }

  /** The opaque id must belong to this server. It is never interpreted as a path. */
  async release(id: string): Promise<boolean> {
    const owned = this.#files.get(id);
    if (!owned) return false;
    try { await unlink(owned.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SessionFileError("file-cleanup-failed", "Session-file cleanup failed; remove the delivered file in a normal terminal.");
    }
    if (owned.timer !== undefined) clearTimeout(owned.timer);
    this.#files.delete(id);
    return true;
  }

  close(): Promise<void> {
    this.#closed = true;
    for (const cancel of this.#waiting) cancel();
    if (this.#closing !== undefined) return this.#closing;
    const closing = (async () => {
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled([...this.#files.keys()].map(id => this.release(id)));
      let failed = results.some(result => result.status === "rejected");
      if (this.#root) {
        const root = await this.#root.catch(() => undefined);
        if (root) try { await rmdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
      }
      if (failed) throw new SessionFileError("file-cleanup-failed", "Session-file cleanup was incomplete; inspect the delivered paths in a normal terminal.");
    })();
    this.#closing = closing;
    // A failed close must remain retryable (for example, a consumer temporarily
    // held a file open on Windows). New issuance stays permanently disabled.
    void closing.catch(() => { if (this.#closing === closing) this.#closing = undefined; });
    return closing;
  }
}
