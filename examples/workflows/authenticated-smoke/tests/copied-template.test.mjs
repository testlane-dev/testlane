/**
 * Regression test for a clean-room release blocker: `runSelfTest()` used to
 * start the loopback app server *before* `parseWorkflow()`, outside any
 * try/finally. `parseWorkflow()` throws when the built contracts are
 * unavailable (e.g. this template copied away from its sibling
 * `../../../dist`), which skipped the server's `close()` entirely -- the
 * process never exited even after `run.mjs` had already printed
 * "workflow smoke failed before execution" and returned exit code 1.
 *
 * This reproduces that exact scenario end to end: copy the template to a
 * temp directory where `../../../dist` cannot resolve to anything, run the
 * real `run.mjs --self-test` CLI as a child process under a hard timeout,
 * and assert it exits promptly and cleanly rather than hanging.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_TIMEOUT_MS = 10_000;

function runChild(runPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runPath, '--self-test', '--json'], {
      cwd,
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

test('self-test fails fast, without leaving a listening server, when copied away from ../../../dist', async () => {
  const tmpBase = await realpath(os.tmpdir());
  const copyDir = await mkdtemp(path.join(tmpBase, 'tl-smoke-'));
  try {
    // Refuse to clean up anything that is not really our own mkdtemp
    // directory before doing anything destructive with it below.
    const resolvedCopyDir = await realpath(copyDir);
    const relativeToTmp = path.relative(tmpBase, resolvedCopyDir);
    assert.ok(
      relativeToTmp.length > 0 && !relativeToTmp.startsWith('..') && !path.isAbsolute(relativeToTmp),
      `refusing to use unexpected temp path: ${resolvedCopyDir}`,
    );

    // A plain copy of the template, minus node_modules/tests, placed under
    // the OS temp directory: three levels up from any file in here does not
    // resolve to this repo's dist/, which is the whole point.
    await cp(templateDir, copyDir, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== 'tests';
      },
    });

    const runPath = path.join(copyDir, 'run.mjs');
    const startedAt = Date.now();
    const result = await runChild(runPath, copyDir);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.signal, null, `child was killed by the hard timeout (server still listening?): stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('workflow smoke failed before execution'), `unexpected stderr: ${result.stderr}`);
    assert.ok(elapsedMs < HARD_TIMEOUT_MS / 2, `expected a fast failure well under ${HARD_TIMEOUT_MS}ms, took ${elapsedMs}ms`);
  } finally {
    await rm(copyDir, { recursive: true, force: true });
  }
});
