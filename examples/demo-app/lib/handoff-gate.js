/**
 * Environment gate for the agent handoff route: fail closed.
 *
 * The route exists only when the deployment says, positively, that it is not
 * production. "Not marked production" is NOT enough: copied to Fly, Render,
 * Kubernetes or a VM, a host-specific variable such as VERCEL_ENV is simply
 * absent, so a gate written as "on unless marked production" would be open
 * there. Every condition below must hold, otherwise the route answers 404:
 *
 *  1. AGENT_HANDOFF_ENABLED is exactly "true" (opt-in flag).
 *  2. AGENT_HANDOFF_ENV is exactly one of HANDOFF_ENV_ALLOWLIST (the positive
 *     non-production marker, set only in the sandbox scope). An unset, empty,
 *     misspelled or unknown value (including "production" and "prod") is off.
 *  3. VERCEL_ENV is not "production" (extra deny, never an allow).
 *  4. The deployment branch is not the release branch (AGENT_HANDOFF_RELEASE_BRANCH,
 *     default "main"; VERCEL_GIT_COMMIT_REF on Vercel).
 *
 * Pure function of `env` so it can be unit-tested without Next. The secret
 * check (32+ characters) lives in the route: it needs the runtime config.
 */
export const HANDOFF_ENV_ALLOWLIST = Object.freeze(["local", "sandbox", "testing", "preview"]);

/** @param {Record<string, string | undefined>} env usually process.env */
export function handoffEnabled(env) {
  if (env.AGENT_HANDOFF_ENABLED !== "true") return false;
  if (typeof env.AGENT_HANDOFF_ENV !== "string" || !HANDOFF_ENV_ALLOWLIST.includes(env.AGENT_HANDOFF_ENV)) return false;
  if (env.VERCEL_ENV === "production") return false;
  const releaseBranch = env.AGENT_HANDOFF_RELEASE_BRANCH || "main";
  if (env.VERCEL_GIT_COMMIT_REF && env.VERCEL_GIT_COMMIT_REF === releaseBranch) return false;
  return true;
}
