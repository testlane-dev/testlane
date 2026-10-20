import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coresimFrameworkProbeSource, coresimNativeProbeEnvironment, inspectCoresimBinary, installPinnedIosTools, parseCoresimProbe, verifyCoresimSources, verifyPinnedIosNativePrerequisite } from '../tools/setup.mjs';
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

async function controlledGyp(root, body) {
  const addon = path.join(root, 'addon'), npmGyp = path.join(root, 'npm/node_modules/node-gyp/bin');
  await mkdir(addon); await mkdir(npmGyp, { recursive: true });
  const entry = path.join(npmGyp, 'node-gyp.js'); await writeFile(entry, body);
  // These hooks must never run when the validated node-gyp entry is invoked directly.
  const hook = "require('node:fs').writeFileSync('unexpected-lifecycle-hook','fixed')";
  await writeFile(path.join(addon, 'package.json'), JSON.stringify({ name: '@appium/coresim', version: '1.13.1',
    scripts: Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare'].map(event => [event, 'node -e '+JSON.stringify(hook)])) }));
  return { entry: await realpath(entry), cwd: await realpath(addon) };
}
const nodeOnlyEnvironment = () => ({ PATH: path.dirname(process.execPath),
  npm_config_nodedir: 'fixed-local-headers', NODE_GYP_FORCE_PYTHON: 'fixed-local-python',
  CC: 'fixed-local-clang', CXX: 'fixed-local-clang++', MAKE: 'fixed-local-make' });

test('direct builder entry receives exact addon cwd and rebuild argument without npm selection or lifecycle hooks', async () => fixture(async root => {
  const invocation = await controlledGyp(root, "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));fs.writeFileSync('observed.json',JSON.stringify({args:process.argv.slice(2),package:p.name,version:p.version,headers:process.env.npm_config_nodedir,python:process.env.NODE_GYP_FORCE_PYTHON,compiler:process.env.CC,npmLifecycle:process.env.npm_lifecycle_event??null}));\n");
  const result = await runDemoChild({ ...invocation, args: ['rebuild'], env: nodeOnlyEnvironment(), timeoutMs: 10000 });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(invocation.cwd, 'observed.json'), 'utf8')), {
    args: ['rebuild'], package: '@appium/coresim', version: '1.13.1', headers: 'fixed-local-headers',
    python: 'fixed-local-python', compiler: 'fixed-local-clang', npmLifecycle: null,
  });
  await assert.rejects(lstat(path.join(invocation.cwd, 'unexpected-lifecycle-hook')), { code: 'ENOENT' });
  await writeFile(invocation.entry, 'process.exitCode=23;\n');
  const failed = await runDemoChild({ ...invocation, args: ['rebuild'], env: nodeOnlyEnvironment(), timeoutMs: 10000 });
  assert.equal(failed.code, 23);
}));

test('direct builder signal termination cannot be normalized to a successful exit', async () => fixture(async root => {
  const invocation = await controlledGyp(root, "process.kill(process.pid,'SIGTERM');\n");
  const result = await runDemoChild({ ...invocation, args: ['rebuild'], env: nodeOnlyEnvironment(), timeoutMs: 10000 });
  assert.notEqual(result.code, 0);
  await assert.rejects(lstat(path.join(invocation.cwd, 'unexpected-lifecycle-hook')), { code: 'ENOENT' });
}));

test('direct builder cancellation waits for confirmed child termination and pre-abort starts no child', async () => fixture(async root => {
  const invocation = await controlledGyp(root, "require('node:fs').writeFileSync('ready.pid',String(process.pid));setInterval(()=>{},1000);\n");
  const controller = new AbortController();
  const pending = runDemoChild({ ...invocation, args: ['rebuild'], env: nodeOnlyEnvironment(), signal: controller.signal, timeoutMs: 20000 });
  // Attach immediately; readiness failures still abort and join the actual retained child.
  const settled = pending.then(value => ({ value }), error => ({ error }));
  let pid;
  try {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      try { pid = Number(await readFile(path.join(invocation.cwd, 'ready.pid'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'controlled builder must be ready before cancellation');
    controller.abort();
    const result = await settled;
    assert.equal(result.error?.message, 'DEMO_CANCELLED'); assert.equal(result.value, undefined);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { controller.abort(); await settled; }
  await writeFile(invocation.entry, "require('node:fs').writeFileSync('preabort-started','fixed');\n");
  await assert.rejects(runDemoChild({ ...invocation, args: ['rebuild'], env: nodeOnlyEnvironment(), signal: controller.signal, timeoutMs: 10000 }), /DEMO_CANCELLED/);
  await assert.rejects(lstat(path.join(invocation.cwd, 'preabort-started')), { code: 'ENOENT' });
}));
