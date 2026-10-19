/**
 * Regression test for `npmChildEnv()` in `examples/demo-app/scripts/lib.mjs`.
 *
 * Root cause: the root "demo" script is
 * `npm --prefix examples/demo-app run demo`. npm's own `--prefix <dir>` flag
 * exports npm_config_prefix, npm_config_local_prefix, and
 * npm_config_global_prefix into the script's environment, all three set to
 * <dir> (verified for npm 10.9.7; reported by a maintainer for npm 11.4.2 on
 * Windows). `runNpm()` used to pass `process.env` straight through to every
 * nested `npm install` it spawns -- including the one at the repo root,
 * whose cwd does not match the inherited prefix. On Windows a mismatched
 * --prefix/local_prefix makes npm add the project as a self-referential
 * "file:" dependency of itself (npm/cli#6960), corrupting
 * examples/demo-app/package.json and its lockfile on first run.
 *
 * There is no dedicated test runner for `examples/demo-app`, so this lives
 * here as a root vitest test (it needs nothing from the demo app's own
 * dependencies, which may not even be installed) -- same rationale as
 * `tests/demo-workflow-proof-symlinked-entry.test.ts`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const libModule = path.join(repo, "examples", "demo-app", "scripts", "lib.mjs");
const { npmChildEnv } = (await import(pathToFileURL(libModule).href)) as {
  npmChildEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

describe("npmChildEnv", () => {
  it("removes npm's --prefix-derived keys regardless of case", () => {
    const env = {
      PATH: "/usr/bin",
      npm_config_prefix: "/tmp/demo-app",
      NPM_CONFIG_LOCAL_PREFIX: "/tmp/demo-app",
      Npm_Config_Global_Prefix: "/tmp/demo-app",
    };
    const result = npmChildEnv(env);
    expect(result).not.toHaveProperty("npm_config_prefix");
    expect(result).not.toHaveProperty("NPM_CONFIG_LOCAL_PREFIX");
    expect(result).not.toHaveProperty("Npm_Config_Global_Prefix");
    expect(Object.keys(result).some((key) => /^npm_config_(local_|global_)?prefix$/i.test(key))).toBe(false);
  });

  it("leaves unrelated keys, including other npm_config_* keys, intact", () => {
    const env = {
      PATH: "/usr/bin",
      TESTLANE_HOME: "/tmp/home",
      TESTLANE_REQUESTER: "demo-setup",
      npm_config_prefix: "/tmp/demo-app",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_https_proxy: "http://127.0.0.1:38465",
      npm_config_user_agent: "npm/10.9.7 node/v22.22.2 linux x64 workspaces/false",
    };
    const result = npmChildEnv(env);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.TESTLANE_HOME).toBe("/tmp/home");
    expect(result.TESTLANE_REQUESTER).toBe("demo-setup");
    expect(result.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(result.npm_config_https_proxy).toBe("http://127.0.0.1:38465");
    expect(result.npm_config_user_agent).toBe("npm/10.9.7 node/v22.22.2 linux x64 workspaces/false");
  });

  it("does not mutate its input", () => {
    const env = { npm_config_prefix: "/tmp/demo-app", PATH: "/usr/bin" };
    const snapshot = { ...env };
    const result = npmChildEnv(env);
    expect(env).toEqual(snapshot);
    expect(result).not.toBe(env);
  });

  it("handles an env with none of the prefix keys set", () => {
    const env = { PATH: "/usr/bin", TESTLANE_HOME: "/tmp/home" };
    const result = npmChildEnv(env);
    expect(result).toEqual(env);
    expect(result).not.toBe(env);
  });
});
