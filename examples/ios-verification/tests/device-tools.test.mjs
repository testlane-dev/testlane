import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installPinnedIosTools, validateIosToolsOutput } from '../tools/setup.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'tld-ios-tools-test-'));
  try { await fn(root); } finally { assert.equal(await realpath(root), root); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true, force: false }); }
}

test('iOS tooling requires an explicit absolute non-root destination', () => {
  for (const invalid of [undefined, 'relative', path.parse(process.cwd()).root, path.join(os.tmpdir(), 'bad\npath')]) assert.throws(() => validateIosToolsOutput(invalid), /IOS_TOOLS_OUTPUT_INVALID/);
  assert.equal(validateIosToolsOutput(path.join(os.tmpdir(), 'tld-ios-tools')), path.resolve(os.tmpdir(), 'tld-ios-tools'));
  assert.equal(validateIosToolsOutput(path.join(os.tmpdir(), 'a'.repeat(200))), path.resolve(os.tmpdir(), 'a'.repeat(200)));
});

test('iOS tooling preserves existing targets without running an installer', async () => {
  await fixture(async root => {
    const output = path.join(root, 'existing'); await mkdir(output); await writeFile(path.join(output, 'sentinel'), 'unchanged');
    await assert.rejects(installPinnedIosTools({ outputDir: output, npmCli: process.execPath }), /IOS_TOOLS_OUTPUT_EXISTS/);
    assert.deepEqual(await readdir(output), ['sentinel']); assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'unchanged');
  });
});

test('iOS tooling refuses a redirected parent', async () => {
  await fixture(async root => {
    const real = path.join(root, 'real'), alias = path.join(root, 'alias'); await mkdir(real);
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installPinnedIosTools({ outputDir: path.join(alias, 'new'), npmCli: process.execPath }), /IOS_TOOLS_OUTPUT_PARENT_REFUSED/);
    assert.deepEqual(await readdir(real), []);
  });
});

test('failed iOS tooling installation retains owned recovery evidence and pinned manifests', async () => {
  await fixture(async root => {
    const output = path.join(root, 'incomplete');
    await assert.rejects(installPinnedIosTools({ outputDir: output, npmCli: path.join(root, 'missing-npm.mjs') }), /IOS_TOOLS_INSTALL_FAILED/);
    const marker = JSON.parse(await readFile(path.join(output, 'testlane-ios-tools.json'), 'utf8'));
    assert.equal(marker.status, 'incomplete'); assert.equal(marker.outputDir, output); assert.equal(marker.childTerminationConfirmed, true);
    assert.match(marker.nonce, /^[a-f0-9]{24}$/); assert.match(marker.lockSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8')).dependencies['appium-xcuitest-driver'], '12.19.1');
    assert.equal(JSON.parse(await readFile(path.join(output, 'setup-recovery.json'), 'utf8')).childTerminationConfirmed, true);
  });
});

test('pre-cancelled iOS tooling setup leaves no destination', async () => {
  await fixture(async root => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(installPinnedIosTools({ outputDir: path.join(root, 'cancelled'), npmCli: process.execPath, signal: controller.signal }), /IOS_TOOLS_CANCELLED/);
    assert.deepEqual(await readdir(root), []);
  });
});

test('active iOS installer cancellation stops its owned child and records confirmed recovery', async () => {
  await fixture(async root => {
    const output = path.join(root, 'cancel'), script = path.join(root, 'fake-npm.mjs');
    await writeFile(script, "import {writeFileSync} from 'node:fs';writeFileSync('child-started','ready');setInterval(()=>{},1000);\n");
    const controller = new AbortController();
    const rejected = assert.rejects(installPinnedIosTools({ outputDir: output, npmCli: script, signal: controller.signal }), /IOS_TOOLS_CANCELLED/);
    try {
      const deadline = Date.now() + 5000; let started = false;
      while (Date.now() < deadline) { try { started = await readFile(path.join(output, 'child-started'), 'utf8') === 'ready'; } catch {} if (started) break; await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.equal(started, true);
    } finally { controller.abort(); }
    await rejected;
    assert.equal(JSON.parse(await readFile(path.join(output, 'setup-recovery.json'), 'utf8')).childTerminationConfirmed, true);
  });
});
