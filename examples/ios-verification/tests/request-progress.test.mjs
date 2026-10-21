import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNativeDriver, NativeDriverError, readIosRequestFailure, readIosRequestProgress } from '../driver.mjs';
import { verifyInstalledIosReadiness } from '../readiness.mjs';
import { publicIosFailure } from '../failure.mjs';
import { fileURLToPath } from 'node:url';
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

function harness(t) {
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
    create(options = {}) { return createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(),
      assertOwned: () => { ownerCount++; return ownerHook ? ownerHook() : true; }, ...options }); },
  };
}

test('full HTTP wait records actual dispatch after settled ownership without claiming headers', async t => {
  const h = harness(t), driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let owners = 0, failure;
  h.owner(() => { if (++owners === 4) h.advance(4700); return true; });
  h.http(route => { if (route.endsWith('/click')) { entered.resolve(); return gate.promise; } });
  const rejected = assert.rejects(driver.click('create-request'), error => { failure = error; return error.code === 'NATIVE_DRIVER_TIMEOUT'; });
  await entered.promise; h.advance(10000); h.expire(); await rejected;
  const progress = readIosRequestProgress(failure);
  assert.deepEqual(progress, { ownershipElapsedMs: 4700, effectiveHttpBudgetMs: 10000, httpBodyElapsedMs: 10000,
    budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: false });
  assert.equal(Object.isFrozen(progress), true); gate.resolve(h.json(null)); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(readIosRequestProgress(failure), progress);
  h.http(undefined); await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
});

test('caller clipping before dispatch survives visible reclassification with no invented fetch or headers', async t => {
  const h = harness(t), driver = await h.create(), stringify = JSON.stringify; let owners = 0;
  h.owner(() => { h.advance(2000); owners++; return true; });
  h.http(route => { if (route.endsWith('/context')) h.advance(2000); });
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.using === 'accessibility id') h.advance(4000.125);
    return stringify(value, ...args);
  });
  await assert.rejects(driver.scrollIntoView('run-marker'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_ELEMENT_TIMEOUT');
    assert.deepEqual(readIosRequestFailure(error), { operation: 'element-find', phase: 'http' });
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 2000, effectiveHttpBudgetMs: 4000, httpBodyElapsedMs: 4000.125,
      budgetSource: 'caller-outer', fetchInvoked: false, responseHeadersObserved: false }); return true;
  });
  assert.equal(owners, 2); assert.equal(h.routes.some(row => row.route.endsWith('/element')), false);
  h.owner(undefined); h.http(undefined); await driver.close();
});

test('late observed headers remain distinguishable from a response-body failure', async t => {
  const h = harness(t), driver = await h.create();
  h.http(route => { if (route.endsWith('/click')) { h.advance(10000.125); return h.json(null); } });
  await assert.rejects(driver.click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT'); assert.deepEqual(readIosRequestFailure(error), { operation: 'click', phase: 'http' });
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 10000, httpBodyElapsedMs: 10000.125,
      budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: true }); return true;
  });
  h.http(undefined); await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
});

test('body timeout freezes observed headers and elapsed time before a late uncooperative body returns', async t => {
  const h = harness(t), driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let failure;
  h.http(route => route.endsWith('/click') ? { ok: true, status: 200, body: { getReader: () => ({ read() { entered.resolve(); return gate.promise; } }) } } : undefined);
  const rejected = assert.rejects(driver.click('create-request'), error => { failure = error; return error.code === 'NATIVE_DRIVER_TIMEOUT'; });
  await entered.promise; h.advance(10000); h.expire(); await rejected;
  const progress = readIosRequestProgress(failure);
  assert.deepEqual(readIosRequestFailure(failure), { operation: 'click', phase: 'response' });
  assert.deepEqual(progress, { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 10000, httpBodyElapsedMs: 10000,
    budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: true });
  h.advance(1200); gate.resolve({ done: true }); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(readIosRequestProgress(failure), progress); h.http(undefined); await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
});

test('settled-owner cancellation during encoding records no dispatch and keeps independently guarded close', async t => {
  const h = harness(t), driver = await h.create(), phase = new AbortController(), stringify = JSON.stringify; let owners = 0, cancelEncoding = false;
  h.owner(() => { if (++owners === 4) cancelEncoding = true; return true; });
  t.mock.method(JSON, 'stringify', (value, ...args) => { if (cancelEncoding) { cancelEncoding = false; phase.abort(); } return stringify(value, ...args); });
  await assert.rejects(driver.withSignal(phase.signal).click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_CANCELLED');
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 10000, httpBodyElapsedMs: 0,
      budgetSource: 'http-body', fetchInvoked: false, responseHeadersObserved: false }); return true;
  });
  assert.equal(h.routes.some(row => row.route.endsWith('/click')), false); h.owner(undefined); await driver.close();
});

test('serialization failure records a settled owner without implying an HTTP call', async t => {
  const h = harness(t), driver = await h.create(), stringify = JSON.stringify; let owners = 0, failEncoding = false;
  h.owner(() => { if (++owners === 4) failEncoding = true; return true; });
  t.mock.method(JSON, 'stringify', (value, ...args) => { if (failEncoding) { failEncoding = false; throw Error(randomBytes(24).toString('base64url')); } return stringify(value, ...args); });
  await assert.rejects(driver.click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_COMMAND_FAILED');
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 10000, httpBodyElapsedMs: 0,
      budgetSource: 'http-body', fetchInvoked: false, responseHeadersObserved: false }); return true;
  });
  assert.equal(h.routes.some(row => row.route.endsWith('/click')), false); h.owner(undefined); await driver.close();
});

test('pending-owner interruption supplies no fictitious completed duration and keeps its permanent fence', async t => {
  const h = harness(t);
  for (const mode of ['cancelled', 'timeout']) {
    const driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(), phase = new AbortController(); let failure;
    h.owner(() => { entered.resolve(); return gate.promise; });
    const rejected = assert.rejects(driver.withSignal(phase.signal).click('run-marker'), error => { failure = error; return error.code === (mode === 'cancelled' ? 'NATIVE_DRIVER_CANCELLED' : 'NATIVE_DRIVER_CONTEXT_TIMEOUT'); });
    await entered.promise;
    if (mode === 'cancelled') { h.advance(1234); phase.abort(); } else { h.advance(5000.125); h.expire(); }
    await rejected; assert.equal(readIosRequestProgress(failure), undefined);
    gate.resolve(true); await Promise.resolve(); await Promise.resolve();
    await assert.rejects(driver.close(), error => { assert.equal(error.code, 'NATIVE_DRIVER_OWNERSHIP_REFUSED'); assert.equal(readIosRequestProgress(error), undefined); return true; });
    assert.equal(h.timers.size, 0); h.owner(undefined);
  }
});

test('false and rejected owners cannot promote arbitrary progress into a failed preauth row', async t => {
  const h = harness(t), driver = await h.create();
  for (const callback of [() => false, () => Promise.reject(Error(randomBytes(24).toString('base64url')))]) {
    h.owner(callback); await assert.rejects(driver.click('run-marker'), error => { assert.equal(error.code, 'NATIVE_DRIVER_OWNERSHIP_REFUSED'); assert.equal(readIosRequestProgress(error), undefined); return true; });
  }
  h.owner(undefined); await driver.close();
});

test('caller ties are labeled conservatively, without claiming a unique full-phase or outer cause', async t => {
  const h = harness(t), driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let owners = 0;
  h.owner(() => { if (++owners === 1) h.advance(4000); return true; });
  h.http(route => { if (route.endsWith('/context')) h.advance(1000); if (route.endsWith('/element')) { entered.resolve(); return gate.promise; } });
  const rejected = assert.rejects(driver.scrollIntoView('run-marker'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_ELEMENT_TIMEOUT');
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 5000, httpBodyElapsedMs: 5000,
      budgetSource: 'caller-outer', fetchInvoked: true, responseHeadersObserved: false }); return true;
  });
  await entered.promise; h.advance(5000); h.expire(); await rejected;
  gate.resolve(h.json(null)); h.owner(undefined); h.http(undefined); await driver.close();
});

test('a cooperative scheduling gap can select the unchanged request-total bound', async t => {
  const h = harness(t), driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(), clear = globalThis.clearTimeout;
  let owners = 0, gap = false;
  h.owner(() => { if (++owners === 4) { h.advance(4999); gap = true; } return true; });
  t.mock.method(globalThis, 'clearTimeout', handle => { clear(handle); if (gap) { gap = false; h.advance(1.25); } });
  h.http(route => { if (route.endsWith('/click')) { entered.resolve(); return gate.promise; } });
  const rejected = assert.rejects(driver.click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT');
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 5000.25, effectiveHttpBudgetMs: 9999.75, httpBodyElapsedMs: 9999.75,
      budgetSource: 'request-total', fetchInvoked: true, responseHeadersObserved: false }); return true;
  });
  await entered.promise; h.advance(9999.75); h.expire(); await rejected;
  gate.resolve(h.json(null)); h.owner(undefined); h.http(undefined); await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
});

test('session timeout keeps its original total and preserves the immutable progress through its wrapper', async t => {
  const h = harness(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  h.owner(() => { h.advance(4700); return true; });
  h.http(route => { if (route === '/session') { entered.resolve(); return gate.promise; } });
  const rejected = assert.rejects(h.create(), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_SESSION_TIMEOUT');
    assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 4700, effectiveHttpBudgetMs: 235300, httpBodyElapsedMs: 235300,
      budgetSource: 'caller-outer', fetchInvoked: true, responseHeadersObserved: false }); return true;
  });
  await entered.promise; h.advance(235300); h.expire(); await rejected; gate.resolve(h.json({ sessionId: 'late-owned-session' }));
  assert.equal(h.timers.size, 0);
});

test('native-context and read-only presence wrappers preserve their actual HTTP progress', async t => {
  const h = harness(t);
  for (const stage of ['context', 'element']) {
    const driver = stage === 'element' ? await h.create() : undefined, entered = Promise.withResolvers(), gate = Promise.withResolvers();
    h.http(route => { if (route.endsWith('/' + stage)) { entered.resolve(); return gate.promise; } });
    const rejected = assert.rejects(driver ? driver.waitFor('session-status') : h.create(), error => {
      assert.equal(error.code, stage === 'context' ? 'NATIVE_DRIVER_CONTEXT_TIMEOUT' : 'NATIVE_DRIVER_READINESS_TIMEOUT');
      assert.deepEqual(readIosRequestProgress(error), { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 5000, httpBodyElapsedMs: 5000,
        budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: false }); return true;
    });
    await entered.promise; h.advance(5000); h.expire(); await rejected;
    gate.resolve(h.json(null)); h.http(undefined); if (driver) await driver.close();
    assert.equal(h.timers.size, 0);
  }
});

test('cancellation while awaiting headers records dispatch without promoting a late response', async t => {
  const h = harness(t), driver = await h.create(), phase = new AbortController(), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let failure;
  h.http(route => { if (route.endsWith('/click')) { entered.resolve(); return gate.promise; } });
  const rejected = assert.rejects(driver.withSignal(phase.signal).click('create-request'), error => { failure = error; return error.code === 'NATIVE_DRIVER_CANCELLED'; });
  await entered.promise; h.advance(333.25); phase.abort(); await rejected;
  const progress = readIosRequestProgress(failure);
  assert.deepEqual(progress, { ownershipElapsedMs: 0, effectiveHttpBudgetMs: 10000, httpBodyElapsedMs: 333.25,
    budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: false });
  gate.resolve(h.json(null)); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(readIosRequestProgress(failure), progress);
  h.http(undefined); await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
});

test('readiness and preauth wrappers preserve an early fractional timer snapshot without changing top-level failure facts', async t => {
  const h = harness(t), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let contexts = 0, preauth = false, report, failure;
  h.owner(() => { if (preauth) h.advance(123.5); return true; });
  h.http(route => {
    if (route.endsWith('/context') && ++contexts === 2) preauth = true;
    if (route.endsWith('/element')) { entered.resolve(); return gate.promise; }
  });
  const rejected = assert.rejects(verifyInstalledIosReadiness({ createNativeDriver: options => h.create({ signal: options.signal }),
    driverOptions: { deviceBinding: binding() }, assertOwned: () => true, appPrewarmed: true, preauthControls: true,
    onPreauthControls: value => { report = value; } }), error => { failure = error; return error.code === 'NATIVE_DRIVER_TIMEOUT'; });
  await entered.promise; h.advance(4999.25); h.expire(); await rejected;
  const expected = { ownershipElapsedMs: 123.5, effectiveHttpBudgetMs: 5000, httpBodyElapsedMs: 4999.25,
    budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: false };
  assert.deepEqual(readIosRequestProgress(failure), expected); assert.equal(report.sessionCleanupAcknowledged, true);
  assert.deepEqual(report.steps, [{ controlId: 'run-marker', step: 'visibility', completed: false, code: 'NATIVE_DRIVER_TIMEOUT',
    request: { operation: 'element-find', phase: 'http' }, requestProgress: expected }]);
  assert.equal(Object.isFrozen(report.steps[0].requestProgress), true);
  const summary = await publicIosFailure({ output: fileURLToPath(new URL('absent-progress-plan', import.meta.url)), stage: 'wda-readiness', error: failure });
  assert.deepEqual(summary.requestFailure, { operation: 'element-find', phase: 'http' }); assert.equal(Object.hasOwn(summary, 'requestProgress'), false);
  const frozen = JSON.stringify(report); h.advance(200); gate.resolve(h.json(null)); await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.stringify(report), frozen);
});

test('progress readers accept only exact own primitive fields, without evaluating accessors or proxies', () => {
  const value = { ownershipElapsedMs: 1.25, effectiveHttpBudgetMs: 5000, httpBodyElapsedMs: 3.5, budgetSource: 'http-body', fetchInvoked: true, responseHeadersObserved: false };
  const fact = { operation: 'element-find', phase: 'http' }, secret = randomBytes(32).toString('base64url'); let touched = 0;
  const valid = new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact, value); value.httpBodyElapsedMs = 9000;
  assert.equal(readIosRequestProgress(valid).httpBodyElapsedMs, 3.5); assert.equal(Object.isFrozen(readIosRequestProgress(valid)), true);
  for (const progress of [{ ...value, extra: secret }, { ...value, ownershipElapsedMs: NaN }, { ...value, effectiveHttpBudgetMs: Infinity },
    { ...value, ownershipElapsedMs: -1 }, { ...value, httpBodyElapsedMs: 3_600_001 }, { ...value, effectiveHttpBudgetMs: 240001 },
    { ...value, budgetSource: secret }, { ...value, fetchInvoked: secret }, { ...value, fetchInvoked: false, responseHeadersObserved: true },
    Object.defineProperty({ ...value }, 'httpBodyElapsedMs', { get() { touched++; return 1; } }),
    new Proxy(value, { get() { touched++; throw Error(secret); }, ownKeys() { touched++; throw Error(secret); } })]) {
    const error = new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact, progress); assert.equal(readIosRequestProgress(error), undefined);
  }
  for (const error of [Object.assign(Error(secret), { requestProgress: value }), new Proxy(valid, { get() { touched++; throw Error(secret); } }),
    Object.defineProperty(new NativeDriverError('NATIVE_DRIVER_TIMEOUT', fact), 'requestProgress', { get() { touched++; return value; } })]) {
    assert.equal(readIosRequestProgress(error), undefined);
  }
  assert.equal(touched, 0);
  for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) assert.equal(JSON.stringify(readIosRequestProgress(valid)).includes(variant), false);
  assert.equal(readIosRequestProgress(new NativeDriverError('NATIVE_DRIVER_TIMEOUT', { operation: 'element-find', phase: 'ownership' }, value)), undefined);
});
