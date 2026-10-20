import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coresimFrameworkProbeSource, coresimNativeProbeEnvironment, coresimRebuildArguments, inspectCoresimBinary, installPinnedIosTools, parseCoresimProbe, verifyCoresimSources, verifyPinnedIosNativePrerequisite } from '../tools/setup.mjs';
import { runDemoChild } from '../../verification-demo/native.mjs';

async function fixture(fn) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-coresim-test-'));
  try { await fn(root); } finally {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^tld-coresim-test-[A-Za-z0-9]+$/);
    assert.equal(await realpath(root), root); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true });
  }
}
const fixedFailure = error => error instanceof Error && error.message === 'IOS_TOOLS_NATIVE_PREREQUISITE_FAILED';

test('native probe environment copies only fixed device-style bindings and preserves native account HOME', () => {
  const binding = { nativeHome: '/Users/runner', privateRoot: '/private/tools/.native', nodeBin: '/opt/node/bin' };
  const environment = coresimNativeProbeEnvironment(binding);
  binding.nativeHome = '/private/tools/.native/home'; binding.privateRoot = '/changed'; binding.nodeBin = '/changed/bin';
  assert.equal(environment.HOME, '/Users/runner'); assert.notEqual(environment.HOME, '/private/tools/.native/home');
  assert.equal(environment.APPIUM_HOME, '/private/tools/.native/appium'); assert.equal(environment.TMPDIR, '/private/tools/.native/tmp/');
  assert.equal(environment.XDG_CACHE_HOME, '/private/tools/.native/cache');
  assert.equal(environment.PATH, '/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(environment.DEVELOPER_DIR, '/Applications/Xcode_26.6.app/Contents/Developer');
  assert.deepEqual(Object.keys(environment).sort(), ['APPIUM_HOME', 'APPIUM_SKIP_EXTENSIONS_INSTALL', 'DEBUG', 'DEVELOPER_DIR', 'HOME', 'LANG', 'LC_ALL', 'NODE_DEBUG', 'PATH', 'TMPDIR', 'VERBOSE_LOGGING', 'XDG_CACHE_HOME'].sort());
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(environment.npm_config_node_gyp, undefined); assert.equal(environment.NODE_PATH, undefined); assert.equal(environment.CORESIM_TEST_PLATFORM, undefined);
});

test('copied framework probe refuses another resolved binary before importing the synthetic native module', async () => fixture(async root => {
  const privateRoot = path.join(root, '.native'), nested = path.join(root, 'node_modules/appium-xcuitest-driver/node_modules');
  const addon = path.join(nested, '@appium/coresim'), loader = path.join(nested, 'node-gyp-build');
  for (const dir of [privateRoot, path.join(addon, 'build/Release'), path.join(addon, 'lib/src'), loader]) await mkdir(dir, { recursive: true });
  const expected = path.join(addon, 'build/Release/coresim.node'), other = path.join(addon, 'build/Release/other.node');
  await writeFile(expected, randomBytes(8)); await writeFile(other, randomBytes(8));
  await writeFile(path.join(addon, 'package.json'), JSON.stringify({ name: '@appium/coresim', type: 'module' }));
  await writeFile(path.join(addon, 'lib/src/index.js'), "import{writeFileSync}from'node:fs';writeFileSync('module-imported','fixed');export const NativeSimctl={frameworkVersion:async()=> '1046.15'};\n");
  const probe = path.join(privateRoot, 'framework-probe.mjs'); await writeFile(probe, coresimFrameworkProbeSource());
  await writeFile(path.join(loader, 'index.js'), 'exports.path=()=>'+JSON.stringify(other)+';\n');
  const refused = await runDemoChild({ entry: probe, cwd: root, timeoutMs: 10000 });
  assert.equal(refused.code, 1); await assert.rejects(lstat(path.join(root, 'module-imported')), { code: 'ENOENT' });
  await writeFile(path.join(loader, 'index.js'), 'exports.path=()=>'+JSON.stringify(expected)+';\n');
  const loaded = await runDemoChild({ entry: probe, cwd: root, timeoutMs: 10000 });
  assert.equal(loaded.code, 0); assert.deepEqual(parseCoresimProbe(loaded.stdout), { schemaVersion: 1, frameworkVersion: '1046.15' });
  assert.equal(await readFile(path.join(root, 'module-imported'), 'utf8'), 'fixed');
}));

test('framework-only probe accepts numeric fixed metadata and rejects extra, malformed or freeform output', () => {
  assert.deepEqual(parseCoresimProbe('{"schemaVersion":1,"frameworkVersion":"1046.15"}'), { schemaVersion: 1, frameworkVersion: '1046.15' });
  assert.deepEqual(parseCoresimProbe('{"schemaVersion":1,"frameworkVersion":"1046"}'), { schemaVersion: 1, frameworkVersion: '1046' });
  const canary = randomBytes(18).toString('hex');
  for (const value of [null, [], {}, { schemaVersion: 1, frameworkVersion: ['1046.15'] }, { schemaVersion: 1, frameworkVersion: canary },
    { schemaVersion: 1, frameworkVersion: '1046.15', extra: canary }, { schemaVersion: 2, frameworkVersion: '1046.15' }]) {
    assert.throws(() => parseCoresimProbe(JSON.stringify(value)), fixedFailure);
  }
  assert.throws(() => parseCoresimProbe(canary), fixedFailure);
});

test('built addon inspection checks actual thin Mach-O architecture and rejects aliases without loading code', async () => fixture(async root => {
  for (const [arch, cpu] of [['x64', 0x01000007], ['arm64', 0x0100000c]]) {
    const bytes = randomBytes(32); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4);
    const folder = path.join(root, arch); await mkdir(folder);
    const file = path.join(folder, 'coresim.node'); await writeFile(file, bytes);
    assert.equal(await inspectCoresimBinary(file, arch), createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(inspectCoresimBinary(file, arch === 'x64' ? 'arm64' : 'x64'), fixedFailure);
    await writeFile(path.join(folder, 'other.node'), randomBytes(8));
    await assert.rejects(inspectCoresimBinary(file, arch), fixedFailure);
  }
  const directory = path.join(root, 'real'); await mkdir(directory); await writeFile(path.join(directory, 'addon.node'), randomBytes(32));
  const alias = path.join(root, 'alias'); await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectCoresimBinary(path.join(alias, 'addon.node'), 'x64'), fixedFailure);
  await assert.rejects(inspectCoresimBinary(path.join(root, 'missing.node'), 'x64'), fixedFailure);
}));

test('missing, duplicate or redirected addon sources are refused before any native loading', async () => fixture(async root => {
  await mkdir(path.join(root, 'node_modules'));
  await assert.rejects(verifyCoresimSources(root), fixedFailure);
  const duplicate = path.join(root, 'node_modules/@appium/coresim'); await mkdir(duplicate, { recursive: true });
  await writeFile(path.join(duplicate, 'package.json'), JSON.stringify({ name: '@appium/coresim', version: '1.13.1' }));
  await assert.rejects(verifyCoresimSources(root), fixedFailure);
  const alias = path.join(root, 'alias'); await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyCoresimSources(alias), fixedFailure);
  await assert.rejects(verifyPinnedIosNativePrerequisite({ toolsRoot: root }), fixedFailure);
}));

test('installer fixture receives owned configuration without ambient canaries or build overrides', async () => fixture(async root => {
  const script = path.join(root, 'fake-npm.mjs'), output = path.join(root, 'tools');
  const name = 'TESTLANE_FIXTURE_CANARY', previous = process.env[name]; process.env[name] = randomBytes(18).toString('hex');
  await writeFile(script, "import{writeFileSync}from'node:fs';import path from'node:path';const within=value=>typeof value==='string'&&value.startsWith(process.cwd()+path.sep);writeFileSync('environment-check.json',JSON.stringify({canaryAbsent:process.env.TESTLANE_FIXTURE_CANARY===undefined,nodeOptionsAbsent:process.env.NODE_OPTIONS===undefined,sourceBuildNotYetEnabled:process.env.npm_config_build_from_source===undefined,owned:['HOME','TMPDIR','XDG_CACHE_HOME','APPIUM_HOME','npm_config_cache','npm_config_userconfig','npm_config_globalconfig'].every(key=>within(process.env[key]))}));process.exitCode=1;\n");
  try { await assert.rejects(installPinnedIosTools({ outputDir: output, npmCli: script }), /IOS_TOOLS_INSTALL_FAILED/); }
  finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'environment-check.json'))), { canaryAbsent: true, nodeOptionsAbsent: true, sourceBuildNotYetEnabled: true, owned: true });
  const marker = JSON.parse(await readFile(path.join(output, 'testlane-ios-tools.json')));
  assert.equal(marker.status, 'incomplete'); assert.equal(marker.nativePrerequisite, undefined);
  assert.equal(JSON.parse(await readFile(path.join(output, 'setup-recovery.json'))).childTerminationConfirmed, true);
}));

test('setup CLI refuses an unsupported host before allocation or child startup', async () => fixture(async root => {
  const script = path.join(root, 'unsupported.mjs'), output = path.join(root, 'not-created');
  const setup = fileURLToPath(new URL('../tools/setup.mjs', import.meta.url));
  await writeFile(script, `Object.defineProperty(process,'platform',{value:'win32'});process.argv=[process.execPath,${JSON.stringify(setup)},'--output-dir',${JSON.stringify(output)}];await import(${JSON.stringify(new URL('../tools/setup.mjs', import.meta.url).href)});\n`);
  const result = await runDemoChild({ entry: script, cwd: root, timeoutMs: 10000 });
  assert.equal(result.code, 1); assert.equal(result.stderr.trim(), 'IOS_TOOLS_MACOS_REQUIRED');
  assert.deepEqual(await readdir(root), ['unsupported.mjs']);
}));

test('offline exact bundled rebuild runs only the target install hook, never prepare, sibling or dependency hooks', async () => fixture(async root => {
  const nodeBin = path.dirname(await realpath(process.execPath)), prefix = path.basename(nodeBin) === 'bin' ? path.dirname(nodeBin) : nodeBin;
  let npmCli;
  for (const candidate of [path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js'), path.join(prefix, 'node_modules/npm/bin/npm-cli.js')]) {
    try { npmCli = await realpath(candidate); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(npmCli, 'the Node distribution must provide npm for this offline fixture');
  const project = path.join(root, 'project'), home = path.join(root, 'home'), temp = path.join(root, 'tmp'), cache = path.join(root, 'cache');
  for (const dir of [project, home, temp, cache, path.join(home, 'roaming'), path.join(home, 'local')]) await mkdir(dir, { recursive: true });
  const events = path.join(root, 'events.jsonl');
  const hook = "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));fs.appendFileSync(process.env.TL_SELECTOR_SENTINEL,JSON.stringify({name:p.name,version:p.version,event:process.env.npm_lifecycle_event})+'\\n');";
  const allHooks = Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare'].map(name => [name, 'node hook.cjs']));
  const lock = { name: 'fixture-root', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} };
  async function add(relative, pkg, inBundle = false) {
    const dir = path.join(project, relative); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg)); await writeFile(path.join(dir, 'hook.cjs'), hook);
    lock.packages[relative.split(path.sep).join('/')] = { version: pkg.version, dependencies: pkg.dependencies, ...(inBundle ? { inBundle: true } : {}) };
  }
  await add('', { name: 'fixture-root', version: '1.0.0', private: true, scripts: allHooks, dependencies: { 'fixture-wrapper': '1.0.0', 'fixture-decoy-wrapper': '1.0.0' } });
  await add('node_modules/fixture-wrapper', { name: 'fixture-wrapper', version: '1.0.0', scripts: allHooks, dependencies: { '@appium/coresim': '1.13.1', 'fixture-sibling': '1.0.0' }, bundleDependencies: ['@appium/coresim', 'fixture-sibling'] });
  await add('node_modules/fixture-wrapper/node_modules/@appium/coresim', { name: '@appium/coresim', version: '1.13.1', scripts: { install: 'node hook.cjs', prepare: 'node hook.cjs' }, dependencies: { 'node-gyp-build': '4.8.4' } }, true);
  await add('node_modules/fixture-wrapper/node_modules/fixture-sibling', { name: 'fixture-sibling', version: '1.0.0', scripts: allHooks }, true);
  await add('node_modules/fixture-wrapper/node_modules/node-gyp-build', { name: 'node-gyp-build', version: '4.8.4', scripts: allHooks }, true);
  await add('node_modules/fixture-decoy-wrapper', { name: 'fixture-decoy-wrapper', version: '1.0.0', scripts: allHooks, dependencies: { '@appium/coresim': '1.13.0' }, bundleDependencies: ['@appium/coresim'] });
  await add('node_modules/fixture-decoy-wrapper/node_modules/@appium/coresim', { name: '@appium/coresim', version: '1.13.0', scripts: allHooks }, true);
  await writeFile(path.join(project, 'package-lock.json'), JSON.stringify(lock));
  const userConfig = path.join(root, 'user.npmrc'), globalConfig = path.join(root, 'global.npmrc');
  await writeFile(userConfig, ''); await writeFile(globalConfig, '');
  const system = process.platform === 'win32' ? process.env.SystemRoot : undefined;
  const environment = { PATH: nodeBin + path.delimiter + (system ? path.join(system, 'System32') : '/usr/bin:/bin'), HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), TMP: temp, TEMP: temp, TMPDIR: temp,
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: cache, npm_config_offline: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', TL_SELECTOR_SENTINEL: events,
    ...(system ? { SystemRoot: system, ComSpec: path.join(system, 'System32/cmd.exe') } : {}) };
  const result = await runDemoChild({ entry: npmCli, args: coresimRebuildArguments(), cwd: project, env: environment, timeoutMs: 30000 });
  assert.equal(result.code, 0);
  const observed = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(observed, [{ name: '@appium/coresim', version: '1.13.1', event: 'install' }]);
}));
