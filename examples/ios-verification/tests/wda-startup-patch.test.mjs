/** Fixed startup lease contracts; no Apple commands or optional tool installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WDA_STARTUP_BLOCK, WDA_STARTUP_PATCH, patchedWdaStartup } from '../tools/wda-startup-patch.mjs';

const execute = new (Object.getPrototypeOf(async function () {}).constructor)('driver', 'wdaCaps', WDA_STARTUP_BLOCK);
function fixture() {
  const seen = [], proxy = { timeout: 5000, _activeRequests: [], getUrlForProxy: () => 'http://127.0.0.1:8211/session',
    request(config) { seen.push(config); return Promise.resolve(); } };
  const driver = { opts: { wdaConnectionTimeout: 5000 }, wda: { jwproxy: proxy, noSessionProxy: { timeout: 5000 } },
    proxyCommand(route, method, body) { return proxy.request({ url: proxy.getUrlForProxy(route, method), method, timeout: proxy.timeout, data: body }); } };
  return { driver, proxy, seen };
}
test('the startup lease changes exactly one request config and restores own/prototype method state', async () => {
  for (const own of [true, false]) {
    const { driver, proxy, seen } = fixture();
    if (!own) { const request = proxy.request; delete proxy.request; Object.setPrototypeOf(proxy, { request }); }
    const before = Object.getOwnPropertyDescriptor(proxy, 'request'), request = proxy.request;
    await execute(driver, {});
    assert.equal(seen.length, 1); assert.equal(seen[0].timeout, 30000);
    assert.equal(proxy.timeout, 5000); assert.equal(driver.wda.noSessionProxy.timeout, 5000);
    assert.equal(proxy.request, request); assert.deepEqual(Object.getOwnPropertyDescriptor(proxy, 'request'), before);
    await proxy.request({ method: 'GET', timeout: proxy.timeout }); assert.equal(seen[1].timeout, 5000);
  }
});
test('rejected transport and synchronous command failures restore the exact method without copying error payloads into policy', async () => {
  for (const synchronous of [true, false]) {
    const { driver, proxy } = fixture(), request = proxy.request;
    const secret = randomBytes(24).toString('base64url'), failure = Error(secret);
    if (synchronous) driver.proxyCommand = () => { throw failure; };
    else proxy.request = () => Promise.reject(failure);
    const original = proxy.request;
    await assert.rejects(execute(driver, {}), error => error === failure);
    assert.equal(proxy.request, original); assert.equal(proxy.timeout, 5000);
    assert.equal(JSON.stringify(WDA_STARTUP_PATCH).includes(secret), false);
    if (synchronous) assert.equal(original, request);
  }
});
test('pending startup refuses concurrent ordinary and duplicate requests without starting another transport', async () => {
  const { driver, proxy } = fixture(), gate = Promise.withResolvers(), seen = [];
  proxy.request = config => { seen.push(config); return gate.promise; }; const original = proxy.request;
  const startup = execute(driver, {});
  await assert.rejects(async () => proxy.request({ url: 'http://127.0.0.1:8211/session/known/element/a/click', method: 'POST', timeout: 5000 }), { message: 'TESTLANE_WDA_STARTUP_SCOPE_REFUSED' });
  await assert.rejects(execute(driver, {}), { message: 'TESTLANE_WDA_STARTUP_SCOPE_REFUSED' });
  assert.equal(seen.length, 1); assert.equal(proxy.timeout, 5000);
  gate.resolve(); await startup; assert.equal(proxy.request, original);
});
test('an externally cancelled unresolved transport cannot be declared settled or resume ordinary requests', async () => {
  const { driver, proxy } = fixture(), gate = Promise.withResolvers();
  proxy.request = () => gate.promise; const original = proxy.request;
  let settled = false; const startup = execute(driver, {}).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.notEqual(proxy.request, original);
  assert.throws(() => proxy.request({ url: 'http://127.0.0.1:8211/session/known/context', method: 'GET', timeout: 5000 }), { message: 'TESTLANE_WDA_STARTUP_SCOPE_REFUSED' });
  // This fixture can positively settle its owned transport; a real cancelled
  // Appium proxy may never settle and then requires whole owned-process teardown.
  gate.reject(Error('CONTROLLED_TRANSPORT_CLOSED'));
  await assert.rejects(startup, { message: 'CONTROLLED_TRANSPORT_CLOSED' });
  assert.equal(settled, true); assert.equal(proxy.request, original);
});
test('non-owned URLs, command timeout wrappers, wrong defaults and active requests fail before a transport starts', async () => {
  const changes = [
    ({ driver }) => { driver.opts.commandTimeouts = { createSession: 1 }; },
    ({ driver }) => { driver.opts.wdaConnectionTimeout = 30000; },
    ({ proxy }) => { proxy.timeout = 30000; },
    ({ proxy }) => { proxy._activeRequests.push({}); },
    ...['http://localhost:8211/session', 'https://127.0.0.1:8211/session', 'http://127.0.0.1:8211/session?x=1', 'http://127.0.0.1:8211/not-session']
      .map(url => ({ proxy }) => { proxy.getUrlForProxy = () => url; }),
  ];
  for (const change of changes) {
    const owned = fixture(); change(owned);
    await assert.rejects(execute(owned.driver, {}), { message: 'TESTLANE_WDA_STARTUP_SCOPE_REFUSED' });
    assert.equal(owned.seen.length, 0);
  }
});
test('source drift and unrecognized patch input are refused with a fixed code', () => {
  for (const input of [Buffer.from(randomBytes(32)), Buffer.from(''), 'not-bytes', null]) {
    assert.throws(() => patchedWdaStartup(input), { message: 'IOS_WDA_STARTUP_PATCH_REFUSED' });
  }
  assert.equal(WDA_STARTUP_PATCH.ordinaryTimeoutMs, 5000); assert.equal(WDA_STARTUP_PATCH.startupTimeoutMs, 30000);
  assert.match(WDA_STARTUP_PATCH.originalSha256, /^[a-f0-9]{64}$/); assert.match(WDA_STARTUP_PATCH.patchedSha256, /^[a-f0-9]{64}$/);
});
