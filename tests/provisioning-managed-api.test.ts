import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { browserBindingHash, type BrowserAccountAdapter } from "../src/provisioning/adapter.js";
import { BROWSER_ADAPTER_PROTOCOL, normalizeBrowserAccountBinding } from "../src/provisioning/contracts.js";
import { openManagedRoot } from "../src/provisioning/managed-files.js";
import { journalFor } from "../src/provisioning/managed-state.js";
import { recoverDisposableBrowserVerification, runDisposableBrowserVerification } from "../src/provisioning/managed-run.js";

function binding(modulePath: string) {
  return normalizeBrowserAccountBinding({ schemaVersion: 1, status: "reviewed", target: { id: randomUUID(), origin: "http://127.0.0.1:4555", environment: "testing" },
    adapter: { protocol: BROWSER_ADAPTER_PROTOCOL, modulePath, sha256: "a".repeat(64) }, roles: ["Editor", "Reviewer"], ttlMs: 600000,
    maxAccountsPerRun: 2, maxActiveAccounts: 4, maxCreateAttemptsPerHour: 10, effects: { email: false, sms: false, billing: false, webhooks: false },
    authTemplate: { strategy: "form-post", options: { loginPath: "/api/login", fields: '{"email":"{{email}}","password":"{{secret}}"}', sessionCookieName: "test_session", mePath: "/api/me" }, roleLabels: { Editor: "editor", Reviewer: "reviewer" } } });
}

it("public options refuse hostile records and signals without I/O, coercion or offending output", async () => {
  let invoked = false;
  const hostile = new Proxy({}, { ownKeys() { invoked = true; throw Error("synthetic-private-canary"); } });
  const report = await runDisposableBrowserVerification(hostile as never);
  expect(report).toMatchObject({ verdict: "blocked", reasonCodes: ["BROWSER_MANAGED_INPUT_REFUSED"] });
  const input = Object.defineProperty({}, "adapter", { get() { invoked = true; throw Error(); }, enumerable: true });
  expect((await runDisposableBrowserVerification(input as never)).reasonCodes).toEqual(["BROWSER_MANAGED_INPUT_REFUSED"]);
  expect(invoked).toBe(false); expect(JSON.stringify(report)).not.toContain("synthetic-private-canary");
});

it("automatic recovery refuses an unknown original child before adapter or native access and retains its lock", async () => {
  const selected = process.platform === "win32" ? process.env["LOCALAPPDATA"] : os.tmpdir();
  if (!selected || !path.isAbsolute(selected)) throw Error("synthetic parent unavailable");
  const parent = await fs.realpath(selected), directory = path.join(parent, "testlane-managed-api-" + randomUUID()), reviewed = binding(path.join(directory, "never-import.mjs"));
  let invoked = false;
  const adapter = Object.defineProperty({}, "metadata", { enumerable: true, get() { invoked = true; throw Error("synthetic-private-canary"); } }) as BrowserAccountAdapter;
  try {
    const root = await openManagedRoot(directory, reviewed.target.id, browserBindingHash(reviewed)); await root.acquire();
    const runId = randomUUID(); await root.current(runId); await root.directory(path.join(root.runs, runId), true);
    const journal = journalFor(reviewed.target.id, browserBindingHash(reviewed), runId, Date.now() + 600000, "b".repeat(64));
    journal.phase = "recovery-required"; journal.child = "unknown"; await root.save(journal); await root.release();
    const result = await recoverDisposableBrowserVerification({ adapter, binding: reviewed, outputDir: directory, runId, allowUserKeychain: true });
    expect(result).toMatchObject({ runId, verdict: "blocked", cleanup: "incomplete", recoveryRequired: true });
    expect(result.reasonCodes).toContain("BROWSER_MANAGED_RECOVERY_REQUIRED"); expect(invoked).toBe(false);
    expect((await fs.lstat(path.join(directory, "run.lock"))).isDirectory()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-canary");
    // Existing lock blocks a second recovery; no stale-age/force option exists.
    const again = await recoverDisposableBrowserVerification({ adapter, binding: reviewed, outputDir: directory, runId, allowUserKeychain: true });
    expect(again.reasonCodes).toEqual(["BROWSER_MANAGED_LOCKED"]); expect(invoked).toBe(false);
  } finally {
    const canonical = await fs.realpath(directory);
    if (canonical !== directory || path.dirname(canonical) !== parent || !path.basename(canonical).startsWith("testlane-managed-api-")) throw Error("synthetic cleanup refused");
    await fs.rm(canonical, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }
}, 120000);
