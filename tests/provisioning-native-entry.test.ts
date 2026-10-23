import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CommandDeps } from "../src/commands.js";
import type { SecretStore } from "../src/store/index.js";
import type { ProfileRegistry } from "../src/types.js";
import { managedNativeOperation } from "../src/provisioning/native-entry.js";

function fixture() {
  const target = randomUUID(), run = randomUUID(), name = `tl-disposable:${target}:${run}:editor`;
  const values = new Map([["profile:foreign-synthetic-control", "synthetic-control-value"]]), touched: string[] = [];
  const store: SecretStore = { kind: "synthetic-inert", async get(key) { touched.push(key); return values.get(key) ?? null; },
    async set(key, value) { touched.push(key); values.set(key, value); }, async delete(key) { touched.push(key); return values.delete(key); },
    async list() { throw new Error("UNRELATED_ENTRIES_MUST_NOT_BE_LISTED"); } };
  const registry: ProfileRegistry = { version: 1, sources: [], profiles: { [name]: { name, app: "testlane-disposable-browser", environment: "testing",
    baseUrl: "http://127.0.0.1:4888", strategy: "form-post", account: { email: `tlp-${run}-editor@example.test`, role: "writer" }, session: { ttlMinutes: 10 },
    options: { loginPath: "/api/login", bodyFormat: "json", fields: '{"email":"{{email}}","password":"{{secret}}"}', sessionCookieName: "synthetic_session", mePath: "/api/me" } } } };
  const deps: CommandDeps = { store, registry, requester: "testlane-disposable-browser", now: () => new Date("2026-01-01T00:00:00Z") };
  return { deps, registry, values, touched, name };
}

describe("managed native entry scope using an inert store", () => {
  it("checks, seeds and deletes only the exact generated entry and never lists other keys", async () => {
    const f = fixture(), secret = "a".repeat(43);
    expect(await managedNativeOperation(f.deps, "present", f.name)).toEqual({ schemaVersion: 1, status: "absent" });
    expect(await managedNativeOperation(f.deps, "seed", f.name, secret)).toEqual({ schemaVersion: 1, status: "seeded" });
    expect(await managedNativeOperation(f.deps, "present", f.name)).toEqual({ schemaVersion: 1, status: "present" });
    await expect(managedNativeOperation(f.deps, "seed", f.name, "b".repeat(43))).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    expect(await managedNativeOperation(f.deps, "delete", f.name)).toEqual({ schemaVersion: 1, status: "deleted" });
    expect(await managedNativeOperation(f.deps, "delete", f.name)).toEqual({ schemaVersion: 1, status: "deleted" });
    expect(await managedNativeOperation(f.deps, "present", f.name)).toEqual({ schemaVersion: 1, status: "absent" });
    expect(f.values.get("profile:foreign-synthetic-control")).toBe("synthetic-control-value");
    expect(f.touched.every(key => key.endsWith(f.name))).toBe(true);
  });

  it("refuses human profiles, production, mismatched owner email and arbitrary app metadata before accessing storage", async () => {
    const f = fixture(), profile = f.registry.profiles[f.name]!;
    await expect(managedNativeOperation(f.deps, "delete", "human-profile")).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    for (const patch of [{ name: "foreign-synthetic-control" }, { app: "different-synthetic-app" }, { environment: "production" }, { account: { email: "foreign@example.test", role: "writer" } }]) {
      const deps = { ...f.deps, registry: { ...f.registry, profiles: { [f.name]: { ...profile, ...patch } } } } as CommandDeps;
      await expect(managedNativeOperation(deps, "delete", f.name)).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    }
    expect(f.touched).toHaveLength(0);
  });

  it("rejects malformed or extra credential inputs before writing storage", async () => {
    const f = fixture();
    for (const value of [undefined, "short", "a".repeat(43) + "\n", "x".repeat(257)]) await expect(managedNativeOperation(f.deps, "seed", f.name, value)).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    await expect(managedNativeOperation(f.deps, "delete", f.name, "a".repeat(43))).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    await expect(managedNativeOperation(f.deps, "present", f.name, "a".repeat(43))).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    expect(f.touched).toHaveLength(0);
  });

  it("keeps failed writes and failed absence checks nonpassing and drops raw exception text", async () => {
    const f = fixture();
    const failedWrite = { ...f.deps, store: { ...f.deps.store, async set() { throw new Error("synthetic-private-canary"); } } };
    await expect(managedNativeOperation(failedWrite, "seed", f.name, "a".repeat(43))).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
    const nonDeletion = { ...f.deps, store: { ...f.deps.store, async get() { return "synthetic-present"; }, async delete() { return true; } } };
    await expect(managedNativeOperation(nonDeletion, "delete", f.name)).rejects.toThrow(/^BROWSER_NATIVE_ENTRY_REFUSED$/);
  });
});
