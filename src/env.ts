/**
 * Environment variables read by Testlane, with the pre-rename fallback.
 *
 * Every variable has a current name (`TESTLANE_*`) and the name it had before
 * the project was renamed (`AGENT_AUTH_*`). The current name wins; the legacy
 * name is read only when the current one is unset or blank, so existing
 * setups (shell profiles, MCP client `env` blocks, scheduled tasks) keep
 * working unchanged. This is the only place that maps the two.
 */

/** Current name -> legacy name. */
export const ENV_VARS = {
  TESTLANE_HOME: "AGENT_AUTH_HOME",
  TESTLANE_PROFILES: "AGENT_AUTH_PROFILES",
  TESTLANE_REQUESTER: "AGENT_AUTH_REQUESTER",
  TESTLANE_STORE: "AGENT_AUTH_STORE",
  TESTLANE_REAL_KEYCHAIN: "AGENT_AUTH_REAL_KEYCHAIN",
} as const;

export type EnvVarName = keyof typeof ENV_VARS;
export type LegacyEnvVarName = (typeof ENV_VARS)[EnvVarName];

export interface EnvLookup {
  /** The value as set (not trimmed). */
  value: string;
  /** Which variable supplied it: the current name or its legacy fallback. */
  source: EnvVarName | LegacyEnvVarName;
}

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Read `name`, falling back to its legacy `AGENT_AUTH_*` name. A blank value
 * counts as unset. Returns undefined when neither is set.
 */
export function lookupEnv(name: EnvVarName, env: NodeJS.ProcessEnv = process.env): EnvLookup | undefined {
  const current = env[name];
  if (isSet(current)) return { value: current, source: name };
  const legacyName = ENV_VARS[name];
  const legacy = env[legacyName];
  if (isSet(legacy)) return { value: legacy, source: legacyName };
  return undefined;
}

/** The value of `name` (or its legacy fallback), or undefined. See lookupEnv. */
export function readEnv(name: EnvVarName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return lookupEnv(name, env)?.value;
}
