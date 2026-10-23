/** Internal durable wrapper journal. Same-user trusted code is not sandboxed. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import { ACCOUNT_UUID } from "./adapter.js";
import { assertBrowserPrivateDirectory, createBrowserPrivateDirectory } from "./private-directory.js";
import { absoluteLocalPath, copyOwnDataRecord } from "./worker-contracts.js";
import { ManagedBrowserError, normalizeManagedJournal, type ManagedJournal } from "./managed-state.js";

const refused = () => new ManagedBrowserError("BROWSER_MANAGED_STATE_REFUSED");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const validFile = (v: BigIntStats, max: number) => v.isFile() && !v.isSymbolicLink() && v.nlink === 1n && v.size >= 1n && v.size <= BigInt(max) &&
  (process.platform === "win32" || (v.uid === BigInt(process.getuid!()) && (v.mode & 0o7777n) === 0o600n));
function missing(error: unknown): boolean {
  if (!error || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return false;
  const field = Object.getOwnPropertyDescriptor(error, "code"); return !!field && Object.hasOwn(field, "value") && field.value === "ENOENT";
}
export interface ManagedRoot {
  readonly root: string;
  readonly runs: string;
  readonly coordinator: string;
  readonly currentRunId: string | null;
  acquire(): Promise<void>;
  release(): Promise<void>;
  directory(directory: string, create: boolean): Promise<void>;
  check(directory: string): Promise<void>;
  current(runId: string | null): Promise<void>;
  save(journal: ManagedJournal): Promise<void>;
  load(runId: string): Promise<ManagedJournal>;
  write(file: string, value: unknown): Promise<void>;
  read(file: string): Promise<unknown>;
  empty(directory: string): Promise<void>;
}

/** Private mode/ACL attestation once at entry; retained identities on each I/O. */
export async function openManagedRoot(requested: string, targetId: string, bindingHash: string): Promise<ManagedRoot> {
  try {
    const root = absoluteLocalPath(requested), identities = new Map<string, BigIntStats>();
    const dir = async (directory: string, create: boolean) => {
      const relative = path.relative(root, directory);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw refused();
      if (directory !== root) await check(path.dirname(directory));
      if (create) await createBrowserPrivateDirectory(directory); else await assertBrowserPrivateDirectory(directory);
      const info = await lstat(directory, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw refused();
      identities.set(directory, info);
    };
    let fresh = false;
    try { await lstat(root); } catch (error) { if (!missing(error)) throw error; fresh = true; }
    await dir(root, fresh);
    const check = async (directory: string) => {
      const relative = path.relative(root, directory);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw refused();
      if (directory !== root) await check(path.dirname(directory));
      const retained = identities.get(directory), info = await lstat(directory, { bigint: true });
      if (!retained || !info.isDirectory() || info.isSymbolicLink() || !same(retained, info) || await realpath(directory) !== directory ||
          (process.platform !== "win32" && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== 0o700n))) throw refused();
    };
    const read = async (file: string, max: number): Promise<unknown> => {
      await check(path.dirname(file));
      const before = await lstat(file, { bigint: true });
      if (!validFile(before, max) || await realpath(file) !== file) throw refused();
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat({ bigint: true });
        if (!validFile(opened, max) || !same(before, opened)) throw refused();
        const bytes = Buffer.alloc(Number(opened.size) + 1); let count = 0;
        while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); count += part.bytesRead; if (!part.bytesRead) break; }
        const ended = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
        if (!validFile(ended, max) || !validFile(named, max) || !same(opened, named) || count !== Number(opened.size) || opened.size !== ended.size || before.size !== named.size ||
            opened.mtimeNs !== ended.mtimeNs || before.mtimeNs !== named.mtimeNs || opened.ctimeNs !== ended.ctimeNs || before.ctimeNs !== named.ctimeNs || await realpath(file) !== file || bytes[count - 1] !== 10) throw refused();
        await check(path.dirname(file));
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))) as unknown;
      } finally { await handle.close(); }
    };
    const write = async (file: string, value: unknown) => {
      await check(path.dirname(file));
      const bytes = Buffer.from(JSON.stringify(value) + "\n");
      if (bytes.length > 16384) throw refused();
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.nlink !== 1n || (process.platform !== "win32" && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== 0o600n))) throw refused();
        await handle.writeFile(bytes); await handle.sync();
      } finally { await handle.close(); }
      await check(path.dirname(file));
    };
    const atomic = async (file: string, value: unknown) => {
      const temporary = path.join(path.dirname(file), ".managed-" + randomUUID() + ".tmp");
      await check(path.dirname(file));
      const existing = await lstat(file, { bigint: true });
      if (!validFile(existing, 16384) || await realpath(file) !== file) throw refused();
      await write(temporary, value);
      try {
        await check(path.dirname(file));
        const named = await lstat(file, { bigint: true });
        if (!validFile(named, 16384) || !same(existing, named)) throw refused();
        await rename(temporary, file);
        if (process.platform !== "win32") { const directory = await open(path.dirname(file), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
        await check(path.dirname(file));
      } catch { throw refused(); } // A partial state remains for explicit review, never automatic repair.
    };
    const ownerFile = path.join(root, "managed-owner.json");
    let owner: { schemaVersion: 1; targetId: string; bindingHash: string; currentRunId: string | null };
    if (fresh) { owner = { schemaVersion: 1, targetId, bindingHash, currentRunId: null }; await write(ownerFile, owner); }
    else {
      const data = copyOwnDataRecord(await read(ownerFile, 2048), ["schemaVersion", "targetId", "bindingHash", "currentRunId"]);
      if (data["schemaVersion"] !== 1 || data["targetId"] !== targetId || data["bindingHash"] !== bindingHash ||
          (data["currentRunId"] !== null && (typeof data["currentRunId"] !== "string" || !ACCOUNT_UUID.test(data["currentRunId"])))) throw refused();
      owner = data as unknown as typeof owner;
    }
    const runs = path.join(root, "runs");
    await dir(runs, fresh);
    let lockIdentity: BigIntStats | undefined;
    let writes: Promise<void> = Promise.resolve();
    const lock = path.join(root, "run.lock");
    const requireLock = async () => {
      await check(root);
      const current = await lstat(lock, { bigint: true });
      if (!lockIdentity || !current.isDirectory() || current.isSymbolicLink() || !same(lockIdentity, current) || await realpath(lock) !== lock) throw refused();
    };
    return Object.freeze({ root, runs, coordinator: path.join(root, "coordinator"), currentRunId: owner.currentRunId,
      async acquire() {
        if (lockIdentity) throw new ManagedBrowserError("BROWSER_MANAGED_LOCKED");
        await check(root);
        try { await lstat(lock); throw new ManagedBrowserError("BROWSER_MANAGED_LOCKED"); } catch (error) { if (!missing(error)) throw new ManagedBrowserError("BROWSER_MANAGED_LOCKED"); }
        // Creation is exclusive; an existing lock is never repaired or stolen.
        await dir(lock, true); lockIdentity = await lstat(lock, { bigint: true });
        const currentOwner = copyOwnDataRecord(await read(ownerFile, 2048), ["schemaVersion", "targetId", "bindingHash", "currentRunId"]);
        if (currentOwner["targetId"] !== targetId || currentOwner["bindingHash"] !== bindingHash || currentOwner["currentRunId"] !== owner.currentRunId) throw refused();
      },
      async release() { await requireLock(); await rmdir(lock); identities.delete(lock); lockIdentity = undefined; await check(root); },
      directory: dir, check,
      async current(runId: string | null) {
        await requireLock();
        if (runId !== null && !ACCOUNT_UUID.test(runId)) throw refused();
        owner = { ...owner, currentRunId: runId }; await atomic(ownerFile, owner);
      },
      save(value: ManagedJournal) {
        // Runner settlement and barrier completion can overlap. Snapshot latest
        // shared state inside this queue, never before an older write settles.
        // An I/O refusal poisons the queue; it cannot be silently repaired.
        writes = writes.then(async () => {
          await requireLock(); const journal = normalizeManagedJournal(value);
          if (journal.targetId !== targetId || journal.bindingHash !== bindingHash || owner.currentRunId !== journal.runId) throw refused();
          const directory = path.join(runs, journal.runId), file = path.join(directory, "managed-run.json"); await check(directory);
          let exists = true; try { await lstat(file); } catch (error) { if (!missing(error)) throw error; exists = false; }
          if (exists) await atomic(file, journal); else await write(file, journal);
        });
        void writes.catch(() => {}); return writes;
      },
      async load(runId: string) {
        await requireLock(); if (!ACCOUNT_UUID.test(runId) || owner.currentRunId !== runId) throw refused();
        const directory = path.join(runs, runId); await dir(directory, false);
        const journal = normalizeManagedJournal(await read(path.join(directory, "managed-run.json"), 16384));
        if (journal.runId !== runId || journal.targetId !== targetId || journal.bindingHash !== bindingHash) throw refused();
        return journal;
      },
      async write(file: string, value: unknown) { await requireLock(); await write(file, value); },
      async read(file: string) { await requireLock(); return read(file, 16384); },
      async empty(directory: string) { await check(directory); if ((await readdir(directory)).length !== 0) throw refused(); await check(directory); },
    });
  } catch (error) { if (error instanceof ManagedBrowserError) throw error; throw refused(); }
}
