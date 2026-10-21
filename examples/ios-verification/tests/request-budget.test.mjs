import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNativeDriver, readIosRequestFailure } from '../driver.mjs';
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

test('a settled 4.7-second owner check leaves a fresh five-second HTTP phase inside the ten-second aggregate', async t => {
  const h = harness(t), driver = await h.create(); let owners = 0, clicked = false;
  h.owner(() => { if (++owners === 4) h.advance(4700); return true; });
  h.http(route => { if (route.endsWith('/click')) { clicked = true; assert.equal([...h.timers.values()][0].milliseconds, 5000); h.advance(300); } });
  await driver.click('create-request');
  assert.equal(clicked, true); assert.equal(h.now(), 5000);
  assert.equal(h.durations.slice(-2).every(ms => ms === 5000), true);
  await driver.close(); assert.equal(h.timers.size, 0);
});

test('a fractional late settled owner result cannot send HTTP, but is not confused with an outstanding owner', async t => {
  const h = harness(t), driver = await h.create(); let owners = 0;
  h.owner(() => { if (++owners === 4) h.advance(5000.001); return true; });
  await assert.rejects(driver.click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT');
    assert.deepEqual(readIosRequestFailure(error), { operation: 'click', phase: 'ownership' }); return true;
  });
  assert.equal(h.routes.some(call => call.route.endsWith('/click')), false);
  h.owner(() => true); await driver.close(); assert.equal(h.routes.at(-1).method, 'DELETE');
});

test('HTTP and the entire response body retain one five-second phase after a slow settled owner', async t => {
  const h = harness(t), driver = await h.create(); let owners = 0, reads = 0;
  h.owner(() => { if (++owners === 4) h.advance(4700); return true; });
  h.http(route => route.endsWith('/click') ? { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
    if (++reads === 1) { h.advance(4999); return { done: false, value: Buffer.from('{"value":null}') }; }
    h.advance(1.001); return { done: true };
  } }) } } : undefined);
  await assert.rejects(driver.click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT');
    assert.deepEqual(readIosRequestFailure(error), { operation: 'click', phase: 'response' }); return true;
  });
  assert.equal(reads, 2); assert.equal(h.now(), 9700.001);
  h.http(undefined); await driver.close(); assert.equal(h.timers.size, 0);
});

test('visibility clips both phases to its immutable ten-second window and never sends the next lookup or action late', async t => {
  const h = harness(t), driver = await h.create(); let owners = 0;
  h.owner(() => { h.advance(++owners === 1 ? 4700 : 2300.001); return true; });
  h.http(route => { if (route.endsWith('/context')) h.advance(3000); });
  await assert.rejects(driver.click('selected-id'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_ELEMENT_TIMEOUT');
    assert.deepEqual(readIosRequestFailure(error), { operation: 'element-find', phase: 'ownership' }); return true;
  });
  assert.equal(owners, 2); assert.equal(h.routes.some(call => /\/element|\/actions/.test(call.route)), false);
  h.owner(() => true); h.http(undefined); await driver.close();
});

test('read-only presence includes its native context in the monotonic ten-second window', async t => {
  const h = harness(t), driver = await h.create(); let owners = 0;
  h.owner(() => { h.advance(++owners === 1 ? 4700 : 2300.001); return true; });
  h.http(route => { if (route.endsWith('/context')) h.advance(3000); });
  await assert.rejects(driver.waitFor('session-status'), { code: 'NATIVE_DRIVER_READINESS_TIMEOUT' });
  assert.equal(owners, 2); assert.equal(h.routes.some(call => call.route.endsWith('/element')), false);
  h.owner(() => true); h.http(undefined); await driver.close();
});

test('keyboard confirmation keeps one five-second monotonic window across ownership and response', async t => {
  const h = harness(t), driver = await h.create(); let hidden = false, confirmationOwner = false;
  h.http(route => {
    if (route.endsWith('/hide_keyboard')) { hidden = true; return h.json(null); }
    if (route.endsWith('/is_keyboard_shown')) {
      if (hidden) { assert.equal(confirmationOwner, true); h.advance(300.001); }
      return h.json(!hidden);
    }
  });
  h.owner(() => { if (hidden) { h.advance(4700); confirmationOwner = true; } return true; });
  await assert.rejects(driver.hideKeyboard(), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT');
    assert.deepEqual(readIosRequestFailure(error), { operation: 'keyboard-state', phase: 'http' }); return true;
  });
  assert.equal(h.routes.filter(call => call.route.endsWith('/hide_keyboard')).length, 1);
  assert.equal(h.routes.filter(call => call.route.endsWith('/is_keyboard_shown')).length, 2);
  h.owner(() => true); h.http(undefined); await driver.close();
});

test('session creation clips slow ownership and all HTTP/body work to the original 240-second deadline', async t => {
  const h = harness(t); let owners = 0;
  h.owner(() => { if (++owners === 1) h.advance(4700); return true; });
  h.http(route => {
    if (route === '/session') { assert.equal([...h.timers.values()][0].milliseconds, 235300); h.advance(235300.001); }
  });
  await assert.rejects(h.create(), { code: 'NATIVE_DRIVER_SESSION_TIMEOUT' });
  assert.equal(owners, 1); assert.deepEqual(h.routes.map(call => call.route), ['/session']); assert.equal(h.timers.size, 0);
});

test('ownership timeout and cancellation permanently fence guards, HTTP and DELETE even after a late ACK', async t => {
  const h = harness(t);
  for (const mode of ['timeout', 'cancelled']) {
    const driver = await h.create(), entered = Promise.withResolvers(), gate = Promise.withResolvers(), phase = new AbortController();
    h.owner(() => { entered.resolve(); return gate.promise; });
    const rejected = assert.rejects(driver.withSignal(phase.signal).click('selected-id'), { code: mode === 'timeout' ? 'NATIVE_DRIVER_CONTEXT_TIMEOUT' : 'NATIVE_DRIVER_CANCELLED' });
    await entered.promise;
    if (mode === 'timeout') h.expire(); else phase.abort();
    await rejected; const owners = h.ownerCount(), routes = h.routes.length;
    for (const action of [() => driver.close(), () => driver.waitFor('session-status'), () => driver.click('selected-id')]) {
      await assert.rejects(action(), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    }
    gate.resolve(true); await Promise.resolve(); await Promise.resolve();
    await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    assert.equal(h.ownerCount(), owners); assert.equal(h.routes.length, routes); assert.equal(h.timers.size, 0);
    h.owner(undefined);
  }
});

test('settled false, synchronous throw and rejection refuse ownership without inventing a pending callback', async t => {
  const h = harness(t), driver = await h.create(), secret = randomBytes(32).toString('base64url');
  for (const owner of [() => false, () => { throw Error(secret); }, () => Promise.reject(Error(secret))]) {
    h.owner(owner); const routes = h.routes.length;
    await assert.rejects(driver.click('selected-id'), error => {
      assert.equal(error.code, 'NATIVE_DRIVER_OWNERSHIP_REFUSED'); assert.equal(String(error.stack).includes(secret), false); return true;
    });
    assert.equal(h.routes.length, routes);
  }
  h.owner(undefined); await driver.close(); assert.equal(h.routes.at(-1).method, 'DELETE');
});

test('cancellation between queuing and executing ownership invokes neither the owner nor HTTP', async t => {
  const h = harness(t), driver = await h.create(), phase = new AbortController();
  const owners = h.ownerCount(), routes = h.routes.length;
  const rejected = assert.rejects(driver.withSignal(phase.signal).click('selected-id'), { code: 'NATIVE_DRIVER_CANCELLED' });
  phase.abort(); await rejected;
  assert.equal(h.ownerCount(), owners); assert.equal(h.routes.length, routes);
  await driver.close();
});

test('cancellation after settled true ownership cannot enqueue HTTP and leaves independent close available', async t => {
  const h = harness(t), driver = await h.create(), phase = new AbortController(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const routes = h.routes.length;
  h.owner(() => { entered.resolve(); return gate.promise; });
  const rejected = assert.rejects(driver.withSignal(phase.signal).click('selected-id'), { code: 'NATIVE_DRIVER_CANCELLED' });
  await entered.promise; gate.resolve(true); await Promise.resolve(); phase.abort(); await rejected;
  assert.equal(h.routes.length, routes, 'cancellation after settled ownership cannot enqueue HTTP');
  h.owner(undefined); await driver.close();
  assert.equal(h.routes.length, routes + 1); assert.equal(h.routes.at(-1).method, 'DELETE');
});

test('a body read ignoring abort is bounded without allowing late chunks to resume the request', async t => {
  const h = harness(t), driver = await h.create(), gate = Promise.withResolvers(), entered = Promise.withResolvers(); let reads = 0;
  h.http(route => route.endsWith('/click') ? { ok: true, status: 200, body: { getReader: () => ({ read() { reads++; entered.resolve(); return gate.promise; } }) } } : undefined);
  const rejected = assert.rejects(driver.click('selected-id'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT'); assert.deepEqual(readIosRequestFailure(error), { operation: 'click', phase: 'response' }); return true;
  });
  await entered.promise; h.expire(); await rejected; const routes = h.routes.length;
  gate.resolve({ done: false, value: Buffer.from('{"value":null}') }); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1); assert.equal(h.routes.length, routes);
  h.http(undefined); await driver.close(); assert.equal(h.timers.size, 0);
});

test('a pending-owner fence also interrupts a concurrent HTTP operation without allowing late resumption', async t => {
  const h = harness(t), driver = await h.create(), httpEntered = Promise.withResolvers(), httpGate = Promise.withResolvers();
  h.http(route => { if (route.endsWith('/click')) { httpEntered.resolve(); return httpGate.promise; } });
  const first = assert.rejects(driver.click('create-request'), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
  await httpEntered.promise;
  const ownerEntered = Promise.withResolvers(), ownerGate = Promise.withResolvers(), phase = new AbortController();
  h.owner(() => { ownerEntered.resolve(); return ownerGate.promise; });
  const second = assert.rejects(driver.withSignal(phase.signal).waitFor('session-status'), { code: 'NATIVE_DRIVER_CANCELLED' });
  await ownerEntered.promise; phase.abort(); await Promise.all([first, second]);
  const routes = h.routes.length, owners = h.ownerCount();
  ownerGate.resolve(true); httpGate.resolve(h.json(null)); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
  assert.equal(h.routes.length, routes); assert.equal(h.ownerCount(), owners); assert.equal(h.timers.size, 0);
});

test('JSON decoding time remains part of the HTTP body deadline and cannot accept a fractional late result', async t => {
  const h = harness(t), driver = await h.create(), parse = JSON.parse; let decoding = false;
  h.http(route => { if (route.endsWith('/click')) { decoding = true; return h.json(null); } });
  t.mock.method(JSON, 'parse', text => { const decoded = parse(text); if (decoding) { decoding = false; h.advance(5000.001); } return decoded; });
  await assert.rejects(driver.click('create-request'), error => {
    assert.equal(error.code, 'NATIVE_DRIVER_TIMEOUT');
    assert.deepEqual(readIosRequestFailure(error), { operation: 'click', phase: 'response' }); return true;
  });
  h.http(undefined); await driver.close();
});

test('setup context ownership and HTTP are clipped to the absolute original session deadline', async t => {
  const h = harness(t); let owners = 0;
  h.owner(() => { if (++owners === 3) h.advance(3000); return true; });
  h.http(route => {
    if (route === '/session') h.advance(236000);
    if (route.endsWith('/context')) { assert.equal([...h.timers.values()][0].milliseconds, 1000); h.advance(1000.001); }
  });
  await assert.rejects(h.create(), { code: 'NATIVE_DRIVER_SESSION_TIMEOUT' });
  assert.deepEqual(h.routes.map(call => call.method), ['POST', 'GET', 'DELETE']);
  assert.equal(owners, 4, 'actual settled ownership permits independently guarded exact-session cleanup');
  assert.equal(h.timers.size, 0);
});
