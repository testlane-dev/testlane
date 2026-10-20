/** Fixed-control sequencing only; no device, app backend or credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { probeIosPreauthControls } from '../preauth-controls.mjs';
import { NativeDriverError } from '../driver.mjs';
import { iosProofDriverOptions, verifyInstalledIosReadiness } from '../readiness.mjs';
import { IOS_DEVICE_SCOPE } from '../device-scope.mjs';

const sequence = ['run-marker', 'quantity', 'unit-price', 'create-request', 'selected-id', 'load-request', 'approve-request', 'anonymous-check'];
function options() {
  const deviceBinding = { schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome: '/Users/runner',
    deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
    udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) };
  return iosProofDriverOptions({ deviceBinding, udid: deviceBinding.udid, deviceSetPath: deviceBinding.deviceSetPath,
    derivedDataPath: deviceBinding.privateRoot + '/derived-data', serverUrl: 'http://127.0.0.1:4723', wdaPort: 8211, mjpegPort: 8212 });
}
function fixture({ failure, cancelAt, closeFailure, controller = new AbortController() } = {}) {
  const calls = [], rows = []; let closes = 0;
  const driver = { context: 'NATIVE_APP', async scrollIntoView(id) {
    calls.push(['visibility', id]);
    if (id === 'quantity' && failure !== undefined) throw failure;
    if (id === cancelAt) controller.abort();
  }, async click(id) { calls.push(['focus', id]); }, async hideKeyboard() { calls.push(['keyboard-dismissal-check', 'dismiss-keyboard']); },
  async close() { closes++; calls.push(['close']); if (closeFailure) throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT'); } };
  return { driver, calls, rows, controller, get closes() { return closes; } };
}

test('the fixed probe observes eight controls, focuses quantity once, checks keyboard dismissal and restores session status', async () => {
  const f = fixture();
  await probeIosPreauthControls({ driver: f.driver, onStep: row => f.rows.push(row) });
  assert.deepEqual(f.calls, [...sequence.map(id => ['visibility', id]), ['focus', 'quantity'],
    ['keyboard-dismissal-check', 'dismiss-keyboard'], ['visibility', 'session-status']]);
  assert.equal(f.rows.length, 11); assert.ok(f.rows.every(row => row.completed && Object.isFrozen(row)));
  assert.deepEqual(f.rows.map(row => Object.keys(row).sort()), Array.from({ length: 11 }, () => ['completed', 'controlId', 'step']));
  assert.equal(f.closes, 0, 'the readiness owner alone closes the exact session');
});

test('a failed control stops immediately and keeps only its trusted fixed code', async () => {
  const f = fixture({ failure: new NativeDriverError('NATIVE_DRIVER_ELEMENT_TIMEOUT') });
  await assert.rejects(probeIosPreauthControls({ driver: f.driver, onStep: row => f.rows.push(row) }), { code: 'NATIVE_DRIVER_ELEMENT_TIMEOUT' });
  assert.deepEqual(f.calls, [['visibility', 'run-marker'], ['visibility', 'quantity']]);
  assert.deepEqual(f.rows[1], { controlId: 'quantity', step: 'visibility', completed: false, code: 'NATIVE_DRIVER_ELEMENT_TIMEOUT' });
});

test('unknown errors, forged codes, getters and proxies cannot leak into fixed records', async () => {
  const secret = randomBytes(32).toString('base64url'); let reads = 0;
  const getter = new NativeDriverError('NATIVE_DRIVER_ELEMENT_TIMEOUT');
  Object.defineProperty(getter, 'code', { get() { reads++; throw Error(secret); } });
  const proxy = new Proxy(new NativeDriverError('NATIVE_DRIVER_ELEMENT_TIMEOUT'), { get() { reads++; throw Error(secret); }, getPrototypeOf() { reads++; throw Error(secret); } });
  for (const failure of [Error(secret), Object.assign(Error(secret), { code: 'NATIVE_DRIVER_ELEMENT_TIMEOUT' }), getter, proxy,
    new NativeDriverError(secret), null]) {
    const f = fixture({ failure });
    await assert.rejects(probeIosPreauthControls({ driver: f.driver, onStep: row => f.rows.push(row) }), { code: 'NATIVE_DRIVER_COMMAND_FAILED' });
    assert.equal(JSON.stringify(f.rows).includes(secret), false); assert.equal(f.rows.at(-1).code, 'NATIVE_DRIVER_COMMAND_FAILED');
  }
  assert.equal(reads, 0);
});

test('pre-cancellation and cancellation during visibility cannot progress or replay an action', async () => {
  const f = fixture(); f.controller.abort();
  await assert.rejects(probeIosPreauthControls({ driver: f.driver, signal: f.controller.signal, onStep: row => f.rows.push(row) }), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.deepEqual(f.calls, []);
  const active = fixture({ cancelAt: 'quantity' });
  await assert.rejects(probeIosPreauthControls({ driver: active.driver, signal: active.controller.signal, onStep: row => active.rows.push(row) }), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.deepEqual(active.calls, [['visibility', 'run-marker'], ['visibility', 'quantity']]);
});

test('optional readiness runs the probe before its one close; failed probe or failed close never claims acknowledged cleanup', async () => {
  for (const mode of ['passed', 'probe-failed', 'close-failed']) {
    const f = fixture({ failure: mode === 'probe-failed' ? new NativeDriverError('NATIVE_DRIVER_ELEMENT_TIMEOUT') : undefined,
      closeFailure: mode === 'close-failed' });
    let observed;
    const run = verifyInstalledIosReadiness({ createNativeDriver: async () => f.driver, driverOptions: options(), assertOwned: () => true,
      appPrewarmed: true, preauthControls: true, onPreauthControls: value => { observed = value; } });
    if (mode === 'passed') await run; else await assert.rejects(run);
    assert.equal(f.closes, 1); assert.deepEqual(f.calls.at(-1), ['close']);
    assert.equal(observed.completed, mode === 'passed'); assert.equal(observed.sessionCleanupAcknowledged, mode !== 'close-failed');
    assert.equal(Object.hasOwn(observed, 'deviceCleanup'), false); assert.equal(Object.hasOwn(observed, 'cleanupVerified'), false);
    assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed.steps));
  }
});

test('close-time cancellation retains fixed failed metadata and never closes twice', async () => {
  const f = fixture(); f.driver.close = async () => { f.calls.push(['close']); f.controller.abort(); };
  let observed;
  await assert.rejects(verifyInstalledIosReadiness({ createNativeDriver: async () => f.driver, driverOptions: options(), assertOwned: () => true,
    appPrewarmed: true, signal: f.controller.signal, preauthControls: true, onPreauthControls: value => { observed = value; } }), { code: 'NATIVE_DRIVER_CANCELLED' });
  assert.equal(f.calls.filter(row => row[0] === 'close').length, 1);
  assert.equal(observed.completed, false); assert.equal(observed.sessionCleanupAcknowledged, true);
});
