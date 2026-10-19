/**
 * Regression test for `broker-double.mjs`'s forked entry guard
 * (`isForkedEntryPoint`): the same class of bug fixed for the `run.mjs`
 * templates and for the other proof scripts, but observed differently here
 * because this module is launched with `fork()` and communicates only over
 * IPC (see `broker-double.mjs`'s own header comment and
 * `tests/broker-double.test.mjs`'s `brokerCall` helper, which this test
 * mirrors).
 *
 * The old guard was
 *
 *   if (process.argv[1] && path.resolve(process.argv[1]) === BROKER_DOUBLE_PATH)
 *
 * `path.resolve()` never resolves symlinks. `BROKER_DOUBLE_PATH` is derived
 * from `import.meta.url`, which Node's module loader always resolves to the
 * file's realpath, so a fork() launched through a symlinked directory --
 * exactly what happens on macOS CI runners, where the OS tmpdir itself is a
 * symlink (/var -> /private/var) -- gets `process.argv[1]` that never
 * string-equals `BROKER_DOUBLE_PATH`. The guard then never installs the
 * `process.on('message', ...)` listener, so a `{ type: 'config' }` message
 * is silently dropped: the forked child never executes a command and never
 * calls `process.exit()`, so it just hangs on the open IPC channel instead
 * of ever closing.
 *
 * This reproduces the mismatch directly (no macOS-specific tmpdir quirk
 * needed): symlink this package's directory, fork `broker-double.mjs`
 * through the symlink, send it a real `{ type: 'config', config }` message
 * exactly as `runtime.mjs`'s `brokerCall` does, and assert it behaves like a
 * normal (non-symlinked) fork -- it answers a `profiles` command on stdout
 * and closes with exit code 0. Pre-fix, this assertion fails: the child
 * never closes within the bounded wait below, so it is killed and observed
 * with no exit code and empty stdout.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { REFERENCE_ROLES, startReferenceApp } from '../reference-app.mjs';
import { brokerDoubleConfig } from '../broker-double.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_TIMEOUT_MS = 10_000;

function brokerCallThroughPath(modulePath, args, config) {
  return new Promise((resolve, reject) => {
    const child = fork(modulePath, args, { silent: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, HARD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.send({ type: 'config', config });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('broker-double.mjs still installs its IPC listener when forked through a symlinked directory', async () => {
  const tmpBase = await realpath(os.tmpdir());
  const scratchDir = await mkdtemp(path.join(tmpBase, 'tl-support-fork-symlink-'));
  try {
    const resolvedScratchDir = await realpath(scratchDir);
    const relativeToTmp = path.relative(tmpBase, resolvedScratchDir);
    assert.ok(
      relativeToTmp.length > 0 && !relativeToTmp.startsWith('..') && !path.isAbsolute(relativeToTmp),
      `refusing to use unexpected temp path: ${resolvedScratchDir}`,
    );

    const linkDir = path.join(scratchDir, 'entry-link');
    try {
      await symlink(packageDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
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
    // really does differ from the realpath the module loader will resolve
    // for BROKER_DOUBLE_PATH.
    const realPackageDir = await realpath(packageDir);
    const realLinkDir = await realpath(linkDir);
    assert.equal(realLinkDir, realPackageDir);
    assert.notEqual(linkDir, realPackageDir);

    const modulePath = path.join(linkDir, 'broker-double.mjs');

    const writer = { email: 'writer@example.test', role: REFERENCE_ROLES.writer, password: 'writer-secret' };
    const app = await startReferenceApp({ accounts: [writer], buildId: 'b', environment: 'testing', runId: 'r', dataScope: 's' });
    try {
      const profiles = [
        { name: 'ns:local:writer', email: writer.email, role: writer.role, environment: 'testing', baseUrl: app.origin, strategy: 'form-post' },
      ];
      const config = brokerDoubleConfig({ app, profiles });

      const result = await brokerCallThroughPath(modulePath, ['--json', 'profiles'], config);

      // Pre-fix, the mismatched realpath comparison leaves the IPC listener
      // uninstalled: the child never acts on the config message and never
      // exits, so it is killed by the bounded wait and observed with no
      // close event, no exit code, and no stdout at all.
      assert.equal(
        result.timedOut,
        false,
        `child never closed after being sent a config message (pre-fix symptom): stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert.equal(result.code, 0, `expected exit 0; got ${result.code}. stdout=${result.stdout} stderr=${result.stderr}`);
      assert.ok(result.stdout.length > 0, 'expected non-empty stdout from the IPC listener actually running');
      assert.deepEqual(JSON.parse(result.stdout), { profiles });
    } finally {
      await app.close();
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});
