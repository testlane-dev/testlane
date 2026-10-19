import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnv } from "./env.js";

/** Default state directory name under the user's home. */
export const HOME_DIR_NAME = ".testlane";
/** State directory name used before the rename; still used when it is the only one present. */
export const LEGACY_HOME_DIR_NAME = ".agent-auth";

/** User-level registry file name inside the state directory (and the repo-level discovery name). */
export const PROFILES_FILE_NAME = "testlane.profiles.json";
/** Registry file name used before the rename; still discovered and read. */
export const LEGACY_PROFILES_FILE_NAME = "agent-auth.profiles.json";
/** Account overrides file name inside the state directory. */
export const OVERRIDES_FILE_NAME = "testlane.overrides.json";
/** Overrides file name used before the rename; still read (and written) when it is the only one present. */
export const LEGACY_OVERRIDES_FILE_NAME = "agent-auth.overrides.json";

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Root directory for user-level state (audit log, stores, locks, HTTP token,
 * user-level profiles and account overrides).
 *
 * 1. `TESTLANE_HOME`, else the legacy `AGENT_AUTH_HOME` (tests set one of them
 *    so they never touch a real home);
 * 2. `~/.testlane` when it exists;
 * 3. else `~/.agent-auth` when it exists (an installation from before the
 *    rename keeps its audit log, store files and overrides; nothing is moved
 *    or deleted);
 * 4. else `~/.testlane` (created on first write).
 */
export function testlaneHome(): string {
  const override = readEnv("TESTLANE_HOME");
  if (override !== undefined) return path.resolve(override);
  const home = os.homedir();
  const current = path.join(home, HOME_DIR_NAME);
  if (isDirectory(current)) return current;
  const legacy = path.join(home, LEGACY_HOME_DIR_NAME);
  if (isDirectory(legacy)) return legacy;
  return current;
}

/** @deprecated Use testlaneHome(). Kept for library consumers from before the rename. */
export const agentAuthHome = testlaneHome;

/**
 * `<dir>/<name>` unless only `<dir>/<legacyName>` exists, in which case the
 * legacy file (so an existing file keeps being read and updated in place).
 */
function preferCurrent(dir: string, name: string, legacyName: string): string {
  const current = path.join(dir, name);
  if (existsSync(current)) return current;
  const legacy = path.join(dir, legacyName);
  if (existsSync(legacy)) return legacy;
  return current;
}

export function auditLogPath(): string {
  return path.join(testlaneHome(), "audit.ndjson");
}

/** `<home>/testlane.profiles.json`, or the legacy `agent-auth.profiles.json` when only that exists. */
export function userProfilesPath(): string {
  return preferCurrent(testlaneHome(), PROFILES_FILE_NAME, LEGACY_PROFILES_FILE_NAME);
}

/**
 * User-level account overrides (`testlane account set`): may change only
 * `account.email` / `account.identifier` of an existing non-production profile.
 * `<home>/testlane.overrides.json`, or the legacy `agent-auth.overrides.json`
 * when only that exists.
 */
export function accountOverridesPath(): string {
  return preferCurrent(testlaneHome(), OVERRIDES_FILE_NAME, LEGACY_OVERRIDES_FILE_NAME);
}

export function storeDir(): string {
  return path.join(testlaneHome(), "store");
}
