/**
 * Best-effort identification of who is asking the broker for something.
 *
 * The result is recorded in the audit log only. It is NOT an authentication
 * mechanism: every input here is caller-controlled.
 *
 * Only the environment variables named below are read (TESTLANE_REQUESTER,
 * else its pre-rename name AGENT_AUTH_REQUESTER, see src/env.ts); nothing else from the
 * environment is ever inspected (so no secret-bearing variable can leak into
 * the audit log through this path).
 *
 * Every candidate is sanitised: trimmed, reduced to [A-Za-z0-9:._-] and capped
 * at REQUESTER_MAX_LENGTH characters. A candidate that is empty after
 * sanitising counts as unset; when nothing is left the result is "cli".
 */
import { readEnv } from "./env.js";

export const REQUESTER_MAX_LENGTH = 64;

export function detectRequester(explicit?: string): string {
  const fromArg = sanitizeRequester(explicit);
  if (fromArg !== undefined) return fromArg;

  const fromEnv = sanitizeRequester(readEnv("TESTLANE_REQUESTER"));
  if (fromEnv !== undefined) return fromEnv;

  // Claude Code sets CLAUDECODE=1 in the shells it spawns.
  if (isSet(process.env["CLAUDECODE"])) return "claude-code";

  if (isSet(process.env["CODEX_SANDBOX"]) || isSet(process.env["CODEX_CI"])) {
    return "codex";
  }

  return "cli";
}

/** Sanitised requester, or undefined when nothing usable is left. */
export function sanitizeRequester(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().replace(/[^A-Za-z0-9:._-]/g, "").slice(0, REQUESTER_MAX_LENGTH);
  return clean === "" ? undefined : clean;
}

/** Blank or whitespace-only values count as "not set". */
function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Default requester for a long-running surface (`testlane mcp`, `testlane serve`):
 * an explicit `--requester` wins, then TESTLANE_REQUESTER (or the legacy
 * AGENT_AUTH_REQUESTER; e.g. set in the MCP
 * client's server `env`), then the surface name. detectRequester() sanitises
 * the result again when deps are built.
 */
export function surfaceRequester(explicit: string | undefined, surface: "mcp" | "http"): string {
  return explicit ?? sanitizeRequester(readEnv("TESTLANE_REQUESTER")) ?? surface;
}
