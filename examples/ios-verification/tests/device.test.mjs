import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { selectIosTarget, ownedSimctlArguments, verifyOwnedSimulator, validateIosContainer, validateIosListener, startOwnedIos } from '../device.mjs';

const udid = '12345678-1234-1234-1234-123456789ABC', other = '87654321-1234-1234-1234-123456789ABC';
const runtimeId = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const deviceSetPath = path.join(os.tmpdir(), 'tld-ios-owned', 'devices');

test('target selection requires the explicit installed runtime and device type without fallback', () => {
  const metadata = { runtimes: [{ identifier: runtimeId, version: '26.4', isAvailable: true }], devicetypes: [{ identifier: deviceType }] };
  assert.deepEqual(selectIosTarget(metadata), { runtimeId, deviceType, platformVersion: '26.4' });
  assert.throws(() => selectIosTarget({ ...metadata, runtimes: [{ ...metadata.runtimes[0], isAvailable: false }] }), /IOS_RUNTIME_UNAVAILABLE/);
  assert.throws(() => selectIosTarget(metadata, { runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3' }), /IOS_RUNTIME_UNAVAILABLE/);
  assert.throws(() => selectIosTarget(metadata, { deviceType: 'booted' }), /IOS_TARGET_SELECTOR_INVALID/);
  assert.throws(() => selectIosTarget({ ...metadata, devicetypes: [] }), /IOS_DEVICE_TYPE_UNAVAILABLE/);
  assert.throws(() => selectIosTarget({ ...metadata, runtimes: 'malformed' }), /IOS_RUNTIME_METADATA_INVALID/);
  assert.throws(() => selectIosTarget({ ...metadata, runtimes: [{ ...metadata.runtimes[0], supportedDeviceTypes: [{ identifier: 'other' }] }] }), /IOS_TARGET_INCOMPATIBLE/);
});

test('simctl commands always select the owned device set and exact UUID', () => {
  assert.deepEqual(ownedSimctlArguments({ deviceSetPath, udid }, 'shutdown'), ['simctl', '--set', deviceSetPath, 'shutdown', udid]);
  assert.deepEqual(ownedSimctlArguments({ deviceSetPath, udid }, 'get_app_container', ['dev.testlane.iosproof', 'data']), ['simctl', '--set', deviceSetPath, 'get_app_container', udid, 'dev.testlane.iosproof', 'data']);
  for (const command of ['erase', 'shutdown all', 'spawn', 'io', 'openurl', 'list']) assert.throws(() => ownedSimctlArguments({ deviceSetPath, udid }, command), /IOS_SIMCTL_SCOPE_REFUSED/);
  for (const invalid of ['booted', 'all', 'phone-udid', '']) assert.throws(() => ownedSimctlArguments({ deviceSetPath, udid: invalid }, 'delete'), /IOS_SIMCTL_SCOPE_REFUSED/);
  assert.throws(() => ownedSimctlArguments({ deviceSetPath, udid }, 'shutdown', ['all']), /IOS_SIMCTL_SCOPE_REFUSED/);
  assert.throws(() => ownedSimctlArguments({ deviceSetPath, udid }, 'get_app_container', ['another.bundle', 'data']), /IOS_SIMCTL_SCOPE_REFUSED/);
});

test('Simulator ownership binds one booted device to marker, nonce, runtime and owner', () => {
  const expected = { nonce: 'a'.repeat(24), name: 'testlane_ios_' + 'a'.repeat(24), udid, ownerPid: 123, runtimeId, deviceType, deviceSetPath };
  const marker = { schemaVersion: 1, ...expected };
  const row = { udid, name: expected.name, state: 'Booted', isAvailable: true }, devices = { [runtimeId]: [row] };
  assert.equal(verifyOwnedSimulator({ expected, marker, devices }).udid, udid);
  for (const changes of [{ marker: { ...marker, ownerPid: 999 } }, { marker: { ...marker, nonce: 'b'.repeat(24) } },
    { devices: { [runtimeId]: [{ ...row, udid: other }] } }, { devices: { [runtimeId]: [{ ...row, name: 'personal' }] } },
    { devices: { [runtimeId]: [{ ...row, state: 'Shutdown' }] } }, { devices: { [runtimeId]: [row, { ...row, udid: other }] } },
    { devices: { foreignRuntime: [row] } }, { devices: { [runtimeId]: [row], malformed: {} } }]) {
    assert.throws(() => verifyOwnedSimulator({ expected, marker, devices, ...changes }), /IOS_OWNERSHIP_REFUSED/);
  }
  assert.equal(verifyOwnedSimulator({ expected, marker, devices: { [runtimeId]: [{ ...row, state: 'Shutdown' }] }, requireBooted: false }).udid, udid);
});

test('bootstrap container must be the exact app data container under the owned UUID', () => {
  const containerPath = path.join(deviceSetPath, udid, 'data', 'Containers', 'Data', 'Application', other);
  assert.equal(validateIosContainer({ deviceSetPath, udid, containerPath }), path.join(containerPath, 'Documents', 'testlane-bootstrap.json'));
  for (const invalid of [path.join(os.tmpdir(), other), containerPath + '-suffix', path.join(deviceSetPath, other, 'data', 'Containers', 'Data', 'Application', other), path.join(containerPath, '..', 'personal')]) {
    assert.throws(() => validateIosContainer({ deviceSetPath, udid, containerPath: invalid }), /IOS_BOOTSTRAP_CONTAINER_REFUSED/);
  }
});

test('Appium, WDA and MJPEG listeners must bind exact IPv4 loopback', () => {
  assert.equal(validateIosListener('p123\nn127.0.0.1:8123\n', 8123), true);
  for (const text of ['p123\nn*:8123\n', 'p123\nn0.0.0.0:8123\n', 'p123\nn192.168.1.2:8123\n', 'p123\nn127.0.0.1:8124\n', 'p123\n']) assert.throws(() => validateIosListener(text, 8123), /IOS_LISTENER_BINDING_REFUSED/);
});

test('unsupported host or pre-cancellation refuses without creating a Simulator', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startOwnedIos({ toolsRoot: path.join(os.tmpdir(), 'not-installed'), outputDir: path.join(os.tmpdir(), 'not-created'), signal: controller.signal }),
    process.platform === 'darwin' ? /IOS_CANCELLED/ : /IOS_MACOS_REQUIRED/);
});
