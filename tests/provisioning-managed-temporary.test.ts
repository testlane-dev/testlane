/** Owned synthetic filesystem only; no provider, browser, broker or native store. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { openManagedRoot } from "../src/provisioning/managed-files.js";
import { finishManagedCleanup, type ManagedLifecycleDependencies } from "../src/provisioning/managed-lifecycle.js";
import { journalFor, managedReport } from "../src/provisioning/managed-state.js";
import type { BrowserAccountCoordinator, BrowserAccountRun } from "../src/provisioning/core.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  const lstat = vi.fn(actual.lstat);
  return { ...actual, default: { ...actual, lstat }, lstat };
});
async function restoreStat() { vi.mocked(fs.lstat).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).lstat); }
afterEach(restoreStat);

async function fixture() {
  const parent = await fs.realpath(process.platform === "win32" ? process.env["LOCALAPPDATA"]! : os.tmpdir());
  const container = path.join(parent, "testlane-temp-cleanup-" + randomUUID()); await fs.mkdir(container, { mode: 0o700 });
  const canonical = await fs.realpath(container), rootDirectory = path.join(container, "managed");
  const targetId = randomUUID(), runId = randomUUID(), bindingHash = "a".repeat(64);
  const root = await openManagedRoot(rootDirectory, targetId, bindingHash); await root.acquire(); await root.current(runId);
  const directory = path.join(root.runs, runId), temporary = path.join(directory, "tmp");
  await root.directory(directory, true); await root.directory(temporary, true);
  const journal = journalFor(targetId, bindingHash, runId, Date.now() + 600000, "b".repeat(64));
  journal.child = "settled"; journal.nativeChild = "settled"; journal.phase = "cleanup";
  journal.accounts = "completed"; journal.native = "completed"; await root.save(journal);
  const cache = path.join(temporary, "playwright-transform-cache");
  const seed = async () => { await fs.mkdir(path.join(cache, "ab"), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(cache, "ab", "inert.spec.js"), "synthetic-cache-only", { flag: "wx", mode: 0o600 }); await fs.writeFile(path.join(cache, "ab", "inert.spec.map"), "{}", { flag: "wx", mode: 0o600 }); };
  return { root, runId, targetId, bindingHash, journal, temporary, directory, container, cache, seed,
    async close() {
      await restoreStat();
      if (await fs.realpath(container) !== canonical || canonical !== container || path.dirname(canonical) !== parent || !path.basename(canonical).startsWith("testlane-temp-cleanup-")) throw Error("synthetic cleanup refused");
      await fs.rm(canonical, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    } };
}

it("reproduces empty-only refusal, then clears a settled run's nested cache without touching other run data", async () => {
  const f = await fixture(); try {
    await f.seed(); const sentinel = path.join(f.directory, "owned-result.json"); await fs.writeFile(sentinel, "preserved", { flag: "wx", mode: 0o600 });
    await expect(f.root.empty(f.temporary)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    await f.root.clearTemporary(f.runId); await f.root.empty(f.temporary);
    expect(await fs.readdir(f.temporary)).toEqual([]); expect(await fs.readFile(sentinel, "utf8")).toBe("preserved");
    expect((await fs.lstat(f.temporary)).isDirectory()).toBe(true); await f.root.clearTemporary(f.runId);
  } finally { await f.close(); }
}, 120000);

it("refuses pending or unknown writers, foreign runs and missing locks before removing any entry", async () => {
  const f = await fixture(); try {
    await f.seed();
    for (const child of ["pending", "unknown"] as const) { f.journal.child = child; await f.root.save(f.journal); await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED"); }
    f.journal.child = "settled";
    for (const native of ["pending", "unknown"] as const) { f.journal.nativeChild = native; await f.root.save(f.journal); await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED"); }
    f.journal.nativeChild = "settled"; await f.root.save(f.journal);
    await expect(f.root.clearTemporary(randomUUID())).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    await f.root.release(); await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect(await fs.readFile(path.join(f.cache, "ab", "inert.spec.js"), "utf8")).toBe("synthetic-cache-only");
  } finally { await f.close(); }
}, 120000);

it("preflights all entries and preserves foreign symlink and hardlink targets without partial deletion", async () => {
  const f = await fixture(); try {
    await f.seed(); const foreign = path.join(f.container, "foreign"); await fs.mkdir(foreign); const outside = path.join(foreign, "keep"); await fs.writeFile(outside, "foreign-inert-only", { flag: "wx", mode: 0o600 });
    const alias = path.join(f.temporary, "z-alias"); await fs.symlink(foreign, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect(await fs.readFile(path.join(f.cache, "ab", "inert.spec.js"), "utf8")).toBe("synthetic-cache-only");
    if (process.platform === "win32") await fs.rmdir(alias); else await fs.unlink(alias);
    const linked = path.join(f.temporary, "z-hardlink"); await fs.link(outside, linked);
    await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect(await fs.readFile(outside, "utf8")).toBe("foreign-inert-only"); expect(await fs.readdir(path.join(f.cache, "ab"))).toHaveLength(2);
  } finally { await f.close(); }
}, 120000);

it("refuses a replaced retained tmp root and leaves both the original and replacement intact", async () => {
  const f = await fixture(); try {
    await f.seed(); const original = path.join(f.directory, "original-tmp"); await fs.rename(f.temporary, original); await fs.mkdir(f.temporary, { mode: 0o700 });
    await fs.writeFile(path.join(f.temporary, "replacement"), "not-admitted", { flag: "wx", mode: 0o600 });
    await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect(await fs.readFile(path.join(original, "playwright-transform-cache", "ab", "inert.spec.js"), "utf8")).toBe("synthetic-cache-only");
    expect(await fs.readFile(path.join(f.temporary, "replacement"), "utf8")).toBe("not-admitted");
  } finally { await f.close(); }
}, 120000);

it("detects an inode mutation after scanning and preserves all remaining entries", async () => {
  const f = await fixture(); try {
    await f.seed(); const target = path.join(f.cache, "ab", "inert.spec.js"), retained = path.join(f.container, "retained-original");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); let calls = 0;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === target && ++calls === 3) { await actual.rename(target, retained); await actual.writeFile(target, "replacement-inert-only", { flag: "wx", mode: 0o600 }); }
      return Reflect.apply(actual.lstat, actual, args);
    }) as typeof fs.lstat);
    await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect(calls).toBeGreaterThanOrEqual(3); expect(await fs.readFile(retained, "utf8")).toBe("synthetic-cache-only");
    expect(await fs.readFile(target, "utf8")).toBe("replacement-inert-only"); expect(await fs.readdir(path.join(f.cache, "ab"))).toHaveLength(2);
  } finally { await f.close(); }
}, 120000);

it("refuses a metadata size ceiling before deleting admitted ordinary files", async () => {
  const f = await fixture(); try {
    await f.seed(); const large = path.join(f.temporary, "z-large"); const file = await fs.open(large, "wx", 0o600);
    try { await file.truncate(16 * 1024 * 1024 + 1); } finally { await file.close(); }
    await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect((await fs.lstat(large)).size).toBe(16 * 1024 * 1024 + 1); expect(await fs.readdir(path.join(f.cache, "ab"))).toHaveLength(2);
  } finally { await f.close(); }
}, 120000);

it("refuses cross-device descendant metadata without traversing or deleting the admitted cache", async () => {
  const f = await fixture(); try {
    await f.seed(); const target = path.join(f.cache, "ab", "inert.spec.js");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const value = await Reflect.apply(actual.lstat, actual, args);
      if (args[0] === target) Object.defineProperty(value, "dev", { value: (value.dev as bigint) + 1n });
      return value;
    }) as typeof fs.lstat);
    await expect(f.root.clearTemporary(f.runId)).rejects.toThrow("BROWSER_MANAGED_STATE_REFUSED");
    expect(await fs.readdir(path.join(f.cache, "ab"))).toHaveLength(2);
  } finally { await f.close(); }
}, 120000);

it("actual parent cleanup callback completes the lifecycle only after scoped disposal and the unchanged empty check", async () => {
  const f = await fixture(); try {
    await f.seed(); f.journal.verification = "passed"; f.journal.barrier = "success"; await f.root.save(f.journal);
    const source = await fs.readFile(new URL("../src/provisioning/managed-run.ts", import.meta.url), "utf8");
    const match = source.match(/emptyTemporary: (async \(\) => \{[^\n]+\}),/); expect(match).not.toBeNull();
    const callback = vm.runInNewContext("(" + match![1] + ")", { root: f.root, run: { runId: f.runId }, temporary: f.temporary,
      checkDirectories: async () => { await f.root.check(f.directory); } }) as () => Promise<void>;
    const run: BrowserAccountRun = { targetId: f.targetId, bindingHash: f.bindingHash, runId: f.runId, expiresAt: f.journal.expiresAt };
    const coordinator = { cleanupRun: async () => ({ cleanup: "completed", ownedRecords: 0, activeReservations: 0 }), snapshot: async () => ({ targetId: f.targetId, bindingHash: f.bindingHash, operations: [] }) } as unknown as BrowserAccountCoordinator;
    const deps = { coordinator, save: value => f.root.save(value), emptyTemporary: callback } as ManagedLifecycleDependencies;
    await finishManagedCleanup(f.journal, run, deps);
    expect(managedReport(f.journal)).toMatchObject({ verdict: "passed", cleanup: "completed", temporaryFiles: "completed", recoveryRequired: false });
    expect(await fs.readdir(f.temporary)).toEqual([]);
  } finally { await f.close(); }
}, 120000);
