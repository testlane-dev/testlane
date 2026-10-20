#!/usr/bin/env node
/** Explicit pinned installer; Simulator startup never installs dependencies. */
import { createHash, randomBytes } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemoChild } from '../../verification-demo/native.mjs';
import { applyPinnedWdaStartupPatch } from './wda-startup-patch.mjs';
import { createIosDeviceEnvironment } from '../environment.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url)), MARKER = 'testlane-ios-tools.json';
const fail = code => new Error(code), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const PINS = [[['appium'], '3.8.0'], [['appium-xcuitest-driver'], '12.19.1'], [['appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent'], '16.16.3']];
const CORESIM = 'node_modules/appium-xcuitest-driver/node_modules/@appium/coresim';
const NATIVE_BINARY = CORESIM + '/build/Release/coresim.node';
const XCODE = '/Applications/Xcode_26.6.app/Contents/Developer';
// Canonical [relative file, SHA256] tuples from the exact lock-integrity archive.
const NATIVE_INPUTS = Object.freeze({
  '@appium/coresim': ['1.13.1', 'abb34a479e468ecb85ed4829b9b9844fc8237f11003e4c72299dd5c7764a5266'],
  'node-gyp-build': ['4.8.4', '843db81889cd6c0ea2bc306ad7cbdfe3d1be083992eeedc53ae976a732a77080'],
  'node-addon-api': ['8.9.2', 'b8f2b602503b05e87326413182fa3895e29ca91154645e8da91a4e97d0385556'],
});
const nativeFail = () => fail('IOS_TOOLS_NATIVE_PREREQUISITE_FAILED');
const version = value => typeof value === 'string' && /^\d+(?:\.\d+){0,4}$/.test(value) && value.length <= 64;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

async function canonicalDirectory(dir) {
  if (!path.isAbsolute(dir) || await realpath(dir) !== dir || !(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) throw nativeFail();
  return dir;
}
async function stableFile(file, maxBytes = 256 * 1024 * 1024) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || await realpath(file) !== file) throw nativeFail();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const sameFile = info => info.isFile() && info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mtimeMs === before.mtimeMs && info.ctimeMs === before.ctimeMs;
  try {
    if (!sameFile(await handle.stat())) throw nativeFail();
    const sum = createHash('sha256'), buffer = Buffer.alloc(65536); let size = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      size += bytesRead; if (size > maxBytes || size > before.size) throw nativeFail(); sum.update(buffer.subarray(0, bytesRead)); }
    if (size !== before.size || !sameFile(await handle.stat()) || !sameFile(await lstat(file)) || await realpath(file) !== file) throw nativeFail();
    return sum.digest('hex');
  } finally { await handle.close(); }
}
async function treeHash(root, { allowBuild = false } = {}) {
  await canonicalDirectory(root); const rows = []; let bytes = 0, entries = 0;
  async function walk(dir, relative = '') {
    for (const name of (await readdir(dir)).sort()) {
      const rel = relative ? relative + '/' + name : name, full = path.join(dir, name);
      if (allowBuild && rel === 'build') continue;
      if (++entries > 10000) throw nativeFail();
      const info = await lstat(full);
      if (info.isSymbolicLink() || await realpath(full) !== full) throw nativeFail();
      if (info.isDirectory()) await walk(full, rel);
      else if (info.isFile()) { bytes += info.size; if (bytes > 64 * 1024 * 1024) throw nativeFail(); rows.push([rel, await stableFile(full, 64 * 1024 * 1024)]); }
      else throw nativeFail();
    }
  }
  await walk(root); rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); return hash(JSON.stringify(rows));
}
async function json(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || await realpath(file) !== file) throw nativeFail(); return JSON.parse(await readFile(file, 'utf8')); }

/** Read-only source verification, never loading a native module. */
export async function verifyCoresimSources(toolsRoot) {
  try {
  const tools = await canonicalDirectory(toolsRoot); let targets = 0, count = 0;
  async function modules(dir) {
    try { await canonicalDirectory(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of await readdir(dir)) {
      if (name === '.bin' || name === '.package-lock.json') continue;
      const candidate = path.join(dir, name), info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== candidate) throw nativeFail();
      const packages = name.startsWith('@') ? (await readdir(candidate)).map(entry => path.join(candidate, entry)) : [candidate];
      for (const folder of packages) {
        if (++count > 10000) throw nativeFail(); await canonicalDirectory(folder);
        const metadata = await json(path.join(folder, 'package.json'));
        if (metadata.name === '@appium/coresim') { targets++; if (folder !== path.join(tools, CORESIM) || metadata.version !== '1.13.1') throw nativeFail(); }
        await modules(path.join(folder, 'node_modules'));
      }
    }
  }
  await modules(path.join(tools, 'node_modules')); if (targets !== 1) throw nativeFail();
  const result = {};
  for (const [name, [expectedVersion, expectedHash]] of Object.entries(NATIVE_INPUTS)) {
    const folder = path.join(tools, 'node_modules/appium-xcuitest-driver/node_modules', name);
    const metadata = await json(path.join(folder, 'package.json'));
    if (metadata.name !== name || metadata.version !== expectedVersion) throw nativeFail();
    const actual = await treeHash(folder, { allowBuild: name === '@appium/coresim' });
    if (actual !== expectedHash) throw nativeFail(); result[name] = actual;
  }
  return Object.freeze(result);
  } catch { throw nativeFail(); }
}

export function coresimRebuildArguments() {
  return Object.freeze(['rebuild', '@appium/coresim@1.13.1', '--ignore-scripts=false', '--foreground-scripts', '--rebuild-bundle=false', '--no-bin-links']);
}
/** Read-only native probes use the same account context as device startup. */
export function coresimNativeProbeEnvironment({ nativeHome, privateRoot, nodeBin }) {
  return createIosDeviceEnvironment({ nativeHome,
    APPIUM_HOME: path.posix.join(privateRoot, 'appium'), TMPDIR: path.posix.join(privateRoot, 'tmp') + '/',
    XDG_CACHE_HOME: path.posix.join(privateRoot, 'cache') },
  { PATH: [nodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), DEVELOPER_DIR: XCODE });
}
/** Fixed source copied into the owned tools tree; resolve before native loading. */
export function coresimFrameworkProbeSource() {
  return `import {createRequire} from 'node:module';import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';const require=createRequire(import.meta.url);const root=fileURLToPath(new URL('../${CORESIM}/',import.meta.url));const expected=fileURLToPath(new URL('../${NATIVE_BINARY}',import.meta.url));const loader=require('../node_modules/appium-xcuitest-driver/node_modules/node-gyp-build');if(realpathSync(expected)!==expected||realpathSync(loader.path(root))!==expected)throw Error('IOS_TOOLS_NATIVE_PREREQUISITE_FAILED');const{NativeSimctl}=await import('../${CORESIM}/lib/src/index.js');const value=await NativeSimctl.frameworkVersion();if(typeof value!=='string'||!/^\\d+(?:\\.\\d+){0,4}$/.test(value)||value.length>64)throw Error('IOS_TOOLS_NATIVE_PREREQUISITE_FAILED');process.stdout.write(JSON.stringify({schemaVersion:1,frameworkVersion:value}));\n`;
}
export function parseCoresimProbe(stdout) {
  try { const value = JSON.parse(stdout); if (!exactKeys(value, ['schemaVersion', 'frameworkVersion']) || value.schemaVersion !== 1 || !version(value.frameworkVersion)) throw nativeFail(); return Object.freeze({ schemaVersion: 1, frameworkVersion: value.frameworkVersion }); }
  catch { throw nativeFail(); }
}
export async function inspectCoresimBinary(file, architecture) {
  try {
  if (!['x64', 'arm64'].includes(architecture)) throw nativeFail();
  const binaries = (await readdir(path.dirname(file))).filter(name => name.endsWith('.node'));
  if (binaries.length !== 1 || binaries[0] !== path.basename(file)) throw nativeFail();
  const digest = await stableFile(file, 64 * 1024 * 1024), handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { const header = Buffer.alloc(8), result = await handle.read(header, 0, 8, 0);
    if (result.bytesRead !== 8 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (architecture === 'x64' ? 0x01000007 : 0x0100000c)) throw nativeFail(); }
  finally { await handle.close(); }
  if (await stableFile(file, 64 * 1024 * 1024) !== digest) throw nativeFail(); return digest;
  } catch { throw nativeFail(); }
}

async function providedBuilder(npmCli) {
  const node = await realpath(process.execPath), nodeBin = path.dirname(node), prefix = path.basename(nodeBin) === 'bin' ? path.dirname(nodeBin) : nodeBin;
  const npm = await realpath(npmCli), expected = [path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js'), path.join(prefix, 'node_modules/npm/bin/npm-cli.js')];
  if (!expected.includes(npm)) throw nativeFail();
  const npmRoot = path.dirname(path.dirname(npm)), npmMetadata = await json(path.join(npmRoot, 'package.json'));
  if (npmMetadata.name !== 'npm' || !version(npmMetadata.version) || Number(npmMetadata.version.split('.')[0]) < 10) throw nativeFail();
  const nodeGypRoot = path.join(npmRoot, 'node_modules/node-gyp'), nodeGyp = path.join(nodeGypRoot, 'bin/node-gyp.js'), gyp = await json(path.join(nodeGypRoot, 'package.json'));
  if (gyp.name !== 'node-gyp' || !version(gyp.version)) throw nativeFail();
  const headersRoot = await canonicalDirectory(path.join(prefix, 'include/node'));
  const header = await readFile(path.join(headersRoot, 'node_version.h'), 'utf8');
  const headerVersion = ['MAJOR', 'MINOR', 'PATCH'].map(part => new RegExp('#define NODE_' + part + '_VERSION\\s+(\\d+)').exec(header)?.[1]).join('.');
  if (headerVersion !== process.versions.node) throw nativeFail();
  const python = await realpath('/usr/bin/python3');
  const compilers = await Promise.all(['/usr/bin/clang', '/usr/bin/clang++', '/usr/bin/make'].map(async file => [file, await stableFile(await realpath(file))]));
  return { npm, npmRoot, nodeGyp, python, prefix, observation: { npmVersion: npmMetadata.version, npmCliSHA256: await stableFile(npm), nodeGypVersion: gyp.version, nodeGypSHA256: await treeHash(nodeGypRoot),
    nodeBinarySHA256: await stableFile(node), nodeHeadersSHA256: await treeHash(headersRoot), pythonSHA256: await stableFile(python), compilerToolsSHA256: hash(JSON.stringify(compilers)) } };
}

// npm prepends ancestor .bin paths. Refuse a shadow executable before the exact
// reviewed loader/Node. NODE_PATH supplies only the validated npm-owned node-gyp.
async function verifyBuildCommands(tools, builder) {
  const packageRoot = path.join(tools, CORESIM), loader = path.join(tools, 'node_modules/appium-xcuitest-driver/node_modules/node-gyp-build/bin.js');
  const dirs = []; for (let cursor = packageRoot;; cursor = path.dirname(cursor)) { dirs.push(path.join(cursor, 'node_modules/.bin')); if (cursor === path.dirname(cursor)) break; }
  dirs.push(path.join(builder.npmRoot, 'node_modules/@npmcli/run-script/lib/node-gyp-bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  for (const [command, expected] of [['node', await realpath(process.execPath)], ['node-gyp-build', loader]]) {
    let found; for (const dir of dirs) { try { found = await realpath(path.join(dir, command)); break; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; } }
    if (found !== expected) throw nativeFail();
  }
  // node-gyp-build resolves a module before its PATH fallback. Every closer
  // package candidate must be absent; the final explicit NODE_PATH is trusted.
  for (let cursor = path.dirname(loader);; cursor = path.dirname(cursor)) {
    try { await lstat(path.join(cursor, 'node_modules/node-gyp')); throw nativeFail(); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (cursor === path.dirname(cursor)) break;
  }
}

async function prepareCoresimPrerequisite({ tools, npmCli, signal, environment, privateRoot }) {
  if (signal?.aborted) throw fail('IOS_TOOLS_CANCELLED');
  if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(process.arch)) throw fail('IOS_TOOLS_NATIVE_MACOS_REQUIRED');
  if (environment.DEVELOPER_DIR !== XCODE) throw nativeFail(); await canonicalDirectory(XCODE);
  const sources = await verifyCoresimSources(tools), builder = await providedBuilder(npmCli);
  const nativeHome = await canonicalDirectory(os.userInfo().homedir);
  await canonicalDirectory(privateRoot);
  const nativeEnvironment = coresimNativeProbeEnvironment({ nativeHome, privateRoot, nodeBin: path.dirname(await realpath(process.execPath)) });
  try { await lstat(path.join(tools, CORESIM, 'build')); throw nativeFail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await verifyBuildCommands(tools, builder);
  const env = { ...environment, NODE_PATH: path.join(builder.npmRoot, 'node_modules'), npm_config_node_gyp: builder.nodeGyp,
    NODE_GYP_FORCE_PYTHON: builder.python, PYTHON: builder.python, PYTHONDONTWRITEBYTECODE: '1', npm_config_nodedir: builder.prefix,
    npm_config_devdir: path.join(privateRoot, 'gyp-cache'), npm_config_build_from_source: 'true', npm_config_arch: process.arch,
    npm_config_offline: 'true', CC: '/usr/bin/clang', CXX: '/usr/bin/clang++', MAKE: '/usr/bin/make' };
  const toolProbe = path.join(privateRoot, 'toolchain-probe.cjs');
  await writeFile(toolProbe, `const{spawnSync}=require('node:child_process');const run=(entry,args)=>{const r=spawnSync(entry,args,{shell:false,env:process.env,timeout:10000,maxBuffer:8192});if(r.status!==0||r.error)throw Error('IOS_TOOLS_NATIVE_PREREQUISITE_FAILED');return r.stdout.toString('utf8').trim()};const x=run('/usr/bin/xcodebuild',['-version']);run('/usr/bin/xcodebuild',['-checkFirstLaunchStatus']);const p=run('/usr/bin/python3',['--version']);const a=/^Xcode (26\\.6)\\r?\\nBuild version ([A-Za-z0-9]+)$/.exec(x),b=/^Python (\\d+\\.\\d+\\.\\d+)$/.exec(p);if(!a||!b)throw Error('IOS_TOOLS_NATIVE_PREREQUISITE_FAILED');process.stdout.write(JSON.stringify({xcodeVersion:a[1],xcodeBuild:a[2],pythonVersion:b[1]}));\n`, { flag: 'wx', mode: 0o600 });
  const observed = await runDemoChild({ entry: toolProbe, cwd: tools, env: nativeEnvironment, signal, timeoutMs: 35000 });
  if (observed.code !== 0) throw nativeFail(); let versions;
  try { versions = JSON.parse(observed.stdout); if (!exactKeys(versions, ['xcodeVersion', 'xcodeBuild', 'pythonVersion']) || versions.xcodeVersion !== '26.6' || !/^[A-Za-z0-9]+$/.test(versions.xcodeBuild) || !version(versions.pythonVersion)) throw nativeFail(); } catch { throw nativeFail(); }
  const rebuilt = await runDemoChild({ entry: builder.npm, args: coresimRebuildArguments(), cwd: tools, env, signal, timeoutMs: 220000 });
  if (rebuilt.code !== 0 || JSON.stringify(await verifyCoresimSources(tools)) !== JSON.stringify(sources)) throw nativeFail();
  const binarySHA256 = await inspectCoresimBinary(path.join(tools, NATIVE_BINARY), process.arch);
  const probe = path.join(privateRoot, 'framework-probe.mjs');
  await writeFile(probe, coresimFrameworkProbeSource(), { flag: 'wx', mode: 0o600 });
  const loaded = await runDemoChild({ entry: probe, cwd: tools, env: nativeEnvironment, signal, timeoutMs: 35000 });
  if (loaded.code !== 0 || JSON.stringify(await verifyCoresimSources(tools)) !== JSON.stringify(sources) || await inspectCoresimBinary(path.join(tools, NATIVE_BINARY), process.arch) !== binarySHA256) throw nativeFail();
  const result = { schemaVersion: 1, sourceBuild: true, packageVersion: '1.13.1', sources, binaryRelativePath: NATIVE_BINARY, binarySHA256,
    nativeHome,
    nodeVersion: process.versions.node, nodeABI: process.versions.modules, nodeNapi: process.versions.napi, architecture: process.arch,
    ...builder.observation, ...versions, frameworkVersion: parseCoresimProbe(loaded.stdout).frameworkVersion,
    npmCli: builder.npm, nodeGyp: builder.nodeGyp, python: builder.python, headersRoot: path.join(builder.prefix, 'include/node'), xcodeDirectory: XCODE };
  if (JSON.stringify((await providedBuilder(builder.npm)).observation) !== JSON.stringify(builder.observation)) throw nativeFail();
  if (signal?.aborted) throw fail('IOS_TOOLS_CANCELLED');
  return Object.freeze(result);
}

/** Verify recorded source/binary/runtime bindings before allocating a Simulator. */
export async function verifyPinnedIosNativePrerequisite({ toolsRoot }) {
  try {
    const tools = await canonicalDirectory(toolsRoot), marker = await json(path.join(tools, MARKER)), value = marker.nativePrerequisite;
    if (process.platform !== 'darwin' || marker.status !== 'ready' || marker.outputDir !== tools || value?.schemaVersion !== 1 || value.sourceBuild !== true ||
        value.packageVersion !== '1.13.1' || value.binaryRelativePath !== NATIVE_BINARY || value.architecture !== process.arch || value.nodeVersion !== process.versions.node ||
        value.nodeABI !== process.versions.modules || value.nodeNapi !== process.versions.napi || !sha256(value.binarySHA256) || !version(value.frameworkVersion) || value.xcodeDirectory !== XCODE) throw nativeFail();
    if (value.nativeHome !== await canonicalDirectory(os.userInfo().homedir)) throw nativeFail();
    if (JSON.stringify(await verifyCoresimSources(tools)) !== JSON.stringify(value.sources) || await inspectCoresimBinary(path.join(tools, NATIVE_BINARY), process.arch) !== value.binarySHA256) throw nativeFail();
    const builder = await providedBuilder(value.npmCli);
    if (Object.entries(builder.observation).some(([key, data]) => value[key] !== data) || value.nodeGyp !== builder.nodeGyp || value.python !== builder.python || value.headersRoot !== path.join(builder.prefix, 'include/node')) throw nativeFail();
    return Object.freeze({ ready: true });
  } catch { throw nativeFail(); }
}

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
    // All installer configuration, downloads, headers, build cache and temporary
    // files stay in this new marked tree. Never forward ambient npm settings.
    const privateRoot = path.join(requested, '.native');
    await mkdir(privateRoot, { mode: 0o700 });
    for (const dir of ['home', 'tmp', 'cache', 'gyp-cache', 'npm-cache', 'appium']) await mkdir(path.join(privateRoot, dir), { mode: 0o700 });
    for (const file of ['user.npmrc', 'global.npmrc']) await writeFile(path.join(privateRoot, file), '', { flag: 'wx', mode: 0o600 });
    const environment = { PATH: [path.dirname(await realpath(process.execPath)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      HOME: path.join(privateRoot, 'home'), TMPDIR: path.join(privateRoot, 'tmp'), TMP: path.join(privateRoot, 'tmp'), TEMP: path.join(privateRoot, 'tmp'),
      XDG_CACHE_HOME: path.join(privateRoot, 'cache'), APPIUM_HOME: path.join(privateRoot, 'appium'), DEVELOPER_DIR: XCODE,
      LANG: 'C', LC_ALL: 'C', APPIUM_SKIP_EXTENSIONS_INSTALL: '1', DEBUG: '', NODE_DEBUG: '', VERBOSE_LOGGING: '0',
      npm_config_cache: path.join(privateRoot, 'npm-cache'), npm_config_userconfig: path.join(privateRoot, 'user.npmrc'),
      npm_config_globalconfig: path.join(privateRoot, 'global.npmrc'), npm_config_update_notifier: 'false' };
    if (signal?.aborted) throw fail('IOS_TOOLS_CANCELLED');
    const result = await runDemoChild({ entry: npmCli, args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      cwd: requested, timeoutMs: 220000, signal, env: environment });
    if (result.code !== 0) throw fail('IOS_TOOLS_INSTALL_FAILED');
    await assertOwned();
    if (hash(await readFile(path.join(requested, 'package.json'))) !== marker.packageSha256 || hash(await readFile(path.join(requested, 'package-lock.json'))) !== marker.lockSha256) throw fail('IOS_TOOLS_MANIFEST_CHANGED');
    for (const [parts, version] of PINS) if (JSON.parse(await readFile(path.join(requested, 'node_modules', ...parts, 'package.json'), 'utf8')).version !== version) throw fail('IOS_TOOLS_VERSION_MISMATCH');
    const project = path.join(requested, 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj', 'project.pbxproj');
    const info = await lstat(project); if (!info.isFile() || info.isSymbolicLink()) throw fail('IOS_TOOLS_WDA_PROJECT_MISSING');
    marker.nativePrerequisite = await prepareCoresimPrerequisite({ tools: requested, npmCli, signal, environment, privateRoot });
    marker.wdaStartupPatch = await applyPinnedWdaStartupPatch({ toolsRoot: requested });
    if (signal?.aborted) throw fail('IOS_TOOLS_CANCELLED');
    marker.status = 'ready'; await writeFile(path.join(requested, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
    return Object.freeze({ toolsRoot: requested, packageSha256: marker.packageSha256, lockSha256: marker.lockSha256, wdaStartupPatch: marker.wdaStartupPatch });
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
