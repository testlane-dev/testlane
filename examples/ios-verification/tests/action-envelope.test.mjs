import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNativeDriver, NativeDriverError, readIosRequestFailure, readIosRemoteUnsettled } from '../driver.mjs';
import { IOS_DEVICE_SCOPE } from '../device-scope.mjs';

const binding = () => ({ schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome: '/Users/runner',
  deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
  udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) });
const caps = () => ({ platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': binding().udid,
  'appium:bundleId': 'dev.testlane.iosproof', 'appium:simulatorDevicesSetPath': binding().deviceSetPath,
  'appium:derivedDataPath': binding().privateRoot + '/derived-data', 'appium:wdaLocalPort': 8211,
  'appium:wdaRemotePort': 8211, 'appium:mjpegServerPort': 8212, 'appium:wdaBindingIP': '127.0.0.1',
  'appium:wdaBaseUrl': 'http://127.0.0.1', 'appium:skipLogCapture': true, 'appium:showIOSLog': false,
  'appium:showXcodeLog': false, 'appium:printPageSourceOnFindFailure': false, 'appium:disableAutomaticScreenshots': true,
  'appium:shutdownOtherSimulators': false, 'appium:resetLocationService': false, 'appium:noReset': true });

function harness(t, factory = createNativeDriver) {
  let now = 0, ownerHook, httpHook, ownerCount = 0;
  const routes = [], timers = new Map(), durations = [], session = 'session-' + randomBytes(12).toString('hex');
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    const handle = {}; timers.set(handle, { callback, milliseconds }); durations.push(milliseconds); return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => timers.delete(handle));
  const json = (value, status = 200) => new Response(JSON.stringify({ value }), { status });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname; routes.push({ route, method: options.method });
    const changed = httpHook?.(route, options); if (changed !== undefined) return changed;
    return json(route === '/session' ? { sessionId: session } : route.endsWith('/context') ? 'NATIVE_APP' :
      route.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'owned-element' } :
      route.endsWith('/displayed') ? true : null);
  });
  return { routes, timers, durations, json,
    advance(value) { now += value; }, now: () => now,
    owner(hook) { ownerHook = hook; }, http(hook) { httpHook = hook; }, ownerCount: () => ownerCount,
    expire() { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
    create(options = {}) { return factory({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(),
      assertOwned: () => { ownerCount++; return ownerHook ? ownerHook() : true; }, ...options }); },
  };
}

import { runNativeCases } from '../../android-verification/runner.mjs';
import { validateNativePlan, sanitizeNativeReport, appendNativeRunFailure } from '../../android-verification/contracts.mjs';
import { runNativeWorker } from '../../android-verification/worker-host.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { verifyInstalledIosReadiness } from '../readiness.mjs';

async function quarantined(driver, h) {
  const routes = h.routes.length, owners = h.ownerCount();
  for (const next of [() => driver.close(), () => driver.waitFor('session-status'), () => driver.text('session-status'), () => driver.click('quantity')])
    await assert.rejects(next(), error => { assert.equal(error.code, 'NATIVE_DRIVER_REMOTE_UNSETTLED'); assert.equal(readIosRemoteUnsettled(error), true); return true; });
  assert.equal(h.routes.length, routes); assert.equal(h.ownerCount(), owners);
}
const plan = () => validateNativePlan({ schemaVersion: 1, runner: 'ios-xcuitest', status: 'reviewed', title: 'Synthetic native action contract',
  target: { baseUrl: 'http://127.0.0.1:4555', environment: 'testing' }, app: { bundleId: 'dev.testlane.iosproof', buildSha256: 'a'.repeat(64) },
  cases: ['first', 'later'].map(id => ({ id, title: 'A fixed synthetic action settles', expected: ['The terminal result is confirmed'], cleanup: { required: true, description: 'Remove only owned state' } })) });

test('only semantic element POSTs gain a bounded observation window; reads and DELETE stay five seconds', async t => {
  const h = harness(t), driver = await h.create(), seen = [];
  h.http(route => {
    const budget = [...h.timers.values()][0].milliseconds; seen.push({ route, budget });
    if (/\/(click|clear|value)$/.test(route) && !route.endsWith('/attribute/value')) { assert.equal(budget, 10000); h.advance(6500); }
    else { assert.ok(budget <= 5000); if (route.endsWith('/attribute/value')) return h.json('observed'); }
  });
  await driver.click('quantity'); await driver.type('run-marker', randomBytes(12).toString('hex')); assert.equal(await driver.text('run-marker'), 'observed'); await driver.close();
  assert.deepEqual(seen.filter(row => /\/(click|clear|value)$/.test(row.route) && !row.route.endsWith('/attribute/value')).map(row => row.budget), [10000, 10000, 10000]);
  assert.equal(h.routes.filter(row => row.route.endsWith('/click')).length, 1); assert.equal(h.timers.size, 0);
});

test('fractional late semantic result preserves original error then permanently blocks guards, queries and DELETE', async t => {
  const h = harness(t), driver = await h.create(); let original;
  h.http(route => { if (route.endsWith('/click')) { h.advance(10000.001); return h.json(null); } });
  await assert.rejects(driver.click('quantity'), error => { original = error; assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT'); assert.equal(readIosRemoteUnsettled(error), true); return true; });
  assert.deepEqual(readIosRequestFailure(original), { operation: 'click', phase: 'http' }); await quarantined(driver, h);
});

test('missing headers, cancellation, late body, malformed body and parsed proxy errors never permit replay or session DELETE', async t => {
  const h = harness(t);
  for (const mode of ['headers', 'cancelled', 'body', 'decode', 'proxy-error']) {
    h.http(undefined); const driver = await h.create(), gate = Promise.withResolvers(), entered = Promise.withResolvers(), phase = new AbortController();
    h.http(route => {
      if (!route.endsWith('/click')) return;
      if (mode === 'headers' || mode === 'cancelled') { entered.resolve(); return gate.promise; }
      if (mode === 'body') return { ok: true, status: 200, body: { getReader: () => ({ read() { entered.resolve(); return gate.promise; } }) } };
      if (mode === 'decode') return new Response(randomBytes(16).toString('hex'));
      return h.json({ error: 'unknown error' }, 500);
    });
    let failure;
    const rejected = assert.rejects(driver.withSignal(phase.signal).click('quantity'), error => { failure = error; return true; });
    if (['headers', 'cancelled', 'body'].includes(mode)) { await entered.promise; if (mode === 'cancelled') phase.abort(); else h.expire(); }
    await rejected; assert.equal(readIosRemoteUnsettled(failure), true);
    assert.equal(failure.code, mode === 'cancelled' ? 'NATIVE_DRIVER_CANCELLED' : ['headers', 'body'].includes(mode) ? 'NATIVE_DRIVER_TIMEOUT' : mode === 'decode' ? 'NATIVE_DRIVER_RESPONSE_INVALID' : 'NATIVE_DRIVER_COMMAND_FAILED');
    await quarantined(driver, h); const routes = h.routes.length;
    gate.resolve(mode === 'body' ? { done: true } : h.json(null)); await Promise.resolve(); await Promise.resolve();
    await quarantined(driver, h); assert.equal(h.routes.length, routes); assert.equal(h.timers.size, 0);
  }
});

test('private uncertainty marker rejects forged properties, accessors and proxies without invoking them', async () => {
  let touched = 0; const fake = new NativeDriverError('NATIVE_DRIVER_REMOTE_UNSETTLED');
  Object.defineProperty(fake, 'remoteUnsettled', { get() { touched++; return true; } });
  for (const value of [fake, Object.assign(Error(), { remoteUnsettled: true }), new Proxy(fake, { get() { touched++; throw Error(); } }), null]) assert.equal(readIosRemoteUnsettled(value), false);
  let cleanup = 0; const input = plan();
  const report = await runNativeCases({ plan: input, cases: [{ id: 'first', run: () => { throw fake; }, cleanup: ({ check }) => { cleanup++; check(true, true); } },
    { id: 'later', run: ({ check }) => check(true, true), cleanup: ({ check }) => check(true, true) }] });
  assert.equal(report.verdict, 'failed'); assert.equal(report.cases[0].reason, 'NATIVE_BODY_FAILED');
  assert.equal(report.reasonCodes.includes('NATIVE_DRIVER_REMOTE_UNSETTLED'), false); assert.equal(cleanup, 1);
  assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report);
  assert.equal(touched, 0);
});

test('a concurrent pending-owner fence after semantic dispatch still quarantines its original failure', async t => {
  const h = harness(t), driver = await h.create(), httpEntered = Promise.withResolvers(), httpGate = Promise.withResolvers();
  h.http(route => { if (route.endsWith('/click')) { httpEntered.resolve(); return httpGate.promise; } });
  let original; const first = assert.rejects(driver.click('quantity'), error => { original = error; return true; }); await httpEntered.promise;
  const ownerEntered = Promise.withResolvers(), ownerGate = Promise.withResolvers(), phase = new AbortController();
  h.owner(() => { ownerEntered.resolve(); return ownerGate.promise; });
  const second = assert.rejects(driver.withSignal(phase.signal).waitFor('session-status'), { code: 'NATIVE_DRIVER_CANCELLED' });
  await ownerEntered.promise; phase.abort(); await Promise.all([first, second]);
  assert.equal(original.code, 'NATIVE_DRIVER_OWNERSHIP_REFUSED'); assert.equal(readIosRemoteUnsettled(original), true);
  ownerGate.resolve(true); httpGate.resolve(h.json(null)); await Promise.resolve(); await quarantined(driver, h);
});

test('actual driver failure halts runner cleanup/later cases and survives JSON sanitizer without new IPC fields', async t => {
  const h = harness(t), driver = await h.create(); let cleanup = 0, later = 0;
  h.http(route => route.endsWith('/click') ? h.json({ error: 'unknown error' }, 500) : undefined);
  const input = plan(), report = await runNativeCases({ plan: input, context: {}, cases: [
    { id: 'first', run: () => driver.click('quantity'), cleanup: () => { cleanup++; } },
    { id: 'later', run: () => { later++; }, cleanup: () => { cleanup++; } },
  ] });
  assert.equal(report.verdict, 'blocked'); assert.equal(cleanup, 0); assert.equal(later, 0); assert.equal(report.cases[1].attempts, 0);
  assert.deepEqual(report.reasonCodes, ['NATIVE_DRIVER_REMOTE_UNSETTLED']);
  assert.deepEqual(report.cases[0].diagnostics.map(row => row.code), ['NATIVE_DRIVER_REMOTE_UNSETTLED', 'NATIVE_DRIVER_COMMAND_FAILED']);
  assert.equal(report.cases[0].cleanup.status, 'unknown'); assert.equal(Object.hasOwn(report.cases[0], 'requestFailure'), false);
  assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report);
  const cancelled = appendNativeRunFailure(structuredClone(report), 'NATIVE_RUN_CANCELLED'); assert.equal(cancelled.verdict, 'cancelled'); assert.deepEqual(sanitizeNativeReport(cancelled, input), cancelled);
  await quarantined(driver, h);
});

test('a later read from an already quarantined driver is trusted uncertainty and cannot start runner cleanup', async t => {
  const h = harness(t), driver = await h.create(); let cleanup = 0, later = 0;
  h.http(route => route.endsWith('/click') ? h.json({ error: 'unknown error' }, 500) : undefined);
  await assert.rejects(driver.click('quantity')); const routes = h.routes.length, owners = h.ownerCount(), input = plan();
  const report = await runNativeCases({ plan: input, cases: [{ id: 'first', run: () => driver.text('session-status'), cleanup: () => { cleanup++; } },
    { id: 'later', run: () => { later++; }, cleanup: () => { cleanup++; } }] });
  assert.equal(report.verdict, 'blocked'); assert.equal(cleanup, 0); assert.equal(later, 0); assert.equal(h.routes.length, routes); assert.equal(h.ownerCount(), owners);
  assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report);
});

test('phase cancellation and timeout carry driver uncertainty after the local callback settles', async t => {
  const h = harness(t);
  for (const mode of ['cancelled', 'timeout']) {
    h.http(undefined); const driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController(); let cleanup = 0, later = 0;
    h.http(route => { if (route.endsWith('/click')) { entered.resolve(); return gate.promise; } }); const input = plan();
    const pending = runNativeCases({ plan: input, signal: controller.signal, timeoutMs: 1234, cases: [
      { id: 'first', run: ({ signal }) => driver.withSignal(signal).click('quantity'), cleanup: () => { cleanup++; } },
      { id: 'later', run: () => { later++; }, cleanup: () => { cleanup++; } },
    ] });
    await entered.promise;
    if (mode === 'cancelled') controller.abort(); else { const timer = [...h.timers.values()].find(row => row.milliseconds === 1234); assert.ok(timer); timer.callback(); }
    const report = await pending; assert.equal(report.verdict, mode === 'cancelled' ? 'cancelled' : 'blocked');
    assert.equal(report.reasonCodes.includes('NATIVE_DRIVER_REMOTE_UNSETTLED'), true); assert.equal(cleanup, 0); assert.equal(later, 0);
    assert.equal(report.cases[0].cleanup.status, 'unknown'); assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report);
    gate.resolve(h.json(null)); await Promise.resolve(); await quarantined(driver, h);
  }
});

test('readiness retains the original semantic failure and cannot acknowledge a quarantined session deletion', async t => {
  const h = harness(t); let report;
  h.http(route => route.endsWith('/click') ? h.json({ error: 'unknown error' }, 500) : undefined);
  await assert.rejects(verifyInstalledIosReadiness({ createNativeDriver: () => h.create(), driverOptions: { deviceBinding: binding() },
    assertOwned: () => true, appPrewarmed: true, preauthControls: true, onPreauthControls: value => { report = value; } }),
  error => { assert.equal(error.code, 'NATIVE_DRIVER_COMMAND_FAILED'); assert.deepEqual(readIosRequestFailure(error), { operation: 'click', phase: 'response' }); return true; });
  assert.equal(report.completed, false); assert.equal(report.sessionCleanupAcknowledged, false);
  assert.equal(report.steps.filter(row => row.completed).length, 8); assert.equal(report.steps.at(-1).controlId, 'quantity');
  assert.equal(h.routes.filter(row => row.method === 'DELETE').length, 0);
});

test('copied installed driver and runner JSON force actual owned Node worker stop without fabricating termination uncertainty', { timeout: 20000 }, async t => {
  const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tld-ios-remote-contract-')));
  let child, childClosed = false;
  const originalSpawn = childProcess.spawn;
  try {
    const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
    for (const file of ['examples/ios-verification/driver.mjs', 'examples/ios-verification/device-scope.mjs', 'examples/ios-verification/setup-ownership.mjs',
      'examples/android-verification/contracts.mjs', 'examples/android-verification/runner.mjs', 'examples/android-verification/driver.mjs', 'examples/android-verification/driver-phase.mjs']) {
      const target = path.join(fixtureRoot, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(sourceRoot, file)));
    }
    const installedDriver = await import(pathToFileURL(path.join(fixtureRoot, 'examples/ios-verification/driver.mjs')));
    const installedRunner = await import(pathToFileURL(path.join(fixtureRoot, 'examples/android-verification/runner.mjs')));
    const h = harness(t, installedDriver.createNativeDriver), driver = await h.create(); let cleanup = 0;
    h.http(route => route.endsWith('/click') ? h.json({ error: 'unknown error' }, 500) : undefined); const input = plan();
    const report = await installedRunner.runNativeCases({ plan: input, cases: [
      { id: 'first', run: () => driver.click('quantity'), cleanup: () => { cleanup++; } },
      { id: 'later', run: () => assert.fail('later case must not start'), cleanup: () => { cleanup++; } },
    ] });
    assert.equal(cleanup, 0); assert.equal(report.cases[0].cleanup.status, 'unknown');
    const wire = JSON.parse(JSON.stringify(report)); assert.deepEqual(sanitizeNativeReport(wire, input), report);
    const closed = Promise.withResolvers();
    childProcess.spawn = function (command, args, options) {
      if (command !== process.execPath || args?.length !== 1 || !args[0].endsWith('worker.mjs')) return originalSpawn(command, args, options);
      const program = 'process.on("message",m=>{if(m.type==="start")process.send({type:"result",report:' + JSON.stringify(wire) + '});});setInterval(()=>{},1000);setTimeout(()=>process.exit(23),15000);';
      child = originalSpawn(command, ['--input-type=module', '--eval', program], options);
      child.once('close', () => { childClosed = true; closed.resolve(); }); return child;
    };
    syncBuiltinESMExports();
    const result = await runNativeWorker({ plan: input, driverOptions: { url: 'http://127.0.0.1:4723', capabilities: caps(), deviceBinding: binding() },
      origin: 'http://127.0.0.1:4555', identities: { editor: { email: 'editor@example.test', role: 'Editor' }, reviewer: { email: 'reviewer@example.test', role: 'Reviewer' } },
      cookies: { editor: randomBytes(24).toString('base64url'), reviewer: randomBytes(24).toString('base64url') }, onRequest: async () => true, timeoutMs: 10000 });
    await closed.promise; assert.equal(childClosed, true);
    assert.notEqual(child.exitCode, 23, 'the host must stop the owned worker before its finite fallback exit');
    assert.equal(result.report.verdict, 'blocked'); assert.equal(result.report.reasonCodes.includes('NATIVE_DRIVER_REMOTE_UNSETTLED'), true);
    assert.equal(result.report.reasonCodes.includes('NATIVE_WORKER_TERMINATION_UNCONFIRMED'), false);
    assert.equal(result.report.reasonCodes.includes('NATIVE_WORKER_RPC_UNSETTLED'), false);
    assert.equal(result.report.reasonCodes.includes('NATIVE_WORKER_FAILED'), false);
    assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(result.report)), input), result.report);
    assert.equal(Object.keys(result).includes('remoteUnsettled'), false, 'IPC adds no private marker field');
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    if (child && !childClosed) { child.kill(); await new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); })); }
    if (!child || childClosed) await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('semantic404 and non-null200 results are never mistaken for successful mutations', async t => {
  const h = harness(t);
  for (const suffix of ['click', 'clear', 'value']) for (const mode of ['missing', 'non-null']) {
    h.http(undefined); const driver = await h.create();
    h.http(route => route.endsWith('/' + suffix) && !route.endsWith('/attribute/value') ?
      h.json(mode === 'missing' ? { error: 'no such element' } : { unexpected: true }, mode === 'missing' ? 404 : 200) : undefined);
    await assert.rejects(suffix === 'click' ? driver.click('quantity') : driver.type('quantity', '3'), error => {
      assert.equal(error.code, mode === 'missing' ? 'NATIVE_DRIVER_COMMAND_FAILED' : 'NATIVE_DRIVER_RESPONSE_INVALID');
      assert.equal(readIosRemoteUnsettled(error), true); return true;
    });
    assert.equal(h.routes.filter(row => row.route.endsWith('/' + suffix) && !row.route.endsWith('/attribute/value')).length >= 1, true);
    await quarantined(driver, h);
  }
});

test('concurrent remote uncertainty survives native-context and visibility reclassification collisions', async t => {
  const h = harness(t);
  for (const mode of ['deadline', 'cancelled']) {
    h.http(undefined); const driver = await h.create(), mutationEntered = Promise.withResolvers(), mutationGate = Promise.withResolvers();
    h.http(route => { if (route.endsWith('/click')) { mutationEntered.resolve(); return mutationGate.promise; } });
    const mutation = assert.rejects(driver.click('quantity')); await mutationEntered.promise;
    const readEntered = Promise.withResolvers(), readGate = Promise.withResolvers(), phase = new AbortController(); let cleanup = 0, later = 0;
    h.http(route => { if (route.endsWith('/context')) { readEntered.resolve(); return readGate.promise; } });
    const input = plan(), pending = runNativeCases({ plan: input, cases: [
      { id: 'first', run: () => driver.withSignal(phase.signal).scrollIntoView('session-status'), cleanup: () => { cleanup++; } },
      { id: 'later', run: () => { later++; }, cleanup: () => { cleanup++; } },
    ] });
    await readEntered.promise;
    if (mode === 'deadline') h.advance(10000.001);
    mutationGate.resolve(h.json({ error: 'unknown error' }, 500)); await mutation;
    if (mode === 'cancelled') phase.abort();
    const report = await pending; assert.equal(report.verdict, 'blocked'); assert.equal(cleanup, 0); assert.equal(later, 0);
    assert.equal(report.reasonCodes.includes('NATIVE_DRIVER_REMOTE_UNSETTLED'), true); assert.equal(report.cases[0].cleanup.status, 'unknown');
    assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report);
    readGate.resolve(h.json('NATIVE_APP')); await Promise.resolve(); await quarantined(driver, h);
  }
});

test('remote uncertainty outranks caught assertion cleanup and also stops a failing cleanup mutation', async t => {
  const h = harness(t);
  for (const stage of ['body', 'cleanup']) {
    h.http(undefined); const driver = await h.create(); let cleanups = 0, later = 0;
    h.http(route => route.endsWith('/click') ? h.json({ error: 'unknown error' }, 500) : undefined); const input = plan();
    const report = await runNativeCases({ plan: input, cases: [{ id: 'first',
      async run({ check }) { try { check(1, 2); } catch {} if (stage === 'body') await driver.click('quantity'); },
      async cleanup() { cleanups++; await driver.click('quantity'); } },
    { id: 'later', run: () => { later++; }, cleanup: () => { cleanups++; } }] });
    assert.equal(report.verdict, 'blocked'); assert.equal(cleanups, stage === 'body' ? 0 : 1); assert.equal(later, 0);
    assert.equal(report.cases[0].cleanup.status, 'unknown'); assert.equal(report.cases[0].diagnostics.some(row => row.code === 'NATIVE_ASSERTION_FAILED'), true);
    assert.equal(report.cases[0].diagnostics.some(row => row.code === 'NATIVE_DRIVER_REMOTE_UNSETTLED'), true);
    assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)), input), report);
  }
});
