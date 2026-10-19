import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { ownedAdbArguments, ownedAvdConfiguration, verifyOwnedIdentity, startOwnedAndroid } from '../device.mjs';

test('ADB scope always selects the exact owned emulator and private loopback server', () => {
  const scoped = ownedAdbArguments({ adbPort: 49321, serial: 'emulator-5564' }, ['shell', 'getprop', 'ro.kernel.qemu']);
  assert.deepEqual(scoped, ['-H', '127.0.0.1', '-P', '49321', '-s', 'emulator-5564', 'shell', 'getprop', 'ro.kernel.qemu']);
  for (const serial of ['phone-serial', '127.0.0.1:5555', 'emulator-5553', 'emulator-5555', 'emulator-5586']) {
    assert.throws(() => ownedAdbArguments({ adbPort: 49321, serial }, ['shell', 'true']), /ANDROID_ADB_SCOPE_REFUSED/);
  }
  assert.throws(() => ownedAdbArguments({ adbPort: 5037, serial: 'emulator-5564' }, ['shell', 'true']), /ANDROID_ADB_SCOPE_REFUSED/);
});

test('ADB scope refuses server controls, device fallback and client-side selector overrides', () => {
  for (const args of [['kill-server'], ['start-server'], ['devices'], ['connect', 'somewhere'], ['-s', 'another', 'shell', 'true'], ['-P', '5037', 'shell', 'true']]) {
    assert.throws(() => ownedAdbArguments({ adbPort: 49321, serial: 'emulator-5564' }, args), /ANDROID_ADB_SCOPE_REFUSED/);
  }
});

test('ownership requires retained live processes, canonical markers and the guest nonce-bound AVD name', () => {
  const nonce = 'a'.repeat(24);
  const expected = { nonce, avdName: 'testlane_' + nonce, serial: 'emulator-5564', ownerPid: 123, emulatorPid: 456, adbPort: 49321 };
  const marker = { schemaVersion: 1, ...expected };
  const input = { expected, marker, alive: true, qemu: '1', avdName: expected.avdName };
  assert.equal(verifyOwnedIdentity(input), true);
  for (const change of [{ alive: false }, { qemu: '0' }, { avdName: 'existing-personal-avd' }, { avdName: 'testlane_' + 'b'.repeat(24) },
    { expected: { ...expected, nonce: 'abc', avdName: 'testlane_abc' } }, { expected: { ...expected, nonce: 'b'.repeat(24) } }, { marker: { ...marker, nonce: 'foreign' } },
    { marker: { ...marker, ownerPid: 321 } }, { marker: { ...marker, emulatorPid: 654 } }, { marker: { ...marker, serial: 'emulator-5554' } }, { marker: { ...marker, adbPort: 5037 } }]) {
    assert.throws(() => verifyOwnedIdentity({ ...input, ...change }), /ANDROID_OWNERSHIP_REFUSED/);
  }
});

test('a new AVD configuration contains only the explicit public image and dedicated identity', () => {
  const avdName = 'testlane_' + 'a'.repeat(24), image = path.join(os.tmpdir(), 'public-sdk', 'system-images', 'image');
  const config = ownedAvdConfiguration({ avdName, image, apiLevel: 34 });
  assert.ok(config.includes('AvdId=' + avdName));
  assert.ok(config.includes('image.sysdir.1=' + image.replaceAll('\\', '/') + '/'));
  assert.ok(config.includes('target=android-34'));
  assert.equal(config.includes('snapshot'), false);
  assert.throws(() => ownedAvdConfiguration({ avdName: 'personal-avd', image, apiLevel: 34 }), /ANDROID_AVD_CONFIGURATION_REFUSED/);
  assert.throws(() => ownedAvdConfiguration({ avdName, image: image + '\npath=elsewhere', apiLevel: 34 }), /ANDROID_AVD_CONFIGURATION_REFUSED/);
});

test('pre-cancelled startup refuses before reading SDK paths or creating a device', async () => {
  const controller = new AbortController(); controller.abort();
  const nonexistent = path.join(os.tmpdir(), 'not-a-configured-sdk');
  await assert.rejects(startOwnedAndroid({ sdkRoot: nonexistent, javaHome: nonexistent, toolsRoot: nonexistent, systemImagePath: nonexistent, outputDir: nonexistent, signal: controller.signal }), /ANDROID_CANCELLED/);
});
