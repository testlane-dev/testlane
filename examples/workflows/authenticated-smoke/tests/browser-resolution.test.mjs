import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserInstallDirectory, loadProjectBrowser } from '../runtime.mjs';
let root, prior, parent;
beforeEach(async () => { prior = process.cwd(); parent = await realpath(os.tmpdir()); root = await mkdtemp(path.join(parent, 'testlane-browser-resolution-')); process.chdir(root); });
afterEach(async () => {
  process.chdir(prior);
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('testlane-browser-resolution-'));
  await rm(resolved, { recursive: true, force: true });
});
async function module(name, marker) {
  const dir = path.join(root, 'node_modules', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.cjs' }));
  await writeFile(path.join(dir, 'index.cjs'), `module.exports = {chromium: {executablePath: () => ${JSON.stringify(marker)}}};`);
}
test('loads app-local @playwright/test through its CommonJS default export', async () => {
  await module('@playwright/test', 'app-test-browser');
  const browser = await loadProjectBrowser();
  assert.equal(browser.chromium.executablePath(), 'app-test-browser');
  assert.equal(browserInstallDirectory('/template-fallback'), root);
});
test('prefers app-local playwright when both browser packages are installed', async () => {
  await module('playwright', 'app-playwright-browser');
  await module('@playwright/test', 'unused-test-browser');
  assert.equal((await loadProjectBrowser()).chromium.executablePath(), 'app-playwright-browser');
});
