import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runNativeCases } from '../runner.mjs';
import { validateNativePlan, sanitizeNativeReport, NATIVE_RUNNER } from '../contracts.mjs';

const plan = (ids = ['create-request'], required = true) => ({ schemaVersion: 1, runner: NATIVE_RUNNER, status: 'reviewed',
  title: 'Disposable native request workflow', target: { baseUrl: 'http://127.0.0.1:4555', environment: 'testing' },
  app: { package: 'com.testlane.nativeproof', apkSha256: 'a'.repeat(64) },
  cases: ids.map(id => ({ id, title: 'A saved request is correct', expected: ['Three items total 4200 cents'],
    cleanup: { required, description: 'Delete the owned record and verify its absence' } })) });
const passing = id => ({ id, run: ({ check }) => check({ total: 4200 }, { total: 4200 }), cleanup: ({ check }) => check([], []) });
const budget = { timeoutMs: 20, cleanupTimeoutMs: 20, settleTimeoutMs: 30 };
const aborted = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });

test('strict native plan accepts only this experimental loopback contract', () => {
  assert.equal(validateNativePlan(plan()).runner, NATIVE_RUNNER);
  for (const mutate of [
    p => { p.runner = 'playwright'; }, p => { p.target.environment = 'production'; },
    p => { p.target.baseUrl = 'http://10.0.2.2:4555'; }, p => { p.target.baseUrl = 'https://example.test'; },
    p => { p.target.baseUrl += '/path'; }, p => { p.target.baseUrl += '?private=value'; },
    p => { p.target.baseUrl = 'http://name:value@127.0.0.1:4555'; }, p => { p.app.apkSha256 = 'not-a-hash'; },
    p => { p.app.package = '../private'; }, p => { p.cases = []; }, p => { p.cases.push({ ...p.cases[0] }); },
    p => { p.cases[0].expected = []; }, p => { p.cases[0].retry = 1; }, p => { p.unreviewed = true; },
  ]) { const value = plan(); mutate(value); assert.throws(() => validateNativePlan(value), /^NativeVerificationError: NATIVE_/); }
});

test('real body and cleanup observations pass, and the worker result sanitizes', async () => {
  const input = plan();
  const result = await runNativeCases({ plan: input, cases: [passing('create-request')] });
  assert.equal(result.verdict, 'passed');
  assert.deepEqual(result.cases[0].cleanup, { required: true, status: 'completed' });
  assert.equal(result.cases[0].bodyAssertionsObserved, 1);
  assert.equal(result.cases[0].cleanupAssertionsObserved, 1);
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('a read-only case can explicitly omit app cleanup', async () => {
  const input = plan(['anonymous-denied'], false);
  const result = await runNativeCases({ plan: input, cases: [{ id: 'anonymous-denied', run: ({ check }) => check(401, 401) }] });
  assert.equal(result.verdict, 'passed');
  assert.equal(result.cases[0].cleanup.status, 'not-required');
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('missing, duplicate, unknown and skip/retry case mappings never invoke code', async () => {
  let calls = 0;
  const input = plan(['first', 'second']);
  const item = id => ({ id, run: () => { calls++; }, cleanup: () => {} });
  for (const cases of [[item('first')], [item('first'), item('first')], [item('first'), item('unknown')],
    [{ ...item('first'), skip: true }, item('second')], [{ ...item('first'), retries: 1 }, item('second')]]) {
    const result = await runNativeCases({ plan: input, cases });
    assert.equal(result.verdict, 'blocked');
    assert.deepEqual(result.reasonCodes, ['NATIVE_CASE_MAPPING_INVALID']);
    assert.equal(calls, 0);
    assert.deepEqual(sanitizeNativeReport(result, input), result);
  }
});

test('draft and missing-cleanup plans are blocked before app actions', async () => {
  let calls = 0;
  const input = plan(); input.status = 'draft';
  const draft = await runNativeCases({ plan: input, cases: [{ ...passing('create-request'), run: () => { calls++; } }] });
  assert.equal(draft.reasonCodes[0], 'NATIVE_PLAN_NOT_REVIEWED');
  input.status = 'reviewed';
  const missing = await runNativeCases({ plan: input, cases: [{ id: 'create-request', run: () => { calls++; } }] });
  assert.equal(missing.verdict, 'blocked');
  assert.equal(missing.cases[0].reason, 'NATIVE_CLEANUP_REQUIRED');
  assert.equal(missing.cases[0].attempts, 0);
  const two = plan(['first', 'second']);
  await runNativeCases({ plan: two, cases: [{ ...passing('first'), run: () => { calls++; } }, { id: 'second', run: () => { calls++; } }] });
  assert.equal(calls, 0);
});

test('caught body and cleanup assertions remain failures', async () => {
  for (const part of ['run', 'cleanup']) {
    const item = passing('create-request');
    item[part] = ({ check }) => { try { check(4199, 4200); } catch {} };
    const input = plan(), result = await runNativeCases({ plan: input, cases: [item] });
    assert.equal(result.verdict, 'failed');
    assert.equal(result.cases[0].reason, part === 'run' ? 'NATIVE_ASSERTION_FAILED' : 'NATIVE_CLEANUP_FAILED');
    assert.equal(result.cases[0].cleanup.status, part === 'run' ? 'completed' : 'failed');
    assert.deepEqual(sanitizeNativeReport(result, input), result);
  }
});

test('missing body or cleanup checks cannot produce acceptance', async () => {
  for (const part of ['run', 'cleanup']) {
    const item = passing('create-request'); item[part] = () => {};
    const result = await runNativeCases({ plan: plan(), cases: [item] });
    assert.notEqual(result.verdict, 'passed');
    assert.equal(result.cases[0].reason, part === 'run' ? 'NATIVE_NO_BODY_CHECKS' : 'NATIVE_NO_CLEANUP_CHECKS');
  }
});

test('settled body failure still executes verified cleanup without retaining errors or returns', async () => {
  const secret = randomBytes(24).toString('base64url') + String.fromCharCode(34, 92) + '+ /?';
  const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2),
    Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')];
  const input = plan(); input.title = secret; input.cases[0].title = secret; input.cases[0].expected = variants;
  input.cases[0].cleanup.description = secret;
  const result = await runNativeCases({ plan: input, context: { privateValue: secret }, cases: [{ id: 'create-request',
    run: ({ check, privateValue }) => { try { check({ privateValue }, { privateValue: variants[2] }); } catch {} throw new Error(variants.join('\n')); },
    cleanup: ({ check }) => { check(true, true); return { secret, stack: variants.join('\n') }; },
  }] });
  assert.equal(result.verdict, 'failed');
  assert.equal(result.cases[0].cleanup.status, 'completed');
  for (const value of variants) assert.equal(JSON.stringify(result).includes(value), false);
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('cooperative timeout aborts the body and only then executes cleanup', async () => {
  let running = false;
  const input = plan(), result = await runNativeCases({ plan: input, ...budget, cases: [{ id: 'create-request',
    run: async ({ signal }) => { running = true; await aborted(signal); running = false; },
    cleanup: ({ check, signal }) => { check(running, false); check(signal.aborted, false); },
  }] });
  assert.equal(result.verdict, 'failed');
  assert.equal(result.cases[0].reason, 'NATIVE_BODY_TIMEOUT');
  assert.equal(result.cases[0].cleanup.status, 'completed');
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('unsettled body never races cleanup or later cases and late results cannot amend the report', async () => {
  let release, cleanup = 0, later = 0;
  const input = plan(['first', 'second']);
  const result = await runNativeCases({ plan: input, ...budget, cases: [
    { id: 'first', run: async ({ check }) => { await new Promise(resolve => { release = resolve; }); check(true, true); }, cleanup: () => { cleanup++; } },
    { ...passing('second'), run: ({ check }) => { later++; check(true, true); } },
  ] });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.cases[0].reason, 'NATIVE_BODY_UNSETTLED');
  assert.equal(result.cases[0].cleanup.status, 'unknown');
  assert.equal(result.cases[1].attempts, 0); assert.equal(cleanup, 0); assert.equal(later, 0);
  const bytes = JSON.stringify(result); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(result), bytes);
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('unsettled or timed-out cleanup cannot be reported as completed', async () => {
  for (const settles of [false, true]) {
    const input = plan(['first', 'second']); let later = 0;
    const result = await runNativeCases({ plan: input, ...budget, cases: [
      { ...passing('first'), cleanup: async ({ signal, check }) => { if (!settles) return new Promise(() => {}); await aborted(signal); check(true, true); } },
      { ...passing('second'), run: ({ check }) => { later++; check(true, true); } },
    ] });
    assert.notEqual(result.verdict, 'passed');
    assert.equal(result.cases[0].cleanup.status, settles ? 'failed' : 'unknown');
    assert.equal(result.cases[0].reason, settles ? 'NATIVE_CLEANUP_TIMEOUT' : 'NATIVE_CLEANUP_UNSETTLED');
    assert.equal(later, settles ? 1 : 0);
    assert.deepEqual(sanitizeNativeReport(result, input), result);
  }
});

test('pre-aborted and mid-case cancellation never pass; cleanup uses a fresh signal', async () => {
  const input = plan(['first', 'second']);
  const pre = new AbortController(); pre.abort();
  let calls = 0;
  const before = await runNativeCases({ plan: input, signal: pre.signal, cases: [passing('first'), passing('second')].map(item => ({ ...item, run: () => { calls++; } })) });
  assert.equal(before.verdict, 'cancelled'); assert.equal(calls, 0);
  const controller = new AbortController();
  const result = await runNativeCases({ plan: input, signal: controller.signal, ...budget, cases: [
    { id: 'first', run: async ({ signal }) => { controller.abort(); await aborted(signal); }, cleanup: ({ check, signal }) => check(signal.aborted, false) }, passing('second'),
  ] });
  assert.equal(result.verdict, 'cancelled'); assert.equal(result.cases[0].cleanup.status, 'completed'); assert.equal(result.cases[1].attempts, 0);
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('cancellation during the last cleanup prevents an overall pass', async () => {
  const controller = new AbortController(), input = plan();
  const result = await runNativeCases({ plan: input, signal: controller.signal, cases: [{ ...passing('create-request'), cleanup: ({ check }) => { controller.abort(); check(true, true); } }] });
  assert.equal(result.verdict, 'cancelled');
  assert.deepEqual(sanitizeNativeReport(result, input), result);
});

test('checked plan and callback mapping are snapshotted before execution', async () => {
  const input = plan(['first', 'second']); let replaced = false;
  const cases = [passing('first'), passing('second')];
  cases[0].run = ({ check }) => { input.cases[1].id = 'changed'; cases[1].run = () => { replaced = true; }; check(true, true); };
  const result = await runNativeCases({ plan: input, cases });
  assert.equal(result.verdict, 'passed'); assert.equal(result.cases[1].id, 'second'); assert.equal(replaced, false);
});

test('worker sanitization refuses extra payloads, inconsistent counts and passing unknown cleanup', async () => {
  const input = plan(), original = await runNativeCases({ plan: input, cases: [passing('create-request')] });
  for (const mutate of [
    r => { r.error = 'private observed value'; }, r => { r.cases[0].actual = 'private observed value'; },
    r => { r.cases[0].id = 'unknown'; }, r => { r.cases[0].assertionsObserved++; },
    r => { r.cases[0].cleanup.status = 'unknown'; }, r => { r.cases[0].bodyAssertionsObserved = 0; r.cases[0].assertionsObserved = 1; },
    r => { r.reasonCodes = ['private observed value']; }, r => { r.cases[0].diagnostics = [{ code: 'NATIVE_BODY_FAILED', phase: 'body', summary: 'private observed value', remedy: 'private' }]; },
  ]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => sanitizeNativeReport(value, input), { message: 'NATIVE_REPORT_INVALID' });
  }
});
