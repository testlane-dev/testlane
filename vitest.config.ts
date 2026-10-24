import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Per-run scratch home, computed at config time. Every test process starts
 * with TESTLANE_HOME (and the legacy AGENT_AUTH_HOME, set to the same path)
 * pointing here, so no test can ever reach the real ~/.testlane or
 * ~/.agent-auth even if it forgets its own override. Tests that need an
 * isolated home still set process.env.TESTLANE_HOME themselves.
 *
 * The other TESTLANE_* / AGENT_AUTH_* variables are blanked (a blank value
 * counts as unset, see src/env.ts) so a developer's shell cannot leak a
 * registry, requester or store choice into a test run.
 */
const testHome = path.join(os.tmpdir(), `testlane-vitest-${process.pid}`);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Windows fixtures run real PowerShell ACL checks. Serialize files so
    // parallel test processes do not exhaust their unchanged 15-second bounds.
    fileParallelism: process.platform !== "win32",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      TESTLANE_HOME: testHome,
      AGENT_AUTH_HOME: testHome,
      TESTLANE_PROFILES: "",
      AGENT_AUTH_PROFILES: "",
      TESTLANE_REQUESTER: "",
      AGENT_AUTH_REQUESTER: "",
      TESTLANE_STORE: "",
      AGENT_AUTH_STORE: "",
    },
  },
});
