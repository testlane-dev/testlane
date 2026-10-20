import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { selectIosTarget, ownedSimctlArguments, acknowledgedIosCreate, verifyOwnedSimulator, validateIosContainer, validateIosListener, startOwnedIos, requireIosHostedDevice, canonicalIosStandardSet } from '../device.mjs';
import { IOS_DEVICE_SCOPE, snapshotIosForeignDevices } from '../device-scope.mjs';

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

test('only a successful UUID acknowledgement settles an attempted external Simulator create', () => {
  assert.equal(acknowledgedIosCreate({ code: 0, stdout: udid + '\n' }), udid);
  for (const result of [{ code: 1, stdout: udid }, { code: null, stdout: udid }, { code: 0, stdout: '' },
    { code: 0, stdout: udid + '\n' + other }, { code: 0, stdout: 'malformed' }, { code: 0 }]) {
    assert.throws(() => acknowledgedIosCreate(result), /IOS_SIMULATOR_CREATE_FAILED/);
  }
});

test('Simulator ownership binds exact nonce/runtime/type while preserving foreign devices', () => {
  const expected = { nonce: 'a'.repeat(24), name: 'testlane_ios_' + 'a'.repeat(24), udid, ownerPid: 123, runtimeId, deviceType, deviceSetPath,
    nativeHome: '/Users/runner', privateRoot: '/private/tmp/tld-ios-abc123', baselineSHA256: 'b'.repeat(64) };
  const marker = { schemaVersion: 2, scope: IOS_DEVICE_SCOPE, ...expected };
  const row = { udid, name: expected.name, state: 'Booted', isAvailable: true, deviceTypeIdentifier: deviceType };
  const foreign = { ...row, udid: other, name: 'Hosted default phone', state: 'Shutdown' };
  const baseline = snapshotIosForeignDevices({ [runtimeId]: [foreign] }), devices = { [runtimeId]: [foreign, row] };
  assert.equal(verifyOwnedSimulator({ expected, marker, devices, baseline }).udid, udid);
  for (const changes of [{ marker: { ...marker, ownerPid: 999 } }, { marker: { ...marker, nonce: 'b'.repeat(24) } },
    { devices: { [runtimeId]: [{ ...row, udid: other }] } }, { devices: { [runtimeId]: [{ ...row, name: 'personal' }] } },
    { devices: { [runtimeId]: [{ ...row, state: 'Shutdown' }] } }, { devices: { [runtimeId]: [{ ...row, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' }] } },
    { devices: { foreignRuntime: [row] } }, { devices: { [runtimeId]: [row], malformed: {} } }]) {
    assert.throws(() => verifyOwnedSimulator({ expected, marker, devices, baseline, ...changes }), /IOS_OWNERSHIP_REFUSED/);
  }
  const drift = { [runtimeId]: [row, { ...foreign, state: 'Booted' }] };
  assert.throws(() => verifyOwnedSimulator({ expected, marker, devices: drift, baseline }), /IOS_FOREIGN_INVENTORY_CHANGED/);
  assert.throws(() => verifyOwnedSimulator({ expected, marker, devices: { [runtimeId]: [row] }, baseline }), /IOS_FOREIGN_INVENTORY_CHANGED/);
  // Drift never authorizes another UUID. Cleanup may still prove only its own
  // target before deleting it, while retaining the failed preservation result.
  assert.equal(verifyOwnedSimulator({ expected, marker, devices: drift, baseline, verifyForeign: false }).udid, udid);
  assert.equal(verifyOwnedSimulator({ expected, marker, devices: { [runtimeId]: [foreign, { ...row, state: 'Shutdown' }] }, baseline, requireBooted: false }).udid, udid);
});

test('hosted-only factory guard cannot be satisfied by a self-hosted or ordinary local Mac', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', TESTLANE_IOS_PROOF_CI: '1' };
  assert.doesNotThrow(() => requireIosHostedDevice({ platform: 'darwin', env }));
  for (const value of [{}, { ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...env, TESTLANE_IOS_PROOF_CI: '0' }]) {
    assert.throws(() => requireIosHostedDevice({ platform: 'darwin', env: value }), /IOS_HOSTED_CI_REQUIRED/);
  }
  assert.throws(() => requireIosHostedDevice({ platform: 'win32', env }), /IOS_MACOS_REQUIRED/);
});

test('standard device set must already exist beneath a canonical native home without aliases', async t => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-ios-standard-test-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.equal(await realpath(root), root); await rm(root, { recursive: true }); });
  const home = path.join(root, 'native-home'), devices = path.join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
  await mkdir(home); await assert.rejects(canonicalIosStandardSet(home), /IOS_STANDARD_DEVICE_SET_REFUSED/);
  await assert.rejects(lstat(path.join(home, 'Library')), { code: 'ENOENT' });
  await mkdir(devices, { recursive: true }); assert.equal(await canonicalIosStandardSet(home), devices);
  const alias = path.join(root, 'alias'); await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(canonicalIosStandardSet(alias), /IOS_STANDARD_DEVICE_SET_REFUSED/);
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
    process.platform === 'darwin' ? /IOS_CANCELLED|IOS_HOSTED_CI_REQUIRED/ : /IOS_MACOS_REQUIRED/);
});
