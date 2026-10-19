#!/usr/bin/env node
/** Build from a clean output directory so removed modules cannot enter a package. */
import { lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const output = path.resolve(root, "dist");
if (path.relative(root, output) !== "dist") throw new Error("Build output must be the project's dist directory");
try {
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(root, realpathSync(output)) !== "dist") {
    throw new Error("Refusing to remove a build output that is not the project's own dist directory");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
rmSync(output, { recursive: true, force: true });
const require = createRequire(import.meta.url);
const compiler = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
