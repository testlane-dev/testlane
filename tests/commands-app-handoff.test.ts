/**
 * `session` / `check` for app-handoff profiles through the broker commands,
 * and app-handoff as the `dependsOn` of a dependent-token profile (a exchange
 * device reached through a one-time handoff, then a member credential exchanged for
 * an x-device-access token).
 *
 * The app is tests/helpers/fake-nextauth.ts with its reference handoff route
 * (same verifier and 302 contract as examples/demo-app) plus the fake exchange
 * API. Every credential, code and cookie is generated at test time and
 * asserted absent from outputs (where not the deliverable), errors and the
 * audit log.
 */
import { randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditTail } from "../src/audit.js";
import {
  BROKER_CONSUMED_HANDOFF_REASON,
  checkProfile,
  issueSession,
  MissingSecretError,
  rotateProfile,
  type CommandDeps,
} from "../src/commands.js";
import { issueHandoff } from "../src/handoff.js";
import { auditLogPath } from "../src/paths.js";
import { SESSION_FORMATS } from "../src/session/format.js";
import { assertValidStoreKey, type SecretStore } from "../src/store/index.js";
import { PolicyError, SignInError, type AuditRow, type Profile, type ProfileRegistry } from "../src/types.js";
import { OriginMismatchError, putProfileSecret } from "../src/vault.js";
import { startFakeNextAuth, type FakeHandoffRoute, type FakeNextAuth } from "./helpers/fake-nextauth.js";
import { createDeviceExchangeRoutes, type DeviceExchangeRoutes } from "./helpers/fake-device-exchange.js";

/** In-memory SecretStore that records which keys were read. Values are never logged. */
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

const DEVICE = "demo:testing:handoff:exchange-device";
const WORKER = "demo:testing:exchange:worker";
const DEVICE_EMAIL = "agent.exchange@example.test";
const OTHER_EMAIL = "someone.else@example.test";
const WORKER_EMAIL = "member@example.test";
const SUBJECT = "member-0042";
const REQUESTER = "vitest-handoff-session";
const SESSION_COOKIE = "next-auth.session-token";
const FOR_WORKER = `internal:dependent:for=${WORKER}`;

/** 8-digit throwaway test credential (long enough not to collide with ports or timestamps in text checks). */
const throwawayPin = (): string => Array.from({ length: 8 }, () => String(randomInt(0, 10))).join("");
const throwaway = (): string => randomBytes(18).toString("base64url");

const savedHome = process.env["TESTLANE_HOME"];
let home = "";
let handoffSecret = "";
let credential = "";
let app: FakeNextAuth | undefined;
let exchange: DeviceExchangeRoutes;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-handoff-session-"));
  process.env["TESTLANE_HOME"] = home;
  handoffSecret = randomBytes(32).toString("base64url");
  credential = throwawayPin();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The app: a device account (service permission, password-less for the broker), the handoff route, the exchange API. */
async function boot(route: Partial<FakeHandoffRoute> = {}): Promise<FakeNextAuth> {
  exchange = createDeviceExchangeRoutes({
    users: [{ subject: SUBJECT, credential, name: "Test Member", role: "Operator", email: WORKER_EMAIL }],
    isDependency: (cookie) => app?.sessionUserFor(cookie)?.permissions?.includes("EXCHANGE_ACCESS") === true,
  });
  app = await startFakeNextAuth({
    users: [
      // The broker never holds these passwords: the device is reached only through the handoff.
      { email: DEVICE_EMAIL, password: throwaway(), name: "Exchange Device", role: "Exchange", permissions: ["EXCHANGE_ACCESS"] },
      { email: OTHER_EMAIL, password: throwaway(), name: "Someone Else", role: "Admin" },
    ],
    includeRoleInSession: true,
    handoff: { secret: handoffSecret, profiles: { [DEVICE]: DEVICE_EMAIL }, ...route },
    extraRoutes: (req, res, url) => {
      if (url.pathname === "/api/broken-me") {
        // An identity endpoint whose connection drops mid-body (undici: "TypeError: terminated").
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "200" });
        res.write('{"user":{"email":');
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      return exchange.handle(req, res, url);
    },
  });
  return app;
}

function must(): FakeNextAuth {
  if (app === undefined) throw new Error("boot() first");
  return app;
}

function deviceProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: DEVICE,
    app: "demo",
    environment: "testing",
    baseUrl: must().baseUrl,
    strategy: "app-handoff",
    account: { email: DEVICE_EMAIL, role: "Exchange" },
    session: { ttlMinutes: 240 },
    options: { mePath: "/api/auth/session", emailField: "user.email" },
    ...overrides,
  };
}

function workerProfile(name: string = WORKER, dependsOn: string = DEVICE): Profile {
  return {
    name,
    app: "demo",
    environment: "testing",
    baseUrl: must().baseUrl,
    strategy: "dependent-token",
    account: { email: WORKER_EMAIL, role: "Operator", identifier: SUBJECT },
    session: { ttlMinutes: 60 },
    options: {
      dependsOn,
      tokenPath: "/api/device/exchange",
      fields: '{"subject":"{{identifier}}","credential":"{{secret}}"}',
      tokenField: "accessToken",
      tokenHeader: "x-device-access",
      expiresAtField: "expiresAt",
      mePath: "/api/device/identity",
      emailField: "subject.email",
    },
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
  store.reads.length = 0;
  const fetchImpl = vi.fn<typeof fetch>((input, init) => fetch(input, init));
  const deps: CommandDeps = { store, registry, requester: REQUESTER, fetchImpl };
  return { deps, store, fetchImpl };
}

async function auditText(): Promise<string> {
  return fs.readFile(auditLogPath(), "utf8").catch(() => "");
}

async function auditRows(): Promise<AuditRow[]> {
  return (await readAuditTail(100)).rows;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

/** One-time material that must never show up where it is not the deliverable. */
function handoffMaterial(): string[] {
  return [handoffSecret, Buffer.from(handoffSecret).toString("base64"), ...must().handoffCodes];
}

function expectNoHandoffMaterial(text: string): void {
  expect(text).not.toContain("code=");
  expect(text).not.toContain("agent-handoff?");
  expect(text).not.toContain("[REDACTED]");
  for (const value of handoffMaterial()) expect(text).not.toContain(value);
}

/** Neither the one-time material nor any session cookie value. */
function expectNothingSensitive(text: string): void {
  expectNoHandoffMaterial(text);
  for (const token of must().sessionTokens) expect(text).not.toContain(token);
}

function errorTexts(err: unknown): string {
  return [String((err as Error).message), String((err as Error).stack), JSON.stringify(err)].join("\n");
}

describe("session for an app-handoff profile", () => {
  it("issues every format from the handoff cookies, audited as the mint and the session, with no code or URL", async () => {
    const fake = await boot();
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });

    const outputs = new Map<string, string>();
    for (const format of SESSION_FORMATS) {
      const { output, artifact, warnings } = await issueSession(deps, DEVICE, { format });
      expect(warnings).toEqual([]);
      expect(artifact).toMatchObject({ profile: DEVICE, strategy: "app-handoff" });
      const token = artifact.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "<none>";
      expect(fake.sessionUserFor(`${SESSION_COOKIE}=${token}`)?.email).toBe(DEVICE_EMAIL);
      expect(output).toContain(token);
      expectNoHandoffMaterial(output);
      expectNoHandoffMaterial(JSON.stringify(artifact));
      outputs.set(format, output);
    }
    expect(outputs.get("cookie")).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    expect(outputs.get("headers")).toMatch(/^Cookie: next-auth\.session-token=[0-9a-f]{64}$/);
    expect(outputs.get("curl")).toMatch(/\tnext-auth\.session-token\t[0-9a-f]{64}$/m);
    const state = JSON.parse(outputs.get("storage-state") ?? "{}") as { cookies: Array<Record<string, unknown>>; origins: unknown[] };
    expect(state.origins).toEqual([]);
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0]).toMatchObject({ name: SESSION_COOKIE, domain: "127.0.0.1", path: "/", httpOnly: true });
    // json carries the same header set as `headers` (the session cookie only), and never the one-time URL or code.
    const jsonOutput = outputs.get("json") ?? "";
    const jsonArtifact = JSON.parse(jsonOutput) as { profile: string; format: string; expiresAt: string; headers: Record<string, string>; droppedHeaders: string[] };
    expect(jsonArtifact).toMatchObject({ profile: DEVICE, format: "json", droppedHeaders: [] });
    expect(Object.keys(jsonArtifact.headers)).toEqual(["Cookie"]);
    expect(jsonArtifact.headers.Cookie).toMatch(/^next-auth\.session-token=[0-9a-f]{64}$/);
    expect(jsonOutput).not.toContain("/api/auth/agent-handoff");
    expectNoHandoffMaterial(jsonOutput);

    // A fresh single-use code per session, each accepted once by the route.
    expect(fake.handoffOutcomes).toEqual(SESSION_FORMATS.map(() => "ok"));
    expect(new Set(fake.handoffCodes).size).toBe(SESSION_FORMATS.length);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(
      SESSION_FORMATS.flatMap(() => ["GET /api/auth/agent-handoff", "GET /api/auth/session"]),
    );

    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.profile, r.strategy, r.format, r.reason, r.requester, r.ok])).toEqual(
      SESSION_FORMATS.flatMap((format) => [
        ["handoff", DEVICE, "app-handoff", format, BROKER_CONSUMED_HANDOFF_REASON, REQUESTER, true],
        ["session", DEVICE, "app-handoff", format, undefined, REQUESTER, true],
      ]),
    );
    const text = await auditText();
    expectNothingSensitive(text);
  });

  it("caps the artifact at the session cookie's expiry and at --ttl", async () => {
    await boot({ maxAgeSeconds: 600 });
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    const start = Date.now();
    const { artifact } = await issueSession(deps, DEVICE, { format: "cookie" });
    expect(Date.parse(artifact.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(Date.parse(artifact.expiresAt)).toBeGreaterThan(start + 590_000);

    const { artifact: short } = await issueSession(deps, DEVICE, { format: "cookie", ttlMinutes: 2 });
    expect(Date.parse(short.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("check confirms the identity through mePath and discards the session", async () => {
    await boot();
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    const result = await checkProfile(deps, DEVICE);
    expect(result).toMatchObject({ profile: DEVICE, ok: true, email: DEVICE_EMAIL, role: "Exchange", roleSource: "declared" });
    expectNothingSensitive(JSON.stringify(result));

    const withRole = deviceProfile({ options: { mePath: "/api/auth/session", emailField: "user.email", roleField: "user.role" } });
    const { deps: deps2 } = await depsFor(registryOf(withRole), { [DEVICE]: handoffSecret });
    expect(await checkProfile(deps2, DEVICE)).toMatchObject({ ok: true, role: "Exchange", roleSource: "app" });

    const rows = await auditRows();
    expect(rows.slice(0, 2).map((r) => [r.event, r.profile, r.format, r.reason, r.ok])).toEqual([
      ["handoff", DEVICE, undefined, BROKER_CONSUMED_HANDOFF_REASON, true],
      ["check", DEVICE, undefined, undefined, true],
    ]);
    expectNothingSensitive(await auditText());
  });

  it("without mePath (no opt-in): session and check refuse with exit 2 before the store, a probe or a mint", async () => {
    await boot();
    const profile = deviceProfile({ options: { handoffPath: "/api/auth/agent-handoff", emailField: "user.email" } });
    const { deps, store, fetchImpl } = await depsFor(registryOf(profile), { [DEVICE]: handoffSecret });
    for (const run of [() => issueSession(deps, DEVICE, { format: "cookie" }), () => checkProfile(deps, DEVICE)]) {
      const err = await rejection(run());
      expect(err).toBeInstanceOf(PolicyError);
      expect((err as PolicyError).code).toBe("invalid-profile");
      expect((err as Error).message).toBe(
        `profile ${DEVICE} uses strategy app-handoff without options.mePath, so session and check are off for it: ` +
          `use \`testlane handoff ${DEVICE}\`, or opt the profile in by adding options.mePath (and emailField) so the ` +
          "broker can confirm the account before handing out its session",
      );
    }
    expect(store.reads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().requests).toEqual([]);
    expect(must().handoffCodes).toEqual([]);
    expect((await auditRows()).map((r) => [r.event, r.reason, r.format])).toEqual([
      ["refused", "strategy-not-supported", "cookie"],
      ["refused", "strategy-not-supported", undefined],
    ]);
    // `handoff` itself needs no opt-in.
    expect((await issueHandoff(deps, DEVICE)).profile).toBe(DEVICE);
  });

  it("an unreachable app: nothing is minted, only the failed session is recorded", async () => {
    const fake = await boot();
    const baseUrl = fake.baseUrl;
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    await fake.close();
    app = undefined;
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe(`could not reach handoff route at ${new URL(baseUrl).host} (ECONNREFUSED)`);
    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.ok, r.reason])).toEqual([
      ["session", false, `could not reach handoff route at ${new URL(baseUrl).host} (ECONNREFUSED)`],
    ]);
  });

  it("a request that gets no answer after the mint is recorded as not delivered; the URL never appears", async () => {
    const fake = await boot();
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    const seen: string[] = [];
    deps.fetchImpl = vi.fn<typeof fetch>(async (input) => {
      seen.push(String(input));
      throw new TypeError(`fetch failed: ${String(input)}`, { cause: new Error(`socket hang up at ${String(input)}`) });
    });
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    const host = new URL(fake.baseUrl).host;
    expect((err as Error).message).toBe(`could not reach handoff route at ${host}`);
    const code = new URL(seen[0] ?? "http://x/").searchParams.get("code") ?? "<none>";
    expect(code).not.toBe("<none>");
    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.ok, r.reason])).toEqual([
      ["handoff", true, BROKER_CONSUMED_HANDOFF_REASON],
      ["handoff", false, `${BROKER_CONSUMED_HANDOFF_REASON}:no-answer`],
      ["session", false, `could not reach handoff route at ${host}`],
    ]);
    for (const text of [errorTexts(err), await auditText()]) {
      expect(text).not.toContain(seen[0] ?? "<none>");
      expect(text).not.toContain(code);
      expect(text).not.toContain("code=");
    }
  });

  it("a body that breaks off at mePath is a SignInError, audited for session and check", async () => {
    await boot();
    const profile = deviceProfile({ options: { mePath: "/api/broken-me", emailField: "user.email" } });
    const { deps } = await depsFor(registryOf(profile), { [DEVICE]: handoffSecret });
    const message = `identity endpoint at ${new URL(must().baseUrl).host} failed while sending its answer`;
    for (const run of [() => issueSession(deps, DEVICE, { format: "cookie" }), () => checkProfile(deps, DEVICE)]) {
      const err = await rejection(run());
      expect(err).toBeInstanceOf(SignInError);
      expect((err as Error).message).toBe(message);
      expectNothingSensitive(errorTexts(err));
    }
    expect((await auditRows()).map((r) => [r.event, r.ok, r.reason])).toEqual([
      ["handoff", true, BROKER_CONSUMED_HANDOFF_REASON],
      ["session", false, message],
      ["handoff", true, BROKER_CONSUMED_HANDOFF_REASON],
      ["check", false, message],
    ]);
    expectNothingSensitive(await auditText());
  });

  it("any other error after the mint still ends in a failure row", async () => {
    await boot();
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    deps.fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).includes("/api/auth/agent-handoff")) return fetch(input, init);
      // A response object whose header parsing blows up with a plain Error.
      const broken = {
        status: 302,
        ok: false,
        body: null,
        headers: {
          get: () => "/",
          getSetCookie: (): string[] => {
            throw new Error("header parser exploded");
          },
        },
      };
      return broken as unknown as Response;
    });
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).not.toBeInstanceOf(SignInError);
    expect((await auditRows()).map((r) => [r.event, r.ok, r.reason])).toEqual([
      ["handoff", true, BROKER_CONSUMED_HANDOFF_REASON],
      ["session", false, "sign-in-error"],
    ]);
  });

  it("a session that cannot be written in the requested format is recorded as failed", async () => {
    await boot({ extraCookies: ["odd=caf\u00e9; Path=/"] });
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    const err = await rejection(issueSession(deps, DEVICE, { format: "headers" }));
    expect((err as Error).message).toBe("session cookie is not representable as a header line");
    expect((await auditRows()).map((r) => [r.event, r.ok, r.reason, r.format])).toEqual([
      ["handoff", true, BROKER_CONSUMED_HANDOFF_REASON, "headers"],
      ["session", false, "format-failed", "headers"],
    ]);
  });

  const failures: Array<[string, Partial<FakeHandoffRoute>, string, number | undefined]> = [
    ["a non-3xx answer", { status: 200 }, "answered 200 instead of a redirect", 200],
    ["a redirect without a cookie", { noCookie: true }, "set no host-only session cookie", 302],
    ["a redirect to a foreign host", { location: "https://elsewhere.example.test/landing-7f3a" }, "redirected off the profile origin", 302],
    ["a protocol-relative redirect", { location: "//elsewhere.example.test/landing-7f3a" }, "redirected off the profile origin", 302],
    ["a redirect to another port", { location: "http://127.0.0.1:9/landing-7f3a" }, "redirected off the profile origin", 302],
    ["a cookie for a foreign domain", { cookieDomain: "elsewhere.example.test" }, "set no host-only session cookie", 302],
    ["a cookie whose Domain is the host itself", { cookieDomain: "127.0.0.1" }, "set no host-only session cookie", 302],
    ["an identity mismatch", { profiles: { [DEVICE]: OTHER_EMAIL } }, `belongs to another account, but the profile expects ${DEVICE_EMAIL}`, undefined],
  ];
  for (const [what, route, message, status] of failures) {
    it(`${what} is a sign-in failure (exit 3 class), audited, leaking nothing`, async () => {
      await boot(route);
      const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
      for (const run of [() => issueSession(deps, DEVICE, { format: "storage-state" }), () => checkProfile(deps, DEVICE)]) {
        const err = await rejection(run());
        expect(err).toBeInstanceOf(SignInError);
        expect((err as SignInError).status).toBe(status);
        expect((err as Error).message).toContain(message);
        expectNothingSensitive(errorTexts(err));
        // The Location the route sent is never echoed.
        expect(errorTexts(err)).not.toContain("landing-7f3a");
        expect(errorTexts(err)).not.toContain("elsewhere.example.test");
      }
      const rows = await auditRows();
      expect(rows.map((r) => [r.event, r.profile, r.format, r.ok])).toEqual([
        ["handoff", DEVICE, "storage-state", true],
        ["session", DEVICE, "storage-state", false],
        ["handoff", DEVICE, undefined, true],
        ["check", DEVICE, undefined, false],
      ]);
      expect(rows[1]?.reason).toContain(message);
      expectNothingSensitive(await auditText());
    });
  }

  it("a handoff secret the app does not share gets the route's 404: a sign-in failure", async () => {
    await boot();
    const brokerSecret = randomBytes(32).toString("base64url");
    const { deps } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: brokerSecret });
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).status).toBe(404);
    expect(must().handoffOutcomes).toEqual(["bad-signature"]);
    expectNothingSensitive(errorTexts(err));
    for (const text of [errorTexts(err), await auditText()]) expect(text).not.toContain(brokerSecret);
  });

  it("refuses a production profile before the store or the network", async () => {
    await boot();
    const prod = deviceProfile({ environment: "production", session: { ttlMinutes: 0 } });
    const { deps, store, fetchImpl } = await depsFor(registryOf(prod), {});
    for (const run of [() => issueSession(deps, DEVICE, { format: "cookie" }), () => checkProfile(deps, DEVICE)]) {
      const err = await rejection(run());
      expect(err).toBeInstanceOf(PolicyError);
      expect((err as PolicyError).code).toBe("production-refused");
    }
    expect(store.reads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.reason])).toEqual([
      ["refused", "production-refused"],
      ["refused", "production-refused"],
    ]);
  });

  it("refuses a profile on a production host before the store or the network", async () => {
    await boot();
    const production: Profile = {
      name: "demo:production",
      app: "demo",
      environment: "production",
      baseUrl: "https://127.0.0.1",
      strategy: "nextauth-credentials",
      account: { email: "", role: "" },
      session: { ttlMinutes: 0 },
    };
    const registry = registryOf(deviceProfile(), production);
    const { deps, store, fetchImpl } = await depsFor(registry, { [DEVICE]: handoffSecret });
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect((err as PolicyError).code).toBe("production-refused");
    expect(store.reads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps origin and environment binding: a secret stored for another origin or tag is refused (exit 6 class)", async () => {
    await boot();
    const elsewhere = deviceProfile({ baseUrl: "http://127.0.0.1:9" });
    const store = new InnerStore();
    await putProfileSecret(store, elsewhere, handoffSecret);
    const fetchImpl = vi.fn<typeof fetch>((input, init) => fetch(input, init));
    const deps: CommandDeps = { store, registry: registryOf(deviceProfile()), requester: REQUESTER, fetchImpl };
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).toBeInstanceOf(OriginMismatchError);
    expect((err as OriginMismatchError).reason).toBe("origin-mismatch");

    const retagged = new InnerStore();
    await putProfileSecret(retagged, deviceProfile({ environment: "sandbox" }), handoffSecret);
    const err2 = await rejection(checkProfile({ ...deps, store: retagged }, DEVICE));
    expect((err2 as OriginMismatchError).reason).toBe("environment-mismatch");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
    expect((await auditRows()).map((r) => [r.event, r.reason])).toEqual([
      ["refused", "origin-mismatch"],
      ["refused", "environment-mismatch"],
    ]);
  });

  it("refuses a stored handoff secret shorter than 32 characters, like `handoff`, before minting", async () => {
    await boot();
    const short = randomBytes(12).toString("hex");
    const { deps, fetchImpl } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: short });
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("invalid-profile");
    expect((err as Error).message).toContain("shorter than 32 characters");
    expect((err as Error).message).not.toContain(short);
    expect(fetchImpl).not.toHaveBeenCalled();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "refused", reason: "handoff-secret-too-short", format: "cookie" });
    expect(await auditText()).not.toContain(short);
  });

  it("refuses an unsafe handoffPath before the store", async () => {
    await boot();
    const { deps, store, fetchImpl } = await depsFor(
      registryOf(deviceProfile({ options: { handoffPath: "/api//handoff", mePath: "/api/auth/session" } })),
      { [DEVICE]: handoffSecret },
    );
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect((err as PolicyError).code).toBe("invalid-profile");
    expect(store.reads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await auditRows())[0]).toMatchObject({ event: "refused", reason: "invalid-profile" });
  });

  it("reports a missing secret as exit 4 class, before any request", async () => {
    await boot();
    const { deps, fetchImpl } = await depsFor(registryOf(deviceProfile()), {});
    const err = await rejection(issueSession(deps, DEVICE, { format: "cookie" }));
    expect(err).toBeInstanceOf(MissingSecretError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rotate still refuses an app-handoff profile (exit 2 class) before the store or the network", async () => {
    await boot();
    const { deps, store, fetchImpl } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    const err = await rejection(rotateProfile(deps, DEVICE));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe("invalid-profile");
    expect(store.reads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
    expect((await auditRows()).map((r) => [r.event, r.reason])).toEqual([["refused", "rotate-not-configured"]]);
  });

  it("leaves `handoff` unchanged: it returns the URL, audits it without a reason, and makes no request", async () => {
    await boot();
    const { deps, fetchImpl } = await depsFor(registryOf(deviceProfile()), { [DEVICE]: handoffSecret });
    const out = await issueHandoff(deps, DEVICE);
    expect(Object.keys(out)).toEqual(["url", "expiresAt", "profile"]);
    expect(new URL(out.url).pathname).toBe("/api/auth/agent-handoff");
    expect(fetchImpl).not.toHaveBeenCalled();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "handoff", profile: DEVICE, ok: true });
    expect(rows[0]?.reason).toBeUndefined();
    expect(rows[0]?.format).toBeUndefined();
  });
});

describe("dependent-token over an app-handoff device", () => {
  it("device handoff, then the member credential POST: the token comes back as x-device-access", async () => {
    const fake = await boot();
    const registry = registryOf(deviceProfile(), workerProfile());
    const { deps } = await depsFor(registry, { [DEVICE]: handoffSecret, [WORKER]: credential });

    const { output, artifact } = await issueSession(deps, WORKER, { format: "headers" });

    expect(artifact.strategy).toBe("dependent-token");
    const token = artifact.headers?.["x-device-access"];
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(output).toContain(`x-device-access: ${token}`);
    expect(output).toMatch(/^Cookie: next-auth\.session-token=[0-9a-f]{64}$/m);
    // The exchange API saw the device's real service session on the credential exchange.
    expect(exchange.requests).toEqual([{ method: "POST", path: "/api/device/exchange", dependency: true, identifier: "subject" }]);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/auth/agent-handoff",
      "GET /api/auth/session",
      "POST /api/device/exchange",
    ]);

    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.profile, r.strategy, r.format, r.reason, r.requester, r.ok])).toEqual([
      ["handoff", DEVICE, "app-handoff", FOR_WORKER, BROKER_CONSUMED_HANDOFF_REASON, REQUESTER, true],
      ["session", DEVICE, "app-handoff", FOR_WORKER, undefined, REQUESTER, true],
      ["session", WORKER, "dependent-token", "headers", undefined, REQUESTER, true],
    ]);
    const text = await auditText();
    expectNothingSensitive(text);
    expect(text).not.toContain(credential);
    expect(text).not.toContain(token ?? "<none>");
    expectNoHandoffMaterial(output);
    expect(output).not.toContain(credential);
    expect(JSON.stringify(artifact)).not.toContain(`"${credential}"`);
  });

  it("check on the worker confirms worker.email through /api/device/identity", async () => {
    await boot();
    const { deps } = await depsFor(registryOf(deviceProfile(), workerProfile()), {
      [DEVICE]: handoffSecret,
      [WORKER]: credential,
    });
    const result = await checkProfile(deps, WORKER);
    expect(result).toMatchObject({ profile: WORKER, ok: true, email: WORKER_EMAIL });
    expect((await auditRows()).map((r) => [r.event, r.profile, r.format ?? null, r.ok])).toEqual([
      ["handoff", DEVICE, FOR_WORKER, true],
      ["session", DEVICE, FOR_WORKER, true],
      ["check", WORKER, null, true],
    ]);
  });

  it("a failed device handoff fails the worker without sending the credential", async () => {
    await boot({ status: 404 });
    const { deps } = await depsFor(registryOf(deviceProfile(), workerProfile()), {
      [DEVICE]: handoffSecret,
      [WORKER]: credential,
    });
    const err = await rejection(issueSession(deps, WORKER, { format: "headers" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).credentialsRejected).toBe(false);
    expect(exchange.requests).toEqual([]);
    expectNothingSensitive(errorTexts(err));
    expect(errorTexts(err)).not.toContain(credential);
    expect((await auditRows()).map((r) => [r.event, r.profile, r.format, r.ok])).toEqual([
      ["handoff", DEVICE, FOR_WORKER, true],
      ["session", DEVICE, FOR_WORKER, false],
      ["session", WORKER, "headers", false],
    ]);
  });

  it("allows the device at dependency depth 2", async () => {
    await boot();
    const [t2, t3] = ["demo:testing:exchange:t2", "demo:testing:exchange:t3"] as const;
    const registry = registryOf(deviceProfile(), workerProfile(t2, t3), workerProfile(t3, DEVICE));
    const { deps } = await depsFor(registry, { [DEVICE]: handoffSecret, [t2]: credential, [t3]: credential });
    const { artifact } = await issueSession(deps, t2, { format: "headers" });
    expect(artifact.headers?.["x-device-access"]).toMatch(/^[0-9a-f]{48}$/);
    expect(must().handoffOutcomes).toEqual(["ok"]);
  });

  it("refuses the device at depth 3 before its secret is read or a code is minted", async () => {
    await boot();
    const [t1, t2, t3] = ["demo:testing:exchange:t1", "demo:testing:exchange:t2", "demo:testing:exchange:t3"] as const;
    const registry = registryOf(deviceProfile(), workerProfile(t1, t2), workerProfile(t2, t3), workerProfile(t3, DEVICE));
    const { deps, store, fetchImpl } = await depsFor(registry, {
      [DEVICE]: handoffSecret,
      [t1]: credential,
      [t2]: credential,
      [t3]: credential,
    });
    const err = await rejection(issueSession(deps, t1, { format: "cookie" }));
    expect(err).toBeInstanceOf(SignInError);
    expect((err as Error).message).toBe(`profile dependencies nest deeper than 2 levels: ${t1} -> ${t2} -> ${t3} -> ${DEVICE}`);
    expect(store.reads).not.toContain(`agent-auth/${DEVICE}`);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
    expect((await auditRows()).some((r) => r.event === "handoff")).toBe(false);
  });

  it("still refuses cycles and self-dependencies before any request", async () => {
    await boot();
    const [a, b] = ["demo:testing:exchange:a", "demo:testing:exchange:b"] as const;
    const { deps, fetchImpl } = await depsFor(registryOf(deviceProfile(), workerProfile(a, b), workerProfile(b, a)), {
      [DEVICE]: handoffSecret,
      [a]: credential,
      [b]: credential,
    });
    const err = await rejection(issueSession(deps, a, { format: "cookie" }));
    expect((err as Error).message).toBe(`profile dependency cycle: ${a} -> ${b} -> ${a}`);

    const self = workerProfile(WORKER, WORKER);
    const { deps: deps2 } = await depsFor(registryOf(self), { [WORKER]: credential });
    const err2 = await rejection(issueSession(deps2, WORKER, { format: "cookie" }));
    expect((err2 as Error).message).toBe("profile option dependsOn must name a different profile");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
  });

  it("refuses a device without mePath (no opt-in) before its secret is read or a code is minted", async () => {
    await boot();
    const device = deviceProfile({ options: { emailField: "user.email" } });
    const { deps, store, fetchImpl } = await depsFor(registryOf(device, workerProfile()), {
      [DEVICE]: handoffSecret,
      [WORKER]: credential,
    });
    const err = await rejection(issueSession(deps, WORKER, { format: "headers" }));
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as Error).message).toContain(`profile ${DEVICE} uses strategy app-handoff without options.mePath`);
    // The worker's own secret is read first (its shape is checked before any dependency), the device's never.
    expect(store.reads).toEqual([`agent-auth/${WORKER}`]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
    expect(exchange.requests).toEqual([]);
    expect((await auditRows()).map((r) => [r.event, r.profile, r.reason, r.format])).toEqual([
      ["refused", DEVICE, "strategy-not-supported", FOR_WORKER],
    ]);
  });

  it("refuses a device on another host (host-not-allowed) before its secret or a code", async () => {
    await boot();
    const other = must().baseUrl.replace("127.0.0.1", "localhost");
    const registry = registryOf(deviceProfile({ baseUrl: other }), workerProfile());
    const { deps, store, fetchImpl } = await depsFor(registry, { [DEVICE]: handoffSecret, [WORKER]: credential });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect((err as PolicyError).code).toBe("host-not-allowed");
    expect(store.reads).toEqual([`agent-auth/${WORKER}`]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
  });

  it("refuses a production device (production-refused) before its secret or a code", async () => {
    await boot();
    // On its own host: a production profile on the worker's host would put that host on the
    // production denylist and refuse the worker itself (covered above).
    const registry = registryOf(
      deviceProfile({ environment: "production", baseUrl: "https://device.example.invalid", session: { ttlMinutes: 0 } }),
      workerProfile(),
    );
    const { deps, store, fetchImpl } = await depsFor(registry, { [WORKER]: credential });
    const err = await rejection(issueSession(deps, WORKER, { format: "cookie" }));
    expect((err as PolicyError).code).toBe("production-refused");
    expect(store.reads).toEqual([`agent-auth/${WORKER}`]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
    expect((await auditRows())[0]).toMatchObject({
      event: "refused",
      profile: DEVICE,
      reason: "production-refused",
      format: FOR_WORKER,
    });
  });

  it("refuses the worker when the device's host is a production host", async () => {
    await boot();
    const production: Profile = {
      name: "demo:production",
      app: "demo",
      environment: "production",
      baseUrl: "https://127.0.0.1",
      strategy: "nextauth-credentials",
      account: { email: "", role: "" },
      session: { ttlMinutes: 0 },
    };
    const registry = registryOf(deviceProfile(), workerProfile(), production);
    const { deps, store, fetchImpl } = await depsFor(registry, { [DEVICE]: handoffSecret, [WORKER]: credential });
    const err = await rejection(issueSession(deps, WORKER, { format: "headers" }));
    expect((err as PolicyError).code).toBe("production-refused");
    expect(store.reads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(must().handoffCodes).toEqual([]);
  });
});
