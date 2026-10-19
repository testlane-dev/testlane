import { createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAuditTail } from "../src/audit.js";
import { MissingSecretError, type CommandDeps } from "../src/commands.js";
import {
  DEFAULT_HANDOFF_PATH,
  HANDOFF_SECRET_MIN_LENGTH,
  HANDOFF_TTL_SECONDS,
  MemoryNonceStore,
  buildHandoffUrl,
  issueHandoff,
  mintHandoffCode,
  verifyHandoffCode,
} from "../src/handoff.js";
import { assertValidStoreKey, type SecretStore } from "../src/store/index.js";
import { PolicyError, type Profile, type ProfileRegistry } from "../src/types.js";
import { putProfileSecret } from "../src/vault.js";

/** Tiny in-memory SecretStore; validates keys like the real adapters. */
class TestStore implements SecretStore {
  readonly kind = "test-memory";
  readonly #data = new Map<string, string>();
  gets = 0;
  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    this.gets += 1;
    return this.#data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    assertValidStoreKey(key);
    this.#data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    assertValidStoreKey(key);
    return this.#data.delete(key);
  }
  async list(): Promise<string[]> {
    return [...this.#data.keys()].sort();
  }
}

const throwaway = (): string => `throwaway-${randomBytes(12).toString("hex")}`;
const b64u = (s: string | Buffer): string => Buffer.from(s).toString("base64url");

const savedHome = process.env["TESTLANE_HOME"];
let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-handoff-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("mintHandoffCode / verifyHandoffCode", () => {
  it("mints a code that verifies once", async () => {
    const secret = throwaway();
    const minted = mintHandoffCode({ profileName: "acme:staging:sales", secret });
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(minted.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(minted.code).not.toContain(secret);

    const payload = Buffer.from(minted.code.split(".")[0] ?? "", "base64url").toString("utf8");
    expect(payload).toBe(`acme:staging:sales.${minted.nonce}.${minted.expiresAt.getTime() / 1000}`);

    const res = await verifyHandoffCode({ code: minted.code, secret, nonceStore: new MemoryNonceStore() });
    expect(res).toEqual({ ok: true, profileName: "acme:staging:sales", nonce: minted.nonce, expiresAt: minted.expiresAt });
  });

  it("sets the expiry HANDOFF_TTL_SECONDS after now", () => {
    const now = new Date("2026-09-23T12:00:00.750Z");
    const { expiresAt } = mintHandoffCode({ profileName: "demo:a", secret: throwaway(), now });
    expect(HANDOFF_TTL_SECONDS).toBe(60);
    expect(expiresAt.toISOString()).toBe("2026-09-23T12:01:00.000Z");
  });

  it("parses profile names containing dots", async () => {
    const secret = throwaway();
    const { code } = mintHandoffCode({ profileName: "app.v2:sandbox.eu:admin", secret });
    const res = await verifyHandoffCode({ code, secret, nonceStore: new MemoryNonceStore() });
    expect(res.ok && res.profileName).toBe("app.v2:sandbox.eu:admin");
  });

  it("rejects a wrong secret as bad-signature", async () => {
    const { code } = mintHandoffCode({ profileName: "demo:a", secret: throwaway() });
    const res = await verifyHandoffCode({ code, secret: throwaway(), nonceStore: new MemoryNonceStore() });
    expect(res).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload as bad-signature", async () => {
    const secret = throwaway();
    const { code, nonce, expiresAt } = mintHandoffCode({ profileName: "demo:sales", secret });
    const sig = code.split(".")[1] ?? "";
    const forged = `${b64u(`demo:admin.${nonce}.${expiresAt.getTime() / 1000}`)}.${sig}`;
    const extended = `${b64u(`demo:sales.${nonce}.${expiresAt.getTime() / 1000 + 3600}`)}.${sig}`;
    for (const c of [forged, extended]) {
      const res = await verifyHandoffCode({ code: c, secret, nonceStore: new MemoryNonceStore() });
      expect(res).toEqual({ ok: false, reason: "bad-signature" });
    }
  });

  it("rejects an expired code (now = expiresAt + 1s) without burning the nonce", async () => {
    const secret = throwaway();
    const { code, expiresAt } = mintHandoffCode({ profileName: "demo:a", secret });
    const store = new MemoryNonceStore();
    const res = await verifyHandoffCode({
      code,
      secret,
      now: new Date(expiresAt.getTime() + 1000),
      nonceStore: store,
    });
    expect(res).toEqual({ ok: false, reason: "expired" });
    expect(store.size).toBe(0);
  });

  it("rejects a replay with the same nonce store", async () => {
    const secret = throwaway();
    const { code } = mintHandoffCode({ profileName: "demo:a", secret });
    const store = new MemoryNonceStore();
    const first = await verifyHandoffCode({ code, secret, nonceStore: store });
    const second = await verifyHandoffCode({ code, secret, nonceStore: store });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects a replay under a faked clock too, and prunes nonces after expiry", async () => {
    const secret = throwaway();
    let clock = new Date("2026-01-01T00:00:00Z");
    const store = new MemoryNonceStore({ now: () => clock });
    const { code, expiresAt } = mintHandoffCode({ profileName: "demo:a", secret, now: clock });
    expect((await verifyHandoffCode({ code, secret, now: clock, nonceStore: store })).ok).toBe(true);
    clock = new Date(clock.getTime() + 30_000);
    expect(await verifyHandoffCode({ code, secret, now: clock, nonceStore: store })).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(store.size).toBe(1);
    clock = new Date(expiresAt.getTime() + 1000);
    const other = mintHandoffCode({ profileName: "demo:a", secret, now: clock });
    expect((await verifyHandoffCode({ code: other.code, secret, now: clock, nonceStore: store })).ok).toBe(true);
    expect(store.size).toBe(1);
    // The original code is still refused: it is expired now.
    expect(await verifyHandoffCode({ code, secret, now: clock, nonceStore: store })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("returns malformed (never throws) for malformed codes", async () => {
    const secret = throwaway();
    const { code } = mintHandoffCode({ profileName: "demo:a", secret });
    const [p, s] = code.split(".");
    const sign = (payload: string): string => createHmac("sha256", secret).update(payload).digest("base64url");
    const future = Math.floor(Date.now() / 1000) + 30;
    const nonce = randomBytes(16).toString("base64url");
    const bad = [
      "",
      "nodot",
      ".",
      `${p}.`,
      `.${s}`,
      `${p}.${s}.extra`,
      `${p}.${s}.`,
      `${p}!.${s}`,
      `${p}.${s}=`,
      `${p}.${s}AA`,
      `${p}.${(s ?? "").slice(0, -1)}`,
      "%%%.%%%",
      "a".repeat(5000),
      // Validly signed but structurally wrong payloads.
      `${b64u("no-dots-here")}.${sign("no-dots-here")}`,
      `${b64u(`demo:a.${nonce}`)}.${sign(`demo:a.${nonce}`)}`,
      `${b64u(`Bad Name.${nonce}.${future}`)}.${sign(`Bad Name.${nonce}.${future}`)}`,
      `${b64u(`demo:a.short.${future}`)}.${sign(`demo:a.short.${future}`)}`,
      `${b64u(`demo:a.${nonce}.12x`)}.${sign(`demo:a.${nonce}.12x`)}`,
      // Expiry far beyond TTL + skew: not something a conforming broker mints.
      `${b64u(`demo:a.${nonce}.${future + 3600}`)}.${sign(`demo:a.${nonce}.${future + 3600}`)}`,
    ];
    const store = new MemoryNonceStore();
    for (const c of bad) {
      const res = await verifyHandoffCode({ code: c, secret, nonceStore: store });
      expect(res, c.slice(0, 40)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(store.size).toBe(0);
    for (const c of [undefined, null, 42] as unknown as string[]) {
      expect(await verifyHandoffCode({ code: c, secret, nonceStore: store })).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("mints unique codes and nonces across 1000 mints", () => {
    const secret = throwaway();
    const now = new Date();
    const codes = new Set<string>();
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const m = mintHandoffCode({ profileName: "demo:a", secret, now });
      codes.add(m.code);
      nonces.add(m.nonce);
    }
    expect(codes.size).toBe(1000);
    expect(nonces.size).toBe(1000);
  });

  it("refuses an empty secret", async () => {
    expect(() => mintHandoffCode({ profileName: "demo:a", secret: "" })).toThrow(/non-empty/);
    await expect(verifyHandoffCode({ code: "a.b", secret: "", nonceStore: new MemoryNonceStore() })).rejects.toThrow(
      /non-empty/,
    );
  });

  it("refuses a secret shorter than HANDOFF_SECRET_MIN_LENGTH (32) in mint and verify, without echoing it", async () => {
    expect(HANDOFF_SECRET_MIN_LENGTH).toBe(32);
    const short = randomBytes(24).toString("hex").slice(0, 31); // 31 chars
    let err: unknown = null;
    try {
      mintHandoffCode({ profileName: "demo:a", secret: short });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/at least 32 characters/);
    expect((err as Error).message).not.toContain(short);
    await expect(verifyHandoffCode({ code: "a.b", secret: short, nonceStore: new MemoryNonceStore() })).rejects.toThrow(
      /at least 32 characters/,
    );
    // Exactly 32 characters is accepted.
    const exact = randomBytes(16).toString("hex");
    expect(exact).toHaveLength(32);
    const { code } = mintHandoffCode({ profileName: "demo:a", secret: exact });
    expect((await verifyHandoffCode({ code, secret: exact, nonceStore: new MemoryNonceStore() })).ok).toBe(true);
  });
});

describe("buildHandoffUrl", () => {
  const base = { name: "demo:a", baseUrl: "https://sandbox.demo.test/app/" };

  it("uses the baseUrl origin and the default path", () => {
    const url = buildHandoffUrl(base, "ab+c/d=.xyz");
    expect(url).toBe(`https://sandbox.demo.test${DEFAULT_HANDOFF_PATH}?code=${encodeURIComponent("ab+c/d=.xyz")}`);
    expect(DEFAULT_HANDOFF_PATH).toBe("/api/auth/agent-handoff");
  });

  it("uses options.handoffPath and keeps a non-default port", () => {
    const url = buildHandoffUrl(
      { name: "demo:a", baseUrl: "http://localhost:3000", options: { handoffPath: "/custom/handoff" } },
      "abc.def",
    );
    expect(url).toBe("http://localhost:3000/custom/handoff?code=abc.def");
  });

  it.each([
    "https://evil.test/x",
    "//evil.test/x",
    "/\\evil.test/x",
    "\\\\evil.test",
    "/a//b",
    "relative/path",
    "",
    "/x?y=1",
    "/x#frag",
    "/x y",
    "javascript:alert(1)",
  ])("rejects unsafe handoffPath %j", (handoffPath) => {
    let err: unknown = null;
    try {
      buildHandoffUrl({ ...base, options: { handoffPath } }, "abc.def");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("invalid-profile");
  });
});

// ---------------------------------------------------------------------------
// issueHandoff end to end
// ---------------------------------------------------------------------------

function profile(name: string, overrides: Partial<Profile>): Profile {
  return {
    name,
    app: "demo-app",
    environment: "sandbox",
    baseUrl: "https://sandbox.demo.test",
    strategy: "app-handoff",
    account: { email: "agent.sales@demo.test", role: "Sales" },
    session: { ttlMinutes: 60 },
    ...overrides,
  };
}

function registry(): ProfileRegistry {
  const entries = [
    profile("demo:sandbox:sales", {}),
    profile("demo:sandbox:custom", { options: { handoffPath: "/api/agent/handoff" } }),
    profile("demo:sandbox:nextauth", { strategy: "nextauth-credentials" }),
    profile("demo:sandbox:nosecret", {}),
    profile("demo:live", {
      environment: "production",
      baseUrl: "https://live.demo.test",
      account: { email: "", role: "" },
      session: { ttlMinutes: 0 },
    }),
  ];
  return { version: 1, profiles: Object.fromEntries(entries.map((p) => [p.name, p])), sources: ["inline"] };
}

function mustProfile(reg: ProfileRegistry, name: string): Profile {
  const p = reg.profiles[name];
  if (p === undefined) throw new Error(`fixture: ${name}`);
  return p;
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (e: unknown) => e,
  );
}

async function auditText(): Promise<string> {
  try {
    return await fs.readFile(path.join(home, "audit.ndjson"), "utf8");
  } catch {
    return "";
  }
}

describe("issueHandoff", () => {
  it("issues a verifiable one-time URL and audits it", async () => {
    const secret = throwaway();
    const reg = registry();
    const store = new TestStore();
    await putProfileSecret(store, mustProfile(reg, "demo:sandbox:sales"), secret);
    const now = new Date();
    const deps: CommandDeps = { store, registry: reg, requester: "vitest", now: () => now };

    const out = await issueHandoff(deps, "demo:sandbox:sales", { requester: "mcp:claude-code" });
    expect(out.profile).toBe("demo:sandbox:sales");
    expect(out.url.startsWith("https://sandbox.demo.test/api/auth/agent-handoff?code=")).toBe(true);
    expect(out.url).not.toContain(secret);
    expect(new Date(out.expiresAt).getTime()).toBe(Math.floor(now.getTime() / 1000) * 1000 + HANDOFF_TTL_SECONDS * 1000);

    const code = new URL(out.url).searchParams.get("code") ?? "";
    const nonceStore = new MemoryNonceStore();
    const res = await verifyHandoffCode({ code, secret, nonceStore, now });
    expect(res.ok && res.profileName).toBe("demo:sandbox:sales");
    expect(await verifyHandoffCode({ code, secret, nonceStore, now })).toEqual({ ok: false, reason: "replayed" });

    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "handoff",
      ok: true,
      profile: "demo:sandbox:sales",
      host: "sandbox.demo.test",
      environment: "sandbox",
      strategy: "app-handoff",
      requester: "mcp:claude-code",
      ts: now.toISOString(),
    });
    const text = await auditText();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(code);
  });

  it("honours options.handoffPath and defaults the requester to deps.requester", async () => {
    const secret = throwaway();
    const reg = registry();
    const store = new TestStore();
    await putProfileSecret(store, mustProfile(reg, "demo:sandbox:custom"), secret);
    const out = await issueHandoff({ store, registry: reg, requester: "cli" }, "demo:sandbox:custom");
    expect(out.url.startsWith("https://sandbox.demo.test/api/agent/handoff?code=")).toBe(true);
    const { rows } = await readAuditTail(1);
    expect(rows[0]?.requester).toBe("cli");
  });

  it("refuses a production profile before the store, with a refused audit row", async () => {
    const reg = registry();
    const store = new TestStore();
    const err = await caught(() => issueHandoff({ store, registry: reg, requester: "vitest" }, "demo:live"));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("production-refused");
    expect(store.gets).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "refused", ok: false, profile: "demo:live", reason: "production-refused" });
  });

  it("refuses a non-app-handoff profile as invalid-profile before the store", async () => {
    const secret = throwaway();
    const reg = registry();
    const store = new TestStore();
    await putProfileSecret(store, mustProfile(reg, "demo:sandbox:nextauth"), secret);
    store.gets = 0;
    const err = await caught(() => issueHandoff({ store, registry: reg, requester: "vitest" }, "demo:sandbox:nextauth"));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("invalid-profile");
    expect((err as Error).message).toBe(
      "profile demo:sandbox:nextauth uses strategy nextauth-credentials; handoff needs strategy app-handoff",
    );
    expect((err as Error).message).not.toContain(secret);
    expect(store.gets).toBe(0);
    const { rows } = await readAuditTail(10);
    expect(rows.some((r) => r.event === "handoff")).toBe(false);
  });

  it("refuses a stored secret shorter than 32 characters (stored before the minimum) and audits it", async () => {
    const reg = registry();
    const store = new TestStore();
    const short = randomBytes(8).toString("hex"); // 16 chars, written past storeSet's check
    await putProfileSecret(store, mustProfile(reg, "demo:sandbox:sales"), short);
    const err = await caught(() => issueHandoff({ store, registry: reg, requester: "vitest" }, "demo:sandbox:sales"));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("invalid-profile");
    expect((err as Error).message).toContain("openssl rand -base64 32");
    expect((err as Error).message).not.toContain(short);
    const { rows } = await readAuditTail(10);
    expect(rows.at(-1)).toMatchObject({ event: "refused", reason: "handoff-secret-too-short", ok: false });
    expect(rows.some((r) => r.event === "handoff")).toBe(false);
  });

  it("throws MissingSecretError when no secret is stored and issues nothing", async () => {
    const reg = registry();
    const store = new TestStore();
    const err = await caught(() => issueHandoff({ store, registry: reg, requester: "vitest" }, "demo:sandbox:nosecret"));
    expect(err).toBeInstanceOf(MissingSecretError);
    const { rows } = await readAuditTail(10);
    expect(rows.some((r) => r.event === "handoff")).toBe(false);
  });

  it("refuses an unknown profile", async () => {
    const err = await caught(() =>
      issueHandoff({ store: new TestStore(), registry: registry(), requester: "vitest" }, "demo:nope"),
    );
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("unknown-profile");
  });

  it("never puts the secret in any error message or stack", async () => {
    const secret = throwaway();
    const reg = registry();
    const store = new TestStore();
    for (const name of ["demo:sandbox:sales", "demo:sandbox:nextauth"]) {
      await putProfileSecret(store, mustProfile(reg, name), secret);
    }
    const deps: CommandDeps = { store, registry: reg, requester: "vitest" };
    const errors = [
      await caught(() => issueHandoff(deps, "demo:live")),
      await caught(() => issueHandoff(deps, "demo:sandbox:nextauth")),
      await caught(() => issueHandoff(deps, "demo:sandbox:nosecret")),
      await caught(() => issueHandoff(deps, "demo:nope")),
      await caught(() =>
        verifyHandoffCode({ code: "x", secret: "", nonceStore: new MemoryNonceStore() }),
      ),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
      expect(`${(e as Error).message}\n${(e as Error).stack ?? ""}`).not.toContain(secret);
    }
    const ok = await issueHandoff(deps, "demo:sandbox:sales");
    expect(ok.url).not.toContain(secret);
    expect(ok.url).not.toContain(encodeURIComponent(secret));
    expect(ok.url).not.toContain(b64u(secret));
    expect(await auditText()).not.toContain(secret);
  });
});
