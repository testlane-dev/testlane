/** Fixed diagnostic data only; disposable HTTP/Node fixtures, never native tools. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNativeCases } from '../../android-verification/runner.mjs';
import { IOS_NATIVE_RUNNER, NATIVE_RUNNER, sanitizeNativeReport, appendNativeRunFailure } from '../../android-verification/contracts.mjs';
import { APPROVAL_REQUIREMENTS } from '../../android-verification/proof-cases.mjs';
import { NativeDriverError } from '../driver.mjs';
import { NativeDriverError as AndroidDriverError } from '../../android-verification/driver.mjs';
import { iosProofDriverOptions } from '../readiness.mjs';

const fact = { operation: 'click', phase: 'response' };
const plan = (runner = IOS_NATIVE_RUNNER) => ({ schemaVersion: 1, runner, status: 'reviewed', title: 'Synthetic native approval proof',
  target: { baseUrl: 'http://127.0.0.1:4555', environment: 'testing' },
  app: runner === IOS_NATIVE_RUNNER ? { bundleId: 'dev.testlane.iosproof', buildSha256: 'a'.repeat(64) } : { package: 'dev.testlane.androidproof', apkSha256: 'a'.repeat(64) },
  cases: APPROVAL_REQUIREMENTS.map(row => ({ ...row, cleanup: { required: row.id !== 'anonymous-denied', description: row.id === 'anonymous-denied' ? 'No state is created' : 'Delete only the unique owned marker and verify absence' } })) });
const callbacks = () => APPROVAL_REQUIREMENTS.map((row, index) => ({ id: row.id, run: ({ check }) => check(true, true),
  ...(index < 4 ? { cleanup: ({ check }) => check(true, true) } : {}) }));
const run = async (body, cleanup, options = {}) => {
  const input = options.plan ?? plan(), cases = callbacks(); cases[0].run = body;
  if (cleanup) cases[0].cleanup = cleanup;
  const report = await runNativeCases({ plan: input, cases, ...options });
  return { input, report };
};
const absent = (value, secret) => {
  const text = JSON.stringify(value);
  for (const encoded of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) assert.equal(text.includes(encoded), false);
};
async function owned(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-ios-case-facts-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^tld-ios-case-facts-[A-Za-z0-9]+$/);
    assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  return root;
}
async function installed(root) {
  for (const [dir, files] of [
    ['android-verification', ['contracts.mjs', 'runner.mjs', 'driver.mjs', 'driver-phase.mjs', 'proof-cases.mjs']],
    ['ios-verification', ['driver.mjs', 'device-scope.mjs', 'setup-ownership.mjs', 'failure.mjs', 'failure-facts.mjs']],
  ]) for (const file of files) { const target = path.join(root, 'examples', dir, file); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(new URL('../../' + dir + '/' + file, import.meta.url))); }
  const load = file => import(pathToFileURL(path.join(root, 'examples', file)).href);
  return { driver: await load('ios-verification/driver.mjs'), runner: await load('android-verification/runner.mjs'),
    contracts: await load('android-verification/contracts.mjs'), failure: await load('ios-verification/failure.mjs') };
}
const device = origin => {
  const deviceBinding = { schemaVersion: 1, scope: 'ephemeral-hosted-standard-device-set', nativeHome: '/Users/runner',
    deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
    udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) };
  return { deviceBinding, udid: deviceBinding.udid, deviceSetPath: deviceBinding.deviceSetPath,
    derivedDataPath: deviceBinding.privateRoot + '/derived-data', serverUrl: origin, wdaPort: 8211, mjpegPort: 8212 };
};
async function httpDriver(t, runtime, secret, failurePhase = 'response') {
  const calls = [], session = randomBytes(16).toString('hex');
  const server = createServer(async (request, response) => {
    for await (const ignored of request) void ignored;
    calls.push(request.url); let value = null, status = 200;
    if (request.url === '/session') value = { sessionId: session };
    else if (request.url.endsWith('/context')) value = 'NATIVE_APP';
    else if (request.url.endsWith('/element')) value = { 'element-6066-11e4-a52e-4f735466cecf': 'fixed-element' };
    else if (request.url.endsWith('/displayed')) value = true;
    else if (request.url.endsWith('/click')) {
      if (failurePhase === 'http') { request.socket.destroy(); return; }
      status = 500; value = { error: secret, message: [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')].join('|') };
    }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver, refuseOwnership = false;
  t.after(async () => { refuseOwnership = false; try { if (driver) await driver.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const origin = 'http://127.0.0.1:' + server.address().port;
  driver = await runtime.driver.createNativeDriver({ ...iosProofDriverOptions(device(origin)), assertOwned: () => !refuseOwnership });
  return { driver, calls, session, refuseOwnership: () => { refuseOwnership = true; } };
}

for (const placement of ['body', 'cleanup', 'both']) test('actual HTTP driver failure survives installed runner, JSON and public projection: ' + placement, async t => {
  const root = await owned(t), runtime = await installed(path.join(root, 'package')), secret = randomBytes(24).toString('hex') + '/+=';
  const { driver, calls, session } = await httpDriver(t, runtime, secret), input = plan(), cases = callbacks();
  cases[0].run = async ({ check }) => { check(true, true); if (placement !== 'cleanup') await driver.click('synthetic-control'); };
  cases[0].cleanup = async ({ check }) => { check(true, true); if (placement !== 'body') await driver.click('synthetic-control'); };
  const report = await runtime.runner.runNativeCases({ plan: input, cases });
  assert.equal(report.verdict, 'failed');
  const expected = { stage: placement === 'cleanup' ? 'cleanup' : 'body', ...fact };
  assert.deepEqual(report.cases[0].requestFailure, expected); assert.equal(Object.isFrozen(report.cases[0].requestFailure), true);
  assert.equal(report.cases[0].reason, placement === 'cleanup' ? 'NATIVE_CLEANUP_FAILED' : 'NATIVE_BODY_FAILED');
  assert.deepEqual(report.cases[0].diagnostics.map(row => row.code), placement === 'both' ? ['NATIVE_BODY_FAILED', 'NATIVE_DRIVER_COMMAND_FAILED', 'NATIVE_CLEANUP_FAILED'] : [placement === 'cleanup' ? 'NATIVE_CLEANUP_FAILED' : 'NATIVE_BODY_FAILED', 'NATIVE_DRIVER_COMMAND_FAILED']);
  const wire = JSON.parse(JSON.stringify(report));
  assert.deepEqual(runtime.contracts.sanitizeNativeReport(wire, input), report);
  assert.deepEqual(sanitizeNativeReport(wire, input), report, 'the worker-host contract accepts the installed JSON data, not a foreign error class');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(input)); await writeFile(path.join(root, 'positive.json'), JSON.stringify(wire));
  const projected = await runtime.failure.publicIosFailure({ output: root, stage: 'positive', error: new Error('fixed') });
  assert.equal(projected.reports.length, 1); assert.deepEqual(projected.reports[0].cases[0].requestFailure, expected);
  absent(projected, secret); absent(projected, session); assert.equal(calls.filter(route => route.endsWith('/click')).length, placement === 'both' ? 2 : 1);
});

for (const phase of ['ownership', 'http']) test('fast installed case distinguishes ' + phase + ' failure through JSON and public projection', async t => {
  const root = await owned(t), runtime = await installed(path.join(root, 'package')), secret = randomBytes(24).toString('hex') + '/+=';
  const fixture = await httpDriver(t, runtime, secret, phase), input = plan(), cases = callbacks();
  const requestsBeforeBody = fixture.calls.length;
  if (phase === 'ownership') fixture.refuseOwnership();
  cases[0].run = async ({ check }) => { check(true, true); await fixture.driver.click('synthetic-control'); };
  const report = await runtime.runner.runNativeCases({ plan: input, cases });
  const expected = { stage: 'body', operation: phase === 'ownership' ? 'native-context' : 'click', phase };
  assert.deepEqual(report.cases[0].requestFailure, expected);
  assert.deepEqual(report.cases[0].diagnostics.map(row => row.code), ['NATIVE_BODY_FAILED', phase === 'ownership' ? 'NATIVE_DRIVER_OWNERSHIP_REFUSED' : 'NATIVE_DRIVER_COMMAND_FAILED']);
  if (phase === 'ownership') assert.equal(fixture.calls.length, requestsBeforeBody, 'refused ownership sends no new HTTP');
  else assert.equal(fixture.calls.filter(route => route.endsWith('/click')).length, 1, 'only the click connection was destroyed');
  const wire = JSON.parse(JSON.stringify(report)); assert.deepEqual(runtime.contracts.sanitizeNativeReport(wire, input), report); assert.deepEqual(sanitizeNativeReport(wire, input), report);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(input)); await writeFile(path.join(root, 'positive.json'), JSON.stringify(wire));
  const projected = await runtime.failure.publicIosFailure({ output: root, stage: 'positive', error: new Error('fixed') });
  assert.equal(projected.reports.length, 1); assert.deepEqual(projected.reports[0].cases[0].requestFailure, expected);
  absent(projected, secret); absent(projected, fixture.session);
});

test('assertion precedence is phase local and only an independent cleanup driver fact can supplement it', async () => {
  const body = ({ check }) => { try { check(false, true); } catch {} throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); };
  const asserted = await run(body);
  assert.equal(asserted.report.cases[0].reason, 'NATIVE_ASSERTION_FAILED'); assert.equal(Object.hasOwn(asserted.report.cases[0], 'requestFailure'), false);
  assert.deepEqual(asserted.report.cases[0].diagnostics.map(row => row.code), ['NATIVE_ASSERTION_FAILED']);
  const cleanup = await run(body, ({ check }) => { check(true, true); throw new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED', fact); });
  assert.equal(cleanup.report.cases[0].reason, 'NATIVE_ASSERTION_FAILED');
  assert.deepEqual(cleanup.report.cases[0].diagnostics.map(row => row.code), ['NATIVE_ASSERTION_FAILED', 'NATIVE_CLEANUP_FAILED', 'NATIVE_DRIVER_COMMAND_FAILED']);
  assert.deepEqual(cleanup.report.cases[0].requestFailure, { stage: 'cleanup', ...fact }); assert.deepEqual(sanitizeNativeReport(cleanup.report, cleanup.input), cleanup.report);
  const bodyFact = await run(() => { throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); }, ({ check }) => { try { check(false, true); } catch {} throw new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED', fact); });
  assert.deepEqual(bodyFact.report.cases[0].requestFailure, { stage: 'body', ...fact });
  assert.deepEqual(bodyFact.report.cases[0].diagnostics.map(row => row.code), ['NATIVE_BODY_FAILED', 'NATIVE_DRIVER_TIMEOUT', 'NATIVE_CLEANUP_FAILED']); assert.deepEqual(sanitizeNativeReport(bodyFact.report, bodyFact.input), bodyFact.report);
});

test('late appended cancellation or unsafe settlement removes facts without changing its real reason; ordinary close failure preserves them', async () => {
  const { input, report } = await run(() => { throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); });
  const before = JSON.stringify(report);
  for (const code of ['NATIVE_RUN_CANCELLED', 'NATIVE_BODY_UNSETTLED', 'NATIVE_CLEANUP_UNSETTLED']) {
    const appended = appendNativeRunFailure(report, code);
    assert.equal(appended.verdict, code === 'NATIVE_RUN_CANCELLED' ? 'cancelled' : 'failed');
    assert.deepEqual(appended.reasonCodes, [code]); assert.equal(appended.cases.some(row => Object.hasOwn(row, 'requestFailure')), false);
    assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(appended)), input), appended);
    assert.equal(JSON.stringify(report), before, 'the prior report is not mutated');
  }
  const closing = appendNativeRunFailure(report, 'NATIVE_DRIVER_CLEANUP_FAILED');
  assert.equal(closing.verdict, 'failed'); assert.deepEqual(closing.reasonCodes, ['NATIVE_DRIVER_CLEANUP_FAILED']);
  assert.deepEqual(closing.cases[0].requestFailure, { stage: 'body', ...fact }); assert.deepEqual(sanitizeNativeReport(closing, input), closing);
});

test('unknown, accessor, proxy, ordinary forged and foreign-class errors supply no per-case fact', async () => {
  const secret = randomBytes(24).toString('hex') + '/+='; let reads = 0;
  const getter = new NativeDriverError('NATIVE_DRIVER_TIMEOUT'); Object.defineProperty(getter, 'code', { get() { reads++; throw Error(secret); } });
  const requestGetter = new NativeDriverError('NATIVE_DRIVER_TIMEOUT'); Object.defineProperty(requestGetter, 'requestFailure', { get() { reads++; throw Error(secret); } });
  const malformed = new NativeDriverError('NATIVE_DRIVER_TIMEOUT'); Object.defineProperty(malformed, 'requestFailure', { value: { ...fact, extra: secret } });
  const proxy = new Proxy(new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact), { get() { reads++; throw Error(secret); }, getPrototypeOf() { reads++; throw Error(secret); }, getOwnPropertyDescriptor() { reads++; throw Error(secret); } });
  const foreign = await import(new URL('../driver.mjs?foreign-case-facts', import.meta.url));
  for (const error of [getter, requestGetter, malformed, proxy, Object.assign(new Error(secret), { code: 'NATIVE_DRIVER_TIMEOUT', requestFailure: fact }),
    { code: 'NATIVE_DRIVER_TIMEOUT', requestFailure: fact }, new AndroidDriverError('NATIVE_DRIVER_TIMEOUT'),
    new foreign.NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact), new NativeDriverError('UNKNOWN_CODE', fact)]) {
    const { input, report } = await run(() => { throw error; });
    assert.equal(Object.hasOwn(report.cases[0], 'requestFailure'), false); assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report); absent(report, secret);
  }
  assert.equal(reads, 0);
});

test('checks, success, Android and cancellation cannot contribute request facts', async () => {
  const thrown = () => new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact);
  for (const [body, cleanup, options] of [
    [({ check }) => { try { check(false, true); } catch {} throw thrown(); }, undefined, {}],
    [({ check }) => check(true, true), ({ check }) => { try { check(false, true); } catch {} throw thrown(); }, {}],
    [({ check }) => { check(true, true); return thrown(); }, undefined, {}],
    [() => { throw thrown(); }, undefined, { plan: plan(NATIVE_RUNNER) }],
    [() => { throw new NativeDriverError('NATIVE_DRIVER_CANCELLED', fact); }, undefined, {}],
  ]) { const { input, report } = await run(body, cleanup, options); assert.equal(Object.hasOwn(report.cases[0], 'requestFailure'), false); assert.deepEqual(sanitizeNativeReport(report, input), report); }
  const controller = new AbortController(); controller.abort(); let called = false;
  const { report } = await run(() => { called = true; throw thrown(); }, undefined, { signal: controller.signal });
  assert.equal(called, false); assert.equal(report.verdict, 'cancelled'); assert.equal(report.cases.some(row => Object.hasOwn(row, 'requestFailure')), false);
  const lateCancel = new AbortController();
  const cancelled = await run(() => { throw thrown(); }, ({ check }) => { check(true, true); lateCancel.abort(); }, { signal: lateCancel.signal });
  assert.equal(cancelled.report.verdict, 'cancelled'); assert.equal(cancelled.report.cases.some(row => Object.hasOwn(row, 'requestFailure')), false);
  assert.deepEqual(sanitizeNativeReport(cancelled.report, cancelled.input), cancelled.report);
});

test('runner timeout and unsettled callbacks omit late driver facts while preserving their primary diagnosis', async () => {
  const { input, report } = await run(async ({ signal }) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); }, undefined,
    { timeoutMs: 25, settleTimeoutMs: 100 });
  assert.equal(report.cases[0].reason, 'NATIVE_BODY_TIMEOUT'); assert.equal(Object.hasOwn(report.cases[0], 'requestFailure'), false); assert.deepEqual(sanitizeNativeReport(report, input), report);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const late = await run(async () => { await gate; throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); }, undefined, { timeoutMs: 25, settleTimeoutMs: 25 });
  const before = JSON.stringify(late.report); assert.equal(late.report.cases[0].reason, 'NATIVE_BODY_UNSETTLED'); assert.equal(Object.hasOwn(late.report.cases[0], 'requestFailure'), false);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(JSON.stringify(late.report), before); assert.deepEqual(sanitizeNativeReport(late.report, late.input), late.report);
  const cleaned = await run(({ check }) => check(true, true), async ({ signal }) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); },
    { cleanupTimeoutMs: 25, settleTimeoutMs: 100 });
  assert.equal(cleaned.report.cases[0].reason, 'NATIVE_CLEANUP_TIMEOUT'); assert.equal(Object.hasOwn(cleaned.report.cases[0], 'requestFailure'), false);
  assert.deepEqual(sanitizeNativeReport(cleaned.report, cleaned.input), cleaned.report);
});

test('strict wire fact rejects accessors, proxies, symbols, malformed data and unsupported phase placement without reads', async () => {
  const { input, report } = await run(() => { throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); });
  let reads = 0; const secret = randomBytes(24).toString('hex');
  const getter = { stage: 'body', phase: 'response' }; Object.defineProperty(getter, 'operation', { enumerable: true, get() { reads++; throw Error(secret); } });
  const symbol = { stage: 'body', ...fact }; symbol[Symbol('extra')] = secret;
  const proxy = new Proxy({ stage: 'body', ...fact }, { get() { reads++; throw Error(secret); }, ownKeys() { reads++; throw Error(secret); }, getPrototypeOf() { reads++; throw Error(secret); } });
  for (const value of [getter, symbol, proxy, null, {}, [], { stage: 'body', ...fact, extra: secret },
    { stage: 'unknown', ...fact }, { stage: 'body', operation: secret, phase: 'response' }, { stage: 'body', operation: 'click', phase: secret },
    Object.assign(Object.create(null), { stage: 'body', ...fact })]) {
    const changed = structuredClone(report); changed.cases[0].requestFailure = value;
    assert.throws(() => sanitizeNativeReport(changed, input), { message: 'NATIVE_REPORT_INVALID' });
  }
  const rowGetter = structuredClone(report); Object.defineProperty(rowGetter.cases[0], 'requestFailure', { enumerable: true, get() { reads++; throw Error(secret); } });
  assert.throws(() => sanitizeNativeReport(rowGetter, input), { message: 'NATIVE_REPORT_INVALID' });
  const rowProxy = structuredClone(report); rowProxy.cases[0] = new Proxy(rowProxy.cases[0], { getOwnPropertyDescriptor() { reads++; throw Error(secret); }, ownKeys() { reads++; throw Error(secret); } });
  assert.throws(() => sanitizeNativeReport(rowProxy, input), { message: 'NATIVE_REPORT_INVALID' });
  for (const mutate of [r => { r.cases[0].requestFailure.stage = 'cleanup'; }, r => { r.cases[1].requestFailure = r.cases[0].requestFailure; },
    r => { r.cases[0].diagnostics = r.cases[0].diagnostics.slice(0, 1); }, r => { r.cases[0].requestFailure = undefined; }]) {
    const changed = JSON.parse(JSON.stringify(report)); mutate(changed); assert.throws(() => sanitizeNativeReport(changed, input), { message: 'NATIVE_REPORT_INVALID' });
  }
  const androidInput = plan(NATIVE_RUNNER), android = await run(() => { throw new AndroidDriverError('NATIVE_DRIVER_TIMEOUT'); }, undefined, { plan: androidInput });
  android.report.cases[0].requestFailure = { stage: 'body', ...fact };
  assert.throws(() => sanitizeNativeReport(android.report, androidInput), { message: 'NATIVE_REPORT_INVALID' }); assert.equal(reads, 0);
});

test('deduplicated cleanup cause is not inferred from a separate untagged body failure', async () => {
  const { input, report } = await run(() => { throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT'); }, () => { throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact); });
  assert.deepEqual(report.cases[0].diagnostics.map(row => row.code), ['NATIVE_BODY_FAILED', 'NATIVE_DRIVER_TIMEOUT', 'NATIVE_CLEANUP_FAILED']);
  assert.equal(Object.hasOwn(report.cases[0], 'requestFailure'), false); assert.deepEqual(sanitizeNativeReport(report, input), report);
});

test('reports without a qualifying fact preserve their exact JSON shape on both platforms', async () => {
  for (const runner of [IOS_NATIVE_RUNNER, NATIVE_RUNNER]) {
    const input = plan(runner), report = await runNativeCases({ plan: input, cases: callbacks() }), bytes = JSON.stringify(report);
    assert.equal(report.cases.some(row => Object.hasOwn(row, 'requestFailure')), false);
    assert.equal(JSON.stringify(sanitizeNativeReport(JSON.parse(bytes), input)), bytes);
  }
});
