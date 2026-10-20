import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeIosSetupOwnership } from '../setup-ownership.mjs';

test('one setup ownership check can take seven logical seconds without changing ordinary request limits', async t => {
  let now = 0, calls = 0;
  t.mock.method(performance, 'now', () => now);
  const result = await stabilizeIosSetupOwnership({ deadline: 240000, assertOwned: () => { calls++; now = 7000; return true; } });
  assert.deepEqual(result, { status: 'completed', completed: true, elapsedMs: 7000 });
  assert.equal(calls, 1);
});

test('setup ownership consumes only the remaining original startup deadline and refuses late completion', async t => {
  let now = 239500, calls = 0, selectedBudget;
  const originalTimer = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { selectedBudget = ms; return originalTimer(fn, ms, ...args); });
  assert.equal((await stabilizeIosSetupOwnership({ deadline: 240000, assertOwned: () => { calls++; now = 240001; return true; } })).status, 'timeout');
  assert.equal(selectedBudget, 500); assert.equal(calls, 1);
  assert.equal((await stabilizeIosSetupOwnership({ deadline: 240000, assertOwned: () => { calls++; return true; } })).status, 'timeout');
  assert.equal(calls, 1, 'expired setup does not start another ownership callback');
});

test('timeout and cancellation fence the result while a late callback remains unconfirmed', async t => {
  let now = 0, expire;
  const originalTimer = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { if (ms === 20000) expire = fn; return originalTimer(fn, ms, ...args); });
  for (const mode of ['timeout', 'cancelled']) {
    now = 0; const entered = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController(); let calls = 0;
    const pending = stabilizeIosSetupOwnership({ deadline: 240000, signal: controller.signal,
      assertOwned: () => { calls++; entered.resolve(); return gate.promise; } });
    await entered.promise;
    if (mode === 'timeout') { now = 20000; expire(); } else controller.abort();
    const result = await pending;
    assert.equal(result.status, mode); assert.equal(result.completed, false);
    gate.resolve(true); await Promise.resolve(); await Promise.resolve();
    assert.equal(result.completed, false); assert.equal(calls, 1);
  }
});

test('nonpositive and rejected callbacks expose only fixed refusal metadata', async () => {
  const secret = 'private-callback-value';
  for (const assertOwned of [() => false, () => undefined, () => { throw Error(secret); }, () => Promise.reject(Error(Buffer.from(secret).toString('base64')))]) {
    const result = await stabilizeIosSetupOwnership({ deadline: performance.now() + 240000, assertOwned });
    assert.equal(result.status, 'refused'); assert.equal(result.completed, false);
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(JSON.stringify(result).includes(value), false);
  }
});
