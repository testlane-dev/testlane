/**
 * The demo's handoff route is copied into other apps, so its environment gate
 * must fail closed: enabled only when AGENT_HANDOFF_ENABLED is "true" AND
 * AGENT_HANDOFF_ENV is an allowlisted non-production marker. A host that sets
 * neither VERCEL_ENV nor anything else (Fly, Render, Kubernetes, a VM) must
 * therefore get a 404, not an open route.
 *
 * Imports the pure gate (examples/demo-app/lib/handoff-gate.js) directly, like
 * the other demo tests: it needs none of the demo app's own dependencies.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const gateModule = path.join(repo, "examples", "demo-app", "lib", "handoff-gate.js");
const { handoffEnabled, HANDOFF_ENV_ALLOWLIST } = (await import(pathToFileURL(gateModule).href)) as {
  handoffEnabled: (env: Record<string, string | undefined>) => boolean;
  HANDOFF_ENV_ALLOWLIST: readonly string[];
};

const on = { AGENT_HANDOFF_ENABLED: "true", AGENT_HANDOFF_ENV: "local" };

describe("handoffEnabled (fail-closed gate)", () => {
  it("is off for an empty environment (a bare Fly/Render/Kubernetes/VM deployment)", () => {
    expect(handoffEnabled({})).toBe(false);
  });

  it("is off when AGENT_HANDOFF_ENABLED is missing, even with a valid marker", () => {
    expect(handoffEnabled({ AGENT_HANDOFF_ENV: "local" })).toBe(false);
  });

  it.each(["", "TRUE", "True", "1", "yes", "false", " true", "true "])(
    "is off when AGENT_HANDOFF_ENABLED is %j (only the exact string true enables)",
    (flag) => {
      expect(handoffEnabled({ ...on, AGENT_HANDOFF_ENABLED: flag })).toBe(false);
    },
  );

  it("is off when the non-production marker is missing (flag alone is not enough)", () => {
    expect(handoffEnabled({ AGENT_HANDOFF_ENABLED: "true" })).toBe(false);
  });

  it.each(["production", "prod", "", "staging", "dev", "Local", "LOCAL", " local", "local ", "sandbox,production", "constructor", "__proto__"])(
    "is off when AGENT_HANDOFF_ENV is %j (not in the allowlist)",
    (marker) => {
      expect(handoffEnabled({ AGENT_HANDOFF_ENABLED: "true", AGENT_HANDOFF_ENV: marker })).toBe(false);
    },
  );

  it("is off when VERCEL_ENV is production, even with the flag and a valid marker", () => {
    for (const marker of HANDOFF_ENV_ALLOWLIST) {
      expect(handoffEnabled({ ...on, AGENT_HANDOFF_ENV: marker, VERCEL_ENV: "production" })).toBe(false);
    }
  });

  it("allowlists exactly local, sandbox, testing and preview", () => {
    expect([...HANDOFF_ENV_ALLOWLIST]).toEqual(["local", "sandbox", "testing", "preview"]);
  });

  it.each(["local", "sandbox", "testing", "preview"])("is on for AGENT_HANDOFF_ENV=%s with the flag", (marker) => {
    expect(handoffEnabled({ AGENT_HANDOFF_ENABLED: "true", AGENT_HANDOFF_ENV: marker })).toBe(true);
  });

  it("stays on for other non-production VERCEL_ENV values", () => {
    expect(handoffEnabled({ ...on, VERCEL_ENV: "preview" })).toBe(true);
    expect(handoffEnabled({ ...on, VERCEL_ENV: "development" })).toBe(true);
  });

  it("does not let VERCEL_ENV stand in for the marker", () => {
    expect(handoffEnabled({ AGENT_HANDOFF_ENABLED: "true", VERCEL_ENV: "preview" })).toBe(false);
    expect(handoffEnabled({ AGENT_HANDOFF_ENABLED: "true", VERCEL_ENV: "development" })).toBe(false);
  });

  it("is off on the release branch (default main, or AGENT_HANDOFF_RELEASE_BRANCH)", () => {
    expect(handoffEnabled({ ...on, VERCEL_GIT_COMMIT_REF: "main" })).toBe(false);
    expect(handoffEnabled({ ...on, VERCEL_GIT_COMMIT_REF: "release", AGENT_HANDOFF_RELEASE_BRANCH: "release" })).toBe(false);
    expect(handoffEnabled({ ...on, VERCEL_GIT_COMMIT_REF: "feature/x" })).toBe(true);
    expect(handoffEnabled({ ...on, VERCEL_GIT_COMMIT_REF: "main", AGENT_HANDOFF_RELEASE_BRANCH: "release" })).toBe(true);
  });
});
