/** Setup diagnostics. Passive by default; authentication requires an explicit profile. */
import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { CheckOutcome } from "./commands.js";
import { ENV_VARS, lookupEnv } from "./env.js";
import { auditLogPath } from "./paths.js";
import { loadProfiles } from "./profiles.js";
import { isStoreKind, whichSync } from "./store/select.js";
import { MissingSecretError } from "./commands.js";
import { PolicyError, SignInError, type ProfileRegistry } from "./types.js";
import { OriginMismatchError } from "./vault.js";
import { VERSION } from "./version.js";

export interface DiagnosticCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  code: string;
  summary: string;
  remedy?: string;
  details?: Record<string, unknown>;
}
export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  version: string;
  runtime: { node: string; platform: string };
  ok: boolean;
  exitCode: number;
  checks: DiagnosticCheck[];
}
export interface DoctorOptions {
  cwd?: string;
  profilesFile?: string;
  registry?: ProfileRegistry;
  authenticationProfile?: string;
  authenticate?: (profile: string) => Promise<CheckOutcome>;
  /** Metadata-only test hooks; no secret store is needed for a passive diagnostic. */
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  executable?: (command: string) => Promise<boolean>;
}

async function executable(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!path.isAbsolute(command)) return whichSync(command, env["PATH"] ?? env["Path"] ?? "") !== null;
  try { await access(command, constants.X_OK); return (await stat(command)).isFile(); } catch { return false; }
}

async function auditAccess(file: string): Promise<DiagnosticCheck> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error();
    await access(file, constants.W_OK);
    return { id: "audit", status: "pass", code: "audit.accessible", summary: "The existing audit file is writable; no append was attempted.", details: { path: file } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { id: "audit", status: "fail", code: "audit.not_writable", summary: "The audit path is not an accessible writable regular file.", remedy: "Review the broker's audit permissions or approve the broker command normally; do not make the whole vault writable.", details: { path: file } };
    }
  }
  let ancestor = path.dirname(file);
  for (;;) {
    try {
      const info = await stat(ancestor);
      if (!info.isDirectory()) throw new Error();
      await access(ancestor, constants.W_OK | constants.X_OK);
      return { id: "audit", status: "pass", code: "audit.accessible", summary: "Audit path prerequisites are accessible; no file was created or appended.", details: { path: file, checkedDirectory: ancestor } };
    } catch (error) {
      const parent = path.dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) {
        return { id: "audit", status: "fail", code: "audit.directory_not_writable", summary: "The audit directory cannot be created or written through its existing parent.", remedy: "Use a private writable broker home and normal client approvals; see docs/platforms.md.", details: { path: file } };
      }
      ancestor = parent;
    }
  }
}

async function storePrerequisites(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, probe: (command: string) => Promise<boolean>): Promise<DiagnosticCheck[]> {
  const selected = lookupEnv("TESTLANE_STORE", env);
  const explicit = selected?.value.trim();
  if (explicit && !isStoreKind(explicit)) return [{ id: "store", status: "fail", code: "store.invalid_kind", summary: "The selected store kind is not supported.", remedy: "Choose dpapi, keychain-macos, secret-service or encrypted-file in human-controlled configuration." }];
  const kind = explicit || (platform === "win32" ? "dpapi" : platform === "darwin" ? "keychain-macos" : "secret-service");
  const native = kind === "encrypted-file" ? (platform === "win32" ? "dpapi" : platform === "darwin" ? "keychain-macos" : "secret-service") : kind;
  const base = { id: "store", details: { kind, source: selected?.source ?? "platform default" } };
  if ((native === "dpapi" && platform !== "win32") || (native === "keychain-macos" && platform !== "darwin") || (kind === "secret-service" && platform !== "linux")) {
    return [{ ...base, status: "fail", code: "store.platform_mismatch", summary: "The configured store does not support this operating system.", remedy: "Use the platform default or a supported encrypted-file setup; see docs/platforms.md." }];
  }
  const root = env["SystemRoot"] ?? env["windir"];
  const command = native === "dpapi" ? (root && root.trim() !== "" ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe") : native === "keychain-macos" ? "/usr/bin/security" : "secret-tool";
  const available = await probe(command);
  if (available && native === "secret-service" && platform !== "linux") {
    return [{ ...base, status: "fail", code: "store.platform_mismatch", summary: "The selected platform keyring does not support this operating system.", remedy: "Use a supported operating system or an explicit encrypted-file passphrase setup without Secret Service; see docs/platforms.md." }];
  }
  if (!available) {
    if (kind === "encrypted-file" && native === "secret-service") {
      return [{ ...base, status: "warn", code: "store.interactive_passphrase", summary: "Encrypted-file storage requires an interactive passphrase here; unattended access is not verified.", remedy: "For agents, configure an unlocked Secret Service keyring; never put a passphrase in argv or environment variables." }];
    }
    return [{ ...base, status: "fail", code: "store.prerequisite_missing", summary: "A required platform store executable is unavailable.", remedy: native === "secret-service" ? "Install secret-tool and an unlocked Secret Service keyring; headless/WSL/container setup is in docs/platforms.md." : "Restore the platform's PowerShell/security executable and retry; see docs/platforms.md." }];
  }
  const checks: DiagnosticCheck[] = [{ ...base, status: "pass", code: "store.prerequisites_available", summary: "Store executable is available. No stored value was read; keychain unlock and decryption are unverified." }];
  if (native === "secret-service" && !env["DBUS_SESSION_BUS_ADDRESS"]?.trim()) {
    checks.push({ id: "store.bus", status: "warn", code: "store.bus_not_declared", summary: "No D-Bus session bus is declared; desktop auto-discovery may still work.", remedy: "For headless/WSL/containers, start the agent in an unlocked private D-Bus/keyring session; see docs/platforms.md." });
  }
  return checks;
}

export async function collectDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const node = options.nodeVersion ?? process.versions.node;
  const checks: DiagnosticCheck[] = [];
  const major = Number(node.split(".")[0]);
  checks.push(major >= 22 ? { id: "runtime", status: "pass", code: "runtime.supported", summary: "Node runtime meets the package's Node 22+ requirement." } : { id: "runtime", status: "fail", code: "runtime.unsupported", summary: "This Node runtime is below the supported minimum.", remedy: "Install Node 22 or newer, then reinstall Testlane using that runtime." });
  const conflicts = Object.entries(ENV_VARS).filter(([current, legacy]) => env[current]?.trim() && env[legacy]?.trim() && env[current] !== env[legacy]).map(([current, legacy]) => ({ current, legacy }));
  checks.push(conflicts.length ? { id: "configuration", status: "warn", code: "configuration.legacy_conflict", summary: "Current and legacy environment variables disagree; current names win.", remedy: "Review and consolidate the human-controlled TESTLANE_* configuration; values are intentionally omitted.", details: { conflicts } } : { id: "configuration", status: "pass", code: "configuration.consistent", summary: "No conflicting current/legacy environment values were found." });
  let registry: ProfileRegistry | undefined;
  const explicit = options.profilesFile ?? lookupEnv("TESTLANE_PROFILES", env)?.value;
  try {
    registry = options.profilesFile !== undefined ? await loadProfiles({ cwd, repoFile: options.profilesFile }) : options.registry ?? await loadProfiles({ cwd });
    const count = Object.keys(registry.profiles).length;
    checks.push(count ? { id: "registry", status: "pass", code: "registry.valid", summary: "The selected registry validates.", details: { sources: registry.sources, profileCount: count, selection: options.profilesFile !== undefined ? "--profiles" : lookupEnv("TESTLANE_PROFILES", env)?.source ?? "discovery", cwd } } : { id: "registry", status: "fail", code: "registry.empty", summary: "No profiles were loaded.", remedy: "Run from your app repository and create a reviewed profile using docs/quickstart.md.", details: { cwd, sources: registry.sources } });
    if (registry.unusedOverrides?.length) checks.push({ id: "registry.overrides", status: "warn", code: "registry.unused_overrides", summary: "Some account overrides match no loaded profile.", remedy: "Have the human review account overrides for the selected registry.", details: { count: registry.unusedOverrides.length } });
  } catch {
    checks.push({ id: "registry", status: "fail", code: "registry.invalid", summary: "The selected registry could not be loaded or validated.", remedy: "Check the approved path, JSON/schema, duplicate profile names and production-host overlap with testlane profiles; see docs/quickstart.md.", details: { cwd, ...(explicit === undefined ? {} : { selectedPath: path.resolve(cwd, explicit) }) } });
  }
  checks.push(...await storePrerequisites(platform, env, options.executable ?? ((command) => executable(command, env))));
  checks.push(await auditAccess(auditLogPath()));
  const projectRequire = createRequire(path.join(cwd, "package.json"));
  let browserPackage: string | undefined;
  for (const name of ["playwright", "@playwright/test"]) {
    try { projectRequire.resolve(name); browserPackage = name; break; } catch { /* Optional dependency, metadata lookup only. */ }
  }
  checks.push(browserPackage ? { id: "browser", status: "pass", code: "browser.dependency_available", summary: "An app-local Playwright dependency resolves; Chromium installation and launch remain unverified.", details: { package: browserPackage } } : { id: "browser", status: "warn", code: "browser.optional_dependency_missing", summary: "No app-local Playwright dependency was found; browser workflows are optional.", remedy: "For browser checks, install the tested @playwright/test version and Chromium in the app repository; see docs/project-install.md." });
  let authenticationExit = 0;
  if (options.authenticationProfile !== undefined) {
    const profile = registry && Object.hasOwn(registry.profiles, options.authenticationProfile) ? registry.profiles[options.authenticationProfile] : undefined;
    if (!profile || !options.authenticate) {
      authenticationExit = profile ? 1 : 2;
      checks.push({ id: "authentication", status: "fail", code: "authentication.unavailable", summary: "The requested authentication check cannot run with this registry.", remedy: "Use an approved profile listed by testlane profiles; resolve registry errors first." });
    } else {
      try {
        const result = await options.authenticate(profile.name);
        authenticationExit = result.ok ? 0 : 3;
        checks.push({ id: "authentication", status: result.ok ? "pass" : "fail", code: result.ok ? "authentication.verified" : "authentication.identity_failed", summary: result.ok ? "The app verified a fresh sign-in; its proving session was discarded." : "The app did not prove the expected identity.", ...(result.ok ? {} : { remedy: "Have the human review the account and identity endpoint; do not print the response body." }), details: { profile: profile.name, roleSource: result.roleSource } });
        if (result.ok && result.roleSource === "declared") {
          checks.push({ id: "authentication.role", status: "warn", code: "authentication.role_declared", summary: "The app proved the account identity but did not report a role; the configured role remains unverified.", remedy: "Verify protected operations separately; see docs/sessions.md." });
        }
        if (result.warnings?.length) {
          checks.push({ id: "authentication.warnings", status: "warn", code: "authentication.broker_warnings", summary: "The broker returned operational warnings; their text is omitted from this report.", remedy: "Have the human review testlane check and testlane status in a normal terminal, including any unresolved rotation; see docs/rotation.md.", details: { count: result.warnings.length } });
        }
      } catch (error) {
        authenticationExit = error instanceof OriginMismatchError ? 6 : error instanceof MissingSecretError ? 4 : error instanceof PolicyError ? 2 : error instanceof SignInError ? 3 : 1;
        checks.push({ id: "authentication", status: "fail", code: "authentication.failed", summary: "Explicit sign-in was refused or failed; no credential or response value is included.", remedy: authenticationExit === 4 || authenticationExit === 6 ? "Human reviews the registry/keychain and re-seeds with testlane store set if appropriate." : authenticationExit === 2 ? "Stop on policy refusal; inspect the approved profile, origin, environment and TTL." : "Check app availability and the approved account/identity options in a normal terminal.", details: { profile: profile.name, exitCode: authenticationExit } });
      }
    }
  } else {
    checks.push({ id: "authentication", status: "warn", code: "authentication.not_requested", summary: "No authentication was attempted; store unlock, credentials and app connectivity remain unverified.", remedy: "To opt in, run testlane doctor --check <approved-profile>. This signs in and discards the session." });
  }
  const ok = checks.every((check) => check.status !== "fail");
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), version: VERSION, runtime: { node, platform }, ok, exitCode: authenticationExit || (ok ? 0 : 1), checks };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`Testlane ${report.version} diagnostics (${report.runtime.platform}, Node ${report.runtime.node})`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
    if (check.remedy) lines.push(`  Next: ${check.remedy}`);
    if (check.id === "registry" && Array.isArray(check.details?.["sources"])) for (const source of check.details["sources"]) lines.push(`  Registry: ${String(source).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")}`);
  }
  lines.push(report.ok ? "Setup prerequisites passed; review warnings and unverified checks above." : "Setup needs attention; follow the next steps above.");
  return lines.join("\n") + "\n";
}
