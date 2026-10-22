/** Protocol/helper fixtures only; no emulator, accounts, broker or native acceptance is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { androidProofDriverOptions, androidReadinessFailure, verifyInstalledAndroidReadiness } from '../readiness.mjs';
import { createNativeDriver, NativeDriverError } from '../driver.mjs';

const device = () => ({ serial: 'emulator-5556', serverUrl: 'http://127.0.0.1:4723', adbPort: 5039, systemPort: 8211 });
const invocation = () => ({ driverOptions: androidProofDriverOptions(device()), assertOwned: () => true });

test('readiness uses the unchanged frozen worker caps and real driver for one session, context, existing readiness wait and exact close', async () => {
  const calls = [], privateValue = randomBytes(24).toString('base64url');
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    calls.push({ method: req.method, route: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    const value = req.url === '/session' ? { sessionId: 'readiness-session', capabilities: { privateValue } } :
      req.url.endsWith('/context') ? 'NATIVE_APP' : req.url.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'readiness-element' } : null;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const owned = device(); owned.serverUrl = 'http://127.0.0.1:' + server.address().port;
    const options = androidProofDriverOptions(owned);
    const result = await verifyInstalledAndroidReadiness({ createNativeDriver, driverOptions: options, assertOwned: () => true });
    assert.deepEqual(calls.map(({ method, route }) => [method, route]), [
      ['POST', '/session'], ['GET', '/session/readiness-session/context'], ['GET', '/session/readiness-session/context'],
      ['POST', '/session/readiness-session/element'], ['DELETE', '/session/readiness-session'],
    ]);
    assert.deepEqual(calls[3].body, { using: 'accessibility id', value: 'session-status' });
    assert.deepEqual(calls[0].body.capabilities.alwaysMatch, {
      platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': owned.serial,
      'appium:appPackage': 'dev.testlane.androidproof', 'appium:appActivity': '.MainActivity',
      'appium:remoteAdbHost': '127.0.0.1', 'appium:adbPort': owned.adbPort, 'appium:systemPort': owned.systemPort,
      'appium:skipLogcatCapture': true, 'appium:suppressKillServer': true,
      'appium:printPageSourceOnFindFailure': false, 'appium:noReset': true, 'appium:newCommandTimeout': 90,
    });
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(options)); assert.ok(Object.isFrozen(options.capabilities));
    assert.throws(() => { options.capabilities['appium:skipLogcatCapture'] = false; }, TypeError);
    assert.throws(() => { options.url = 'http://example.test'; }, TypeError);
    assert.equal(result.sessionCleanup, 'deleted'); assert.equal(result.nativeContextVerified, true); assert.equal(result.appReadinessObserved, true);
    for (const value of [privateValue, owned.serial, 'readiness-session', 'readiness-element']) assert.equal(JSON.stringify(result).includes(value), false);
    for (const key of ['deviceCleanup', 'cleanupVerified', 'response', 'sessionId']) assert.equal(Object.hasOwn(result, key), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('setup and readiness timings exclude the one close and cannot create teardown claims', async t => {
  let now = 0, closes = 0, waits = 0; t.mock.method(performance, 'now', () => now);
  const options = invocation();
  const result = await verifyInstalledAndroidReadiness({ ...options, createNativeDriver: async supplied => {
    assert.equal(supplied.capabilities, options.driverOptions.capabilities); assert.equal(supplied.url, options.driverOptions.url);
    now = 43000;
    return { context: 'NATIVE_APP', async waitFor(id) { waits++; assert.equal(id, 'session-status'); now += 3000; }, async close() { closes++; now += 4000; } };
  } });
  assert.equal(waits, 1); assert.equal(closes, 1); assert.equal(result.sessionSetupMs, 43000); assert.equal(result.readinessMs, 3000);
  assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'purpose', 'runner', 'installedDriver', 'sessionCreated',
    'nativeContextVerified', 'appReadinessObserved', 'sessionCleanup', 'sessionSetupMs', 'readinessMs'].sort());
});

test('unknown construction and failed context, readiness or close prevent success without a close retry', async () => {
  for (const mode of ['create-failed', 'context-failed', 'wait-failed', 'close-failed', 'close-primitive', 'wait-and-close-failed']) {
    let creates = 0, waits = 0, closes = 0;
    await assert.rejects(verifyInstalledAndroidReadiness({ ...invocation(), createNativeDriver: async () => {
      creates++;
      if (mode === 'create-failed') throw new NativeDriverError('NATIVE_DRIVER_SESSION_TIMEOUT');
      return { context: mode === 'context-failed' ? 'WEBVIEW' : 'NATIVE_APP', async waitFor() {
        waits++; if (mode.startsWith('wait-')) throw new NativeDriverError('NATIVE_DRIVER_READINESS_TIMEOUT');
      }, async close() {
        closes++;
        if (mode === 'close-failed' || mode === 'wait-and-close-failed') throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT');
        if (mode === 'close-primitive') throw null;
      } };
    } }), { code: mode === 'create-failed' ? 'NATIVE_DRIVER_SESSION_TIMEOUT' : mode === 'context-failed' ? 'NATIVE_DRIVER_CONTEXT_REFUSED' :
      mode.startsWith('wait-') ? 'NATIVE_DRIVER_READINESS_TIMEOUT' : mode === 'close-primitive' ? 'NATIVE_DRIVER_COMMAND_FAILED' : 'NATIVE_DRIVER_TIMEOUT' });
    assert.equal(creates, 1); assert.equal(closes, mode === 'create-failed' ? 0 : 1);
    assert.equal(waits, ['create-failed', 'context-failed'].includes(mode) ? 0 : 1);
  }
});

test('cancellation before construction, during readiness and during close cannot open the credential gate', async () => {
  const before = new AbortController(); before.abort(); let creates = 0, closes = 0, waits = 0;
  await assert.rejects(verifyInstalledAndroidReadiness({ ...invocation(), signal: before.signal,
    createNativeDriver: async () => { creates++; } }), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.equal(creates, 0); assert.equal(closes, 0);
  for (const point of ['create', 'wait', 'close']) {
    const active = new AbortController();
    await assert.rejects(verifyInstalledAndroidReadiness({ ...invocation(), signal: active.signal, createNativeDriver: async () => {
      creates++; if (point === 'create') active.abort();
      return { context: 'NATIVE_APP', async waitFor() { waits++; if (point === 'wait') active.abort(); },
        async close() { closes++; if (point === 'close') active.abort(); } };
    } }), { code: 'NATIVE_DRIVER_CANCELLED' });
  }
  assert.equal(creates, 3); assert.equal(closes, 3); assert.equal(waits, 2);
});

test('failure status reads only trusted own primitive codes and omits arbitrary errors, accessors, proxies and raw messages', async () => {
  let touched = 0;
  const secret = randomBytes(24).toString('base64url'), getter = new NativeDriverError('NATIVE_DRIVER_TIMEOUT');
  Object.defineProperty(getter, 'code', { get() { touched++; throw Error(secret); } });
  const revoked = Proxy.revocable(Error(secret), {}); revoked.revoke();
  const values = [null, secret, Error(secret), { code: 'NATIVE_DRIVER_TIMEOUT', message: secret },
    Object.assign(Object.create(NativeDriverError.prototype), { code: 'NATIVE_DRIVER_TIMEOUT' }), getter, revoked.proxy,
    new Proxy(new NativeDriverError('NATIVE_DRIVER_TIMEOUT'), { getPrototypeOf() { touched++; throw Error(secret); }, get() { touched++; throw Error(secret); } }),
    new NativeDriverError(secret), new NativeDriverError(['NATIVE_DRIVER_TIMEOUT'])];
  for (const value of values) {
    const record = androidReadinessFailure(value);
    assert.equal(record.code, 'NATIVE_DRIVER_COMMAND_FAILED'); assert.equal(JSON.stringify(record).includes(secret), false);
    assert.deepEqual(Object.keys(record).sort(), ['schemaVersion', 'purpose', 'runner', 'status', 'stage', 'code'].sort());
    await assert.rejects(verifyInstalledAndroidReadiness({ ...invocation(), createNativeDriver: async () => { throw value; } }),
      error => error instanceof NativeDriverError && error.code === 'NATIVE_DRIVER_COMMAND_FAILED' && !error.message.includes(secret));
  }
  for (const code of ['NATIVE_DRIVER_SESSION_TIMEOUT', 'NATIVE_DRIVER_CANCELLED', 'NATIVE_DRIVER_OWNERSHIP_REFUSED']) {
    const error = new NativeDriverError(code); error.message = secret;
    assert.equal(androidReadinessFailure(error).code, code); assert.equal(JSON.stringify(androidReadinessFailure(error)).includes(secret), false);
  }
  assert.equal(touched, 0);
});
