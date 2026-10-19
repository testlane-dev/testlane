#!/usr/bin/env node
/** Explicit short-path installer. Device startup never downloads tooling. */
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemoChild } from '../../verification-demo/native.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = 'testlane-android-tools.json';
const fail = code => new Error(code);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const APK_PATHS = [
  ['node_modules', 'appium-uiautomator2-driver', 'node_modules', 'io.appium.settings', 'apks', 'settings_apk-debug.apk'],
  ['node_modules', 'appium-uiautomator2-driver', 'node_modules', 'appium-uiautomator2-server', 'apks', 'appium-uiautomator2-server-v10.6.6.apk'],
  ['node_modules', 'appium-uiautomator2-driver', 'node_modules', 'appium-uiautomator2-server', 'apks', 'appium-uiautomator2-server-debug-androidTest.apk'],
];

export function validateToolsOutputPath(outputDir, { platform = process.platform } = {}) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || /[\r\n\0]/.test(outputDir)) throw fail('ANDROID_TOOLS_OUTPUT_INVALID');
  const result = path.resolve(outputDir);
  if (path.parse(result).root === result) throw fail('ANDROID_TOOLS_OUTPUT_INVALID');
  // adb on Windows cannot stat these dependency APKs at deep npm paths. Refuse
  // the known failure before downloading anything, with headroom below MAX_PATH.
  if (platform === 'win32' && APK_PATHS.some(parts => path.join(result, ...parts).length > 240)) throw fail('ANDROID_TOOLS_OUTPUT_TOO_DEEP');
  return result;
}

export async function installPinnedTools({ outputDir, npmCli, signal } = {}) {
  const requested = validateToolsOutputPath(outputDir);
  if (signal?.aborted) throw fail('ANDROID_TOOLS_CANCELLED');
  if (typeof npmCli !== 'string' || !path.isAbsolute(npmCli) || /[\r\n\0]/.test(npmCli)) throw fail('ANDROID_TOOLS_USE_NPM_RUN_SETUP');
  const parent = await realpath(path.dirname(requested));
  if (!same(parent, path.dirname(requested)) || (await lstat(path.dirname(requested))).isSymbolicLink()) throw fail('ANDROID_TOOLS_OUTPUT_PARENT_REFUSED');
  const source = await realpath(SOURCE);
  const [packageBytes, lockBytes] = await Promise.all(['package.json', 'package-lock.json'].map(file => readFile(path.join(source, file))));
  const metadata = JSON.parse(packageBytes), lock = JSON.parse(lockBytes);
  if (metadata.dependencies?.appium !== '3.8.0' || metadata.dependencies?.['appium-uiautomator2-driver'] !== '8.7.0' ||
      lock.packages?.['node_modules/appium']?.version !== '3.8.0' || lock.packages?.['node_modules/appium-uiautomator2-driver']?.version !== '8.7.0' ||
      lock.packages?.['node_modules/appium-uiautomator2-driver/node_modules/appium-uiautomator2-server']?.version !== '10.6.6' ||
      lock.packages?.['node_modules/appium-uiautomator2-driver/node_modules/io.appium.settings']?.version !== '8.0.9') throw fail('ANDROID_TOOLS_VERSION_MISMATCH');
  try { await mkdir(requested, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('ANDROID_TOOLS_OUTPUT_EXISTS'); throw fail('ANDROID_TOOLS_OUTPUT_CREATE_FAILED'); }
  const nonce = randomBytes(12).toString('hex');
  const marker = { schemaVersion: 1, purpose: 'explicit-local-android-tooling', nonce, ownerPid: process.pid, outputDir: requested,
    packageSha256: hash(packageBytes), lockSha256: hash(lockBytes), status: 'installing' };
  let terminationConfirmed = true;
  async function assertOwned({ markerRequired = true } = {}) {
    if (!same(await realpath(requested), requested) || (await lstat(requested)).isSymbolicLink()) throw fail('ANDROID_TOOLS_OUTPUT_OWNERSHIP_REFUSED');
    if (markerRequired) {
      const info = await lstat(path.join(requested, MARKER));
      if (info.isSymbolicLink() || !info.isFile()) throw fail('ANDROID_TOOLS_OUTPUT_OWNERSHIP_REFUSED');
      const actual = JSON.parse(await readFile(path.join(requested, MARKER), 'utf8'));
      if (actual.nonce !== nonce || actual.ownerPid !== process.pid || actual.outputDir !== requested || actual.lockSha256 !== marker.lockSha256) throw fail('ANDROID_TOOLS_OUTPUT_OWNERSHIP_REFUSED');
    }
  }
  try {
    await assertOwned({ markerRequired: false });
    await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(requested, 'package.json'), packageBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(requested, 'package-lock.json'), lockBytes, { flag: 'wx', mode: 0o600 });
    if (signal?.aborted) throw fail('ANDROID_TOOLS_CANCELLED');
    // No lifecycle hooks, driver registration, global Appium home or default
    // Android configuration is used during this explicit installation.
    const result = await runDemoChild({ entry: npmCli, args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      cwd: requested, timeoutMs: 220_000, signal,
      env: { ...process.env, npm_config_update_notifier: 'false', APPIUM_SKIP_EXTENSIONS_INSTALL: '1' } });
    if (result.code !== 0) throw fail('ANDROID_TOOLS_INSTALL_FAILED');
    await assertOwned();
    if (hash(await readFile(path.join(requested, 'package.json'))) !== marker.packageSha256 || hash(await readFile(path.join(requested, 'package-lock.json'))) !== marker.lockSha256) throw fail('ANDROID_TOOLS_MANIFEST_CHANGED');
    for (const [parts, version] of [[['appium'], '3.8.0'], [['appium-uiautomator2-driver'], '8.7.0'],
      [['appium-uiautomator2-driver', 'node_modules', 'appium-uiautomator2-server'], '10.6.6'], [['appium-uiautomator2-driver', 'node_modules', 'io.appium.settings'], '8.0.9']]) {
      const installed = JSON.parse(await readFile(path.join(requested, 'node_modules', ...parts, 'package.json'), 'utf8'));
      if (installed.version !== version) throw fail('ANDROID_TOOLS_VERSION_MISMATCH');
    }
    for (const parts of APK_PATHS) {
      const file = path.join(requested, ...parts), info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw fail('ANDROID_TOOLS_APK_INVALID');
    }
    marker.status = 'ready'; await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
    return Object.freeze({ toolsRoot: requested, packageSha256: marker.packageSha256, lockSha256: marker.lockSha256 });
  } catch (error) {
    if (error.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') terminationConfirmed = false;
    // Keep partial installation and evidence. Never delete a computed destination
    // after an unconfirmed child or failed canonical-path ownership check.
    try {
      await assertOwned();
      marker.status = 'incomplete'; marker.childTerminationConfirmed = terminationConfirmed;
      await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
      await writeFile(path.join(requested, 'setup-recovery.json'), JSON.stringify({ schemaVersion: 1, status: 'manual-inspection-required', toolsRoot: requested,
        childTerminationConfirmed: terminationConfirmed }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { /* Preserve existing evidence if the path has changed. */ }
    if (!terminationConfirmed) throw fail('ANDROID_TOOLS_TERMINATION_UNCONFIRMED');
    if (error.message === 'DEMO_CANCELLED') throw fail('ANDROID_TOOLS_CANCELLED');
    if (error.message === 'DEMO_CHILD_TIMEOUT') throw fail('ANDROID_TOOLS_INSTALL_TIMEOUT');
    throw fail(/^ANDROID_TOOLS_[A-Z_]+$/.test(error.message) ? error.message : 'ANDROID_TOOLS_SETUP_FAILED');
  }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--output-dir') throw fail('ANDROID_TOOLS_ARGUMENTS_INVALID');
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await installPinnedTools({ outputDir: process.argv[3], npmCli: process.env.npm_execpath, signal: controller.signal });
    console.log(JSON.stringify({ installed: true, ...result, appium: '3.8.0', uiautomator2: '8.7.0' }));
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
function isEntryPoint() {
  try { return same(realpathSync(process.argv[1]), realpathSync(fileURLToPath(import.meta.url))); } catch { return false; }
}
if (isEntryPoint()) try { await main(); } catch (error) { console.error(/^ANDROID_TOOLS_[A-Z_]+$/.test(error.message) ? error.message : 'ANDROID_TOOLS_SETUP_FAILED'); process.exitCode = 1; }
