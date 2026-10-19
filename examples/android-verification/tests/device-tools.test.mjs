import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installPinnedTools, validateToolsOutputPath } from '../tools/setup.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'tld-tools-test-'));
  try { await fn(root); }
  finally {
    assert.equal(await realpath(root), root);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: false });
  }
}

test('tooling refuses omitted, relative and invalid output paths before installation', () => {
  for (const output of [undefined, 'relative', path.parse(process.cwd()).root, path.join(os.tmpdir(), 'bad\npath')]) {
    assert.throws(() => validateToolsOutputPath(output), /ANDROID_TOOLS_OUTPUT_INVALID/);
  }
  assert.equal(validateToolsOutputPath(path.join(os.tmpdir(), 'tld-short')), path.resolve(os.tmpdir(), 'tld-short'));
});

test('the conservative APK path-depth limit applies only to Windows', () => {
  const deep = path.join(os.tmpdir(), 'a'.repeat(200));
  assert.throws(() => validateToolsOutputPath(deep, { platform: 'win32' }), /ANDROID_TOOLS_OUTPUT_TOO_DEEP/);
  for (const platform of ['linux', 'darwin']) assert.equal(validateToolsOutputPath(deep, { platform }), path.resolve(deep));
});

test('tooling refuses an existing directory without changing its files', async () => {
  await fixture(async root => {
    const output = path.join(root, 'existing'); await mkdir(output);
    await writeFile(path.join(output, 'sentinel'), 'leave this unchanged');
    await assert.rejects(installPinnedTools({ outputDir: output, npmCli: process.execPath }), /ANDROID_TOOLS_OUTPUT_EXISTS/);
    assert.deepEqual(await readdir(output), ['sentinel']);
    assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'leave this unchanged');
  });
});

test('tooling refuses a junction or symlink parent instead of following it', async () => {
  await fixture(async root => {
    const real = path.join(root, 'real'), alias = path.join(root, 'alias');
    await mkdir(real); await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installPinnedTools({ outputDir: path.join(alias, 'new'), npmCli: process.execPath }), /ANDROID_TOOLS_OUTPUT_PARENT_REFUSED/);
    assert.deepEqual(await readdir(real), []);
  });
});

test('failed bounded installation retains only its new directory and recovery evidence', async () => {
  await fixture(async root => {
    const output = path.join(root, 'incomplete');
    await assert.rejects(installPinnedTools({ outputDir: output, npmCli: path.join(root, 'missing-npm.mjs') }), /ANDROID_TOOLS_INSTALL_FAILED/);
    const marker = JSON.parse(await readFile(path.join(output, 'testlane-android-tools.json'), 'utf8'));
    const recovery = JSON.parse(await readFile(path.join(output, 'setup-recovery.json'), 'utf8'));
    assert.equal(marker.status, 'incomplete'); assert.equal(marker.outputDir, output);
    assert.equal(marker.childTerminationConfirmed, true); assert.match(marker.nonce, /^[a-f0-9]{24}$/);
    assert.match(marker.packageSha256, /^[a-f0-9]{64}$/); assert.match(marker.lockSha256, /^[a-f0-9]{64}$/);
    assert.equal(recovery.status, 'manual-inspection-required'); assert.equal(recovery.childTerminationConfirmed, true);
  });
});

test('pre-cancelled tooling setup does not create a destination', async () => {
  await fixture(async root => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(installPinnedTools({ outputDir: path.join(root, 'cancelled'), npmCli: process.execPath, signal: controller.signal }), /ANDROID_TOOLS_CANCELLED/);
    assert.deepEqual(await readdir(root), []);
  });
});

test('cancellation stops an active owned installer and preserves recovery evidence', async () => {
  await fixture(async root => {
    const output = path.join(root, 'cancel'), script = path.join(root, 'fake-npm.mjs');
    await writeFile(script, "import {writeFileSync} from 'node:fs';writeFileSync('child-started','ready');setInterval(()=>{},1000);\n");
    const controller = new AbortController();
    const running = installPinnedTools({ outputDir: output, npmCli: script, signal: controller.signal });
    const rejected = assert.rejects(running, /ANDROID_TOOLS_CANCELLED/);
    try {
      const deadline = Date.now() + 5000;
      let started = false;
      while (Date.now() < deadline) {
        try { started = await readFile(path.join(output, 'child-started'), 'utf8') === 'ready'; } catch {}
        if (started) break; await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(started, true, 'fake installer reached execution');
    } finally { controller.abort(); }
    await rejected;
    const recovery = JSON.parse(await readFile(path.join(output, 'setup-recovery.json'), 'utf8'));
    assert.equal(recovery.childTerminationConfirmed, true);
    assert.equal(JSON.parse(await readFile(path.join(output, 'testlane-android-tools.json'), 'utf8')).status, 'incomplete');
  });
});
