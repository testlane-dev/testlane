/**
 * Exclusive per-profile lock files for `rotate`.
 *
 * A lock is a create-only ("wx") file `<TESTLANE_HOME>/locks/<base64url profile>.lock`
 * holding `{ pid, ts, token }` (no secret). A lock younger than the stale
 * limit (15 min) means "another rotation is in progress"; an older one is
 * treated as left behind by a crashed process and replaced. Release removes
 * the file only while it still holds this process's token.
 *
 * Replacing a stale lock re-reads it first and removes it only when unchanged,
 * which narrows (but cannot fully close, on a plain filesystem) the window in
 * which two processes both replace the same stale lock.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentAuthHome } from "./paths.js";

/** A rotate lock older than this is considered stale and replaced. */
export const ROTATE_LOCK_STALE_MS = 15 * 60 * 1000;

/** Location of the rotate lock for `profileName`. */
export function rotateLockPath(profileName: string): string {
  return path.join(agentAuthHome(), "locks", `${Buffer.from(profileName, "utf8").toString("base64url")}.lock`);
}

/** The lock is held by someone else. `since` is the holder's timestamp when readable. */
export class LockHeldError extends Error {
  override readonly name = "LockHeldError";
  constructor(
    message: string,
    public readonly file: string,
    public readonly since: string | null,
  ) {
    super(message);
  }
}

export interface HeldLock {
  file: string;
  release(): Promise<void>;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/** The holder's timestamp (ms) from the file content, else its mtime, else null. */
async function lockTime(file: string, content: string): Promise<number | null> {
  try {
    const ts = (JSON.parse(content) as { ts?: unknown }).ts;
    if (typeof ts === "string" && Number.isFinite(Date.parse(ts))) return Date.parse(ts);
  } catch {
    // fall through to mtime
  }
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Take the lock at `file` or throw LockHeldError. `now` is used both for the
 * timestamp written and for the staleness check.
 */
export async function acquireLock(file: string, now: Date, staleMs: number = ROTATE_LOCK_STALE_MS): Promise<HeldLock> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  const content = JSON.stringify({ pid: process.pid, ts: now.toISOString(), token });
  const release = async (): Promise<void> => {
    try {
      if ((await readOrNull(file)) === content) await rm(file, { force: true });
    } catch {
      // Best effort: a lock left behind goes stale after staleMs.
    }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { file, release };
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
    }
    const existing = await readOrNull(file);
    if (existing === null) continue; // released meanwhile: try again
    const at = await lockTime(file, existing);
    if (at !== null && now.getTime() - at < staleMs) {
      throw new LockHeldError("lock held", file, new Date(at).toISOString());
    }
    // Stale: replace it, but only if nobody replaced it since we read it.
    if ((await readOrNull(file)) === existing) await rm(file, { force: true });
  }
  throw new LockHeldError("lock held", file, null);
}
