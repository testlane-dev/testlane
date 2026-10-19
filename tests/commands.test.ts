import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditTail } from "../src/audit.js";
import { checkProfile, issueSession, type CommandDeps } from "../src/commands.js";
import { PolicyError, type Profile, type ProfileRegistry } from "../src/types.js";
import { putProfileSecret } from "../src/vault.js";
import { MemoryStore } from "./helpers/memory-store.js";

const savedHome = process.env["TESTLANE_HOME"];
let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-commands-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

function profile(name: string, overrides: Partial<Profile>): Profile {
  return {
    name,
    app: "demo-app",
    environment: "sandbox",
    baseUrl: "https://sandbox.demo.test",
    strategy: "nextauth-credentials",
    account: { email: "agent@demo.test", role: "Admin" },
    session: { ttlMinutes: 30 },
    ...overrides,
  };
}

/**
 * A registry that parseRegistry would reject (a sandbox entry on a production
 * host), built by hand to prove the policy layer refuses it independently.
 */
function overlappingRegistry(): ProfileRegistry {
  const entries = [
    profile("demo:prod", {
      environment: "production",
      baseUrl: "https://prod.demo.test",
      allowedHosts: ["api.prod.demo.test"],
      account: { email: "", role: "" },
      session: { ttlMinutes: 0 },
    }),
    profile("demo:sandbox:on-prod", { baseUrl: "https://prod.demo.test" }),
    profile("demo:sandbox:ok", { allowedHosts: ["api.prod.demo.test"] }),
  ];
  return { version: 1, profiles: Object.fromEntries(entries.map((p) => [p.name, p])), sources: ["inline"] };
}

describe("registry-derived production hosts reach the policy engine", () => {
  it("refuses session/check for a non-production profile on a production host, before store or network", async () => {
    const store = new MemoryStore();
    const registry = overlappingRegistry();
    const target = registry.profiles["demo:sandbox:on-prod"];
    if (target === undefined) throw new Error("fixture");
    await putProfileSecret(store, target, `throwaway-${randomBytes(8).toString("hex")}`);
    store.gets = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    const deps: CommandDeps = { store, registry, requester: "vitest", fetchImpl };

    for (const run of [
      () => issueSession(deps, "demo:sandbox:on-prod", { format: "cookie" }),
      () => checkProfile(deps, "demo:sandbox:on-prod"),
    ]) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PolicyError);
      expect((err as PolicyError).code).toBe("production-refused");
    }
    expect(store.gets).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ event: "refused", profile: "demo:sandbox:on-prod", reason: "production-refused" });
    }
  });

  it("refuses a --target on a production host", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    const deps: CommandDeps = { store, registry: overlappingRegistry(), requester: "vitest", fetchImpl };
    const err = await issueSession(deps, "demo:sandbox:ok", {
      format: "cookie",
      targetUrl: "https://api.prod.demo.test/v1",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as PolicyError).code).toBe("production-refused");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it.each(["mismatching-email", "reflected-role", "rotated-role"])("keeps reflected session material out of check output and audit (%s)", async (mode) => {
  const value = randomBytes(24).toString("hex");
  const rotated = randomBytes(24).toString("hex");
  const account = profile("demo:sandbox:check", { strategy: "form-post", options: {
    loginPath: "/login", primeCookies: "false", sessionCookieName: "sid", mePath: "/me",
    fields: '{"email":"{{email}}","password":"{{secret}}"}',
  } });
  const store = new MemoryStore(); await putProfileSecret(store, account, randomBytes(32).toString("hex"));
  const deps: CommandDeps = { store, registry: { version: 1, profiles: { [account.name]: account }, sources: [] }, requester: "test",
    fetchImpl: async (url) => new URL(String(url)).pathname === "/login"
      ? Response.json({}, { headers: { "set-cookie": `sid=${value}; Path=/; Secure; HttpOnly` } })
      : Response.json({ email: mode === "mismatching-email" ? value : account.account.email, role: mode === "rotated-role" ? rotated : value },
        mode === "rotated-role" ? { headers: { "set-cookie": `sid=${rotated}; Path=/; Secure; HttpOnly` } } : {}),
  };
  const result = await checkProfile(deps, account.name);
  expect(JSON.stringify(result)).not.toContain(value);
  expect(JSON.stringify(result)).not.toContain(rotated);
  const audit = await readAuditTail(20);
  expect(JSON.stringify(audit)).not.toContain(value);
  expect(JSON.stringify(audit)).not.toContain(rotated);
  if (mode === "mismatching-email") {
    expect(result).toMatchObject({ ok: false, roleSource: "declared" });
    expect(result.email).toBeUndefined();
    expect(audit.rows.at(-1)?.reason).toBe("identity-mismatch");
  } else expect(result).toMatchObject({ ok: true, roleSource: "app", role: "[REDACTED]" });
});

it.each([false, true])("redacts bare bearer credentials through the real dependency path (rotated=%s)", async (rotate) => {
  const token = randomBytes(24).toString("hex"); const next = randomBytes(24).toString("hex");
  const device = profile("demo:sandbox:device", { strategy: "form-post", options: {
    loginPath: "/login", primeCookies: "false", sessionCookieName: "sid",
    fields: '{"email":"{{email}}","password":"{{secret}}"}',
  } });
  const worker = profile("demo:sandbox:worker", { strategy: "dependent-token", options: {
    dependsOn: device.name, tokenPath: "/token", fields: '{"credential":"{{secret}}"}',
    tokenField: "token", expiresAtField: "expiresAt", mePath: "/me", emailField: "email", roleField: "role",
  } });
  const store = new MemoryStore();
  for (const account of [device, worker]) await putProfileSecret(store, account, randomBytes(32).toString("hex"));
  const result = await checkProfile({ store, requester: "test", registry: { version: 1, profiles: { [device.name]: device, [worker.name]: worker }, sources: [] },
    fetchImpl: async (url) => {
      const route = new URL(String(url)).pathname;
      if (route === "/login") return Response.json({}, { headers: { "set-cookie": `sid=${randomBytes(24).toString("hex")}; Path=/; Secure; HttpOnly` } });
      if (route === "/token") return Response.json({ token, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return Response.json({ email: worker.account.email, role: rotate ? next : token }, rotate ? { headers: { authorization: `Bearer ${next}` } } : {});
    },
  }, worker.name);
  expect(result).toMatchObject({ ok: true, role: "[REDACTED]", roleSource: "app" });
  for (const value of [token, next]) {
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(await readAuditTail(20))).not.toContain(value);
  }
});
