/**
 * Regression test for a clean-room release blocker: `run.mjs` used to import
 * `./runtime.mjs` as an ordinary top-level import, and `runtime.mjs` itself
 * statically imports `../authenticated-smoke/runtime.mjs`. Copying only
 * `examples/workflows/feature-acceptance/` (without its `authenticated-smoke`
 * sibling) made Node fail to resolve that module graph before any of this
 * file's own code -- or any try/catch in it -- ever ran, crashing with a raw
 * `ERR_MODULE_NOT_FOUND` and a full stack trace instead of a friendly error.
 *
 * This reproduces that exact scenario end to end: copy *only*
 * `feature-acceptance/` (no `authenticated-smoke` next to it) to a temp
 * directory, run the real `run.mjs` CLI as a child process, and assert it
 * exits 1 promptly with the fixed message and no stack trace text.
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
    const child = spawn(process.execPath, [runPath, '--json'], {
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

test('run.mjs fails fast with a friendly message (no stack trace) when copied without its authenticated-smoke sibling', async () => {
  const tmpBase = await realpath(os.tmpdir());
  const copyDir = await mkdtemp(path.join(tmpBase, 'tl-feature-'));
  try {
    // Refuse to clean up anything that is not really our own mkdtemp
    // directory before doing anything destructive with it below.
    const resolvedCopyDir = await realpath(copyDir);
    const relativeToTmp = path.relative(tmpBase, resolvedCopyDir);
    assert.ok(
      relativeToTmp.length > 0 && !relativeToTmp.startsWith('..') && !path.isAbsolute(relativeToTmp),
      `refusing to use unexpected temp path: ${resolvedCopyDir}`,
    );

    // Copy ONLY feature-acceptance/ -- deliberately no authenticated-smoke/
    // sibling next to it -- minus node_modules/tests.
    await cp(templateDir, copyDir, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== 'tests';
      },
    });

    // Sanity check: the whole point of this test is that the sibling really
    // is not there to resolve.
    const siblingRuntime = path.resolve(copyDir, '../authenticated-smoke/runtime.mjs');
    await assert.rejects(() => realpath(siblingRuntime));

    const runPath = path.join(copyDir, 'run.mjs');
    const startedAt = Date.now();
    const result = await runChild(runPath, copyDir);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.signal, null, `child was killed by the hard timeout: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      'feature acceptance failed before execution: examples/workflows/authenticated-smoke must be installed next to this template; see README\n',
    );
    assert.ok(!result.stderr.includes('ERR_MODULE_NOT_FOUND'), `stderr leaked the raw error: ${result.stderr}`);
    assert.ok(!/\bat .+\(.*:\d+:\d+\)/.test(result.stderr), `stderr contains a stack frame: ${result.stderr}`);
    assert.ok(elapsedMs < HARD_TIMEOUT_MS / 2, `expected a fast failure well under ${HARD_TIMEOUT_MS}ms, took ${elapsedMs}ms`);
  } finally {
    await rm(copyDir, { recursive: true, force: true });
  }
});
