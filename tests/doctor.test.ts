import * as AjvModule from "ajv/dist/2020.js";
import * as AjvFormatsModule from "ajv-formats";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDoctor, formatDoctor, type DoctorOptions } from "../src/doctor.js";
import { MissingSecretError } from "../src/commands.js";
import { parseRegistry } from "../src/profiles.js";
import { PolicyError, SignInError } from "../src/types.js";
import { OriginMismatchError } from "../src/vault.js";

let home = "";
let savedHome: string | undefined;
const entry = { app: "doctor-app", environment: "testing", baseUrl: "http://127.0.0.1:43123", strategy: "nextauth-credentials", account: { email: "qa@example.test", role: "QA" }, session: { ttlMinutes: 30 } };
const registry = () => parseRegistry({ version: 1, profiles: { "doctor:testing:qa": entry } }, "memory-registry");
const options = (): DoctorOptions => ({ registry: registry(), cwd: home, platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "test-session" }, executable: async () => true });

beforeEach(async () => {
  savedHome = process.env["TESTLANE_HOME"];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-doctor-"));
  process.env["TESTLANE_HOME"] = home;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"]; else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("passive setup diagnostics", () => {
  it("emits the shipped machine-readable schema for pass and failure reports", async () => {
    const AjvConstructor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile: (schema: object) => (data: unknown) => boolean };
    const addFormats = ((AjvFormatsModule as unknown as { default?: unknown }).default ?? AjvFormatsModule) as unknown as (instance: unknown) => void;
    const ajv = new AjvConstructor({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(await fs.readFile(new URL("../schema/doctor-report.schema.json", import.meta.url), "utf8")) as object);
    expect(validate(await collectDoctor(options()))).toBe(true);
    expect(validate(await collectDoctor({ ...options(), authenticationProfile: "missing" }))).toBe(true);
  });
  it("reports prerequisites without network/authentication calls or filesystem writes", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not expected"));
    const authenticate = vi.fn();
    const before = await fs.readdir(home);
    const report = await collectDoctor({ ...options(), authenticate });
    expect(report).toMatchObject({ schemaVersion: 1, ok: true, exitCode: 0 });
    expect(report.checks.find(c => c.id === "registry")).toMatchObject({ code: "registry.valid", details: { profileCount: 1 } });
    expect(report.checks.find(c => c.id === "authentication")?.code).toBe("authentication.not_requested");
    expect(network).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(await fs.readdir(home)).toEqual(before);
    expect(formatDoctor(report)).toContain("No authentication was attempted");
  });

  it("finds an app registry walking up from a nested test directory", async () => {
    const file = path.join(home, "testlane.profiles.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, profiles: { "doctor:testing:qa": entry } }));
    const cwd = path.join(home, "e2e", "nested");
    await fs.mkdir(cwd, { recursive: true });
    const { registry: _injected, ...discovered } = options();
    const report = await collectDoctor({ ...discovered, cwd });
    expect(report.checks.find(c => c.id === "registry")).toMatchObject({ code: "registry.valid", details: { sources: [file], profileCount: 1 } });
  });

  it("reports malformed/credential-bearing configuration without echoing its content", async () => {
    const value = randomBytes(24).toString("base64url");
    const file = path.join(home, "invalid.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, profiles: { "doctor:testing:qa": { ...entry, password: value } } }));
    const report = await collectDoctor({ ...options(), profilesFile: file });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.id === "registry")?.code).toBe("registry.invalid");
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(value);
  });

  it("reports empty registries and an audit path that is a directory", async () => {
    await fs.mkdir(path.join(home, "audit.ndjson"));
    const report = await collectDoctor({ ...options(), registry: parseRegistry({ version: 1, profiles: {} }, "empty") });
    expect(report.exitCode).toBe(1);
    expect(report.checks.find(c => c.id === "registry")?.code).toBe("registry.empty");
    expect(report.checks.find(c => c.id === "audit")?.code).toBe("audit.not_writable");
  });

  it("omits conflicting environment values and invalid store input", async () => {
    const value = randomBytes(24).toString("base64url");
    const report = await collectDoctor({ ...options(), env: { TESTLANE_STORE: value, AGENT_AUTH_STORE: "secret-service" } });
    expect(report.checks.find(c => c.id === "configuration")?.code).toBe("configuration.legacy_conflict");
    expect(report.checks.find(c => c.id === "store")?.code).toBe("store.invalid_kind");
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(value);
  });

  it("treats a blank store override as the platform default", async () => {
    const report = await collectDoctor({ ...options(), env: { TESTLANE_STORE: "   " } });
    expect(report.checks.find(c => c.id === "store")?.details?.["kind"]).toBe("secret-service");
  });

  it("identifies missing Linux tooling and undeclared session buses", async () => {
    const missing = await collectDoctor({ ...options(), executable: async () => false });
    expect(missing.checks.find(c => c.id === "store")?.code).toBe("store.prerequisite_missing");
    const noBus = await collectDoctor({ ...options(), env: {} });
    expect(noBus.checks.find(c => c.id === "store.bus")?.code).toBe("store.bus_not_declared");
  });

  it("distinguishes a platform mismatch from encrypted-file interactive prerequisites", async () => {
    const mismatch = await collectDoctor({ ...options(), env: { TESTLANE_STORE: "dpapi" } });
    expect(mismatch.checks.find(c => c.id === "store")?.code).toBe("store.platform_mismatch");
    const interactive = await collectDoctor({ ...options(), env: { TESTLANE_STORE: "encrypted-file" }, executable: async () => false });
    expect(interactive.checks.find(c => c.id === "store")?.code).toBe("store.interactive_passphrase");
    expect(interactive.checks.find(c => c.id === "store")?.status).toBe("warn");
  });

  it.each([
    ["secret-service", "win32"],
    ["secret-service", "darwin"],
    ["keychain-macos", "linux"],
    ["dpapi", "linux"],
  ] as const)("refuses %s on %s before probing an executable", async (kind, platform) => {
    const executable = vi.fn(async () => true);
    const report = await collectDoctor({ ...options(), platform, env: { TESTLANE_STORE: kind }, executable });
    expect(report.checks.find(c => c.id === "store")?.code).toBe("store.platform_mismatch");
    expect(executable).not.toHaveBeenCalled();
  });

  it("does not call a directory an available native store executable", async () => {
    const directory = path.join(home, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await fs.mkdir(directory, { recursive: true });
    const { executable: _injected, ...actualProbe } = options();
    const report = await collectDoctor({ ...actualProbe, platform: "win32", env: { SystemRoot: home } });
    expect(report.checks.find(c => c.id === "store")?.code).toBe("store.prerequisite_missing");
  });

  it("uses the DPAPI adapter's PATH fallback for a blank Windows root", async () => {
    const executable = vi.fn(async () => true);
    await collectDoctor({ ...options(), platform: "win32", env: { SystemRoot: "   " }, executable });
    expect(executable).toHaveBeenCalledExactlyOnceWith("powershell.exe");
  });

  it("distinguishes unsupported Secret Service from the explicit interactive fallback", async () => {
    const installed = await collectDoctor({ ...options(), platform: "freebsd", env: { TESTLANE_STORE: "encrypted-file" } });
    expect(installed.checks.find(c => c.id === "store")?.code).toBe("store.platform_mismatch");
    const interactive = await collectDoctor({ ...options(), platform: "freebsd", env: { TESTLANE_STORE: "encrypted-file" }, executable: async () => false });
    expect(interactive.checks.find(c => c.id === "store")?.code).toBe("store.interactive_passphrase");
  });

  it("resolves optional browser metadata without importing app code", async () => {
    const directory = path.join(home, "node_modules", "playwright");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "playwright", type: "module", exports: "./index.js" }));
    const marker = randomBytes(24).toString("base64url");
    const sideEffect = path.join(home, "import-was-executed");
    await fs.writeFile(path.join(directory, "index.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sideEffect)}, ${JSON.stringify(marker)});`);
    const report = await collectDoctor(options());
    expect(report.checks.find(c => c.id === "browser")).toMatchObject({ code: "browser.dependency_available", details: { package: "playwright" } });
    await expect(fs.access(sideEffect)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(marker);
  });

  it("warns without failing when browser tooling is absent", async () => {
    const report = await collectDoctor(options());
    expect(report.ok).toBe(true);
    expect(report.checks.find(c => c.id === "browser")).toMatchObject({ status: "warn", code: "browser.optional_dependency_missing" });
  });

  it("reports unsupported Node without hiding other diagnostic results", async () => {
    const report = await collectDoctor({ ...options(), nodeVersion: "20.0.0" });
    expect(report.exitCode).toBe(1);
    expect(report.checks.find(c => c.id === "runtime")?.code).toBe("runtime.unsupported");
    expect(report.checks.some(c => c.id === "registry")).toBe(true);
  });
});

describe("explicit authentication diagnostics", () => {
  it("does not treat inherited object keys as approved profiles", async () => {
    const authenticate = vi.fn();
    const report = await collectDoctor({ ...options(), authenticationProfile: "constructor", authenticate });
    expect(report.exitCode).toBe(2);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("returns only verification metadata, never response identity/session values", async () => {
    const value = randomBytes(24).toString("base64url");
    const authenticate = vi.fn(async () => ({ ok: true, profile: "doctor:testing:qa", email: value, role: value, roleSource: "app" as const, expiresAt: new Date().toISOString() }));
    const report = await collectDoctor({ ...options(), authenticationProfile: "doctor:testing:qa", authenticate });
    expect(report.exitCode).toBe(0);
    expect(authenticate).toHaveBeenCalledExactlyOnceWith("doctor:testing:qa");
    expect(report.checks.find(c => c.id === "authentication")?.code).toBe("authentication.verified");
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(value);
  });

  it("reports an identity mismatch with exit 3 without including returned identity values", async () => {
    const value = randomBytes(24).toString("base64url");
    const report = await collectDoctor({ ...options(), authenticationProfile: "doctor:testing:qa", authenticate: async () => ({ ok: false, profile: "doctor:testing:qa", email: value, role: value, message: value, roleSource: "declared", expiresAt: new Date().toISOString() }) });
    expect(report).toMatchObject({ ok: false, exitCode: 3 });
    expect(report.checks.find(c => c.id === "authentication")?.code).toBe("authentication.identity_failed");
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(value);
  });

  it("retains warning signals without forwarding broker warning text or a configured role", async () => {
    const value = randomBytes(24).toString("base64url");
    const report = await collectDoctor({ ...options(), authenticationProfile: "doctor:testing:qa", authenticate: async () => ({ ok: true, profile: "doctor:testing:qa", role: value, roleSource: "declared", expiresAt: new Date().toISOString(), warnings: [value] }) });
    expect(report).toMatchObject({ ok: true, exitCode: 0 });
    expect(report.checks.find(c => c.id === "authentication.role")?.code).toBe("authentication.role_declared");
    expect(report.checks.find(c => c.id === "authentication.warnings")).toMatchObject({ code: "authentication.broker_warnings", status: "warn", details: { count: 1 } });
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(value);
  });

  it("retains other setup failures when explicit authentication succeeds", async () => {
    const report = await collectDoctor({ ...options(), nodeVersion: "20.0.0", authenticationProfile: "doctor:testing:qa", authenticate: async () => ({ ok: true, profile: "doctor:testing:qa", role: "QA", roleSource: "app", expiresAt: new Date().toISOString() }) });
    expect(report).toMatchObject({ ok: false, exitCode: 1 });
    expect(report.checks.find(c => c.id === "authentication")?.code).toBe("authentication.verified");
  });

  it.each([2, 3, 4, 6, 1])("preserves authentication exit %i without forwarding exception text", async (exit) => {
    const value = randomBytes(24).toString("base64url");
    const error = exit === 2 ? new PolicyError(value, "production-refused") : exit === 3 ? new SignInError(value) : exit === 4 ? new MissingSecretError(value) : exit === 6 ? new OriginMismatchError(value, "doctor:testing:qa", "origin-mismatch") : new Error(value);
    const report = await collectDoctor({ ...options(), authenticationProfile: "doctor:testing:qa", authenticate: async () => { throw error; } });
    expect(report.exitCode).toBe(exit);
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain(value);
  });
});
