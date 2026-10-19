#!/usr/bin/env node
/** Explicit pinned installer; Simulator startup never installs dependencies. */
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemoChild } from '../../verification-demo/native.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url)), MARKER = 'testlane-ios-tools.json';
const fail = code => new Error(code), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const PINS = [[['appium'], '3.8.0'], [['appium-xcuitest-driver'], '12.19.1'], [['appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent'], '16.16.3']];

export function validateIosToolsOutput(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || /[\r\n\0]/.test(outputDir)) throw fail('IOS_TOOLS_OUTPUT_INVALID');
  const result = path.resolve(outputDir);
  if (path.parse(result).root === result) throw fail('IOS_TOOLS_OUTPUT_INVALID');
  return result;
}

export async function installPinnedIosTools({ outputDir, npmCli, signal } = {}) {
  const requested = validateIosToolsOutput(outputDir);
  if (signal?.aborted) throw fail('IOS_TOOLS_CANCELLED');
  if (typeof npmCli !== 'string' || !path.isAbsolute(npmCli) || /[\r\n\0]/.test(npmCli)) throw fail('IOS_TOOLS_USE_NPM_RUN_SETUP');
  const parent = await realpath(path.dirname(requested));
  if (!same(parent, path.dirname(requested)) || (await lstat(path.dirname(requested))).isSymbolicLink()) throw fail('IOS_TOOLS_OUTPUT_PARENT_REFUSED');
  const source = await realpath(SOURCE);
  const [packageBytes, lockBytes] = await Promise.all(['package.json', 'package-lock.json'].map(file => readFile(path.join(source, file))));
  const metadata = JSON.parse(packageBytes), lock = JSON.parse(lockBytes);
  if (metadata.dependencies?.appium !== '3.8.0' || metadata.dependencies?.['appium-xcuitest-driver'] !== '12.19.1' ||
      PINS.some(([parts, version]) => lock.packages?.[['node_modules', ...parts].join('/')]?.version !== version)) throw fail('IOS_TOOLS_VERSION_MISMATCH');
  try { await mkdir(requested, { recursive: false, mode: 0o700 }); }
  catch (error) { throw fail(error.code === 'EEXIST' ? 'IOS_TOOLS_OUTPUT_EXISTS' : 'IOS_TOOLS_OUTPUT_CREATE_FAILED'); }
  const marker = { schemaVersion: 1, purpose: 'explicit-local-ios-tooling', nonce: randomBytes(12).toString('hex'), ownerPid: process.pid,
    outputDir: requested, packageSha256: hash(packageBytes), lockSha256: hash(lockBytes), status: 'installing' };
  let terminationConfirmed = true;
  async function assertOwned(markerRequired = true) {
    if (!same(await realpath(requested), requested) || (await lstat(requested)).isSymbolicLink()) throw fail('IOS_TOOLS_OUTPUT_OWNERSHIP_REFUSED');
    if (!markerRequired) return;
    const info = await lstat(path.join(requested, MARKER));
    if (!info.isFile() || info.isSymbolicLink()) throw fail('IOS_TOOLS_OUTPUT_OWNERSHIP_REFUSED');
    const actual = JSON.parse(await readFile(path.join(requested, MARKER), 'utf8'));
    if (['nonce', 'ownerPid', 'outputDir', 'packageSha256', 'lockSha256'].some(key => actual[key] !== marker[key])) throw fail('IOS_TOOLS_OUTPUT_OWNERSHIP_REFUSED');
  }
  try {
    await assertOwned(false);
    await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(requested, 'package.json'), packageBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(requested, 'package-lock.json'), lockBytes, { flag: 'wx', mode: 0o600 });
    if (signal?.aborted) throw fail('IOS_TOOLS_CANCELLED');
    const result = await runDemoChild({ entry: npmCli, args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      cwd: requested, timeoutMs: 220000, signal, env: { ...process.env, npm_config_update_notifier: 'false', APPIUM_SKIP_EXTENSIONS_INSTALL: '1' } });
    if (result.code !== 0) throw fail('IOS_TOOLS_INSTALL_FAILED');
    await assertOwned();
    if (hash(await readFile(path.join(requested, 'package.json'))) !== marker.packageSha256 || hash(await readFile(path.join(requested, 'package-lock.json'))) !== marker.lockSha256) throw fail('IOS_TOOLS_MANIFEST_CHANGED');
    for (const [parts, version] of PINS) if (JSON.parse(await readFile(path.join(requested, 'node_modules', ...parts, 'package.json'), 'utf8')).version !== version) throw fail('IOS_TOOLS_VERSION_MISMATCH');
    const project = path.join(requested, 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj', 'project.pbxproj');
    const info = await lstat(project); if (!info.isFile() || info.isSymbolicLink()) throw fail('IOS_TOOLS_WDA_PROJECT_MISSING');
    marker.status = 'ready'; await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
    return Object.freeze({ toolsRoot: requested, packageSha256: marker.packageSha256, lockSha256: marker.lockSha256 });
  } catch (error) {
    if (error.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') terminationConfirmed = false;
    try {
      await assertOwned(); marker.status = 'incomplete'; marker.childTerminationConfirmed = terminationConfirmed;
      await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
      await writeFile(path.join(requested, 'setup-recovery.json'), JSON.stringify({ schemaVersion: 1, status: 'manual-inspection-required', toolsRoot: requested,
        childTerminationConfirmed: terminationConfirmed }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { /* Keep evidence rather than writing through a changed path. */ }
    if (!terminationConfirmed) throw fail('IOS_TOOLS_TERMINATION_UNCONFIRMED');
    if (error.message === 'DEMO_CANCELLED') throw fail('IOS_TOOLS_CANCELLED');
    if (error.message === 'DEMO_CHILD_TIMEOUT') throw fail('IOS_TOOLS_INSTALL_TIMEOUT');
    throw fail(/^IOS_TOOLS_[A-Z_]+$/.test(error.message) ? error.message : 'IOS_TOOLS_SETUP_FAILED');
  }
}

async function main() {
  if (process.platform !== 'darwin') throw fail('IOS_TOOLS_MACOS_REQUIRED');
  if (process.argv.length !== 4 || process.argv[2] !== '--output-dir') throw fail('IOS_TOOLS_ARGUMENTS_INVALID');
  const controller = new AbortController(), cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log(JSON.stringify({ installed: true, ...await installPinnedIosTools({ outputDir: process.argv[3], npmCli: process.env.npm_execpath, signal: controller.signal }),
    appium: '3.8.0', xcuitest: '12.19.1', webdriveragent: '16.16.3' })); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
function isEntryPoint() { try { return same(realpathSync(process.argv[1]), realpathSync(fileURLToPath(import.meta.url))); } catch { return false; } }
if (isEntryPoint()) try { await main(); } catch (error) { console.error(/^IOS_TOOLS_[A-Z_]+$/.test(error.message) ? error.message : 'IOS_TOOLS_SETUP_FAILED'); process.exitCode = 1; }
