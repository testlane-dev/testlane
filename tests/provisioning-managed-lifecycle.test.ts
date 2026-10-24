import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { browserRunProfile } from "../src/provisioning/worker-contracts.js";
import { browserAccountEmail, type BrowserAccountRole } from "../src/provisioning/adapter.js";
import type { BrowserAccountCoordinator, BrowserAccountOperation, BrowserAccountRun } from "../src/provisioning/core.js";
import { executeManagedLifecycle, finishManagedCleanup, type ManagedLifecycleDependencies } from "../src/provisioning/managed-lifecycle.js";
import { finalManagedReport, journalFor, managedReport, ManagedBrowserError, normalizeManagedJournal } from "../src/provisioning/managed-state.js";
import type { ManagedOutcome } from "../src/provisioning/managed-report.js";

const secret = "synthetic-secret-not-for-reports-0123456789";
function fixture() {
  const run: BrowserAccountRun = { targetId: randomUUID(), bindingHash: "a".repeat(64), runId: randomUUID(), expiresAt: 610000 };
  const journal = journalFor(run.targetId, run.bindingHash, run.runId, run.expiresAt, "b".repeat(64)), nonce = "c".repeat(48);
  let now = 10000, cancelled = false, sourceCalls = 0, cleanupCalls = 0, launchCalls = 0, stops = 0, turns = 0;
  const calls: string[] = [], saved: string[] = [], store = new Set<string>(), rows: BrowserAccountOperation[] = [];
  let done!: (outcome: ManagedOutcome) => void;
  const runner = new Promise<ManagedOutcome>(resolve => { done = resolve; });
  let requested = false, requestValue: unknown | undefined, nativeHook: ((operation: string, profile: string) => void | Promise<void>) | undefined;
  let beforeCreate: ((role: BrowserAccountRole) => void) | undefined, cleanupHook: (() => void | Promise<void>) | undefined;
  const request = () => ({ schemaVersion: 1, targetId: run.targetId, runId: run.runId, expiresAt: run.expiresAt, nonce });
  const coordinator: BrowserAccountCoordinator = {
    bindingHash: run.bindingHash,
    beginRun: async () => { throw Error("must not begin another run"); }, recoverRun: async id => { if (id !== run.runId) throw Error(); return run; },
    async createAccount(handle, role, deliver) {
      expect(handle).toBe(run); beforeCreate?.(role); calls.push("create:" + role);
      const profile = browserRunProfile(run.targetId, run.runId, role === "Editor" ? "editor" : "reviewer"), id = randomUUID();
      rows.push({ owner: { ...run, operationId: randomUUID(), role, email: browserAccountEmail(run.runId, role) }, profile, accountId: id, status: "seeding", createdAt: now });
      await deliver({ email: browserAccountEmail(run.runId, role), password: secret, role, accountId: id, profile });
      return { id, profile, role, expiresAt: run.expiresAt };
    },
    async cleanupRun(handle) { expect(handle).toBe(run); cleanupCalls++; calls.push("cleanup"); await cleanupHook?.(); return { scope: "accounts-and-sessions", cleanup: "completed", operations: rows.length, ownedRecords: 0, activeReservations: 0 }; },
    async snapshot() { return { schemaVersion: 1, targetId: run.targetId, bindingHash: run.bindingHash, lastNow: now, runs: [{ runId: run.runId, expiresAt: run.expiresAt, status: "released" }], operations: structuredClone(rows) }; },
  };
  const deps: { -readonly [K in keyof ManagedLifecycleDependencies]: ManagedLifecycleDependencies[K] } = {
    coordinator,
    async save(value) { saved.push(JSON.stringify(normalizeManagedJournal(value))); },
    async native(operation, profile, password) {
      calls.push(operation + ":" + (profile.endsWith(":editor") ? "editor" : "reviewer"));
      expect(journal.nativeChild).toBe("pending"); expect(saved.at(-1)).toContain('"nativeChild":"pending"');
      await nativeHook?.(operation, profile);
      if (operation === "seed") { expect(password).toBe(secret); expect(journal.attemptedProfiles).toContain(profile); store.add(profile); return "seeded"; }
      expect(password).toBeUndefined();
      if (operation === "delete") { store.delete(profile); return "deleted"; }
      return store.has(profile) ? "present" : "absent";
    },
    async assertSource() { calls.push("source"); sourceCalls++; },
    async launch() { calls.push("launch"); launchCalls++; expect(journal.child).toBe("pending"); return runner; },
    stopRunner() { calls.push("stop"); stops++; done({ verification: "blocked", settled: true }); },
    async request() { if (!requested) { requested = true; return requestValue ?? request(); } return undefined; },
    async respond(status) { calls.push("respond:" + status); done({ verification: status === "success" ? "passed" : "failed", settled: true }); },
    async emptyTemporary() { calls.push("empty"); }, cancelled: () => cancelled, now: () => now,
    async pause() { if (++turns > 100) throw Error("inert test failed to settle"); await Promise.resolve(); },
  };
  return { run, journal, nonce, deps, calls, saved, store, rows, done: (outcome: ManagedOutcome) => done(outcome),
    setNow(v: number) { now = v; }, cancel() { cancelled = true; }, setRequest(v: unknown) { requestValue = v; },
    setNative(v: typeof nativeHook) { nativeHook = v; }, setBeforeCreate(v: typeof beforeCreate) { beforeCreate = v; }, setCleanup(v: typeof cleanupHook) { cleanupHook = v; },
    counts: () => ({ sourceCalls, cleanupCalls, launchCalls, stops }), runIt: () => executeManagedLifecycle(journal, run, nonce, deps) };
}

it("journals before every sink and completes the same-run barrier, runner join and native cleanup", async () => {
  const f = fixture(); await f.runIt();
  expect(managedReport(f.journal)).toMatchObject({ verdict: "passed", cleanup: "completed", recoveryRequired: false });
  expect(f.calls.slice(0, 9)).toEqual(["source", "present:editor", "present:reviewer", "source", "create:Editor", "seed:editor", "source", "create:Reviewer", "seed:reviewer"]);
  expect(f.calls.indexOf("cleanup")).toBeLessThan(f.calls.indexOf("respond:success"));
  expect(f.calls.filter(v => v.startsWith("delete:"))).toEqual(["delete:editor", "delete:reviewer"]);
  expect(f.calls.filter(v => v.startsWith("respond:"))).toHaveLength(1);
  expect(f.store.size).toBe(0); expect(f.counts()).toMatchObject({ launchCalls: 1, stops: 0 });
  expect(f.saved.join("\n")).not.toContain(secret); expect(JSON.stringify(managedReport(f.journal))).not.toContain(secret);
});

it("retains intended browser failure while independently completing cleanup", async () => {
  const f = fixture(); f.deps.respond = async status => { expect(status).toBe("success"); f.done({ verification: "failed", settled: true }); };
  await f.runIt(); expect(managedReport(f.journal)).toMatchObject({ verdict: "failed", verification: "failed", cleanup: "completed", recoveryRequired: false });
  expect(f.journal.reasonCodes).toEqual(["BROWSER_MANAGED_RUN_FAILED"]); expect(f.store.size).toBe(0);
});

it("refuses foreign native presence before create and never deletes that entry", async () => {
  const f = fixture(); const foreign = f.journal.baseline[0]!.profile; f.store.add(foreign); await f.runIt();
  expect(f.rows).toHaveLength(0); expect(f.counts().launchCalls).toBe(0); expect(f.store.has(foreign)).toBe(true);
  expect(f.calls.some(v => v.startsWith("delete:"))).toBe(false); expect(f.journal.reasonCodes).toContain("BROWSER_MANAGED_NATIVE_PRESENT");
});

it("cleans original attempted profiles after a lost seed ACK when the child is known settled", async () => {
  const f = fixture(); f.setNative((operation, profile) => { if (operation === "seed") { f.store.add(profile); throw new ManagedBrowserError("BROWSER_MANAGED_NATIVE_FAILED", true); } });
  await f.runIt(); expect(f.rows).toHaveLength(1); expect(f.journal.attemptedProfiles).toEqual([f.rows[0]!.profile]);
  expect(f.calls.filter(v => v.startsWith("delete:"))).toEqual(["delete:editor"]); expect(f.store.size).toBe(0);
  expect(managedReport(f.journal)).toMatchObject({ verdict: "blocked", cleanup: "completed" });
});

it("unknown seed stop permanently fences fallback mutations and recovery cleanup", async () => {
  const f = fixture(); f.setNative(operation => { if (operation === "seed") throw new ManagedBrowserError("BROWSER_MANAGED_CHILD_UNKNOWN", false); });
  await f.runIt(); const count = f.calls.length; await finishManagedCleanup(f.journal, f.run, f.deps);
  expect(f.journal.nativeChild).toBe("unknown"); expect(f.counts().cleanupCalls).toBe(0); expect(f.calls.length).toBe(count);
  expect(managedReport(f.journal)).toMatchObject({ cleanup: "incomplete", recoveryRequired: true });
});

it("unknown/malformed runner outcome cannot trigger account or native fallback cleanup", async () => {
  const f = fixture(); f.deps.request = async () => undefined; f.deps.launch = async () => ({ verification: "blocked", settled: false });
  await f.runIt(); expect(f.journal.child).toBe("unknown"); expect(f.counts().cleanupCalls).toBe(0);
  expect(f.store.size).toBe(2); expect(f.calls.some(v => v.startsWith("delete:"))).toBe(false);
});

it("refuses a wrong-run revocation request and joins the actual runner before fallback cleanup", async () => {
  const f = fixture(); f.setRequest({ schemaVersion: 1, targetId: f.run.targetId, runId: randomUUID(), expiresAt: f.run.expiresAt, nonce: f.nonce });
  await f.runIt(); expect(f.counts().stops).toBe(1); expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("cleanup"));
  expect(f.calls.some(v => v.startsWith("respond:"))).toBe(false); expect(f.journal.reasonCodes).toContain("BROWSER_MANAGED_BARRIER_FAILED");
  expect(managedReport(f.journal).verdict).not.toBe("passed");
});

it("does not renew an expired barrier window or claim a late revocation ACK", async () => {
  const f = fixture(); f.setCleanup(() => f.setNow(f.run.expiresAt)); await f.runIt();
  expect(f.calls).toContain("respond:failed"); expect(f.calls).not.toContain("respond:success");
  expect(managedReport(f.journal).verdict).not.toBe("passed");
});

it("known settled cleanup failure can recover only original owners without creating, seeding or launching", async () => {
  const f = fixture(); let fail = true; f.setCleanup(() => { if (fail) throw Error("synthetic-private-canary"); });
  await f.runIt(); expect(managedReport(f.journal)).toMatchObject({ cleanup: "incomplete", recoveryRequired: true });
  const before = f.counts(), owners = JSON.stringify(f.rows.map(v => v.owner)); fail = false;
  await finishManagedCleanup(f.journal, f.run, f.deps);
  expect(JSON.stringify(f.rows.map(v => v.owner))).toBe(owners); expect(f.counts().launchCalls).toBe(before.launchCalls);
  expect(f.calls.filter(v => v.startsWith("seed:"))).toHaveLength(2); expect(managedReport(f.journal).cleanup).toBe("completed");
  expect(JSON.stringify(managedReport(f.journal))).not.toContain("synthetic-private-canary");
});

it("pre-create cancellation and changed-source refusal cannot start accounts or a runner", async () => {
  const first = fixture(); first.cancel(); await first.runIt(); expect(first.rows).toHaveLength(0); expect(first.counts().launchCalls).toBe(0);
  const changed = fixture(); changed.deps.assertSource = async () => { throw new ManagedBrowserError("BROWSER_MANAGED_PREFLIGHT_REFUSED"); };
  await changed.runIt(); expect(changed.rows).toHaveLength(0); expect(changed.counts().launchCalls).toBe(0);
});

it("hostile journal/request records never invoke accessors or proxy traps and never export canaries", async () => {
  const f = fixture(); let invoked = false;
  const hostile = Object.defineProperty({ ...f.journal }, "environmentHash", { enumerable: true, get() { invoked = true; throw Error(secret); } });
  expect(() => normalizeManagedJournal(hostile)).toThrow("BROWSER_MANAGED_STATE_REFUSED");
  const revocable = Proxy.revocable([], {}); revocable.revoke();
  expect(() => normalizeManagedJournal({ ...f.journal, baseline: revocable.proxy })).toThrow("BROWSER_MANAGED_STATE_REFUSED");
  f.setRequest(new Proxy({}, { ownKeys() { invoked = true; throw Error(secret); } })); await f.runIt();
  expect(invoked).toBe(false); expect(JSON.stringify(managedReport(f.journal))).not.toContain(secret);
});

it("cancellation during native cleanup preserves known cleanup and prevents a pass", async () => {
  const f = fixture(), native = f.deps.native;
  f.deps.native = async (...args) => { const result = await native(...args); if (args[0] === "delete") f.cancel(); return result; };
  await f.runIt();
  expect(managedReport(f.journal)).toMatchObject({ verdict: "cancelled", cleanup: "completed", recoveryRequired: false });
  expect(f.store.size).toBe(0); expect(f.journal.child).toBe("settled"); expect(f.journal.nativeChild).toBe("settled");
  expect(f.journal.reasonCodes).toEqual(["BROWSER_MANAGED_CANCELLED"]);
});

it("cancellation during the final source await prevents pass without inventing unknown writers", async () => {
  const f = fixture(); f.deps.assertSource = async () => { if (f.journal.phase === "complete") { await Promise.resolve(); f.cancel(); } };
  await f.runIt();
  expect(managedReport(f.journal)).toMatchObject({ verdict: "cancelled", verification: "passed", cleanup: "completed" });
  expect(f.journal.child).toBe("settled"); expect(f.journal.nativeChild).toBe("settled"); expect(f.counts().stops).toBe(0);
});

it("synchronous post-release report sampling changes only verdict diagnostics, with no later journal write", async () => {
  const f = fixture(); await f.runIt(); const persisted = f.saved.at(-1), writes = f.saved.length;
  expect(finalManagedReport(f.journal, true)).toMatchObject({ verdict: "cancelled", cleanup: "completed", recoveryRequired: false });
  expect(f.saved).toHaveLength(writes); expect(f.saved.at(-1)).toBe(persisted); expect(f.journal.child).toBe("settled");
  expect(f.journal.reasonCodes).toEqual(["BROWSER_MANAGED_CANCELLED"]);
});
