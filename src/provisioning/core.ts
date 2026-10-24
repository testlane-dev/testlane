/** Durable parent coordinator. No example app, provider SDK or migration imports. */
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { accountFailure, ACCOUNT_UUID, browserAccountEmail, readAccountOwner, readAdapterAcknowledgement, readBrowserAccountFailureCode,
  readCoordinatorBinding, readCreatedAccount, readOwnedInspection, verifyBrowserAccountAdapter,
  type BrowserAccountOwner, type BrowserAccountRole } from "./adapter.js";
import { browserRunProfile, absoluteLocalPath, copyDenseDataArray, copyOwnDataRecord } from "./worker-contracts.js";
import { assertBrowserPrivateDirectory, createBrowserPrivateDirectory } from "./private-directory.js";

type RunStatus = "active" | "recovery-required" | "cleaning" | "released";
type OperationStatus = "creating" | "seeding" | "ready" | "create-unknown" | "seed-unknown" | "deleted";
interface RunRow { runId: string; expiresAt: number; status: RunStatus }
export interface BrowserAccountOperation {
  readonly owner: BrowserAccountOwner;
  readonly profile: string;
  readonly accountId: string | null;
  readonly status: OperationStatus;
  readonly createdAt: number;
}
interface OperationRow { owner: BrowserAccountOwner; profile: string; accountId: string | null; status: OperationStatus; createdAt: number }
interface State { schemaVersion: 1; targetId: string; bindingHash: string; lastNow: number; runs: RunRow[]; operations: OperationRow[] }
export interface BrowserAccountRun { readonly targetId: string; readonly bindingHash: string; readonly runId: string; readonly expiresAt: number }
export interface BrowserAccountCredential { readonly email: string; readonly password: string; readonly role: BrowserAccountRole; readonly accountId: string; readonly profile: string }
export interface BrowserAccountCleanup {
  readonly scope: "accounts-and-sessions";
  readonly cleanup: "completed";
  readonly operations: number;
  readonly ownedRecords: 0;
  readonly activeReservations: 0;
}
export interface BrowserAccountSnapshot {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly bindingHash: string;
  readonly lastNow: number;
  readonly runs: readonly Readonly<RunRow>[];
  readonly operations: readonly BrowserAccountOperation[];
}
export interface BrowserAccountCoordinator {
  readonly bindingHash: string;
  beginRun(input: { readonly runId: string }): Promise<BrowserAccountRun>;
  createAccount(handle: BrowserAccountRun, role: BrowserAccountRole, deliverCredential: (credential: BrowserAccountCredential) => void | Promise<void>): Promise<{ readonly id: string; readonly profile: string; readonly role: BrowserAccountRole; readonly expiresAt: number }>;
  cleanupRun(handle: BrowserAccountRun): Promise<BrowserAccountCleanup>;
  recoverRun(runId: string): Promise<BrowserAccountRun>;
  snapshot(): Promise<BrowserAccountSnapshot>;
}

function ownFsCode(error: unknown, code: string): boolean {
  if (!error || types.isProxy(error) || !types.isNativeError(error)) return false;
  const field = Object.getOwnPropertyDescriptor(error, "code");
  return field !== undefined && Object.hasOwn(field, "value") && field.value === code;
}
function boundedRows(value: unknown): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value)) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID");
  const size = Object.getOwnPropertyDescriptor(value, "length");
  if (!size || !Object.hasOwn(size, "value") || typeof size.value !== "number" || !Number.isSafeInteger(size.value) || size.value > 1000) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID");
  return copyDenseDataArray(value, size.value);
}

/**
 * Arbitrary trusted adapter/delivery promises are awaited, not forcibly stopped.
 * This API makes no native-entry cleanup claim. The parent must separately join
 * its seed children and remove/verify every attempted profile from this journal.
 */
export async function createBrowserAccountCoordinator({ adapter: inputAdapter, binding: inputBinding, root: requested, now = Date.now }: {
  adapter: unknown; binding: unknown; root: string; now?: () => number;
}): Promise<BrowserAccountCoordinator> {
  const { adapter, binding, bindingHash } = await verifyBrowserAccountAdapter(inputAdapter, inputBinding);
  if (typeof now !== "function") throw accountFailure("BROWSER_ACCOUNT_INPUT_REFUSED");
  let root: string;
  try { root = absoluteLocalPath(requested); }
  catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
  const ownerFile = path.join(root, "owner.json"), ledgerFile = path.join(root, "ledger.json"), lock = path.join(root, "ledger.lock");
  const pendingDeliveries = new Set<string>();
  let nonce: string, fresh = false;
  let bound;
  try { bound = readCoordinatorBinding(await adapter.coordinatorBinding()); }
  catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
  if (bound && (bound.root !== root || bound.targetId !== binding.target.id || bound.bindingHash !== bindingHash)) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID");
  try {
    let existing;
    try { existing = await lstat(root); } catch (error) { if (!ownFsCode(error, "ENOENT")) throw error; }
    if (existing) await assertBrowserPrivateDirectory(root);
    else { if (bound) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); await createBrowserPrivateDirectory(root); fresh = true; }
  } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
  const rootIdentity = await lstat(root, { bigint: true }).catch(() => { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); });
  async function assertRootIdentity(): Promise<void> {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || await realpath(root) !== root) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID");
  }
  function privateFile(info: BigIntStats): boolean {
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n &&
      (process.platform === "win32" || ((info.mode & 0o7777n) === 0o600n && info.uid === BigInt(process.getuid!())));
  }

  async function readFileData(file: string): Promise<unknown> {
    let retained: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await assertRootIdentity();
      if (await realpath(file) !== file) throw Error();
      const before = await lstat(file, { bigint: true });
      if (!privateFile(before) || before.size < 1n || before.size > 1_048_576n) throw Error();
      retained = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const opened = await retained.stat({ bigint: true });
      if (!privateFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error();
      const bytes = Buffer.alloc(Number(opened.size) + 1); let length = 0;
      while (length < bytes.length) { const read = await retained.read(bytes, length, bytes.length - length, null); if (read.bytesRead === 0) break; length += read.bytesRead; }
      const after = await retained.stat({ bigint: true }), named = await lstat(file, { bigint: true });
      if (!privateFile(after) || !privateFile(named) || length !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || named.dev !== opened.dev || named.ino !== opened.ino || await realpath(file) !== file) throw Error();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
    } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
    finally { try { await retained?.close(); } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_IO_FAILED"); } }
  }
  async function durable(file: string, value: unknown, exclusive = false): Promise<void> {
    const temporary = exclusive ? file : path.join(root, "write-" + randomUUID() + ".json");
    let retained: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await assertRootIdentity();
      retained = await open(temporary, "wx", 0o600);
      await retained.writeFile(JSON.stringify(value) + "\n"); await retained.sync(); await retained.close(); retained = undefined;
      await assertRootIdentity();
      if (!exclusive) await rename(temporary, file);
      if (process.platform !== "win32") { const directory = await open(root, "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_IO_FAILED"); }
    finally {
      try { await retained?.close(); } catch { /* The fixed write failure remains nonpassing. */ }
      if (!exclusive) await unlink(temporary).catch(() => {});
    }
  }
  async function assertRoot(): Promise<void> {
    const owner = copyOwnDataRecord(await readFileData(ownerFile), ["schemaVersion", "targetId", "bindingHash", "nonce"]);
    if (owner["schemaVersion"] !== 1 || owner["targetId"] !== binding.target.id || owner["bindingHash"] !== bindingHash || owner["nonce"] !== nonce) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID");
  }
  function validateState(value: unknown): State {
    try {
      const data = copyOwnDataRecord(value, ["schemaVersion", "targetId", "bindingHash", "lastNow", "runs", "operations"]);
      if (data["schemaVersion"] !== 1 || data["targetId"] !== binding.target.id || data["bindingHash"] !== bindingHash || typeof data["lastNow"] !== "number" || !Number.isSafeInteger(data["lastNow"]) || data["lastNow"] < 0) throw Error();
      const runs: RunRow[] = [], operations: OperationRow[] = [], ids = new Set<string>(), opIds = new Set<string>(), slots = new Set<string>(), accounts = new Set<string>();
      for (const raw of boundedRows(data["runs"])) {
        const run = copyOwnDataRecord(raw, ["runId", "expiresAt", "status"]);
        if (typeof run["runId"] !== "string" || !ACCOUNT_UUID.test(run["runId"]) || ids.has(run["runId"]) || typeof run["expiresAt"] !== "number" || !Number.isSafeInteger(run["expiresAt"]) || run["expiresAt"] < 1 || !["active", "recovery-required", "cleaning", "released"].includes(run["status"] as string)) throw Error();
        ids.add(run["runId"]); runs.push(run as unknown as RunRow);
      }
      for (const raw of boundedRows(data["operations"])) {
        const row = copyOwnDataRecord(raw, ["owner", "profile", "accountId", "status", "createdAt"]), owner = readAccountOwner(row["owner"]), run = runs.find(item => item.runId === owner.runId);
        const slot = owner.runId + ":" + owner.role, profile = browserRunProfile(binding.target.id, owner.runId, owner.role === "Editor" ? "editor" : "reviewer");
        if (owner.targetId !== binding.target.id || owner.bindingHash !== bindingHash || !run || owner.expiresAt !== run.expiresAt || opIds.has(owner.operationId) || slots.has(slot) || row["profile"] !== profile ||
            (row["accountId"] !== null && (typeof row["accountId"] !== "string" || !ACCOUNT_UUID.test(row["accountId"]) || accounts.has(row["accountId"]))) ||
            !["creating", "seeding", "ready", "create-unknown", "seed-unknown", "deleted"].includes(row["status"] as string) || typeof row["createdAt"] !== "number" || !Number.isSafeInteger(row["createdAt"]) || row["createdAt"] < 0 || row["createdAt"] > owner.expiresAt || owner.expiresAt - row["createdAt"] > binding.ttlMs ||
            (["seeding", "ready", "seed-unknown"].includes(row["status"] as string) && row["accountId"] === null) ||
            (run.status === "released" && row["status"] !== "deleted")) throw Error();
        opIds.add(owner.operationId); slots.add(slot); if (typeof row["accountId"] === "string") accounts.add(row["accountId"]);
        operations.push({ owner, profile, accountId: row["accountId"] as string | null, status: row["status"] as OperationStatus, createdAt: row["createdAt"] });
      }
      return { schemaVersion: 1, targetId: binding.target.id, bindingHash, lastNow: data["lastNow"], runs, operations };
    } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
  }
  async function readState(): Promise<State> { try { await assertRoot(); return validateState(await readFileData(ledgerFile)); } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); } }
  if (fresh) {
    nonce = randomBytes(32).toString("hex");
    await durable(ownerFile, { schemaVersion: 1, targetId: binding.target.id, bindingHash, nonce }, true);
    await durable(ledgerFile, { schemaVersion: 1, targetId: binding.target.id, bindingHash, lastNow: 0, runs: [], operations: [] }, true);
  } else {
    try {
      const owner = copyOwnDataRecord(await readFileData(ownerFile), ["schemaVersion", "targetId", "bindingHash", "nonce"]);
      if (typeof owner["nonce"] !== "string" || !/^[a-f0-9]{64}$/.test(owner["nonce"]) || (bound && owner["nonce"] !== bound.nonce)) throw Error();
      nonce = owner["nonce"]; await readState();
    } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
  }
  const coordinatorBinding = Object.freeze({ root, targetId: binding.target.id, bindingHash, nonce });
  try {
    readAdapterAcknowledgement(await adapter.bindCoordinator(coordinatorBinding), "bound", true);
    const actual = readCoordinatorBinding(await adapter.coordinatorBinding());
    if (!actual || Object.keys(coordinatorBinding).some(key => actual[key as keyof typeof actual] !== coordinatorBinding[key as keyof typeof coordinatorBinding])) throw Error();
  } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }

  async function transaction<T>(callback: (state: State, current: number) => T, allowRollback = false): Promise<T> {
    // One full private-root check per transaction, identity checks per file op.
    // Same-OS-user code is trusted; inode retention is not a fresh ACL attestation.
    await assertBrowserPrivateDirectory(root); await assertRoot(); const deadline = performance.now() + 3000; let acquired = false;
    while (!acquired) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
      catch (error) {
        if (!ownFsCode(error, "EEXIST")) throw accountFailure("BROWSER_ACCOUNT_STATE_IO_FAILED");
        try { const info = await lstat(lock); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(lock) !== lock) throw Error(); }
        catch (error) { if (ownFsCode(error, "ENOENT")) continue; throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
        if (performance.now() >= deadline) throw accountFailure("BROWSER_ACCOUNT_STATE_LOCKED");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      const state = await readState(), clock = now();
      if (!Number.isSafeInteger(clock) || clock < 0 || (!allowRollback && clock < state.lastNow)) throw accountFailure("BROWSER_ACCOUNT_CLOCK_REFUSED");
      const current = Math.max(clock, state.lastNow); state.lastNow = current;
      const before = structuredClone(state); let result: T;
      try { result = callback(state, current); validateState(state); }
      catch (error) { await durable(ledgerFile, before); throw error; }
      await durable(ledgerFile, state); return result;
    } catch (error) { const code = readBrowserAccountFailureCode(error); throw accountFailure(code ?? "BROWSER_ACCOUNT_STATE_INVALID"); }
    finally {
      try { const info = await lstat(lock); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(lock) !== lock) throw Error(); await rmdir(lock); }
      catch { throw accountFailure("BROWSER_ACCOUNT_STATE_IO_FAILED"); }
    }
  }
  function matchingRun(state: State, raw: unknown): RunRow {
    try {
      const handle = copyOwnDataRecord(raw, ["targetId", "bindingHash", "runId", "expiresAt"]);
      const run = state.runs.find(item => item.runId === handle["runId"]);
      if (!run || handle["targetId"] !== binding.target.id || handle["bindingHash"] !== bindingHash || handle["expiresAt"] !== run.expiresAt) throw Error();
      return run;
    } catch { throw accountFailure("BROWSER_ACCOUNT_RUN_REFUSED"); }
  }
  const handleFor = (run: RunRow): BrowserAccountRun => Object.freeze({ targetId: binding.target.id, bindingHash, runId: run.runId, expiresAt: run.expiresAt });
  const blocked = (state: State): boolean => state.runs.some(run => run.status === "recovery-required" || run.status === "cleaning") || state.operations.some(row => row.status === "create-unknown" || row.status === "seed-unknown");
  async function markUnknown(handle: BrowserAccountRun, operationId: string, status: "create-unknown" | "seed-unknown"): Promise<void> {
    await transaction(state => {
      const run = matchingRun(state, handle), row = state.operations.find(item => item.owner.operationId === operationId);
      if (row && row.status !== "deleted") { if (row.status !== "create-unknown" && row.status !== "seed-unknown") row.status = status; run.status = "recovery-required"; }
    }, true);
  }
  return Object.freeze({ bindingHash,
    async beginRun(input: { readonly runId: string }): Promise<BrowserAccountRun> {
      let runId: unknown;
      try { runId = copyOwnDataRecord(input, ["runId"])["runId"]; } catch { throw accountFailure("BROWSER_ACCOUNT_INPUT_REFUSED"); }
      if (typeof runId !== "string" || !ACCOUNT_UUID.test(runId)) throw accountFailure("BROWSER_ACCOUNT_INPUT_REFUSED");
      return transaction((state, current) => {
        if (blocked(state) || state.operations.some(row => row.status !== "ready" && row.status !== "deleted")) throw accountFailure("BROWSER_ACCOUNT_CLEANUP_INCOMPLETE");
        if (state.runs.some(run => run.runId === runId)) throw accountFailure("BROWSER_ACCOUNT_REPLAY_REFUSED");
        if (state.runs.length >= 1000 || !Number.isSafeInteger(current + binding.ttlMs)) throw accountFailure("BROWSER_ACCOUNT_QUOTA_REFUSED");
        const run: RunRow = { runId, expiresAt: current + binding.ttlMs, status: "active" }; state.runs.push(run); return handleFor(run);
      });
    },
    async createAccount(handle: BrowserAccountRun, role: BrowserAccountRole, deliverCredential: (credential: BrowserAccountCredential) => void | Promise<void>) {
      if (role !== "Editor" && role !== "Reviewer") throw accountFailure("BROWSER_ACCOUNT_ROLE_REFUSED");
      if (typeof deliverCredential !== "function" || types.isProxy(deliverCredential)) throw accountFailure("BROWSER_ACCOUNT_INPUT_REFUSED");
      const reserved = await transaction((state, current) => {
        const run = matchingRun(state, handle);
        if (blocked(state)) throw accountFailure("BROWSER_ACCOUNT_CLEANUP_INCOMPLETE");
        if (run.status !== "active") throw accountFailure("BROWSER_ACCOUNT_RUN_REFUSED");
        if (current >= run.expiresAt) throw accountFailure("BROWSER_ACCOUNT_EXPIRED");
        const mine = state.operations.filter(row => row.owner.runId === run.runId);
        if (mine.some(row => row.owner.role === role)) throw accountFailure("BROWSER_ACCOUNT_REPLAY_REFUSED");
        if (state.operations.length >= 1000 || mine.length >= binding.maxAccountsPerRun || state.operations.filter(row => row.status !== "deleted").length >= binding.maxActiveAccounts || state.operations.filter(row => row.createdAt > current - 3_600_000).length >= binding.maxCreateAttemptsPerHour) throw accountFailure("BROWSER_ACCOUNT_QUOTA_REFUSED");
        const owner = readAccountOwner({ targetId: binding.target.id, bindingHash, runId: run.runId, operationId: randomUUID(), role, email: browserAccountEmail(run.runId, role), expiresAt: run.expiresAt });
        const profile = browserRunProfile(binding.target.id, run.runId, role === "Editor" ? "editor" : "reviewer");
        // The possible native profile is durable BEFORE account creation or sink delivery.
        state.operations.push({ owner, profile, accountId: null, status: "creating", createdAt: current }); return { owner, profile };
      });
      let password: string | undefined = randomBytes(32).toString("base64url"), phase: "create" | "seed" = "create";
      try {
        const id = readCreatedAccount(await adapter.createOwned(reserved.owner, password));
        await transaction(state => {
          const run = matchingRun(state, handle), row = state.operations.find(item => item.owner.operationId === reserved.owner.operationId);
          if (!row || run.status !== "active" || row.status !== "creating") throw accountFailure("BROWSER_ACCOUNT_RUN_REFUSED");
          row.accountId = id; row.status = "seeding";
        });
        phase = "seed";
        readAdapterAcknowledgement(await adapter.beginCredentialDelivery(reserved.owner), "pending", true);
        pendingDeliveries.add(reserved.owner.operationId);
        try { await deliverCredential(Object.freeze({ email: reserved.owner.email, password, role, accountId: id, profile: reserved.profile })); }
        finally { try { readAdapterAcknowledgement(await adapter.endCredentialDelivery(reserved.owner), "pending", false); } finally { pendingDeliveries.delete(reserved.owner.operationId); } }
        await transaction(state => {
          const run = matchingRun(state, handle), row = state.operations.find(item => item.owner.operationId === reserved.owner.operationId);
          if (!row || run.status !== "active" || row.status !== "seeding") throw accountFailure("BROWSER_ACCOUNT_RUN_REFUSED"); row.status = "ready";
        });
        return Object.freeze({ id, profile: reserved.profile, role, expiresAt: reserved.owner.expiresAt });
      } catch (error) {
        await markUnknown(handle, reserved.owner.operationId, phase === "seed" ? "seed-unknown" : "create-unknown");
        const code = readBrowserAccountFailureCode(error); if (code) throw accountFailure(code);
        throw accountFailure(phase === "seed" ? "BROWSER_ACCOUNT_SEED_UNKNOWN" : "BROWSER_ACCOUNT_CREATE_UNKNOWN");
      } finally { password = undefined; }
    },
    async cleanupRun(handle: BrowserAccountRun): Promise<BrowserAccountCleanup> {
      const entries = await transaction(state => { const run = matchingRun(state, handle); run.status = "cleaning"; return structuredClone(state.operations.filter(row => row.owner.runId === run.runId)); }, true);
      try {
        for (const row of entries) {
          const before = readOwnedInspection(await adapter.inspectOwned(row.owner));
          if (row.accountId !== null && before.id !== null && before.id !== row.accountId) throw accountFailure("BROWSER_ACCOUNT_OWNERSHIP_REFUSED");
          const knownAccountId = row.accountId ?? before.id;
          readAdapterAcknowledgement(await adapter.revokeDeleteOwned(row.owner), "revoked", true);
          const after = readOwnedInspection(await adapter.inspectOwned(row.owner));
          if (after.present || !after.revoked || after.deliveryPending || after.ownedRecords !== 0 || after.activeReservations !== 0 ||
              (after.id !== null && after.id !== knownAccountId) || pendingDeliveries.has(row.owner.operationId)) throw accountFailure("BROWSER_ACCOUNT_CLEANUP_INCOMPLETE");
          await transaction(state => { const item = state.operations.find(entry => entry.owner.operationId === row.owner.operationId); if (!item) throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); item.status = "deleted"; }, true);
        }
        await transaction(state => {
          const run = matchingRun(state, handle);
          if (state.operations.some(row => row.owner.runId === run.runId && row.status !== "deleted")) throw accountFailure("BROWSER_ACCOUNT_CLEANUP_INCOMPLETE");
          run.status = "released";
        }, true);
        return Object.freeze({ scope: "accounts-and-sessions", cleanup: "completed", operations: entries.length, ownedRecords: 0, activeReservations: 0 });
      } catch { throw accountFailure("BROWSER_ACCOUNT_CLEANUP_INCOMPLETE"); }
    },
    async recoverRun(runId: string): Promise<BrowserAccountRun> {
      if (typeof runId !== "string" || !ACCOUNT_UUID.test(runId)) throw accountFailure("BROWSER_ACCOUNT_RUN_REFUSED");
      return transaction(state => { const run = state.runs.find(item => item.runId === runId); if (!run) throw accountFailure("BROWSER_ACCOUNT_RUN_REFUSED"); return handleFor(run); }, true);
    },
    async snapshot(): Promise<BrowserAccountSnapshot> { await assertBrowserPrivateDirectory(root); return structuredClone(await readState()); },
  });
}
