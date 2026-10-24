/** Internal state machine. Public API binds real leaves, never caller callbacks. */
import type { BrowserAccountCoordinator, BrowserAccountRun } from "./core.js";
import type { BrowserAccountRole } from "./adapter.js";
import { copyOwnDataRecord } from "./worker-contracts.js";
import { ManagedBrowserError, managedErrorCode, managedStopConfirmed, remember, type ManagedJournal } from "./managed-state.js";
import type { ManagedOutcome } from "./managed-report.js";

export interface ManagedLifecycleDependencies {
  readonly coordinator: BrowserAccountCoordinator;
  readonly save: (journal: ManagedJournal) => Promise<void>;
  readonly native: (operation: "present" | "seed" | "delete", profile: string, secret?: string) => Promise<"present" | "absent" | "seeded" | "deleted">;
  readonly assertSource: () => Promise<void>;
  readonly launch: () => Promise<ManagedOutcome>;
  readonly stopRunner: () => void;
  readonly request: () => Promise<unknown | undefined>;
  readonly respond: (status: "success" | "failed") => Promise<void>;
  readonly emptyTemporary: () => Promise<void>;
  readonly cancelled: () => boolean;
  readonly now: () => number;
  readonly pause: () => Promise<void>;
}

/** All native calls are intent-journaled; unknown stop is permanent in this run. */
async function nativeCall(journal: ManagedJournal, deps: ManagedLifecycleDependencies, operation: "present" | "seed" | "delete", profile: string, secret?: string) {
  if (journal.nativeChild !== "settled") throw new ManagedBrowserError("BROWSER_MANAGED_CHILD_UNKNOWN", false);
  journal.nativeChild = "pending"; await deps.save(journal);
  try {
    const status = await deps.native(operation, profile, secret);
    journal.nativeChild = "settled"; await deps.save(journal); return status;
  } catch (error) {
    journal.nativeChild = managedStopConfirmed(error) ? "settled" : "unknown";
    await deps.save(journal);
    throw new ManagedBrowserError(journal.nativeChild === "unknown" ? "BROWSER_MANAGED_CHILD_UNKNOWN" : "BROWSER_MANAGED_NATIVE_FAILED", journal.nativeChild === "settled");
  }
}
function check(journal: ManagedJournal, deps: ManagedLifecycleDependencies): void {
  if (deps.cancelled()) throw new ManagedBrowserError("BROWSER_MANAGED_CANCELLED");
  if (deps.now() >= journal.expiresAt) throw new ManagedBrowserError("BROWSER_MANAGED_CANCELLED");
}

/** Cleanup does not remove app records: the reviewed adapter must verify zero. */
export async function finishManagedCleanup(journal: ManagedJournal, run: BrowserAccountRun, deps: ManagedLifecycleDependencies): Promise<void> {
  if (journal.child === "pending" || journal.child === "unknown" || journal.nativeChild !== "settled") {
    journal.phase = "recovery-required"; remember(journal, "BROWSER_MANAGED_CHILD_UNKNOWN"); await deps.save(journal); return;
  }
  journal.phase = "cleanup"; await deps.save(journal);
  try {
    const result = await deps.coordinator.cleanupRun(run);
    if (result.cleanup !== "completed" || result.ownedRecords !== 0 || result.activeReservations !== 0) throw Error();
    journal.accounts = "completed";
  } catch { journal.accounts = "incomplete"; remember(journal, "BROWSER_MANAGED_CLEANUP_INCOMPLETE"); }
  await deps.save(journal);
  try {
    // Core's durable original-owner journal, not successful-seed callbacks, is
    // authoritative for every possible store attempt (including lost ACKs).
    const snapshot = await deps.coordinator.snapshot(), entries = snapshot.operations.filter(row => row.owner.runId === run.runId);
    if (snapshot.targetId !== journal.targetId || snapshot.bindingHash !== journal.bindingHash || entries.length > 2) throw Error();
    for (const row of entries) {
      const baseline = journal.baseline.find(v => v.profile === row.profile);
      if (!baseline || baseline.absent !== true || row.owner.targetId !== journal.targetId || row.owner.bindingHash !== journal.bindingHash) throw Error();
      if (await nativeCall(journal, deps, "delete", row.profile) !== "deleted" || await nativeCall(journal, deps, "present", row.profile) !== "absent") throw Error();
    }
    journal.native = "completed";
  } catch { journal.native = "incomplete"; remember(journal, "BROWSER_MANAGED_CLEANUP_INCOMPLETE"); }
  await deps.save(journal);
  if (journal.nativeChild === "settled") {
    try { await deps.emptyTemporary(); journal.files = "completed"; }
    catch { journal.files = "incomplete"; remember(journal, "BROWSER_MANAGED_CLEANUP_INCOMPLETE"); }
  } else { journal.files = "incomplete"; remember(journal, "BROWSER_MANAGED_CHILD_UNKNOWN"); }
  journal.phase = journal.accounts === "completed" && journal.native === "completed" && journal.files === "completed" && journal.nativeChild === "settled" ? "complete" : "recovery-required";
  await deps.save(journal);
}

export async function executeManagedLifecycle(journal: ManagedJournal, run: BrowserAccountRun, nonce: string, deps: ManagedLifecycleDependencies): Promise<void> {
  let running: Promise<void> | undefined, runnerDone = false;
  const childState = () => journal.child; // Updated by the joined runner continuation.
  let barrierHandled = false;
  const cleanup = () => deps.coordinator.cleanupRun(run); // One barrier request; recovery is an explicit later API.
  try {
    check(journal, deps); await deps.assertSource(); check(journal, deps);
    for (const row of journal.baseline) {
      const status = await nativeCall(journal, deps, "present", row.profile); row.absent = status === "absent";
      await deps.save(journal);
      if (!row.absent) throw new ManagedBrowserError("BROWSER_MANAGED_NATIVE_PRESENT");
    }
    journal.phase = "accounts"; await deps.save(journal);
    for (const role of ["Editor", "Reviewer"] as const) {
      check(journal, deps); await deps.assertSource(); check(journal, deps);
      await deps.coordinator.createAccount(run, role as BrowserAccountRole, async credential => {
        const baseline = journal.baseline.find(row => row.profile === credential.profile);
        if (!baseline?.absent || journal.attemptedProfiles.includes(credential.profile)) throw new ManagedBrowserError("BROWSER_MANAGED_STATE_REFUSED");
        journal.attemptedProfiles.push(credential.profile); await deps.save(journal);
        check(journal, deps);
        if (await nativeCall(journal, deps, "seed", credential.profile, credential.password) !== "seeded") throw new ManagedBrowserError("BROWSER_MANAGED_NATIVE_FAILED");
      });
    }
    check(journal, deps); await deps.assertSource(); check(journal, deps);
    journal.phase = "runner"; journal.child = "pending"; await deps.save(journal);
    running = deps.launch().then(async outcome => {
      journal.verification = outcome.verification; journal.child = outcome.settled ? "settled" : "unknown";
      if (!outcome.settled) remember(journal, "BROWSER_MANAGED_REPORT_INVALID");
      else if (outcome.verification !== "passed") remember(journal, outcome.verification === "cancelled" ? "BROWSER_MANAGED_CANCELLED" : "BROWSER_MANAGED_RUN_FAILED");
      await deps.save(journal);
    }, async () => { journal.child = "unknown"; remember(journal, "BROWSER_MANAGED_CHILD_UNKNOWN"); await deps.save(journal); }).finally(() => { runnerDone = true; });
    void running.catch(() => {}); // Retain rejection until the joined await, without an unhandled interval.
    while (!runnerDone) {
      if (!barrierHandled && !deps.cancelled()) {
        const request = await deps.request();
        if (request !== undefined) {
          if (childState() === "unknown") throw new ManagedBrowserError("BROWSER_MANAGED_CHILD_UNKNOWN", false);
          const data = copyOwnDataRecord(request, ["schemaVersion", "targetId", "runId", "expiresAt", "nonce"]);
          if (data["schemaVersion"] !== 1 || data["targetId"] !== run.targetId || data["runId"] !== run.runId || data["expiresAt"] !== run.expiresAt || data["nonce"] !== nonce) throw new ManagedBrowserError("BROWSER_MANAGED_BARRIER_FAILED");
          barrierHandled = true; journal.barrier = "pending"; await deps.save(journal);
          let status: "success" | "failed" = "failed";
          try {
            check(journal, deps);
            const receipt = await cleanup();
            if (receipt.cleanup !== "completed" || receipt.ownedRecords !== 0 || receipt.activeReservations !== 0) throw Error();
            journal.accounts = "completed"; check(journal, deps);
            if (childState() === "unknown") throw Error();
            status = "success";
          } catch { journal.accounts = "incomplete"; remember(journal, "BROWSER_MANAGED_BARRIER_FAILED"); }
          // A completed account cleanup after expiry is not an in-window ACK.
          await deps.respond(status); journal.barrier = status; await deps.save(journal);
        }
      }
      if (!runnerDone) await deps.pause();
    }
    await running;
    if (journal.verification === "passed" && journal.barrier !== "success") remember(journal, "BROWSER_MANAGED_BARRIER_FAILED");
    if (childState() === "settled") {
      try { await deps.assertSource(); } catch { remember(journal, "BROWSER_MANAGED_PREFLIGHT_REFUSED"); }
    }
  } catch (error) {
    remember(journal, managedErrorCode(error) ?? "BROWSER_MANAGED_ACCOUNT_FAILED");
    if (running && !runnerDone) { deps.stopRunner(); await running; }
  } finally {
    // No late runner is allowed to outlive a returned parent result. If its
    // own stop/report is unknown, cleanup below refuses instead of inventing ACK.
    if (running && !runnerDone) { deps.stopRunner(); await running; }
  }
  await finishManagedCleanup(journal, run, deps);
  if (journal.child === "settled" && journal.verification === "passed") {
    try { await deps.assertSource(); } catch { remember(journal, "BROWSER_MANAGED_PREFLIGHT_REFUSED"); }
  }
  // Cleanup must finish despite cancellation, but a signal observed before
  // completion cannot be converted into a passing verification outcome.
  if (deps.cancelled()) remember(journal, "BROWSER_MANAGED_CANCELLED");
  await deps.save(journal);
}
