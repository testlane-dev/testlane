import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openManagedRoot } from "../src/provisioning/managed-files.js";
import { journalFor } from "../src/provisioning/managed-state.js";
import { executeManagedLifecycle } from "../src/provisioning/managed-lifecycle.js";
import type { BrowserAccountCoordinator, BrowserAccountOperation, BrowserAccountRun } from "../src/provisioning/core.js";
import type { ManagedOutcome } from "../src/provisioning/managed-report.js";

it("retains exact private locks, durably recovers the original journal, and refuses linked state", async () => {
  const selected = process.platform === "win32" ? process.env["LOCALAPPDATA"] : os.tmpdir();
  if (!selected || !path.isAbsolute(selected)) throw Error("synthetic private parent unavailable");
  const parent = await fs.realpath(selected), directory = path.join(parent, "testlane-managed-" + randomUUID());
  const targetId = randomUUID(), bindingHash = "a".repeat(64), runId = randomUUID();
  try {
    const root = await openManagedRoot(directory, targetId, bindingHash); await root.acquire();
    const competitor = await openManagedRoot(directory, targetId, bindingHash);
    await expect(competitor.acquire()).rejects.toThrow("BROWSER_MANAGED_LOCKED");
    await root.current(runId); const runDirectory = path.join(root.runs, runId); await root.directory(runDirectory, true);
    const journal = journalFor(targetId, bindingHash, runId, Date.now() + 600000, "b".repeat(64));
    journal.phase = "recovery-required"; journal.accounts = "incomplete"; await root.save(journal); await root.release();
    const recovered = await openManagedRoot(directory, targetId, bindingHash); await recovered.acquire();
    expect(recovered.currentRunId).toBe(runId); expect(await recovered.load(runId)).toEqual(journal);
    // Exercise the real atomic journal with immediate runner completion while
    // the barrier continuation also saves. Both calls are demonstrably pending.
    const run: BrowserAccountRun = { targetId, bindingHash, runId, expiresAt: journal.expiresAt }, operations: BrowserAccountOperation[] = [];
    let pending = 0, maximumPending = 0, requested = false, resolveRunner!: (outcome: ManagedOutcome) => void;
    const runner = new Promise<ManagedOutcome>(resolve => { resolveRunner = resolve; });
    const coordinator: BrowserAccountCoordinator = {
      bindingHash, beginRun: async () => { throw Error(); }, recoverRun: async () => run,
      async createAccount(_handle, role, deliver) {
        const profile = journal.baseline[role === "Editor" ? 0 : 1]!.profile, id = randomUUID(), email = `tlp-${runId}-${role.toLowerCase()}@example.test`;
        operations.push({ owner: { ...run, operationId: randomUUID(), role, email }, profile, accountId: id, status: "ready", createdAt: Date.now() });
        await deliver({ email, password: "inert-password-only", role, accountId: id, profile }); return { id, role, profile, expiresAt: run.expiresAt };
      },
      cleanupRun: async () => ({ scope: "accounts-and-sessions", cleanup: "completed", operations: operations.length, ownedRecords: 0, activeReservations: 0 }),
      snapshot: async () => ({ schemaVersion: 1, targetId, bindingHash, lastNow: Date.now(), runs: [], operations }),
    };
    const nonce = "c".repeat(48);
    await executeManagedLifecycle(journal, run, nonce, {
      coordinator,
      async save(value) { pending++; maximumPending = Math.max(maximumPending, pending); try { await recovered.save(value); } finally { pending--; } },
      native: async operation => operation === "seed" ? "seeded" : operation === "delete" ? "deleted" : "absent",
      assertSource: async () => {}, launch: () => runner, stopRunner: () => resolveRunner({ verification: "blocked", settled: true }),
      request: async () => { if (requested) return; requested = true; return { schemaVersion: 1, targetId, runId, expiresAt: run.expiresAt, nonce }; },
      respond: async () => { resolveRunner({ verification: "passed", settled: true }); }, emptyTemporary: async () => {}, cancelled: () => false, now: Date.now,
      pause: () => new Promise(resolve => setTimeout(resolve, 1)),
    });
    expect(maximumPending).toBeGreaterThan(1); expect(await recovered.load(runId)).toEqual(journal); expect(journal.phase).toBe("complete");
    const file = path.join(runDirectory, "managed-run.json"), hardlink = path.join(runDirectory, "foreign-linked-copy");
    await fs.link(file, hardlink);
    await expect(recovered.load(runId)).rejects.toThrow(); expect((await fs.lstat(hardlink)).nlink).toBe(2);
    await fs.unlink(hardlink);
    await recovered.release();
    // A different lock object must never be removed by our old retained handle.
    const final = await openManagedRoot(directory, targetId, bindingHash); await final.acquire();
    const lock = path.join(directory, "run.lock"); await fs.rmdir(lock); await fs.mkdir(lock, { mode: 0o700 });
    await expect(final.release()).rejects.toThrow(); expect((await fs.lstat(lock)).isDirectory()).toBe(true);
  } finally {
    const canonical = await fs.realpath(directory);
    if (canonical !== directory || path.dirname(canonical) !== parent || !path.basename(canonical).startsWith("testlane-managed-")) throw Error("synthetic cleanup refused");
    await fs.rm(canonical, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }
}, 120000);
