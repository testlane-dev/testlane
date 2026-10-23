/** Parent-owned browser orchestration; the public facade lives in browser.ts. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { types } from "node:util";
import { browserAccountEmail, browserBindingHash, type BrowserAccountAdapter } from "./adapter.js";
import { normalizeBrowserAccountBinding, type BrowserAccountBinding } from "./contracts.js";
import { createBrowserAccountCoordinator, type BrowserAccountRun } from "./core.js";
import { createBrowserWorkerEnvironment } from "./environment.js";
import { BrowserChildError, runBrowserChild } from "./child.js";
import { assertManagedBrowserPlanUnchanged, prepareManagedBrowserPlan, type PreparedBrowserPlan } from "./preflight.js";
import { absoluteLocalPath, browserRunProfile, copyOwnDataRecord, createBrowserWorkerBinding, type BrowserWorkerBinding } from "./worker-contracts.js";
import { readBrowserBarrierFile } from "./worker-io.js";
import { openManagedRoot, type ManagedRoot } from "./managed-files.js";
import { executeManagedLifecycle, finishManagedCleanup, type ManagedLifecycleDependencies } from "./managed-lifecycle.js";
import { projectManagedBrowserOutcome, type ManagedPlannedCase } from "./managed-report.js";
import { finalManagedReport, journalFor, managedErrorCode, managedReport, ManagedBrowserError, remember, type ManagedBrowserReport, type ManagedJournal } from "./managed-state.js";
export type { ManagedBrowserReport, ManagedCode, CleanupState, VerificationState } from "./managed-state.js";

export interface DisposableBrowserOptions {
  readonly adapter: BrowserAccountAdapter;
  readonly binding: BrowserAccountBinding;
  readonly planFile: string;
  /** Persistent private per-target directory; never a disposable test harness directory. */
  readonly outputDir: string;
  /** Explicit opt-in required for Linux Secret Service or macOS login keychain. */
  readonly allowUserKeychain?: boolean;
  readonly signal?: AbortSignal;
}
export interface RecoverDisposableBrowserOptions extends Omit<DisposableBrowserOptions, "planFile"> { readonly runId: string }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const aborted = (signal?: AbortSignal) => signal !== undefined && Reflect.apply(abortedGetter, signal, []) === true;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Normalized = { adapter: BrowserAccountAdapter; binding: BrowserAccountBinding; outputDir: string; allowUserKeychain: boolean; signal?: AbortSignal; planFile?: string; runId?: string };

function options(input: unknown, recovery: boolean): Normalized {
  try {
    const data = copyOwnDataRecord(input, ["adapter", "binding", recovery ? "runId" : "planFile", "outputDir", "allowUserKeychain", "signal"], ["adapter", "binding", recovery ? "runId" : "planFile", "outputDir"]);
    const signal = data["signal"];
    if (signal !== undefined) {
      if (!signal || typeof signal !== "object" || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw Error();
      for (const name of ["aborted", "reason", "addEventListener", "removeEventListener", "throwIfAborted", "onabort"]) if (Object.hasOwn(signal, name)) throw Error();
      Reflect.apply(abortedGetter, signal, []);
    }
    if (data["allowUserKeychain"] !== undefined && typeof data["allowUserKeychain"] !== "boolean") throw Error();
    const normalized: Normalized = { adapter: data["adapter"] as BrowserAccountAdapter, binding: normalizeBrowserAccountBinding(data["binding"]), outputDir: absoluteLocalPath(data["outputDir"]), allowUserKeychain: data["allowUserKeychain"] === true,
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }) };
    if (recovery) { if (typeof data["runId"] !== "string" || !UUID.test(data["runId"])) throw Error(); normalized.runId = data["runId"]; }
    else normalized.planFile = absoluteLocalPath(data["planFile"]);
    return normalized;
  } catch { throw new ManagedBrowserError("BROWSER_MANAGED_INPUT_REFUSED"); }
}

/** Native view copied by trusted parent code; no environment values are logged. */
function runtimeSnapshot(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [name, field] of Object.entries(Object.getOwnPropertyDescriptors(process.env))) {
    if (!Object.hasOwn(field, "value") || (field.value !== undefined && typeof field.value !== "string")) throw new ManagedBrowserError("BROWSER_MANAGED_INPUT_REFUSED");
    Object.defineProperty(result, name, { value: field.value as string | undefined, enumerable: true, writable: false, configurable: false });
  }
  return result;
}
function environment(input: Normalized, directory: string): Readonly<NodeJS.ProcessEnv> {
  const platform = process.platform;
  if (!["win32", "linux", "darwin"].includes(platform) || (platform !== "win32" && !input.allowUserKeychain)) throw new ManagedBrowserError("BROWSER_MANAGED_PLATFORM_REFUSED");
  const store = { win32: "dpapi", linux: "secret-service", darwin: "keychain-macos" }[platform as "win32" | "linux" | "darwin"];
  return createBrowserWorkerEnvironment({ platform, store, runDirectory: directory, runtime: runtimeSnapshot() });
}
function environmentHash(env: Readonly<NodeJS.ProcessEnv>): string { return digest(JSON.stringify(Object.keys(env).sort().map(key => [key, env[key]]))); }
function platformAllowed(input: Normalized): void {
  if (!["win32", "linux", "darwin"].includes(process.platform) || (process.platform !== "win32" && !input.allowUserKeychain)) throw new ManagedBrowserError("BROWSER_MANAGED_PLATFORM_REFUSED");
}

interface Entry { readonly file: string; readonly sha256: string; readonly dev: bigint; readonly ino: bigint; readonly bytes: Buffer }
async function entry(file: string): Promise<Entry> {
  try {
    if (await realpath(file) !== file) throw Error();
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 1048576n) throw Error();
    const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await fd.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error();
      const bytes = Buffer.alloc(Number(opened.size) + 1); let count = 0;
      while (count < bytes.length) { const part = await fd.read(bytes, count, bytes.length - count, count); count += part.bytesRead; if (!part.bytesRead) break; }
      const after = await fd.stat({ bigint: true }), named = await lstat(file, { bigint: true });
      if (count !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || named.nlink !== 1n || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== before.size || named.mtimeNs !== before.mtimeNs || named.ctimeNs !== before.ctimeNs || await realpath(file) !== file) throw Error();
      const accepted = bytes.subarray(0, count);
      return Object.freeze({ file, sha256: digest(accepted), dev: opened.dev, ino: opened.ino, bytes: accepted });
    } finally { await fd.close(); }
  } catch { throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED"); }
}
async function unchanged(entries: readonly Entry[]): Promise<void> {
  for (const previous of entries) { const current = await entry(previous.file); if (current.dev !== previous.dev || current.ino !== previous.ino || current.sha256 !== previous.sha256) throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED"); }
}

function registry(binding: BrowserAccountBinding, runId: string): unknown {
  const profiles: Record<string, unknown> = {};
  for (const role of ["Editor", "Reviewer"] as const) {
    profiles[browserRunProfile(binding.target.id, runId, role === "Editor" ? "editor" : "reviewer")] = {
      app: "testlane-disposable-browser", environment: binding.target.environment, baseUrl: binding.target.origin, strategy: binding.authTemplate.strategy,
      account: { email: browserAccountEmail(runId, role), role: binding.authTemplate.roleLabels[role] }, session: { ttlMinutes: 10 }, options: binding.authTemplate.options,
    };
  }
  return { version: 1, profiles };
}
function confirmedChildError(error: unknown): boolean {
  if (!error || typeof error !== "object" || types.isProxy(error) || Object.getPrototypeOf(error) !== BrowserChildError.prototype || !types.isNativeError(error)) return false;
  return Object.getOwnPropertyDescriptor(error, "terminationConfirmed")?.value === true;
}
function fallback(error: unknown): ManagedBrowserReport {
  const code = managedErrorCode(error) ?? "BROWSER_MANAGED_STATE_REFUSED";
  return Object.freeze({ schemaVersion: 1, runId: null, verdict: code === "BROWSER_MANAGED_CANCELLED" ? "cancelled" : "blocked", reasonCodes: Object.freeze([code]),
    verification: "not-run", cleanup: "incomplete", accounts: "pending", nativeEntries: "pending", temporaryFiles: "pending", recoveryRequired: true });
}

async function realDependencies(input: Normalized, root: ManagedRoot, journal: ManagedJournal, run: BrowserAccountRun,
  coordinator: Awaited<ReturnType<typeof createBrowserAccountCoordinator>>, env: Readonly<NodeJS.ProcessEnv>, entries: readonly Entry[], prepared?: PreparedBrowserPlan, worker?: BrowserWorkerBinding): Promise<ManagedLifecycleDependencies> {
  const runDirectory = path.join(root.runs, run.runId), temporary = path.join(runDirectory, "tmp"), revocation = path.join(runDirectory, "revocation");
  const nativeEntry = entries.find(item => item.file.endsWith(path.sep + "native-entry.js"))!;
  const cliEntry = entries.find(item => item.file.endsWith(path.sep + "cli.js"));
  const runnerAbort = new AbortController(), runnerSignal = input.signal ? AbortSignal.any([input.signal, runnerAbort.signal]) : runnerAbort.signal;
  const checkDirectories = async () => { await root.check(root.root); await root.check(root.runs); await root.check(runDirectory); };
  const assertSource = async () => {
    await checkDirectories(); await unchanged(entries);
    if (prepared) await assertManagedBrowserPlanUnchanged(prepared);
    if (JSON.stringify(await root.read(path.join(runDirectory, "profiles.json"))) !== JSON.stringify(registry(input.binding, run.runId))) throw new ManagedBrowserError("BROWSER_MANAGED_STATE_REFUSED");
    if (worker && JSON.stringify(await root.read(path.join(runDirectory, "worker-binding.json"))) !== JSON.stringify(worker)) throw new ManagedBrowserError("BROWSER_MANAGED_STATE_REFUSED");
  };
  let planned: readonly ManagedPlannedCase[] = [];
  let reportSources: { helperSHA256: string; harnessSHA256: string } | undefined;
  if (prepared) {
    const source = (name: string) => entries.find(item => item.file === fileURLToPath(new URL("../../examples/agent-verification/" + name, import.meta.url)))!;
    const helper = source("authoring.mjs"), harness = ["runtime.mjs", "contracts.mjs", "reporter.mjs", "bootstrap.mjs", "run.mjs"].map(name => source(name));
    if (!helper || harness.some(item => !item)) throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED");
    reportSources = { helperSHA256: helper.sha256, harnessSHA256: digest(Buffer.concat(harness.map(item => item.bytes))) };
    // Recheck around the bounded read: only the exact preflight-bound JSON is used.
    await assertManagedBrowserPlanUnchanged(prepared);
    const handle = await open(prepared.plan.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes: Buffer;
    try { const size = (await handle.stat()).size; if (size < 1 || size > 256 * 1024) throw Error(); bytes = Buffer.alloc(size + 1); const read = await handle.read(bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, read.bytesRead); }
    finally { await handle.close(); }
    if (digest(bytes) !== prepared.plan.sha256) throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED");
    const contractsURL = new URL("../../examples/agent-verification/contracts.mjs", import.meta.url).href;
    const contracts = await import(contractsURL) as { validatePlan(value: unknown): { cases: readonly ManagedPlannedCase[] } };
    planned = contracts.validatePlan(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown).cases;
    await assertManagedBrowserPlanUnchanged(prepared);
  }
  return {
    coordinator, save: value => root.save(value), assertSource,
    async native(operation, profile, secret) {
      await checkDirectories(); await unchanged([nativeEntry]);
      try {
        const result = await runBrowserChild({ entry: process.execPath, args: [nativeEntry.file, operation, profile], cwd: runDirectory, env, timeoutMs: 35000, maxOutputBytes: 1024,
          ...(operation === "seed" && input.signal !== undefined ? { signal: input.signal } : {}), ...(secret === undefined ? {} : { input: secret }) });
        if (result.code !== 0 || !result.stderrEmpty || !result.stdout.endsWith("\n")) throw new ManagedBrowserError("BROWSER_MANAGED_NATIVE_FAILED");
        const reply = copyOwnDataRecord(JSON.parse(result.stdout) as unknown, ["schemaVersion", "status"]), expected = operation === "seed" ? ["seeded"] : operation === "delete" ? ["deleted"] : ["present", "absent"];
        if (reply["schemaVersion"] !== 1 || !expected.includes(reply["status"] as string)) throw new ManagedBrowserError("BROWSER_MANAGED_NATIVE_FAILED");
        await checkDirectories(); return reply["status"] as "present" | "absent" | "seeded" | "deleted";
      } catch (error) {
        if (managedErrorCode(error)) throw error;
        throw new ManagedBrowserError("BROWSER_MANAGED_NATIVE_FAILED", confirmedChildError(error));
      }
    },
    async launch() {
      if (!prepared || !cliEntry || !reportSources) throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED");
      const result = await runBrowserChild({ entry: process.execPath, args: [cliEntry.file, "verify", "run", "--plan", prepared.plan.file, "--output-dir", path.join(runDirectory, "verification"), "--json"],
        cwd: prepared.projectDirectory, env, signal: runnerSignal, timeoutMs: 210000, maxOutputBytes: 256 * 1024 });
      if (!result.stderrEmpty || !result.stdout.endsWith("\n")) return { verification: "blocked", settled: false };
      try { return await projectManagedBrowserOutcome(JSON.parse(result.stdout) as unknown, result.code, prepared, planned, reportSources); }
      catch { return { verification: "blocked", settled: false }; }
    },
    stopRunner: () => runnerAbort.abort(),
    async request() {
      await checkDirectories(); await root.check(revocation);
      const file = path.join(revocation, "request.json"), first = await readBrowserBarrierFile(file);
      if (!first) return;
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(first.bytes)) as unknown;
      const second = await readBrowserBarrierFile(file);
      if (!second || second.identity.dev !== first.identity.dev || second.identity.ino !== first.identity.ino || !second.bytes.equals(first.bytes)) throw new ManagedBrowserError("BROWSER_MANAGED_BARRIER_FAILED");
      return value;
    },
    async respond(status) {
      await checkDirectories(); await root.check(revocation);
      if (!worker || JSON.stringify(await root.read(path.join(runDirectory, "worker-binding.json"))) !== JSON.stringify(worker)) throw new ManagedBrowserError("BROWSER_MANAGED_BARRIER_FAILED");
      await root.write(path.join(revocation, "response.json"), { schemaVersion: 1, targetId: run.targetId, runId: run.runId, expiresAt: run.expiresAt, nonce: worker.revocation.nonce, status });
    },
    emptyTemporary: async () => { await checkDirectories(); await root.empty(temporary); },
    cancelled: () => aborted(input.signal), now: Date.now, pause: () => pause(25),
  };
}

/** No raw child report is returned; the existing private runner report stays local. */
export async function runDisposableBrowserVerification(value: DisposableBrowserOptions): Promise<ManagedBrowserReport> {
  let root: ManagedRoot | undefined, locked = false, journal: ManagedJournal | undefined;
  try {
    const input = options(value, false); platformAllowed(input);
    if (aborted(input.signal)) throw new ManagedBrowserError("BROWSER_MANAGED_CANCELLED");
    const prepared = await prepareManagedBrowserPlan(input.planFile!, input.binding);
    const entries = await Promise.all([fileURLToPath(new URL("../cli.js", import.meta.url)), fileURLToPath(new URL("./native-entry.js", import.meta.url)), input.binding.adapter.modulePath,
      ...["authoring.mjs", "runtime.mjs", "contracts.mjs", "reporter.mjs", "bootstrap.mjs", "run.mjs"].map(name => fileURLToPath(new URL("../../examples/agent-verification/" + name, import.meta.url)))].map(entry));
    if (entries[2]!.sha256 !== input.binding.adapter.sha256) throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED");
    root = await openManagedRoot(input.outputDir, input.binding.target.id, browserBindingHash(input.binding)); await root.acquire(); locked = true;
    if (root.currentRunId !== null) throw new ManagedBrowserError("BROWSER_MANAGED_RECOVERY_REQUIRED");
    const coordinator = await createBrowserAccountCoordinator({ adapter: input.adapter, binding: input.binding, root: root.coordinator });
    const runId = randomUUID(), runDirectory = path.join(root.runs, runId);
    await root.current(runId); await root.directory(runDirectory, true);
    for (const child of ["broker-home", "tmp", "revocation", "verification"]) await root.directory(path.join(runDirectory, child), true);
    const env = environment(input, runDirectory), run = await coordinator.beginRun({ runId });
    journal = journalFor(run.targetId, run.bindingHash, run.runId, run.expiresAt, environmentHash(env)); await root.save(journal);
    await root.write(path.join(runDirectory, "profiles.json"), registry(input.binding, runId));
    const nonce = randomBytes(24).toString("hex"), worker = createBrowserWorkerBinding({ targetId: run.targetId, runId, expiresAt: run.expiresAt, cliPath: entries[0]!.file, baseURL: input.binding.target.origin, runDirectory, nonce }, Date.now());
    await root.write(path.join(runDirectory, "worker-binding.json"), worker);
    const deps = await realDependencies(input, root, journal, run, coordinator, env, entries, prepared, worker);
    await executeManagedLifecycle(journal, run, nonce, deps);
    const report = managedReport(journal);
    if (report.cleanup === "completed") await root.current(null);
    if (journal.child !== "pending" && journal.child !== "unknown" && journal.nativeChild === "settled") { await root.release(); locked = false; }
    return finalManagedReport(journal, aborted(input.signal));
  } catch (error) {
    if (journal) { remember(journal, managedErrorCode(error) ?? "BROWSER_MANAGED_STATE_REFUSED"); journal.phase = "recovery-required"; try { await root?.save(journal); } catch { /* Preserve original private files. */ } return managedReport(journal); }
    return fallback(error);
  } finally {
    // Release only our exact lock once all child/delivery work is settled. A
    // known cleanup failure leaves its journal and permits explicit recovery.
    if (root && locked && (!journal || (journal.child !== "pending" && journal.child !== "unknown" && journal.nativeChild === "settled"))) {
      try { await root.release(); } catch { /* Already nonpassing on the explicit final-release path. */ }
    }
  }
}

/** No create, seed, retry or runner launch. Only original-run scoped cleanup. */
export async function recoverDisposableBrowserVerification(value: RecoverDisposableBrowserOptions): Promise<ManagedBrowserReport> {
  let root: ManagedRoot | undefined, locked = false, journal: ManagedJournal | undefined;
  try {
    const input = options(value, true); platformAllowed(input);
    if (aborted(input.signal)) throw new ManagedBrowserError("BROWSER_MANAGED_CANCELLED");
    root = await openManagedRoot(input.outputDir, input.binding.target.id, browserBindingHash(input.binding)); await root.acquire(); locked = true;
    if (root.currentRunId !== input.runId) throw new ManagedBrowserError("BROWSER_MANAGED_RECOVERY_REQUIRED");
    journal = await root.load(input.runId!);
    if (journal.child === "pending" || journal.child === "unknown" || journal.nativeChild !== "settled") throw new ManagedBrowserError("BROWSER_MANAGED_RECOVERY_REQUIRED", false);
    const directory = path.join(root.runs, journal.runId), env = environment(input, directory);
    if (environmentHash(env) !== journal.environmentHash) throw new ManagedBrowserError("BROWSER_MANAGED_RECOVERY_REQUIRED");
    for (const child of ["broker-home", "tmp", "revocation", "verification"]) await root.directory(path.join(directory, child), false);
    if (JSON.stringify(await root.read(path.join(directory, "profiles.json"))) !== JSON.stringify(registry(input.binding, journal.runId))) throw new ManagedBrowserError("BROWSER_MANAGED_RECOVERY_REQUIRED");
    const entries = await Promise.all([fileURLToPath(new URL("./native-entry.js", import.meta.url)), input.binding.adapter.modulePath].map(entry));
    if (entries[1]!.sha256 !== input.binding.adapter.sha256) throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED");
    const coordinator = await createBrowserAccountCoordinator({ adapter: input.adapter, binding: input.binding, root: root.coordinator });
    const run = await coordinator.recoverRun(journal.runId);
    if (run.targetId !== journal.targetId || run.bindingHash !== journal.bindingHash || run.expiresAt !== journal.expiresAt) throw new ManagedBrowserError("BROWSER_MANAGED_RECOVERY_REQUIRED");
    const deps = await realDependencies(input, root, journal, run, coordinator, env, entries);
    await finishManagedCleanup(journal, run, deps);
    const report = managedReport(journal); if (report.cleanup === "completed") await root.current(null);
    await root.release(); locked = false; return finalManagedReport(journal, aborted(input.signal));
  } catch (error) {
    if (journal) { remember(journal, managedErrorCode(error) ?? "BROWSER_MANAGED_STATE_REFUSED"); journal.phase = "recovery-required"; try { await root?.save(journal); } catch { /* Never repair unknown files. */ } return managedReport(journal); }
    return fallback(error);
  } finally {
    if (root && locked && (!journal || (journal.child !== "pending" && journal.child !== "unknown" && journal.nativeChild === "settled"))) { try { await root.release(); } catch { /* Retained lock requires manual review. */ } }
  }
}
