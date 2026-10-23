import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BROWSER_ADAPTER_PROTOCOL, normalizeBrowserAccountBinding } from "../src/provisioning/contracts.js";
import { accountFailure, browserAccountEmail, readOwnedInspection, verifyBrowserAccountAdapter, type BrowserAccountAdapter,
  type BrowserAccountOwner, type BrowserCoordinatorBinding } from "../src/provisioning/adapter.js";
import { createBrowserAccountCoordinator, type BrowserAccountCredential } from "../src/provisioning/core.js";
import { createBrowserPrivateDirectory } from "../src/provisioning/private-directory.js";

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const inertEntry = "export const reviewedSyntheticAdapterSource = true;\n";
const equivalent = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function fixture() {
  const privateParent = process.platform === "win32" ? process.env["LOCALAPPDATA"] : os.tmpdir();
  if (typeof privateParent !== "string" || !path.isAbsolute(privateParent)) throw Error("synthetic private parent unavailable");
  const parent = await fs.realpath(privateParent), directory = path.join(parent, "testlane-core-" + randomUUID());
  await createBrowserPrivateDirectory(directory);
  const entry = path.join(directory, "reviewed-adapter.mjs"); await fs.writeFile(entry, inertEntry, { flag: "wx", mode: 0o600 });
  const root = path.join(directory, "coordinator"); let clock = 1_000_000;
  const binding = normalizeBrowserAccountBinding({ schemaVersion: 1, status: "reviewed", target: { id: randomUUID(), origin: "http://127.0.0.1:4555", environment: "testing" },
    adapter: { protocol: BROWSER_ADAPTER_PROTOCOL, modulePath: entry, sha256: hash(inertEntry) }, roles: ["Editor", "Reviewer"], ttlMs: 600000,
    maxAccountsPerRun: 2, maxActiveAccounts: 4, maxCreateAttemptsPerHour: 10, effects: { email: false, sms: false, billing: false, webhooks: false },
    authTemplate: { strategy: "form-post", options: { loginPath: "/api/login", fields: '{"email":"{{email}}","password":"{{secret}}"}', sessionCookieName: "test_session", mePath: "/api/me" }, roleLabels: { Editor: "writer", Reviewer: "reader" } } });
  type Entry = { owner: BrowserAccountOwner; id: string | null; revoked: boolean; pending: boolean; records: number };
  const operations = new Map<string, Entry>(), accounts = new Map<string, BrowserAccountOwner | null>(), attempts: number[] = [];
  const foreignId = randomUUID(); accounts.set(foreignId, null);
  let coordinator: BrowserCoordinatorBinding | null = null, calls = 0, lostCreate = false, deleteRefused = false;
  let beforeCreate: (() => Promise<void>) | undefined, inspectionOverride: unknown, inspectionSequence: unknown[] = [];
  const ownerEntry = (owner: BrowserAccountOwner) => {
    if (owner.targetId !== binding.target.id || !coordinator || owner.bindingHash !== coordinator.bindingHash) throw accountFailure("BROWSER_ACCOUNT_OWNERSHIP_REFUSED");
    const item = operations.get(owner.operationId);
    if (item && !equivalent(item.owner, owner)) throw accountFailure("BROWSER_ACCOUNT_OWNERSHIP_REFUSED");
    return item;
  };
  const adapter: BrowserAccountAdapter = {
    metadata: { protocol: binding.adapter.protocol, target: binding.target },
    verifyTarget: async function (this: void, _binding, bindingHash) {
      calls++; if (this !== undefined) throw Error("flat closure expected");
      return { target: binding.target, bindingHash, enforced: { targetBinding: true, immutableOwnership: true, targetWideQuotas: true, expiry: true, disabledEffects: true, tombstones: true, liveRevocation: true } };
    },
    coordinatorBinding: async () => { calls++; return coordinator && structuredClone(coordinator); },
    bindCoordinator: async value => { calls++; if (coordinator && !equivalent(coordinator, value)) throw Error("synthetic binding refused"); coordinator = structuredClone(value); return { bound: true }; },
    createOwned: async (owner, _password) => {
      calls++; const prior = ownerEntry(owner);
      if (prior || [...operations.values()].some(row => row.owner.runId === owner.runId && row.owner.role === owner.role)) throw accountFailure("BROWSER_ACCOUNT_REPLAY_REFUSED");
      if (owner.expiresAt <= clock || owner.expiresAt > clock + 600000) throw accountFailure("BROWSER_ACCOUNT_EXPIRED");
      if ([...operations.values()].filter(row => !row.revoked).length >= 4 || attempts.filter(time => time > clock - 3600000).length >= 10) throw accountFailure("BROWSER_ACCOUNT_QUOTA_REFUSED");
      attempts.push(clock); const item: Entry = { owner: structuredClone(owner), id: null, revoked: false, pending: false, records: 0 }; operations.set(owner.operationId, item);
      await beforeCreate?.();
      if (item.revoked || owner.expiresAt <= clock) throw accountFailure("BROWSER_ACCOUNT_REPLAY_REFUSED");
      item.id = randomUUID(); accounts.set(item.id, owner);
      if (lostCreate) { lostCreate = false; throw Error("private-synthetic-canary"); }
      return { id: item.id };
    },
    inspectOwned: async owner => {
      calls++; const item = ownerEntry(owner);
      if (inspectionSequence.length) return inspectionSequence.shift() as Awaited<ReturnType<BrowserAccountAdapter["inspectOwned"]>>;
      if (inspectionOverride !== undefined) return inspectionOverride as Awaited<ReturnType<BrowserAccountAdapter["inspectOwned"]>>;
      return { present: !!item?.id && accounts.has(item.id), id: item?.id ?? null, revoked: item?.revoked === true,
        deliveryPending: item?.pending === true, ownedRecords: item?.records ?? 0, activeReservations: item && !item.revoked ? 1 : 0 };
    },
    beginCredentialDelivery: async owner => { calls++; const item = ownerEntry(owner); if (!item?.id || item.revoked || item.pending) throw Error("refused"); item.pending = true; return { pending: true }; },
    endCredentialDelivery: async owner => { calls++; const item = ownerEntry(owner); if (!item?.pending) throw Error("refused"); item.pending = false; return { pending: false }; },
    revokeDeleteOwned: async owner => {
      calls++; if (deleteRefused) throw Error("private-synthetic-canary");
      const item = ownerEntry(owner) ?? { owner: structuredClone(owner), id: null, revoked: false, pending: false, records: 0 };
      item.revoked = true; operations.set(owner.operationId, item); if (item.id) accounts.delete(item.id); return { revoked: true };
    },
  };
  const now = () => clock;
  const reopen = () => createBrowserAccountCoordinator({ adapter, binding, root, now });
  return { directory, parent, entry, root, binding, adapter, accounts, operations, attempts, foreignId, now, reopen,
    calls: () => calls, setClock(value: number) { clock = value; }, loseCreate() { lostCreate = true; }, setDeleteRefused(value: boolean) { deleteRefused = value; },
    setBeforeCreate(value: (() => Promise<void>) | undefined) { beforeCreate = value; }, setInspection(value: unknown) { inspectionOverride = value; }, setInspectionSequence(value: unknown[]) { inspectionSequence = value; },
    async dispose() {
      const actual = await fs.realpath(directory);
      if (actual !== directory || path.dirname(actual) !== parent || !path.basename(actual).startsWith("testlane-core-")) throw Error("synthetic cleanup refused");
      await fs.rm(actual, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    } };
}

it("verifies entry and metadata before any adapter method and never imports the file", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.entry, "throw new Error('must never execute');\n");
    await expect(f.reopen()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_ADAPTER_REFUSED" }); expect(f.calls()).toBe(0);
    await expect(fs.lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(f.entry, inertEntry);
    let invoked = false; const hostile = { ...f.adapter };
    Object.defineProperty(hostile, "createOwned", { enumerable: true, get() { invoked = true; throw Error("private-synthetic-canary"); } });
    await expect(createBrowserAccountCoordinator({ adapter: hostile, binding: f.binding, root: f.root })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_ADAPTER_REFUSED" });
    await expect(verifyBrowserAccountAdapter(new Proxy(f.adapter, { ownKeys() { invoked = true; throw Error(); } }), f.binding)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_ADAPTER_REFUSED" });
    await expect(verifyBrowserAccountAdapter({ ...f.adapter, metadata: { ...f.adapter.metadata, target: { ...f.binding.target, origin: "http://localhost:4555" } } }, f.binding)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_ADAPTER_REFUSED" });
    await expect(verifyBrowserAccountAdapter({ ...f.adapter, verifyTarget: async () => ({ target: f.binding.target, bindingHash: "a".repeat(64), enforced: { expiry: false } }) }, f.binding)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_ADAPTER_REFUSED" });
    expect(invoked).toBe(false); expect(f.calls()).toBe(0);
  } finally { await f.dispose(); }
}, 60000);

it("journals profile and original owner before create/delivery and cleans only owned accounts", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }); let secret = "";
    f.setBeforeCreate(async () => {
      const state = await manager.snapshot(), row = state.operations[0]!;
      expect(row.status).toBe("creating"); expect(row.accountId).toBeNull(); expect(row.profile.includes(run.runId)).toBe(true);
      expect(row.owner.email).toBe(browserAccountEmail(run.runId, "Editor"));
    });
    const created = await manager.createAccount(run, "Editor", async credential => {
      secret = credential.password;
      const state = await manager.snapshot(), row = state.operations[0]!;
      expect(row.status).toBe("seeding"); expect(row.profile).toBe(credential.profile); expect(row.owner.email).toBe(browserAccountEmail(run.runId, "Editor"));
      expect(row.accountId).toBe(credential.accountId); expect(Object.isFrozen(credential)).toBe(true);
    });
    expect(Object.hasOwn(created, "password")).toBe(false);
    const text = await fs.readFile(path.join(f.root, "ledger.json"), "utf8");
    expect([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")].some(value => text.includes(value))).toBe(false);
    const receipt = await manager.cleanupRun(run);
    expect(receipt).toEqual({ scope: "accounts-and-sessions", cleanup: "completed", operations: 1, ownedRecords: 0, activeReservations: 0 });
    expect(f.accounts.size === 1 && f.accounts.has(f.foreignId)).toBe(true);
    const state = await manager.snapshot(); expect(state.operations[0]!.status).toBe("deleted"); expect(state.operations[0]!.profile).toBe(created.profile);
    expect(state.runs[0]!.status).toBe("released");
  } finally { await f.dispose(); }
}, 120000);

it("persists ambiguous create and recovers the same owner without another creation", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }); f.loseCreate();
    await expect(manager.createAccount(run, "Editor", () => { throw Error("must not deliver"); })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CREATE_UNKNOWN" });
    const before = await manager.snapshot(); expect(before.operations[0]!.status).toBe("create-unknown"); expect(before.operations[0]!.accountId).toBeNull();
    await expect(manager.beginRun({ runId: randomUUID() })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    const recovered = await f.reopen(); await recovered.cleanupRun(await recovered.recoverRun(run.runId));
    expect(f.attempts.length).toBe(1); expect(f.accounts.size === 1 && f.accounts.has(f.foreignId)).toBe(true);
    expect((await recovered.snapshot()).operations[0]!.owner).toEqual(before.operations[0]!.owner);
  } finally { await f.dispose(); }
}, 120000);

it("fences a pending create with a persistent tombstone and never resurrects deleted state", async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try {
    f.setBeforeCreate(async () => { entered.release(); await release.promise; });
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }); let delivered = false;
    const pending = manager.createAccount(run, "Editor", () => { delivered = true; }).then(() => null, error => error);
    await entered.promise; await manager.cleanupRun(run); release.release();
    const error: unknown = await pending; expect(error).toMatchObject({ code: "BROWSER_ACCOUNT_REPLAY_REFUSED" });
    expect(delivered).toBe(false); expect((await manager.snapshot()).operations[0]!.status).toBe("deleted"); expect(f.accounts.size).toBe(1);
    await manager.beginRun({ runId: randomUUID() });
  } finally { release.release(); await f.dispose(); }
}, 120000);

it("pending delivery blocks cleanup and fresh runs through reopen until the actual sink settles", async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() });
    const pending = manager.createAccount(run, "Editor", async () => { entered.release(); await release.promise; }).then(() => null, error => error);
    await entered.promise;
    await expect(manager.cleanupRun(run)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    const recovered = await f.reopen(); await expect(recovered.cleanupRun(await recovered.recoverRun(run.runId))).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    await expect(recovered.beginRun({ runId: randomUUID() })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    release.release(); expect(await pending).toMatchObject({ code: "BROWSER_ACCOUNT_RUN_REFUSED" });
    await recovered.cleanupRun(await recovered.recoverRun(run.runId)); expect((await recovered.snapshot()).runs[0]!.status).toBe("released");
  } finally { release.release(); await f.dispose(); }
}, 120000);

it("does not issue a cleanup receipt while owned records or reservations remain", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }); await manager.createAccount(run, "Editor", () => {});
    const row = [...f.operations.values()][0]!; row.records = 1;
    await expect(manager.cleanupRun(run)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    row.records = 0;
    f.setInspection({ present: false, id: row.id, revoked: true, deliveryPending: false, ownedRecords: 0, activeReservations: 1 });
    await expect(manager.cleanupRun(run)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    f.setInspection(undefined); await manager.cleanupRun(run);
    expect(f.accounts.has(f.foreignId)).toBe(true);
  } finally { await f.dispose(); }
}, 120000);

it("refuses changed post-deletion identity even when the response claims absence", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }), created = await manager.createAccount(run, "Editor", () => {});
    const clean = { present: false, id: created.id, revoked: true, deliveryPending: false, ownedRecords: 0, activeReservations: 0 };
    f.setInspectionSequence([{ ...clean, present: true, revoked: false, activeReservations: 1 }, { ...clean, id: f.foreignId }]);
    await expect(manager.cleanupRun(run)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    expect(f.accounts.has(f.foreignId)).toBe(true); expect((await manager.snapshot()).runs[0]!.status).not.toBe("released");
    await manager.cleanupRun(run);
  } finally { await f.dispose(); }
}, 120000);

it("retains seed unknown and original profile after rejected delivery or deletion", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() });
    const revocable = Proxy.revocable({}, { getPrototypeOf() { throw Error("private-synthetic-canary"); } }); revocable.revoke();
    await expect(manager.createAccount(run, "Editor", () => { throw revocable.proxy; })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_SEED_UNKNOWN" });
    expect((await manager.snapshot()).operations[0]!.status).toBe("seed-unknown");
    f.setDeleteRefused(true); await expect(manager.cleanupRun(run)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" });
    expect((await manager.snapshot()).operations[0]!.profile.includes(run.runId)).toBe(true);
    f.setDeleteRefused(false); await manager.cleanupRun(run);
  } finally { await f.dispose(); }
}, 120000);

it("enforces active quota across concurrent runs without fresh-root or replay escape", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), runs = [await manager.beginRun({ runId: randomUUID() }), await manager.beginRun({ runId: randomUUID() }), await manager.beginRun({ runId: randomUUID() })];
    const outcomes = await Promise.allSettled(runs.flatMap(run => (["Editor", "Reviewer"] as const).map(role => manager.createAccount(run, role, () => {}))));
    expect(outcomes.filter(result => result.status === "fulfilled").length).toBe(4);
    await expect(createBrowserAccountCoordinator({ adapter: f.adapter, binding: f.binding, root: path.join(f.directory, "new-ledger"), now: f.now })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_STATE_INVALID" });
    for (const run of runs) await manager.cleanupRun(run);
    await expect(manager.beginRun({ runId: runs[0]!.runId })).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_REPLAY_REFUSED" });
    expect(f.accounts.size === 1 && f.accounts.has(f.foreignId)).toBe(true);
  } finally { await f.dispose(); }
}, 120000);

it("retains the fixed ten-attempt hourly quota through cleanup and recovery", async () => {
  const f = await fixture();
  try {
    let manager = await f.reopen();
    for (let index = 0; index < 5; index++) {
      const run = await manager.beginRun({ runId: randomUUID() });
      for (const role of ["Editor", "Reviewer"] as const) await manager.createAccount(run, role, () => {});
      await manager.cleanupRun(run); if (index === 2) manager = await f.reopen();
    }
    const run = await manager.beginRun({ runId: randomUUID() });
    await expect(manager.createAccount(run, "Editor", () => {})).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_QUOTA_REFUSED" });
    expect(f.attempts.length).toBe(10); expect((await manager.snapshot()).operations.length).toBe(10);
    f.setClock(f.now() + 3600001); // Expired original grant cannot be reused after the rate window.
    await expect(manager.createAccount(run, "Editor", () => {})).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_EXPIRED" });
    const fresh = await manager.beginRun({ runId: randomUUID() }); await manager.createAccount(fresh, "Editor", () => {}); await manager.cleanupRun(fresh);
  } finally { await f.dispose(); }
}, 180000);

it("persists observed clock on refused mutations and permits only narrow rollback cleanup", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }); await manager.createAccount(run, "Editor", () => {});
    f.setClock(f.now() + 1000);
    await expect(manager.createAccount(run, "Editor", () => {})).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_REPLAY_REFUSED" });
    f.setClock(f.now() - 1);
    await expect(manager.createAccount(run, "Reviewer", () => {})).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLOCK_REFUSED" });
    await manager.cleanupRun(run); expect((await manager.snapshot()).runs[0]!.status).toBe("released");
  } finally { await f.dispose(); }
}, 120000);

it("refuses corrupt/foreign identity state and aliased ledger without touching foreign control", async () => {
  const f = await fixture();
  try {
    const manager = await f.reopen(), run = await manager.beginRun({ runId: randomUUID() }); await manager.createAccount(run, "Editor", () => {});
    const file = path.join(f.root, "ledger.json"), original = await fs.readFile(file), state = JSON.parse(original.toString()) as { operations: { accountId: string }[] };
    state.operations[0]!.accountId = f.foreignId; await fs.writeFile(file, JSON.stringify(state));
    await expect(manager.cleanupRun(run)).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE" }); expect(f.accounts.has(f.foreignId)).toBe(true);
    await fs.writeFile(file, "{private-synthetic-canary"); await expect(manager.snapshot()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_STATE_INVALID" });
    await fs.writeFile(file, original); await fs.unlink(file);
    await expect(f.reopen()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_STATE_INVALID" });
    const foreignDirectory = path.join(f.directory, "foreign-control"); await fs.mkdir(foreignDirectory); await fs.writeFile(path.join(foreignDirectory, "control.txt"), "synthetic-control");
    await fs.symlink(foreignDirectory, file, process.platform === "win32" ? "junction" : "dir");
    await expect(manager.snapshot()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_STATE_INVALID" });
    expect((await fs.readFile(path.join(foreignDirectory, "control.txt"), "utf8")) === "synthetic-control").toBe(true);
  } finally { await f.dispose(); }
}, 120000);

it("refuses hostile inspection data with fixed errors, never copied provider data", () => {
  let invoked = false;
  const data = { present: false, id: null, revoked: true, deliveryPending: false, ownedRecords: 0, activeReservations: 0 };
  const getter = { ...data }; Object.defineProperty(getter, "ownedRecords", { enumerable: true, get() { invoked = true; throw Error("private-synthetic-canary"); } });
  const proxy = new Proxy(data, { ownKeys() { invoked = true; throw Error("private-synthetic-canary"); } });
  for (const value of [getter, proxy, { ...data, [Symbol("private")]: "private-synthetic-canary" }, { ...data, ownedRecords: NaN }, { ...data, activeReservations: -1 }, { ...data, raw: Buffer.from("private-synthetic-canary").toString("base64") }]) expect(() => readOwnedInspection(value)).toThrow(/^BROWSER_ACCOUNT_OWNERSHIP_REFUSED$/);
  expect(invoked).toBe(false);
});

it("refuses hardlinked entry and ledger files without changing their target bytes", async () => {
  const f = await fixture();
  try {
    const entryLink = path.join(f.directory, "entry-link.mjs"); await fs.link(f.entry, entryLink);
    await expect(f.reopen()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_ADAPTER_REFUSED" }); expect(f.calls()).toBe(0);
    expect(hash(await fs.readFile(entryLink, "utf8")) === hash(inertEntry)).toBe(true); await fs.unlink(entryLink);
    const manager = await f.reopen(), ledger = path.join(f.root, "ledger.json"), ledgerLink = path.join(f.directory, "ledger-link.json");
    const before = await fs.readFile(ledger); await fs.link(ledger, ledgerLink);
    await expect(manager.snapshot()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_STATE_INVALID" });
    expect((await fs.readFile(ledgerLink)).equals(before)).toBe(true);
    await fs.unlink(ledgerLink); await manager.snapshot();
    if (process.platform !== "win32") {
      await fs.chmod(ledger, 0o644); await expect(manager.snapshot()).rejects.toMatchObject({ code: "BROWSER_ACCOUNT_STATE_INVALID" });
      await fs.chmod(ledger, 0o600);
    }
  } finally { await f.dispose(); }
}, 120000);
