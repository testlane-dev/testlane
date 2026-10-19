import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createDeadline, SmokeError } from '../runtime.mjs';

const RUNTIME_URL = new URL('../runtime.mjs', import.meta.url).href;
const CHILD_HARD_TIMEOUT_MS = 10_000;

/**
 * Runs `scriptSource` (an ESM module body) in a fresh child process and
 * collects its exit code/stdout/stderr. Used below to reproduce the
 * unhandled-rejection regression: node:test's own in-process
 * unhandledRejection handling makes an in-process assertion unreliable (it
 * can abort the whole worker rather than fail just the one assertion), so
 * the only trustworthy signal is a real child process's exit code plus
 * whether Node printed an unhandled-rejection trace to stderr.
 */
function runChildScript(scriptSource) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', scriptSource], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_HARD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * Regression coverage for a deadline's internal timeout rejection escaping
 * unhandled when `race()` is never the (only) consumer: `createDeadline()`'s
 * `timeoutPromise` only gets a `.catch` by way of `race()`'s own
 * `Promise.race([...]).catch(...)`. A caller that only ever uses
 * `cleanupRace()` (feature-acceptance's cleanup path, when the run fails
 * before record creation so `cleanupRecordState` -- the only `race()` caller
 * on the cleanup deadline -- never runs) or that uses neither method at all
 * left that rejection with no handler once the timer fired, crashing the
 * whole Node process with an unhandled rejection instead of the run/report
 * finishing normally. Fixed by attaching a no-op `.catch` at creation time.
 */
test('a deadline timing out with only cleanupRace() used produces no unhandled rejection', async () => {
  const script = `
    import { createDeadline } from '${RUNTIME_URL}';
    const deadline = createDeadline(80); // short: expires almost immediately
    // Mirrors feature-acceptance's cleanup path when the run fails before
    // record creation: cleanupRace() is used (a fast op here; a hung
    // browser.close() is covered by the runner.test.mjs regression test),
    // but the deadline's own race() is never called by anything.
    await deadline.cleanupRace(Promise.resolve('closed'));
    // Give the deadline's own internal timer (80ms) time to actually fire,
    // unobserved by anything but the no-op .catch, before the process exits.
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.exit(0);
  `;
  const { code, signal, stdout, stderr } = await runChildScript(script);
  assert.equal(signal, null, `child was killed by a signal; stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `expected a clean exit; stdout=${stdout} stderr=${stderr}`);
  assert.doesNotMatch(stderr, /unhandled/i, `expected no unhandled-rejection trace; stderr=${stderr}`);
  assert.doesNotMatch(stderr, /TIMEOUT/, `expected no leaked TIMEOUT rejection trace; stderr=${stderr}`);
});

test('a deadline timing out with no method ever used produces no unhandled rejection', async () => {
  const script = `
    import { createDeadline } from '${RUNTIME_URL}';
    createDeadline(80); // short: expires almost immediately; race()/cleanupRace() never called
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.exit(0);
  `;
  const { code, signal, stdout, stderr } = await runChildScript(script);
  assert.equal(signal, null, `child was killed by a signal; stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `expected a clean exit; stdout=${stdout} stderr=${stderr}`);
  assert.doesNotMatch(stderr, /unhandled/i, `expected no unhandled-rejection trace; stderr=${stderr}`);
  assert.doesNotMatch(stderr, /TIMEOUT/, `expected no leaked TIMEOUT rejection trace; stderr=${stderr}`);
});

/**
 * Unit coverage for `createDeadline().cleanupRace`: its per-operation ceiling
 * must track what is actually left on the deadline (floored at
 * CLEANUP_OP_FLOOR_MS = 2000ms), not a flat 2000ms regardless of the caller's
 * own configured budget. Timings are short and generously tolerant so the
 * assertions stay deterministic under CI/CPU load.
 */

test('cleanupRace lets a cleanup op finish when the deadline still has slack beyond the old flat 2000ms cap', async () => {
  const deadline = createDeadline(6000); // plenty of remaining() budget for cleanup
  try {
    const started = Date.now();
    // Resolves after ~3000ms: under the old flat-2000ms cleanupRace this
    // would have been cut off with CLEANUP_FAILED even though the run's own
    // deadline had 6000ms to give.
    const slowCleanup = sleep(3000).then(() => 'closed');
    const outcome = await deadline.cleanupRace(slowCleanup);
    const elapsed = Date.now() - started;
    assert.equal(outcome, 'closed');
    assert.ok(elapsed < 5500, `expected the cleanup op to settle well before the old 2000ms cap plus margin, took ${elapsed}ms`);
  } finally {
    deadline.dispose();
  }
});

test('cleanupRace still rejects CLEANUP_FAILED, bounded by CLEANUP_OP_FLOOR_MS, once the run deadline has already expired', async () => {
  const deadline = createDeadline(1); // expires almost immediately
  // Dispose the run's own timer right away (unrelated to cleanupRace's own
  // per-op timer) so its TIMEOUT rejection never fires unobserved once we
  // sleep past `end` below -- cleanupRace itself only reads elapsed wall
  // clock time (`end - Date.now()`), never this disposed timer/flag.
  deadline.dispose();
  await sleep(20); // let the run deadline's `end` actually elapse before cleanup starts
  const started = Date.now();
  const neverResolves = new Promise(() => {}); // e.g. a hung browser.close()
  await assert.rejects(
    deadline.cleanupRace(neverResolves),
    (error) => error instanceof SmokeError && error.code === 'CLEANUP_FAILED',
  );
  const elapsed = Date.now() - started;
  // Bounded by the CLEANUP_OP_FLOOR_MS floor (2000ms), not left hanging
  // indefinitely and not cut to ~0ms either.
  assert.ok(elapsed >= 1800, `expected the floor (~2000ms) to apply, only waited ${elapsed}ms`);
  assert.ok(elapsed < 3500, `expected the floor to bound the wait, took ${elapsed}ms`);
});

test('cleanupRace does not leave a dangling per-op timer after a promise resolves quickly', async () => {
  const deadline = createDeadline(6000);
  try {
    const outcome = await deadline.cleanupRace(Promise.resolve('closed'));
    assert.equal(outcome, 'closed');
    // No direct handle on the internal timer here; this is an outcome check
    // (the process/test-runner must still exit promptly) rather than an
    // introspection of timer internals.
  } finally {
    deadline.dispose();
  }
});

/**
 * Unit coverage for `cleanupRace`'s optional `reserveMs`: it carves out
 * budget for a LATER cleanup op (e.g. feature-acceptance's safety-critical
 * record GET/DELETE/verify) that an earlier op must not be allowed to
 * starve, while the CLEANUP_OP_FLOOR_MS floor still applies underneath it.
 */

test('cleanupRace(promise, { reserveMs }) shortens the per-op cap by reserveMs, bounded below by CLEANUP_OP_FLOOR_MS', async () => {
  const deadline = createDeadline(6000); // remaining() well above both the reserve and the eventual cap
  try {
    const started = Date.now();
    const neverResolves = new Promise(() => {}); // e.g. a hung context.close()
    // Expected cap: max(2000, 6000 - 3500) = 2500ms, well under the 6000ms
    // outer deadline, so the op settles (and this test returns) long before
    // that outer timer could fire.
    await assert.rejects(
      deadline.cleanupRace(neverResolves, { reserveMs: 3500 }),
      (error) => error instanceof SmokeError && error.code === 'CLEANUP_FAILED',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2100 && elapsed < 3400, `expected the reserved cap (~2500ms) to apply, took ${elapsed}ms`);
  } finally {
    deadline.dispose();
  }
});

test('cleanupRace(promise, { reserveMs }) never drops the cap below CLEANUP_OP_FLOOR_MS even when the reserve would otherwise push it lower', async () => {
  const deadline = createDeadline(3000); // remaining() minus the reserve below would go negative
  try {
    const started = Date.now();
    const neverResolves = new Promise(() => {});
    // remaining(~3000) - reserveMs(2500) = ~500ms, which is below
    // CLEANUP_OP_FLOOR_MS (2000ms), so the floor must apply: cap = 2000ms,
    // still comfortably under the 3000ms outer deadline.
    await assert.rejects(
      deadline.cleanupRace(neverResolves, { reserveMs: 2500 }),
      (error) => error instanceof SmokeError && error.code === 'CLEANUP_FAILED',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1800 && elapsed < 2700, `expected the CLEANUP_OP_FLOOR_MS floor (~2000ms) to apply despite the reserve, took ${elapsed}ms`);
  } finally {
    deadline.dispose();
  }
});

test('cleanupRace(promise, { reserveMs }) still lets a cleanup op that finishes well inside the reduced cap resolve normally', async () => {
  const deadline = createDeadline(8000);
  try {
    const started = Date.now();
    const quickCleanup = sleep(500).then(() => 'closed');
    // cap = max(2000, 8000 - 3000) = 5000ms; resolving at ~500ms is nowhere
    // near either the reduced cap or the outer deadline.
    const outcome = await deadline.cleanupRace(quickCleanup, { reserveMs: 3000 });
    const elapsed = Date.now() - started;
    assert.equal(outcome, 'closed');
    assert.ok(elapsed < 2000, `expected the quick op to resolve well before the reduced cap, took ${elapsed}ms`);
  } finally {
    deadline.dispose();
  }
});
