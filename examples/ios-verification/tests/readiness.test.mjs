import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { iosProofDriverOptions, verifyInstalledIosReadiness } from '../readiness.mjs';
import { createNativeDriver, NativeDriverError } from '../driver.mjs';
import { IOS_DEVICE_SCOPE } from '../device-scope.mjs';

function device() {
  const deviceBinding = { schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome: '/Users/runner',
    deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
    udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) };
  return { deviceBinding, udid: deviceBinding.udid, deviceSetPath: deviceBinding.deviceSetPath,
    derivedDataPath: deviceBinding.privateRoot + '/derived-data', serverUrl: 'http://127.0.0.1:4723', wdaPort: 8211, mjpegPort: 8212 };
}

test('readiness uses the worker privacy options and real driver to create, verify context and close one exact session without UI actions', async () => {
  const calls = [], server = createServer(async (req, res) => {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    calls.push({ method: req.method, route: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    const value = req.url === '/session' ? { sessionId: 'readiness-session' } : req.url.endsWith('/context') ? 'NATIVE_APP' : null;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const owned = device(); owned.serverUrl = 'http://127.0.0.1:' + server.address().port;
    const options = iosProofDriverOptions(owned);
    const result = await verifyInstalledIosReadiness({ createNativeDriver, driverOptions: options, assertOwned: () => true, appPrewarmed: true });
    assert.deepEqual(calls.map(({ method, route }) => [method, route]), [
      ['POST', '/session'], ['GET', '/session/readiness-session/context'], ['DELETE', '/session/readiness-session'],
    ]);
    const caps = calls[0].body.capabilities.alwaysMatch;
    for (const key of ['appium:showXcodeLog', 'appium:showIOSLog', 'appium:printPageSourceOnFindFailure', 'appium:shutdownOtherSimulators']) assert.equal(caps[key], false);
    for (const key of ['appium:skipLogCapture', 'appium:disableAutomaticScreenshots', 'appium:isHeadless', 'appium:usePrebuiltWDA']) assert.equal(caps[key], true);
    assert.equal(caps['appium:wdaConnectionTimeout'], 5000); assert.equal(caps['appium:wdaStartupRetries'], 1);
    assert.equal(result.sessionCleanup, 'deleted'); assert.equal(result.nativeContextVerified, true); assert.equal(result.installedDriver, true);
    assert.equal(result.deviceScope, IOS_DEVICE_SCOPE); assert.ok(Number.isSafeInteger(result.sessionSetupMs));
    assert.equal(Object.hasOwn(result, 'deviceCleanup'), false); assert.equal(Object.hasOwn(result, 'cleanupVerified'), false);
    assert.equal(JSON.stringify(result).includes('readiness-session'), false);
    assert.equal(JSON.stringify(result).includes(owned.udid), false);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(options)); assert.ok(Object.isFrozen(options.deviceBinding)); assert.ok(Object.isFrozen(options.capabilities));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('readiness measures setup before its one close and publishes no teardown claim', async t => {
  let now = 0, closes = 0; t.mock.method(performance, 'now', () => now);
  const options = iosProofDriverOptions(device());
  const result = await verifyInstalledIosReadiness({ driverOptions: options, assertOwned: () => true, appPrewarmed: true,
    createNativeDriver: async supplied => {
      assert.equal(supplied.capabilities, options.capabilities); assert.equal(supplied.deviceBinding, options.deviceBinding);
      now = 97000; return { context: 'NATIVE_APP', async close() { closes++; now += 4000; } };
    } });
  assert.equal(result.sessionSetupMs, 97000); assert.equal(closes, 1);
  assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'purpose', 'runner', 'deviceScope', 'installedDriver', 'appPrewarmed',
    'sessionCreated', 'nativeContextVerified', 'sessionCleanup', 'sessionSetupMs'].sort());
});

test('unknown construction and failed close never become readiness success and no close is retried', async () => {
  const options = iosProofDriverOptions(device());
  for (const mode of ['unknown-create', 'close-failed', 'close-primitive', 'context-refused']) {
    let closes = 0;
    await assert.rejects(verifyInstalledIosReadiness({ driverOptions: options, assertOwned: () => true, appPrewarmed: true,
      createNativeDriver: async () => {
        if (mode === 'unknown-create') throw new NativeDriverError('NATIVE_DRIVER_SESSION_TIMEOUT');
        return { context: mode === 'context-refused' ? 'WEBVIEW' : 'NATIVE_APP', async close() {
          closes++;
          if (mode === 'close-failed') throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT');
          if (mode === 'close-primitive') throw null;
        } };
      } }), error => error.code === (mode === 'close-primitive' ? 'NATIVE_DRIVER_COMMAND_FAILED' : mode === 'unknown-create' ? 'NATIVE_DRIVER_SESSION_TIMEOUT' : mode === 'context-refused' ? 'NATIVE_DRIVER_CONTEXT_REFUSED' : 'NATIVE_DRIVER_TIMEOUT'));
    assert.equal(closes, mode === 'unknown-create' ? 0 : 1);
  }
});

test('cancellation refuses allocation or closes one already-created readiness driver independently', async () => {
  const controller = new AbortController(); controller.abort(); let creates = 0, closes = 0;
  const options = { driverOptions: iosProofDriverOptions(device()), assertOwned: () => true, appPrewarmed: true, signal: controller.signal,
    createNativeDriver: async () => { creates++; return { context: 'NATIVE_APP', close: async () => { closes++; } }; } };
  await assert.rejects(verifyInstalledIosReadiness(options), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.equal(creates, 0); assert.equal(closes, 0);
  const active = new AbortController();
  await assert.rejects(verifyInstalledIosReadiness({ ...options, signal: active.signal, createNativeDriver: async () => {
    active.abort(); return { context: 'NATIVE_APP', close: async () => { closes++; } };
  } }), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.equal(closes, 1);
  const duringClose = new AbortController();
  await assert.rejects(verifyInstalledIosReadiness({ ...options, signal: duringClose.signal, createNativeDriver: async () => ({
    context: 'NATIVE_APP', close: async () => { closes++; duringClose.abort(); },
  }) }), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.equal(closes, 2, 'close-time cancellation never retries the exact-session close');
});
