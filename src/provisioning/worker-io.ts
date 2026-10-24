/** Worker-only fixed file handoff. No account, provider or parent-controller imports. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { types } from "node:util";
import { assertBrowserPrivateDirectory } from "./private-directory.js";
import { absoluteLocalPath, copyOwnDataRecord, normalizeBrowserWorkerBinding, type BrowserWorkerBinding } from "./worker-contracts.js";

export const BROWSER_WORKER_BINDING_ENV = "TESTLANE_BROWSER_WORKER_BINDING";
const WAIT_MS = 15000, BINDING_BYTES = 16384, RESPONSE_BYTES = 2048;
interface Identity { readonly dev: bigint; readonly ino: bigint }
interface Loaded {
  readonly binding: BrowserWorkerBinding; readonly bindingFile: string; readonly bindingSHA256: string; readonly bindingIdentity: Identity;
  readonly runDirectory: string; readonly runIdentity: Identity; readonly revocationIdentity: Identity;
  lastWall: number; pending?: Promise<Readonly<{ status: "success" }>>;
}
const loaded = new WeakMap<BrowserWorkerBinding, Loaded>();
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const aborted = (signal?: AbortSignal): boolean => signal !== undefined && abortedGetter.call(signal) === true;
function fixed(code: string): Error {
  const error = new Error(code); error.name = "BrowserProvisioningError"; error.stack = code; return error;
}
function fixedMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" ? descriptor.value : undefined;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
function errno(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return false;
  const field = Object.getOwnPropertyDescriptor(error, "code"); return !!field && Object.hasOwn(field, "value") && field.value === code;
}

async function directoryIdentity(directory: string, expected?: Identity): Promise<Identity> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory ||
      (expected && !sameIdentity(info, expected)) || (process.platform !== "win32" &&
        ((info.mode & 0o7777n) !== 0o700n || info.uid !== BigInt(process.getuid!())))) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
  return { dev: info.dev, ino: info.ino };
}

/** Bounded ordinary handle reads. Binding reads are strict; barrier writes may still be in progress. */
async function boundedFile(file: string, maximum: number, allowMissing = false, barrier = false): Promise<{ bytes: Buffer; identity: Identity } | undefined> {
  let before;
  try { before = await lstat(file, { bigint: true }); } catch (error) { if (allowMissing && errno(error, "ENOENT")) return; throw error; }
  const valid = (info: typeof before) => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size >= 0n && info.size <= BigInt(maximum) &&
    (process.platform === "win32" || (info.uid === BigInt(process.getuid!()) && (info.mode & 0o7777n) === 0o600n));
  if (!valid(before) || await realpath(file) !== file) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!valid(opened) || !sameIdentity(before, opened)) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
    const buffer = Buffer.alloc(maximum + 1); let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); offset += bytesRead;
      if (!bytesRead || offset === buffer.length) break;
    }
    const afterHandle = await handle.stat({ bigint: true }), afterPath = await lstat(file, { bigint: true });
    if (offset > maximum || !valid(afterHandle) || !valid(afterPath) ||
        !sameIdentity(opened, afterHandle) || !sameIdentity(opened, afterPath) || await realpath(file) !== file) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
    // Cross-path/fd ctime equality is not portable on Windows. Each surface must
    // remain stable against its own earlier sample; identity is compared across both.
    const changed = before.size !== opened.size || before.mtimeNs !== opened.mtimeNs ||
      offset !== Number(opened.size) || afterHandle.size !== opened.size || afterPath.size !== before.size ||
      afterHandle.mtimeNs !== opened.mtimeNs || afterPath.mtimeNs !== before.mtimeNs ||
      afterHandle.ctimeNs !== opened.ctimeNs || afterPath.ctimeNs !== before.ctimeNs;
    if (changed) { if (barrier) return; throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED"); }
    const bytes = buffer.subarray(0, offset);
    if (barrier && bytes.at(-1) !== 10) return;
    return { bytes, identity: { dev: opened.dev, ino: opened.ino } };
  } finally { await handle.close(); }
}

/** Internal data-only leaf. Callers retain/verify private directory authority separately. */
export async function readBrowserBarrierFile(file: string): Promise<Readonly<{ bytes: Buffer; identity: Identity }> | undefined> {
  try {
    const canonical = absoluteLocalPath(file), directory = path.dirname(canonical);
    if (path.basename(directory) !== "revocation" || !["request.json", "response.json"].includes(path.basename(canonical))) throw fixed("BROWSER_REVOCATION_REFUSED");
    const before = await directoryIdentity(directory);
    const record = await boundedFile(canonical, RESPONSE_BYTES, true, true);
    await directoryIdentity(directory, before);
    return record;
  } catch { throw fixed("BROWSER_REVOCATION_REFUSED"); }
}
function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }

export async function loadBrowserWorkerBinding(bindingFile: string | undefined = process.env[BROWSER_WORKER_BINDING_ENV]): Promise<BrowserWorkerBinding> {
  try {
    const file = absoluteLocalPath(bindingFile), runDirectory = path.dirname(file);
    if (path.basename(file) !== "worker-binding.json") throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
    await assertBrowserPrivateDirectory(runDirectory);
    const runIdentity = await directoryIdentity(runDirectory), record = await boundedFile(file, BINDING_BYTES);
    if (!record) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
    const now = Date.now(), binding = normalizeBrowserWorkerBinding(json(record.bytes), now);
    if (path.basename(runDirectory) !== binding.runId || binding.revocation.directory !== path.join(runDirectory, "revocation")) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
    await assertBrowserPrivateDirectory(binding.revocation.directory);
    const revocationIdentity = await directoryIdentity(binding.revocation.directory);
    await directoryIdentity(runDirectory, runIdentity);
    const checked = await boundedFile(file, BINDING_BYTES);
    if (!checked || !sameIdentity(checked.identity, record.identity) || !checked.bytes.equals(record.bytes) || Date.now() < now || Date.now() >= binding.expiresAt) throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
    loaded.set(binding, { binding, bindingFile: file, bindingSHA256: digest(record.bytes), bindingIdentity: record.identity,
      runDirectory, runIdentity, revocationIdentity, lastWall: now });
    return binding;
  } catch (error) {
    if (fixedMessage(error) === "BROWSER_PRIVATE_DIRECTORY_STOP_UNCONFIRMED") throw error;
    throw fixed("BROWSER_ACCOUNT_BINDING_REFUSED");
  }
}

async function verifyLoaded(record: Loaded): Promise<void> {
  await directoryIdentity(record.runDirectory, record.runIdentity);
  await directoryIdentity(record.binding.revocation.directory, record.revocationIdentity);
  const current = await boundedFile(record.bindingFile, BINDING_BYTES);
  if (!current || !sameIdentity(current.identity, record.bindingIdentity) || digest(current.bytes) !== record.bindingSHA256) throw fixed("BROWSER_REVOCATION_REFUSED");
}

async function revoke(record: Loaded, signal?: AbortSignal): Promise<Readonly<{ status: "success" }>> {
  const wall = Date.now(), began = performance.now(), allowance = Math.min(WAIT_MS, record.binding.expiresAt - wall);
  if (aborted(signal)) throw fixed("BROWSER_CANCELLED");
  if (!Number.isSafeInteger(wall) || wall < record.lastWall) throw fixed("BROWSER_REVOCATION_REFUSED");
  if (!(allowance > 0)) throw fixed("BROWSER_REVOCATION_TIMEOUT");
  const deadline = began + allowance, budget = new AbortController(), timer = setTimeout(() => budget.abort(), allowance);
  const operationSignal = AbortSignal.any(signal ? [signal, budget.signal] : [budget.signal]);
  const check = () => {
    if (aborted(signal)) throw fixed("BROWSER_CANCELLED");
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < record.lastWall) throw fixed("BROWSER_REVOCATION_REFUSED");
    record.lastWall = now;
    if (budget.signal.aborted || performance.now() >= deadline || now >= record.binding.expiresAt) throw fixed("BROWSER_REVOCATION_TIMEOUT");
  };
  const directory = record.binding.revocation.directory, requestFile = path.join(directory, "request.json"), responseFile = path.join(directory, "response.json");
  try {
    check(); await assertBrowserPrivateDirectory(record.runDirectory, { signal: operationSignal }); check();
    await assertBrowserPrivateDirectory(directory, { signal: operationSignal }); check(); await verifyLoaded(record); check();
    for (const file of [requestFile, responseFile]) {
      try { await lstat(file); throw fixed("BROWSER_REVOCATION_REFUSED"); } catch (error) { if (!errno(error, "ENOENT")) throw error; }
      check();
    }
    const request = { schemaVersion: 1, targetId: record.binding.targetId, runId: record.binding.runId, expiresAt: record.binding.expiresAt, nonce: record.binding.revocation.nonce };
    const handle = await open(requestFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw fixed("BROWSER_REVOCATION_REFUSED");
      check(); await handle.writeFile(JSON.stringify(request) + "\n"); await handle.sync(); check();
    } finally { await handle.close(); }
    for (;;) {
      check(); await verifyLoaded(record); check();
      const response = await readBrowserBarrierFile(responseFile); check();
      // The parent publishes one LF-terminated JSON record. An in-progress wx
      // write is not a committed reply; it cannot authorize success.
      if (response && response.bytes.at(-1) === 10) {
        const value = copyOwnDataRecord(json(response.bytes), ["schemaVersion", "targetId", "runId", "expiresAt", "nonce", "status"]);
        for (const key of ["schemaVersion", "targetId", "runId", "expiresAt", "nonce"] as const) if (value[key] !== request[key]) throw fixed("BROWSER_REVOCATION_REFUSED");
        if (value["status"] !== "success" && value["status"] !== "failed") throw fixed("BROWSER_REVOCATION_REFUSED");
        await assertBrowserPrivateDirectory(directory, { signal: operationSignal }); check(); await verifyLoaded(record); check();
        const final = await readBrowserBarrierFile(responseFile);
        if (!final || final.bytes.at(-1) !== 10 || !sameIdentity(final.identity, response.identity) || !final.bytes.equals(response.bytes)) throw fixed("BROWSER_REVOCATION_REFUSED");
        check(); if (value["status"] === "failed") throw fixed("BROWSER_REVOCATION_FAILED");
        return Object.freeze({ status: "success" });
      }
      await pause(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal: operationSignal });
    }
  } catch (error) {
    const message = fixedMessage(error);
    if (message === "BROWSER_PRIVATE_DIRECTORY_STOP_UNCONFIRMED") throw error;
    check();
    if (message === "BROWSER_REVOCATION_FAILED") throw fixed(message);
    throw fixed("BROWSER_REVOCATION_REFUSED");
  } finally { clearTimeout(timer); }
}

function normalizedSignal(options: unknown): AbortSignal | undefined {
  const value = copyOwnDataRecord(options, ["signal"], []), signal = value["signal"];
  if (signal === undefined) return;
  if (signal === null || typeof signal !== "object" || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw fixed("BROWSER_REVOCATION_REFUSED");
  for (const name of ["aborted", "reason", "addEventListener", "removeEventListener", "throwIfAborted", "onabort"]) if (Object.hasOwn(signal, name)) throw fixed("BROWSER_REVOCATION_REFUSED");
  abortedGetter.call(signal); // Brand-check without reading any supplied accessor or abort reason.
  return signal as AbortSignal;
}

/** One request per loaded binding. Repeated callers join; failure is never retried. */
export function requestBrowserRunRevocation(binding: BrowserWorkerBinding, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<Readonly<{ status: "success" }>> {
  try {
    const signal = normalizedSignal(options), record = loaded.get(binding);
    if (!record) throw fixed("BROWSER_REVOCATION_REFUSED");
    return record.pending ??= revoke(record, signal);
  } catch { return Promise.reject(fixed("BROWSER_REVOCATION_REFUSED")); }
}
