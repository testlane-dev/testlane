/**
 * Regression test for a clean-room CI false-pass: the entry guard used to be
 *
 *   if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
 *
 * `path.resolve()` never resolves symlinks, but Node's default module
 * resolution *does* realpath the file it loads, so import.meta.url comes
 * back as the target's real path. Any time `run.mjs` is invoked through a
 * symlinked directory -- which is exactly what happens on macOS CI runners,
 * where the OS tmpdir itself is a symlink (/var -> /private/var) -- the two
 * sides of that comparison never match, `main()` silently never runs, and
 * the process exits 0 with no output at all: a clean-room CI job that ran
 * nothing would still look green.
 *
 * This reproduces the mismatch directly (no macOS-specific tmpdir quirk
 * needed): create our own directory symlink to this template, invoke
 * `run.mjs` through the symlink with a bad flag, and assert the process
 * behaves as it does when invoked normally -- non-zero exit and a non-empty
 * usage message on stderr. Pre-fix, this assertion fails (exit 0, empty
 * stdout/stderr); see the task record for the failing run captured before
 * the guard was fixed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_TIMEOUT_MS = 10_000;

function runChild(runPath, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runPath, '--this-flag-does-not-exist'], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: HARD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('run.mjs still runs main() when invoked through a symlinked directory', async () => {
  const tmpBase = await realpath(os.tmpdir());
  const scratchDir = await mkdtemp(path.join(tmpBase, 'tl-smoke-symlink-'));
  try {
    const resolvedScratchDir = await realpath(scratchDir);
    const relativeToTmp = path.relative(tmpBase, resolvedScratchDir);
    assert.ok(
      relativeToTmp.length > 0 && !relativeToTmp.startsWith('..') && !path.isAbsolute(relativeToTmp),
      `refusing to use unexpected temp path: ${resolvedScratchDir}`,
    );

    const linkDir = path.join(scratchDir, 'entry-link');
    try {
      await symlink(templateDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (process.platform === 'win32' && err?.code === 'EPERM') {
        // Directory symlinks (as opposed to junctions) can require elevated
        // privileges on Windows; 'junction' above already avoids that, so
        // this only trips if junction creation itself is blocked. Skip
        // rather than fail the suite over a host permission we don't
        // control.
        return;
      }
      throw err;
    }

    // Sanity check: the whole point of this test is that the symlinked path
    // really does differ from the realpath the module loader will resolve.
    const realTemplateDir = await realpath(templateDir);
    const realLinkDir = await realpath(linkDir);
    assert.equal(realLinkDir, realTemplateDir);
    assert.notEqual(linkDir, realTemplateDir);

    const runPath = path.join(linkDir, 'run.mjs');
    const homeDir = path.join(scratchDir, 'home');
    const env = {
      ...process.env,
      TESTLANE_HOME: homeDir,
      AGENT_AUTH_HOME: homeDir,
    };

    const result = await runChild(runPath, scratchDir, env);

    assert.equal(result.signal, null, `child was killed by the hard timeout: stdout=${result.stdout} stderr=${result.stderr}`);
    // Pre-fix, the broken guard makes main() never run at all: the process
    // exits 0 with completely empty stdout and stderr. Assert both the exit
    // code AND that output was produced, so a false "it exited non-zero for
    // some unrelated reason" can't slip through.
    assert.equal(result.code, 1, `expected exit 1 (usage error); got ${result.code}. stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(result.stderr.length > 0, 'expected non-empty stderr from main() actually running');
    assert.ok(result.stderr.includes('usage:'), `expected a usage message on stderr, got: ${result.stderr}`);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});
