/**
 * Regression test for a clean-room CI false-pass in
 * `examples/demo-app/scripts/workflow-proof.mjs`, the same class of bug fixed
 * for `run.mjs` and the other proof scripts (see e.g.
 * `examples/workflows/feature-acceptance/tests/symlinked-entry.test.mjs`):
 * the entry guard used to be
 *
 *   if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
 *
 * `path.resolve()` never resolves symlinks, but Node's default module
 * resolution *does* realpath the file it loads, so import.meta.url comes
 * back as the target's real path. Any time `workflow-proof.mjs` is invoked
 * through a symlinked directory -- which is exactly what happens on macOS CI
 * runners, where the OS tmpdir itself is a symlink (/var -> /private/var) --
 * the two sides of that comparison never match, `main()` silently never
 * runs, and the process exits 0 with no output at all: a clean-room demo
 * "real broker proof" job that ran nothing would still look green.
 *
 * There is no dedicated test runner for `examples/demo-app`, so this lives
 * here as a root vitest test (it needs nothing from the demo app's own
 * dependencies, which may not even be installed).
 *
 * This reproduces the mismatch directly (no macOS-specific tmpdir quirk
 * needed): create our own directory symlink to `examples/demo-app/scripts`,
 * invoke `workflow-proof.mjs` through the symlink with a bad flag, and
 * assert the process behaves as it does when invoked normally -- non-zero
 * exit and a non-empty usage message on stderr. The bad-flag path is chosen
 * specifically because `argsOf()` rejects it and throws before any
 * prerequisite check, broker CLI, keychain, browser, or network activity, so
 * this regression test never touches a real keychain (the one side effect at
 * module load, setting DEMO_STATE_DIR/DEMO_NEXT_DIST_DIR and importing
 * `lib.mjs`, happens unconditionally regardless of the entry guard and does
 * not itself touch disk or the network). Pre-fix, this assertion fails (exit
 * 0, empty stdout/stderr).
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const scriptsDir = path.join(repoRoot, "examples", "demo-app", "scripts");
const HARD_TIMEOUT_MS = 10_000;

interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(scriptPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--this-flag-does-not-exist"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HARD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe("workflow-proof.mjs symlinked entry", () => {
  it("still runs main() when invoked through a symlinked directory", async () => {
    const tmpBase = await realpath(os.tmpdir());
    const scratchDir = await mkdtemp(path.join(tmpBase, "tl-demo-proof-symlink-"));
    try {
      const resolvedScratchDir = await realpath(scratchDir);
      const relativeToTmp = path.relative(tmpBase, resolvedScratchDir);
      expect(relativeToTmp.length > 0 && !relativeToTmp.startsWith("..") && !path.isAbsolute(relativeToTmp)).toBe(true);

      const linkDir = path.join(scratchDir, "entry-link");
      try {
        await symlink(scriptsDir, linkDir, process.platform === "win32" ? "junction" : "dir");
      } catch (err: unknown) {
        if (process.platform === "win32" && (err as NodeJS.ErrnoException)?.code === "EPERM") {
          // Directory symlinks (as opposed to junctions) can require
          // elevated privileges on Windows; 'junction' above already avoids
          // that, so this only trips if junction creation itself is
          // blocked. Skip rather than fail the suite over a host permission
          // we don't control.
          return;
        }
        throw err;
      }

      // Sanity check: the whole point of this test is that the symlinked
      // path really does differ from the realpath the module loader will
      // resolve.
      const realScriptsDir = await realpath(scriptsDir);
      const realLinkDir = await realpath(linkDir);
      expect(realLinkDir).toBe(realScriptsDir);
      expect(linkDir).not.toBe(realScriptsDir);

      const scriptPath = path.join(linkDir, "workflow-proof.mjs");
      const homeDir = path.join(scratchDir, "home");
      const env = {
        ...process.env,
        TESTLANE_HOME: homeDir,
        AGENT_AUTH_HOME: homeDir,
      };

      const result = await runChild(scriptPath, scratchDir, env);

      expect(result.signal, `child was killed by the hard timeout: stdout=${result.stdout} stderr=${result.stderr}`).toBeNull();
      // Pre-fix, the broken guard makes main() never run at all: the
      // process exits 0 with completely empty stdout and stderr. Assert
      // both the exit code AND that output was produced, so a false "it
      // exited non-zero for some unrelated reason" can't slip through.
      expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(1);
      expect(result.stderr.length, "expected non-empty stderr from main() actually running").toBeGreaterThan(0);
      expect(result.stderr).toContain("usage:");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
