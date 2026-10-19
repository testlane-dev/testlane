/**
 * Generic dependent-token exchanges through the same policy, vault and audit
 * path as direct sign-in, using an independent fictional service contract.
 */
import { randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeSecretAssignment, readAuditTail } from "../src/audit.js";
import { checkProfile, dependencyAuditFormat, issueSession, type CommandDeps } from "../src/commands.js";
import { auditLogPath } from "../src/paths.js";
import { assertValidStoreKey, type SecretStore } from "../src/store/index.js";
import { PolicyError, SignInError, type Profile, type ProfileRegistry } from "../src/types.js";
import { putProfileSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";
import { createDeviceExchangeRoutes, type DeviceExchangeRoutes } from "./helpers/fake-device-exchange.js";

/** In-memory SecretStore that also records which keys were read. Values are never logged. */
class InnerStore implements SecretStore {
  readonly kind = "memory";
  readonly #data = new Map<string, string>();
  readonly reads: string[] = [];

  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    this.reads.push(key);
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

const SERVICE = "acme:local:service";
const WORKER = "acme:local:exchange-worker";
const SERVICE_EMAIL = "service@example.invalid";
const WORKER_EMAIL = "member@example.invalid";
const SUBJECT = "member-qa";
const REQUESTER = "vitest-exchange";

/** 8-digit throwaway test credential (long enough not to collide with ports or timestamps in text checks). */
const throwawayPin = (): string => Array.from({ length: 8 }, () => String(randomInt(0, 10))).join("");
const throwawayPassword = (): string => randomBytes(18).toString("base64url");

const savedHome = process.env["TESTLANE_HOME"];
let home = "";
let fake: FakeNextAuth;
let exchange: DeviceExchangeRoutes;
let servicePassword = "";
let credential = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-exchange-"));
  process.env["TESTLANE_HOME"] = home;
  servicePassword = throwawayPassword();
  credential = throwawayPin();
  exchange = createDeviceExchangeRoutes({
    users: [{ subject: SUBJECT, credential, name: "Test Member", role: "Member", email: WORKER_EMAIL }],
    isDependency: (cookie) => fake.sessionUserFor(cookie)?.permissions?.includes("EXCHANGE_ACCESS") === true,
  });
  fake = await startFakeNextAuth({
    users: [{ email: SERVICE_EMAIL, password: servicePassword, name: "Service", role: "Service", permissions: ["EXCHANGE_ACCESS"] }],
    extraRoutes: (req, res, url) => exchange.handle(req, res, url),
  });
});

afterEach(async () => {
  await fake.close();
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function serviceProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: SERVICE,
    app: "acme",
    environment: "sandbox",
    baseUrl: fake.baseUrl,
    strategy: "nextauth-credentials",
    account: { email: SERVICE_EMAIL, role: "Service" },
    session: { ttlMinutes: 240 },
    ...overrides,
  };
}

function exchangeProfile(name: string, service: string, overrides: Partial<Profile> = {}): Profile {
  return {
    name,
    app: "acme",
    environment: "sandbox",
    baseUrl: fake.baseUrl,
    strategy: "dependent-token",
    account: { email: WORKER_EMAIL, role: "Member", identifier: SUBJECT },
    session: { ttlMinutes: 60 },
    options: {
      dependsOn: service,
      tokenPath: "/api/device/exchange",
      fields: '{"subject":"{{identifier}}","credential":"{{secret}}"}',
      tokenField: "accessToken",
      tokenHeader: "x-device-access",
      expiresAtField: "expiresAt",
      mePath: "/api/device/identity",
      emailField: "subject.email",
      roleField: "subject.role",
    },
    ...overrides,
  };
}

function registryOf(...profiles: Profile[]): ProfileRegistry {
  return { version: 1, profiles: Object.fromEntries(profiles.map((p) => [p.name, p])), sources: ["inline"] };
}

async function depsFor(registry: ProfileRegistry, secrets: Record<string, string>) {
  const store = new InnerStore();
  for (const [name, secret] of Object.entries(secrets)) {
    const profile = registry.profiles[name];
    if (profile === undefined) throw new Error(`fixture: ${name}`);
    await putProfileSecret(store, profile, secret);
  }
  const fetchImpl = vi.fn<typeof fetch>((input, init) => fetch(input, init));
  const deps: CommandDeps = { store, registry, requester: REQUESTER, fetchImpl };
  return { deps, store, fetchImpl };
}

async function auditText(): Promise<string> {
  return fs.readFile(auditLogPath(), "utf8").catch(() => "");
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

describe("exchange-credential through issueSession", () => {
  it("signs in the service first and writes two session audit rows", async () => {
    const registry = registryOf(serviceProfile(), exchangeProfile(WORKER, SERVICE));
    const { deps } = await depsFor(registry, { [SERVICE]: servicePassword, [WORKER]: credential });

    const { output, artifact } = await issueSession(deps, WORKER, { format: "cookie" });

    expect(artifact.strategy).toBe("dependent-token");
    const token = artifact.headers?.["x-device-access"];
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const serviceCookie = artifact.cookies.find((c) => c.name === "next-auth.session-token");
    expect(serviceCookie).toBeDefined();
    expect(output).toBe(`next-auth.session-token=${serviceCookie?.value}`);
    // The fake exchange API saw a real service session (EXCHANGE_ACCESS) on the sign-in.
    expect(exchange.requests).toEqual([{ method: "POST", path: "/api/device/exchange", dependency: true, identifier: "subject" }]);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/auth/csrf",
      "POST /api/auth/callback/credentials",
      "POST /api/device/exchange",
    ]);

    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event: "session",
      profile: SERVICE,
      strategy: "nextauth-credentials",
      format: `internal:dependent:for=${WORKER}`,
      requester: REQUESTER,
      ok: true,
    });
    expect(rows[1]).toMatchObject({
      event: "session",
      profile: WORKER,
      strategy: "dependent-token",
      format: "cookie",
      requester: REQUESTER,
      ok: true,
    });

    const text = await auditText();
    for (const value of [credential, servicePassword, token ?? "<none>", serviceCookie?.value ?? "<none>"]) {
      expect(text).not.toContain(value);
    }
    expect(JSON.stringify(artifact)).not.toContain(`"${credential}"`);
    expect(JSON.stringify(artifact)).not.toContain(servicePassword);
  });

  it("check verifies the exchange identity through /api/device/identity", async () => {
    const registry = registryOf(serviceProfile(), exchangeProfile(WORKER, SERVICE));
    const { deps } = await depsFor(registry, { [SERVICE]: servicePassword, [WORKER]: credential });
    const result = await checkProfile(deps, WORKER);
    expect(result).toMatchObject({ profile: WORKER, ok: true, email: WORKER_EMAIL, role: "Member", roleSource: "app" });
    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => [r.event, r.profile, r.format ?? null, r.ok])).toEqual([
      ["session", SERVICE, `internal:dependent:for=${WORKER}`, true],
      ["check", WORKER, null, true],
    ]);
  });

  it("a wrong credential fails with SignInError, audited without the credential", async () => {
    const registry = registryOf(serviceProfile(), exchangeProfile(WORKER, SERVICE));
    let wrong = throwawayPin();
    while (wrong === credential) wrong = throwawayPin();
    const { deps } = await depsFor(registry, { [SERVICE]: servicePassword, [WORKER]: wrong });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).status).toBe(401);
    expect((err as SignInError).message).not.toContain(wrong);

    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => [r.event, r.profile, r.ok])).toEqual([
      ["session", SERVICE, true],
      ["session", WORKER, false],
    ]);
    const text = await auditText();
    expect(text).not.toContain(wrong);
    expect(text).not.toContain(credential);
  });

  it("refuses a dependency cycle before any request", async () => {
    const a = "acme:local:exchange-a";
    const b = "acme:local:exchange-b";
    const registry = registryOf(serviceProfile(), exchangeProfile(a, b), exchangeProfile(b, a));
    const { deps, fetchImpl } = await depsFor(registry, { [a]: throwawayPin(), [b]: throwawayPin() });
    const err = await rejection(issueSession(deps, a, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe(`profile dependency cycle: ${a} -> ${b} -> ${a}`);
    expect(fetchImpl).not.toHaveBeenCalled();
    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => [r.event, r.profile, r.ok, r.format])).toEqual([
      ["session", b, false, `internal:dependent:for=${a}`],
      ["session", a, false, "cookie"],
    ]);
  });

  it("refuses dependencies nested deeper than 2 levels before any request", async () => {
    const [t1, t2, t3, t4] = ["acme:local:t1", "acme:local:t2", "acme:local:t3", "acme:local:t4"] as const;
    const registry = registryOf(
      serviceProfile(),
      exchangeProfile(t1, t2),
      exchangeProfile(t2, t3),
      exchangeProfile(t3, t4),
      exchangeProfile(t4, SERVICE),
    );
    const { deps, fetchImpl, store } = await depsFor(registry, {
      [SERVICE]: servicePassword,
      [t1]: throwawayPin(),
      [t2]: throwawayPin(),
      [t3]: throwawayPin(),
      [t4]: throwawayPin(),
    });
    const err = await rejection(issueSession(deps, t1, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toContain("nest deeper than 2 levels");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reads).not.toContain(`agent-auth/${t4}`);
    expect(store.reads).not.toContain(`agent-auth/${SERVICE}`);
    // Boundary: t3 is signed in at dependency depth 2 (allowed, so its secret IS read);
    // t4 would be depth 3 (refused before its secret is read).
    expect(store.reads).toEqual([`agent-auth/${t1}`, `agent-auth/${t2}`, `agent-auth/${t3}`]);
    expect((err as Error).message).toBe(
      `profile dependencies nest deeper than 2 levels: ${t1} -> ${t2} -> ${t3} -> ${t4}`,
    );
  });

  it("names the requesting profile in the dependency audit format, withholding a name the audit guard would refuse", async () => {
    const worker = "acme:local:token:exchange"; // a legal name whose "token:" segment looks like an assignment
    const registry = registryOf(serviceProfile(), exchangeProfile(worker, SERVICE));
    const { deps } = await depsFor(registry, { [SERVICE]: servicePassword, [worker]: credential });
    await issueSession(deps, worker, { format: "cookie" });
    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => [r.event, r.profile, r.format, r.ok])).toEqual([
      ["session", SERVICE, "internal:dependent:for=(withheld)", true],
      ["session", worker, "cookie", true],
    ]);
  });

  it("refuses a service profile on another host (host-not-allowed), without reading its secret or touching the network", async () => {
    const elsewhere = "acme:local:service-elsewhere";
    const other = fake.baseUrl.replace("127.0.0.1", "localhost");
    const registry = registryOf(
      serviceProfile({ name: elsewhere, baseUrl: other }),
      exchangeProfile(WORKER, elsewhere),
    );
    const { deps, fetchImpl, store } = await depsFor(registry, { [elsewhere]: servicePassword, [WORKER]: credential });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("host-not-allowed");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reads).toEqual([`agent-auth/${WORKER}`]);
    const { rows } = await readAuditTail(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "refused",
      profile: WORKER,
      reason: "host-not-allowed",
      format: `internal:dependent:for=${WORKER}`,
      ok: false,
    });
  });

  it("refuses a production service profile (production-refused) before its secret or the network", async () => {
    const prodService = "acme:prod:service";
    const registry = registryOf(
      serviceProfile({
        name: prodService,
        environment: "production",
        baseUrl: "https://acme.example.invalid",
        account: { email: "", role: "" },
        session: { ttlMinutes: 0 },
      }),
      exchangeProfile(WORKER, prodService),
    );
    const { deps, fetchImpl, store } = await depsFor(registry, { [WORKER]: credential });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("production-refused");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reads).toEqual([`agent-auth/${WORKER}`]);
    const { rows } = await readAuditTail(10);
    expect(rows[0]).toMatchObject({ event: "refused", profile: prodService, reason: "production-refused", ok: false });
  });

  it("refuses an unknown service profile", async () => {
    const registry = registryOf(exchangeProfile(WORKER, "acme:local:missing"));
    const { deps, fetchImpl } = await depsFor(registry, { [WORKER]: credential });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("unknown-profile");
    expect(fetchImpl).not.toHaveBeenCalled();
    const { rows } = await readAuditTail(10);
    expect(rows[0]).toMatchObject({ event: "refused", profile: WORKER, reason: "unknown-profile" });
  });
});

describe("dependent-token (explicit profile) through issueSession / checkProfile", () => {
  function explicitProfile(name: string, dependsOn: string): Profile {
    return {
      name,
      app: "acme",
      environment: "sandbox",
      baseUrl: fake.baseUrl,
      strategy: "dependent-token",
      account: { email: WORKER_EMAIL, role: "Member", identifier: SUBJECT },
      session: { ttlMinutes: 60 },
      options: {
        dependsOn,
        tokenPath: "/api/device/exchange",
        fields: '{"credential":"{{secret}}","subject":"{{identifier}}"}',
        secretPattern: "^\\d{4,8}$",
        tokenField: "accessToken",
        tokenHeader: "x-device-access",
        expiresAtField: "expiresAt",
        mePath: "/api/device/identity",
        emailField: "subject.email",
        roleField: "subject.role",
      },
    };
  }

  it("issues explicit token/header configuration with no secret in output", async () => {
    const registry = registryOf(serviceProfile(), explicitProfile(WORKER, SERVICE));
    const { deps } = await depsFor(registry, { [SERVICE]: servicePassword, [WORKER]: credential });

    const { output, artifact } = await issueSession(deps, WORKER, { format: "headers" });
    expect(artifact.strategy).toBe("dependent-token");
    const token = artifact.headers?.["x-device-access"];
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(output).toContain(`x-device-access: ${token}`);
    expect(output).toMatch(/^Cookie: next-auth\.session-token=/m);
    expect(exchange.requests).toEqual([{ method: "POST", path: "/api/device/exchange", dependency: true, identifier: "subject" }]);

    const { rows } = await readAuditTail(10);
    expect(rows.map((r) => [r.event, r.profile, r.strategy, r.format, r.ok])).toEqual([
      ["session", SERVICE, "nextauth-credentials", `internal:dependent:for=${WORKER}`, true],
      ["session", WORKER, "dependent-token", "headers", true],
    ]);
    const text = await auditText();
    for (const value of [credential, servicePassword, token ?? "<none>"]) expect(text).not.toContain(value);
    expect(output).not.toContain(credential);
    expect(output).not.toContain(servicePassword);
    expect(JSON.stringify(artifact)).not.toContain(`"${credential}"`);
  });

  it("labels dependency audit rows so the strategy name never trips the audit guard", () => {
    for (const name of [WORKER, "acme:local:token:exchange"]) {
      const format = dependencyAuditFormat({ name, strategy: "dependent-token" });
      expect(format.startsWith("internal:dependent:for=")).toBe(true);
      expect(looksLikeSecretAssignment(format)).toBe(false);
    }
    expect(dependencyAuditFormat({ name: "acme:local:token:exchange", strategy: "dependent-token" })).toBe(
      "internal:dependent:for=(withheld)",
    );
  });

  it("check verifies the identity through mePath", async () => {
    const registry = registryOf(serviceProfile(), explicitProfile(WORKER, SERVICE));
    const { deps } = await depsFor(registry, { [SERVICE]: servicePassword, [WORKER]: credential });
    const result = await checkProfile(deps, WORKER);
    expect(result).toMatchObject({ profile: WORKER, ok: true, email: WORKER_EMAIL, role: "Member", roleSource: "app" });
  });

  it("refuses a secret that fails secretPattern before the dependency is signed in", async () => {
    const registry = registryOf(serviceProfile(), explicitProfile(WORKER, SERVICE));
    const badSecret = throwawayPassword();
    const { deps, fetchImpl, store } = await depsFor(registry, { [SERVICE]: servicePassword, [WORKER]: badSecret });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe("secret does not match profile option secretPattern");
    expect((err as Error).message).not.toContain(badSecret);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.reads).toEqual([`agent-auth/${WORKER}`]);
    expect(await auditText()).not.toContain(badSecret);
  });
});
