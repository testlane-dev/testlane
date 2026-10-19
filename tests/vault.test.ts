import { randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getProfile, loadProfiles } from "../src/profiles.js";
import { isRedactable, redactor } from "../src/redact.js";
import { secretKeyFor } from "../src/store/index.js";
import type { Profile } from "../src/types.js";
import {
  dropPendingSecret,
  getProfileSecret,
  getProfileSecrets,
  OriginMismatchError,
  promotePendingSecret,
  putProfileSecret,
  setPendingSecret,
} from "../src/vault.js";
import { MemoryStore } from "./helpers/memory-store.js";

/** Throwaway value generated per test; never a realistic literal. */
const throwaway = (): string => `throwaway-${randomBytes(12).toString("hex")}`;

function profile(baseUrl: string, name = "demo:local:admin"): Profile {
  return {
    name,
    app: "demo-app",
    environment: "sandbox",
    baseUrl,
    strategy: "nextauth-credentials",
    account: { email: "agent@demo.test", role: "Admin" },
    session: { ttlMinutes: 30 },
  };
}

async function catchOrigin(p: Promise<unknown>): Promise<OriginMismatchError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OriginMismatchError);
  return err as OriginMismatchError;
}

describe("putProfileSecret / getProfileSecret", () => {
  it("stores a v3 envelope bound to the baseUrl origin, with storedAt, and round-trips it", async () => {
    const store = new MemoryStore();
    const p = profile("http://127.0.0.1:3000/app/");
    const secret = throwaway();
    const now = new Date("2026-09-01T10:00:00.000Z");
    await putProfileSecret(store, p, secret, now);

    const raw = await store.get(secretKeyFor(p));
    expect(JSON.parse(raw ?? "null")).toEqual({
      v: 3,
      origin: "http://127.0.0.1:3000",
      environment: "sandbox",
      secret,
      storedAt: "2026-09-01T10:00:00.000Z",
    });
    // A path change on the same origin keeps working.
    expect(await getProfileSecret(store, profile("http://127.0.0.1:3000/other"))).toBe(secret);
    expect(await getProfileSecrets(store, p)).toEqual({ secret, storedAt: "2026-09-01T10:00:00.000Z", version: 3 });
  });

  it("still reads a v2 envelope (storedAt unknown -> null) and upgrades it to v3 on the next write", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const secret = throwaway();
    await store.set(secretKeyFor(p), JSON.stringify({ v: 2, origin: "https://demo.test", environment: "sandbox", secret }));
    expect(await getProfileSecret(store, p)).toBe(secret);
    expect(await getProfileSecrets(store, p)).toEqual({ secret, storedAt: null, version: 2 });

    // A pending write carries the unknown age over (storedAt null) in a v3 envelope.
    const pending = throwaway();
    await setPendingSecret(store, p, pending, new Date("2026-09-02T00:00:00.000Z"));
    expect(JSON.parse((await store.get(secretKeyFor(p))) ?? "null")).toEqual({
      v: 3,
      origin: "https://demo.test",
      environment: "sandbox",
      secret,
      storedAt: null,
      pendingSecret: pending,
      pendingSince: "2026-09-02T00:00:00.000Z",
    });
    // Dropping keeps the old secret and its unknown age.
    expect(await dropPendingSecret(store, p)).toBe(true);
    expect(await getProfileSecrets(store, p)).toEqual({ secret, storedAt: null, version: 3 });
    // store set writes a fresh v3 envelope with a known age.
    await putProfileSecret(store, p, secret, new Date("2026-09-03T00:00:00.000Z"));
    expect(await getProfileSecrets(store, p)).toEqual({ secret, storedAt: "2026-09-03T00:00:00.000Z", version: 3 });
  });

  it("returns null when nothing is stored", async () => {
    expect(await getProfileSecret(new MemoryStore(), profile("https://demo.test"))).toBeNull();
  });

  it("registers the loaded secret with the redactor", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const secret = throwaway();
    // Write the envelope directly so only getProfileSecret can have registered it.
    await store.set(secretKeyFor(p), JSON.stringify({ v: 2, origin: "https://demo.test", environment: "sandbox", secret }));
    expect(redactor.redact(`x ${secret} y`)).toContain(secret);
    expect(await getProfileSecret(store, p)).toBe(secret);
    expect(redactor.redact(`x ${secret} y`)).toBe("x [REDACTED] y");
  });

  it("does not register a short numeric secret, so session output keeps its digits; a password still redacts", async () => {
    const store = new MemoryStore();
    const exchange: Profile = {
      ...profile("https://demo.test", "demo:local:exchange"),
      strategy: "dependent-token",
      account: { email: "member@demo.test", role: "Member", identifier: "member-1" },
    };
    const pin = String(randomInt(1000, 10_000)); // 4-digit throwaway PIN
    await putProfileSecret(store, exchange, pin);
    expect(await getProfileSecret(store, exchange)).toBe(pin);
    // Session output that happens to contain the PIN's digits (cookie value, Max-Age, timestamp).
    const output = `sid=ab${pin}cd; Max-Age=${pin}; Expires=${pin}-01-01T00:00:00.000Z`;
    expect(redactor.redact(output)).toBe(output);

    const password = throwaway();
    await putProfileSecret(store, profile("https://demo.test"), password);
    expect(await getProfileSecret(store, profile("https://demo.test"))).toBe(password);
    expect(redactor.redact(`x ${password} y`)).toBe("x [REDACTED] y");
  });

  it("isRedactable: at least 4 characters and not a short all-digit value", () => {
    for (const v of ["1234", "12345678", "12345678901"]) expect(isRedactable(v)).toBe(false);
    for (const v of ["abc", "", null, undefined]) expect(isRedactable(v)).toBe(false);
    for (const v of ["123456789012", "12a4", "pw-1", throwaway()]) expect(isRedactable(v)).toBe(true);
  });

  it("refuses a secret bound to another origin, naming both origins but never the secret", async () => {
    const store = new MemoryStore();
    const secret = throwaway();
    await putProfileSecret(store, profile("http://127.0.0.1:3000"), secret);

    for (const moved of ["http://127.0.0.1:3001", "https://127.0.0.1:3000", "http://localhost:3000", "https://attacker.example.net"]) {
      const err = await catchOrigin(getProfileSecret(store, profile(moved)));
      expect(err.reason).toBe("origin-mismatch");
      expect(err.profile).toBe("demo:local:admin");
      expect(err.message).toContain('"demo:local:admin"');
      expect(err.message).toContain("http://127.0.0.1:3000");
      expect(err.message).toContain(new URL(moved).origin);
      expect(err.message).toContain("testlane store set demo:local:admin");
      expect(err.message).not.toContain(secret);
    }
  });

  it("refuses a legacy (pre-envelope) value as origin-unknown and tells the human to re-run store set", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    for (const legacy of [throwaway(), `${1_000_000 + randomBytes(2).readUInt16BE(0)}`, JSON.stringify({ secret: throwaway() })]) {
      await store.set(secretKeyFor(p), legacy);
      const err = await catchOrigin(getProfileSecret(store, p));
      expect(err.reason).toBe("origin-unknown");
      expect(err.message).toContain("testlane store set demo:local:admin");
      expect(err.message).not.toContain(legacy);
    }
  });

  it("refuses malformed envelopes (wrong version, extra keys, empty secret, bad timestamps, half a pending pair)", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const base = { origin: "https://demo.test", environment: "sandbox" };
    const at = "2026-09-01T00:00:00.000Z";
    for (const env of [
      { v: 1, origin: "https://demo.test", secret: throwaway() },
      { v: 2, ...base, secret: throwaway(), extra: "x" },
      { v: 2, ...base, secret: "" },
      { v: 2, origin: "https://demo.test", secret: throwaway() },
      { v: 2, origin: "https://demo.test", environment: "staging", secret: throwaway() },
      { v: 2, ...base, secret: throwaway(), storedAt: at },
      { v: 3, ...base, secret: throwaway() },
      { v: 3, ...base, secret: throwaway(), storedAt: "yesterday" },
      { v: 3, ...base, secret: throwaway(), storedAt: at, extra: "x" },
      { v: 3, ...base, secret: throwaway(), storedAt: at, pendingSecret: throwaway() },
      { v: 3, ...base, secret: throwaway(), storedAt: at, pendingSince: at },
      { v: 3, ...base, secret: throwaway(), storedAt: at, pendingSecret: "", pendingSince: at },
      { v: 3, ...base, secret: throwaway(), storedAt: at, pendingSecret: throwaway(), pendingSince: "soon" },
      { v: 4, ...base, secret: throwaway(), storedAt: at },
    ]) {
      await store.set(secretKeyFor(p), JSON.stringify(env));
      expect((await catchOrigin(getProfileSecret(store, p))).reason).toBe("origin-unknown");
    }
  });

  it("never stores a secret for a production profile", async () => {
    const store = new MemoryStore();
    const p = { ...profile("https://prod.demo.test"), environment: "production" as const };
    await expect(putProfileSecret(store, p, throwaway())).rejects.toMatchObject({ code: "production-refused" });
    expect(store.size).toBe(0);
  });

  it("refuses a secret stored under a different environment tag (re-tagging is not a bypass)", async () => {
    const store = new MemoryStore();
    const secret = throwaway();
    await putProfileSecret(store, profile("https://demo.test"), secret);
    for (const environment of ["testing", "production"] as const) {
      const err = await catchOrigin(getProfileSecret(store, { ...profile("https://demo.test"), environment }));
      expect(err.reason).toBe("environment-mismatch");
      expect(err.message).toContain("sandbox");
      expect(err.message).toContain(environment);
      expect(err.message).not.toContain(secret);
    }
  });

  it("refuses to store an empty secret", async () => {
    await expect(putProfileSecret(new MemoryStore(), profile("https://demo.test"), "")).rejects.toThrow("empty secret");
  });
});

describe("pending secrets (two-phase rotation)", () => {
  const t0 = new Date("2026-09-01T00:00:00.000Z");
  const t1 = new Date("2026-09-02T00:00:00.000Z");
  const t2 = new Date("2026-09-03T00:00:00.000Z");

  it("setPendingSecret keeps the current secret and its storedAt; getProfileSecrets returns both", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const current = throwaway();
    const pending = throwaway();
    await putProfileSecret(store, p, current, t0);
    await setPendingSecret(store, p, pending, t1);
    expect(await getProfileSecret(store, p)).toBe(current);
    expect(await getProfileSecrets(store, p)).toEqual({
      secret: current,
      storedAt: t0.toISOString(),
      pendingSecret: pending,
      pendingSince: t1.toISOString(),
      version: 3,
    });
  });

  it("promotePendingSecret makes the pending value current with storedAt = now and clears the pending fields", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const pending = throwaway();
    await putProfileSecret(store, p, throwaway(), t0);
    await setPendingSecret(store, p, pending, t1);
    expect(await promotePendingSecret(store, p, pending, t2)).toBe(true);
    expect(await getProfileSecrets(store, p)).toEqual({ secret: pending, storedAt: t2.toISOString(), version: 3 });
    // A second promote of the same value is a no-op success (a concurrent promote won).
    expect(await promotePendingSecret(store, p, pending, t2)).toBe(true);
    expect(await promotePendingSecret(store, p)).toBe(false);
  });

  it("promote / drop with an expected value refuse a pending value that changed meanwhile", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const current = throwaway();
    await putProfileSecret(store, p, current, t0);
    await setPendingSecret(store, p, throwaway(), t1);
    const other = throwaway();
    expect(await promotePendingSecret(store, p, other, t2)).toBe(false);
    expect(await dropPendingSecret(store, p, other)).toBe(false);
    expect((await getProfileSecrets(store, p))?.pendingSecret).toBeDefined();
    expect((await getProfileSecrets(store, p))?.secret).toBe(current);
  });

  it("dropPendingSecret removes only the pending value; nothing pending -> false", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const current = throwaway();
    const pending = throwaway();
    await putProfileSecret(store, p, current, t0);
    expect(await dropPendingSecret(store, p)).toBe(false);
    await setPendingSecret(store, p, pending, t1);
    expect(await dropPendingSecret(store, p, pending)).toBe(true);
    expect(await getProfileSecrets(store, p)).toEqual({ secret: current, storedAt: t0.toISOString(), version: 3 });
  });

  it("registers the pending value with the redactor when loaded", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    const pending = throwaway();
    await store.set(
      secretKeyFor(p),
      JSON.stringify({
        v: 3,
        origin: "https://demo.test",
        environment: "sandbox",
        secret: throwaway(),
        storedAt: t0.toISOString(),
        pendingSecret: pending,
        pendingSince: t1.toISOString(),
      }),
    );
    expect(redactor.redact(pending)).toBe(pending);
    await getProfileSecrets(store, p);
    expect(redactor.redact(`x ${pending} y`)).toBe("x [REDACTED] y");
  });

  it("setPendingSecret refuses when nothing is stored, and for production; binding still applies", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    await expect(setPendingSecret(store, p, throwaway())).rejects.toThrow("nothing to rotate");
    const prod = { ...p, environment: "production" as const };
    await expect(setPendingSecret(store, prod, throwaway())).rejects.toMatchObject({ code: "production-refused" });
    await putProfileSecret(store, p, throwaway(), t0);
    const moved = profile("https://elsewhere.demo.test");
    const err = await catchOrigin(setPendingSecret(store, { ...moved, name: p.name }, throwaway()));
    expect(err.reason).toBe("origin-mismatch");
  });

  it("store set (putProfileSecret) discards a pending value", async () => {
    const store = new MemoryStore();
    const p = profile("https://demo.test");
    await putProfileSecret(store, p, throwaway(), t0);
    await setPendingSecret(store, p, throwaway(), t1);
    const fresh = throwaway();
    await putProfileSecret(store, p, fresh, t2);
    expect(await getProfileSecrets(store, p)).toEqual({ secret: fresh, storedAt: t2.toISOString(), version: 3 });
  });
});

describe("account overrides and the vault binding", () => {
  it("changing the override email needs no new store set: the binding is origin + environment only", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-vault-override-"));
    try {
      const repoFile = path.join(tmp, "testlane.profiles.json");
      const overridesFile = path.join(tmp, "testlane.overrides.json");
      const userFile = path.join(tmp, "no-user-file.json");
      await fs.writeFile(
        repoFile,
        JSON.stringify({
          version: 1,
          profiles: {
            "demo:local:operator": {
              app: "demo-app",
              environment: "sandbox",
              baseUrl: "http://127.0.0.1:3000",
              strategy: "nextauth-credentials",
              account: { email: "operator@demo.test", role: "Operator" },
              session: { ttlMinutes: 30 },
            },
          },
        }),
      );
      const load = async () =>
        getProfile(await loadProfiles({ cwd: tmp, repoFile, userFile, overridesFile }), "demo:local:operator");

      const store = new MemoryStore();
      const secret = throwaway();
      await putProfileSecret(store, await load(), secret);
      const stored = await store.get(secretKeyFor("demo:local:operator"));
      expect(Object.keys(JSON.parse(stored ?? "{}") as object).sort()).toEqual([
        "environment",
        "origin",
        "secret",
        "storedAt",
        "v",
      ]);

      for (const email of ["operator+run1@demo.test", "operator+run2@demo.test"]) {
        await fs.writeFile(overridesFile, JSON.stringify({ version: 1, overrides: { "demo:local:operator": { account: { email } } } }));
        const p = await load();
        expect(p.account.email).toBe(email);
        expect(secretKeyFor(p)).toBe(secretKeyFor("demo:local:operator"));
        expect(await getProfileSecret(store, p)).toBe(secret);
      }
      // Nothing was re-stored.
      expect(await store.get(secretKeyFor("demo:local:operator"))).toBe(stored);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
