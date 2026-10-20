/** Environment contracts and a controlled Node child; no SDK, Java, ADB or store execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { androidDeviceDirectories, createAndroidControlEnvironment, createAndroidDeviceEnvironment, requireAndroidProofHost } from '../environment.mjs';
import { stopOwnedAndroidProcesses } from '../device.mjs';

const binding = platform => platform === 'win32' ? {
  root: 'C:\\private\\tld-android-unit', sdkRoot: 'C:\\public-sdk', javaHome: 'C:\\Program Files\\Java',
  nodeExecutable: 'C:\\public-node\\node.exe', adbPort: 49321,
} : { root: '/private/tmp/tld-android-unit', sdkRoot: '/public-sdk', javaHome: '/public-java', nodeExecutable: '/public-node/node', adbPort: 49321 };
const system = () => ({ SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
const sourceFor = platform => platform === 'win32' ? { ...system(), Path: 'C:\\Windows\\System32;C:/Windows/' } : { PATH: '/usr/bin:/bin/' };
const invalid = callback => assert.throws(callback, { message: 'ANDROID_DEVICE_ENV_INVALID' });
const commonKeys = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_AVD_HOME',
  'ADB_VENDOR_KEYS', 'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_PORT', 'ADB_MDNS_AUTO_CONNECT', 'ADB_USB', 'ADB_EMU', 'APPIUM_HOME', 'APPIUM_TMP_DIR',
  'HOME', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'DEBUG', 'NODE_DEBUG', 'ANDROID_VERBOSE', 'APPIUM_SKIP_EXTENSIONS_INSTALL'];
const windowsKeys = ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'];

test('Windows native host policy requires every explicit hosted-CI flag without forwarding them to device children', () => {
  const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', TESTLANE_ANDROID_PROOF_CI: '1' };
  assert.equal(requireAndroidProofHost(hosted, { platform: 'win32' }), true);
  assert.equal(requireAndroidProofHost({ github_actions: 'true', runner_environment: 'github-hosted', testlane_android_proof_ci: '1' }, { platform: 'win32' }), true);
  for (const source of [{}, ...Object.keys(hosted).map(key => ({ ...hosted, [key]: undefined })),
    { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...hosted, TESTLANE_ANDROID_PROOF_CI: 'true' },
    { ...hosted, GITHUB_ACTIONS: 'TRUE' }, { ...hosted, github_actions: 'true' }]) {
    assert.throws(() => requireAndroidProofHost(source, { platform: 'win32' }), { message: 'ANDROID_HOST_POLICY_REFUSED' });
  }
  let touched = false;
  Object.defineProperty(hosted, 'UNRECOGNIZED_CREDENTIAL', { enumerable: true, get() { touched = true; throw Error('UNEXPECTED_READ'); } });
  assert.equal(requireAndroidProofHost(hosted, { platform: 'win32' }), true); assert.equal(touched, false);
  for (const platform of ['linux', 'darwin']) assert.equal(requireAndroidProofHost({}, { platform }), true);
  const env = createAndroidDeviceEnvironment(binding('win32'), Object.assign(hosted, system()), { platform: 'win32' });
  for (const key of ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'TESTLANE_ANDROID_PROOF_CI']) assert.equal(Object.hasOwn(env, key), false);
});

test('exact Windows/POSIX allowlists keep owned paths and omit credentials, proxies and injection without inspecting unknown getters', () => {
  const canary = randomBytes(32).toString('base64url'); let touched = 0;
  const omitted = ['GITHUB_TOKEN', 'gh_token', 'ACTIONS_RUNTIME_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY',
    'DATABASE_URL', 'TESTLANE_HOME', 'TESTLANE_PROFILE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_V8_COVERAGE',
    'JDK_JAVA_OPTIONS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'CLASSPATH', 'JDK_HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'CFFIXED_USER_HOME', 'PYTHONPATH', 'BASH_ENV', 'ENV', 'PSModulePath', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY',
    'SSL_CERT_FILE', 'ADB_TRACE', 'ANDROID_SERIAL', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_LOG_TAGS', 'QT_PLUGIN_PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'];
  for (const platform of ['win32', 'linux', 'darwin']) {
    const owned = Object.freeze(binding(platform)), before = JSON.stringify(owned);
    const source = { ...Object.fromEntries(omitted.map(key => [key, canary])), ...sourceFor(platform), HOME: canary, USERPROFILE: canary,
      TMP: canary, TEMP: canary, TMPDIR: canary, APPIUM_HOME: canary, APPIUM_TMP_DIR: canary, ADB_VENDOR_KEYS: canary,
      ADB_SERVER_SOCKET: canary, ANDROID_HOME: canary, JAVA_HOME: canary };
    Object.defineProperty(source, 'UNKNOWN_GETTER', { enumerable: true, get() { touched++; throw Error(canary); } });
    Object.freeze(source);
    const result = createAndroidDeviceEnvironment(owned, source, { platform }), paths = platform === 'win32' ? path.win32 : path.posix;
    assert.deepEqual(Object.keys(result).sort(), [...commonKeys, ...(platform === 'win32' ? windowsKeys : [])].sort());
    for (const key of omitted) assert.equal(Object.hasOwn(result, key), false);
    for (const value of [canary, encodeURIComponent(canary), Buffer.from(canary).toString('base64')]) assert.equal(JSON.stringify(result).includes(value), false);
    assert.equal(result.HOME, paths.join(owned.root, 'home'));
    assert.equal(result.TMP, paths.join(owned.root, 'tmp')); assert.equal(result.TEMP, result.TMP); assert.equal(result.TMPDIR, result.TMP);
    assert.equal(result.APPIUM_TMP_DIR, result.TMP); assert.equal(result.XDG_CACHE_HOME, paths.join(owned.root, 'cache'));
    assert.equal(result.APPIUM_HOME, paths.join(owned.root, 'appium'));
    assert.equal(result.ANDROID_USER_HOME, paths.join(owned.root, 'android')); assert.equal(result.ANDROID_EMULATOR_HOME, result.ANDROID_USER_HOME);
    assert.equal(result.ANDROID_AVD_HOME, paths.join(result.ANDROID_USER_HOME, 'avd'));
    assert.equal(result.ADB_VENDOR_KEYS, paths.join(result.ANDROID_USER_HOME, 'adbkey'));
    assert.equal(result.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:49321'); assert.equal(result.ANDROID_ADB_SERVER_PORT, '49321');
    assert.equal(result.JAVA_HOME, owned.javaHome); assert.equal(result.ANDROID_HOME, owned.sdkRoot); assert.equal(result.ANDROID_SDK_ROOT, owned.sdkRoot);
    assert.equal(result.PATH.split(paths.delimiter)[0], paths.dirname(owned.nodeExecutable));
    if (platform === 'win32') {
      assert.equal(result.USERPROFILE, result.HOME); assert.equal(result.HOMEDRIVE + result.HOMEPATH, result.HOME);
      assert.equal(result.APPDATA, paths.join(result.HOME, 'AppData', 'Roaming')); assert.equal(result.LOCALAPPDATA, paths.join(result.HOME, 'AppData', 'Local'));
    }
    assert.equal(result.LANG, 'C'); assert.equal(result.LC_ALL, 'C'); assert.equal(result.APPIUM_SKIP_EXTENSIONS_INSTALL, '1');
    for (const key of ['DEBUG', 'NODE_DEBUG', 'ANDROID_VERBOSE']) assert.equal(result[key], '');
    for (const key of ['ADB_MDNS_AUTO_CONNECT', 'ADB_USB', 'ADB_EMU']) assert.equal(result[key], '0');
    assert.equal(JSON.stringify(owned), before); assert.equal(source.HOME, canary); assert.ok(Object.isFrozen(result));
  }
  assert.equal(touched, 0);
});

test('Windows OS-only cleanup environment cannot inherit user PATH or profile and uses only its fixed command processor', () => {
  const canary = randomBytes(24).toString('base64url');
  const result = createAndroidControlEnvironment({ ...system(), PATH: 'not-an-executable-path', HOME: canary, GH_TOKEN: canary, NODE_OPTIONS: canary }, { platform: 'win32' });
  assert.deepEqual(result, { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'C:\\Windows\\System32' });
  assert.ok(Object.isFrozen(result)); assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(createAndroidControlEnvironment({ windir: 'C:\\Windows' }, { platform: 'win32' }).ComSpec, result.ComSpec);
  invalid(() => createAndroidControlEnvironment({}, { platform: 'win32' }));
  invalid(() => createAndroidControlEnvironment({ ...system(), windir: 'C:\\Other' }, { platform: 'win32' }));
  invalid(() => createAndroidControlEnvironment({ ...system(), ComSpec: 'C:\\other\\shell.exe' }, { platform: 'win32' }));
  invalid(() => createAndroidControlEnvironment({ ...system(), SYSTEMROOT: 'C:\\Windows' }, { platform: 'win32' }));
});

test('PATH case handling, fixed fallbacks and Darwin POSIX configuration do not rely on a parent-path fallback', () => {
  const win = createAndroidDeviceEnvironment(binding('win32'), system(), { platform: 'win32' });
  assert.equal(win.PATH.endsWith('C:\\Windows\\System32;C:\\Windows'), true);
  assert.equal(Object.hasOwn(win, 'Path'), false);
  invalid(() => createAndroidDeviceEnvironment(binding('win32'), { ...system(), PATH: 'C:\\Windows', Path: 'C:\\Other' }, { platform: 'win32' }));
  const linux = createAndroidDeviceEnvironment(binding('linux'), {}, { platform: 'linux' });
  const darwin = createAndroidDeviceEnvironment(binding('darwin'), {}, { platform: 'darwin' });
  assert.deepEqual(darwin, linux); assert.equal(linux.PATH.endsWith('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'), true);
});

test('malformed, relative, ambiguous and injected configuration always uses one fixed refusal code', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const value of [null, [], undefined, {}, { ...binding(platform), extra: 'unexpected' },
      { ...binding(platform), root: 'relative' }, { ...binding(platform), sdkRoot: 'relative' },
      { ...binding(platform), nodeExecutable: 'relative' }, { ...binding(platform), adbPort: 5037 }, { ...binding(platform), adbPort: 0 }]) {
      invalid(() => createAndroidDeviceEnvironment(value, sourceFor(platform), { platform }));
    }
    const invalidPaths = platform === 'win32' ? ['', 'C:\\Windows;', '.;C:\\Windows', 'C:relative', '\\\\server\\share', '\\\\?\\C:\\Windows',
      'C:\\Windows\\..\\Other', '%SystemRoot%\\System32', '"C:\\Program Files"', 'C:\\Windows\n'] : ['', '/usr/bin:', '.:/usr/bin', 'relative', '/usr/../bin', '/usr/bin\n'];
    for (const PATH of invalidPaths) invalid(() => createAndroidDeviceEnvironment(binding(platform), { ...(platform === 'win32' ? system() : {}), PATH }, { platform }));
    for (const source of [null, []]) invalid(() => createAndroidDeviceEnvironment(binding(platform), source, { platform }));
  }
});

test('owned directories are derived under the marked root without changing filesystem authority', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const owned = binding(platform), paths = platform === 'win32' ? path.win32 : path.posix;
    const directories = androidDeviceDirectories(owned.root, { platform });
    assert.ok(Object.isFrozen(directories));
    for (const value of Object.values(directories)) assert.equal(paths.relative(owned.root, value).startsWith('..'), false);
    invalid(() => androidDeviceDirectories(paths.join(paths.dirname(owned.root), 'unowned'), { platform }));
  }
});

test('a real controlled Node child sees only owned home/temp selection and no inherited canary', { timeout: 10000 }, async () => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-android-env'));
  const canary = randomBytes(24).toString('base64url'); let child;
  try {
    const configuration = process.platform === 'win32' ? createAndroidControlEnvironment() : { PATH: '/usr/bin:/bin' };
    const env = createAndroidDeviceEnvironment({ root, sdkRoot: path.join(root, 'sdk'), javaHome: path.join(root, 'java'), nodeExecutable: await realpath(process.execPath), adbPort: 49321 },
      { ...configuration, UNRECOGNIZED_CREDENTIAL: canary, NODE_OPTIONS: canary, JAVA_TOOL_OPTIONS: canary });
    const code = 'const os=require("node:os");const expected=' + JSON.stringify({ home: env.HOME, temp: env.TMPDIR, canary }) + ';' +
      'console.log(JSON.stringify({home:os.homedir()===expected.home,temp:os.tmpdir()===expected.temp,clean:!Object.values(process.env).some(value=>value.includes(expected.canary)),injection:process.env.NODE_OPTIONS===undefined&&process.env.JAVA_TOOL_OPTIONS===undefined}));';
    let stdout = ''; const done = Promise.withResolvers();
    child = childProcess.spawn(process.execPath, ['-e', code], { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 1024) child.kill(); });
    child.once('error', () => done.reject(Error('ENV_CHILD_FAILED'))); child.once('close', code => code === 0 ? done.resolve() : done.reject(Error('ENV_CHILD_FAILED')));
    const timer = setTimeout(() => { child.kill(); done.reject(Error('ENV_CHILD_TIMEOUT')); }, 5000);
    try { await done.promise; } finally { clearTimeout(timer); }
    assert.deepEqual(JSON.parse(stdout), { home: true, temp: true, clean: true, injection: true });
  } finally {
    if (child && child.exitCode === null) child.kill();
    assert.equal(path.dirname(await realpath(root)), parent); assert.match(path.basename(root), /^tld-android-env[A-Za-z0-9]+$/);
    assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true, force: false });
  }
});

test('Windows tree-kill launch receives only the OS allowlist with unchanged retained PID arguments', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform'), originalSpawn = childProcess.spawn;
  const canary = randomBytes(24).toString('base64url'), closed = Promise.withResolvers(); let seen;
  const state = { pid: 4321, spawned: true, exited: false, closed: false, child: { exitCode: null, signalCode: null }, done: closed.promise,
    controlEnvironment: { ...system(), GH_TOKEN: canary, NODE_OPTIONS: canary, PATH: canary } };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    childProcess.spawn = (executable, args, options) => {
      seen = { executable, args, options }; const killer = new EventEmitter(); killer.kill = () => {};
      queueMicrotask(() => { state.closed = true; state.child.exitCode = 0; closed.resolve(); killer.emit('close', 0); }); return killer;
    };
    syncBuiltinESMExports();
    assert.deepEqual(await stopOwnedAndroidProcesses({ emulator: state }, { platform: 'win32' }), []);
    assert.equal(seen.executable, path.join('C:\\Windows', 'System32', 'taskkill.exe')); assert.deepEqual(seen.args, ['/PID', '4321', '/T', '/F']);
    assert.equal(seen.options.shell, false); assert.equal(seen.options.windowsHide, true);
    assert.deepEqual(seen.options.env, createAndroidControlEnvironment(system(), { platform: 'win32' }));
    assert.equal(JSON.stringify(seen.options.env).includes(canary), false);
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports(); Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('controlled child proves host refusal and supported-host cleanup without starting native tools', { timeout: 15000 }, async () => {
  const parent = await realpath(os.tmpdir()), fixture = await mkdtemp(path.join(parent, 'tae'));
  const sdk = path.join(fixture, 's'), java = path.join(fixture, 'j'), tools = path.join(fixture, 't');
  const image = path.join(sdk, 'system-images', 'i'), output = path.join(fixture, 'o');
  const driver = path.join(tools, 'node_modules', 'appium-uiautomator2-driver');
  const server = path.join(driver, 'node_modules', 'appium-uiautomator2-server'), settings = path.join(driver, 'node_modules', 'io.appium.settings');
  const exe = name => name + (process.platform === 'win32' ? '.exe' : '');
  let child;
  try {
    const files = new Map([
      [path.join(sdk, 'platform-tools', exe('adb')), 'synthetic-unused-tool'],
      [path.join(sdk, 'emulator', exe('emulator')), 'synthetic-unused-tool'],
      [path.join(java, 'bin', exe('java')), 'synthetic-unused-tool'],
      [path.join(image, 'kernel-ranchu'), 'synthetic-unused-image'], [path.join(image, 'userdata.img'), 'synthetic-unused-image'],
      [path.join(image, 'source.properties'), 'SystemImage.Abi=x86_64\nSystemImage.TagId=google_apis\nAndroidVersion.ApiLevel=34\n'],
      [path.join(tools, 'node_modules', 'appium', 'package.json'), JSON.stringify({ version: '3.8.0' })],
      [path.join(driver, 'package.json'), JSON.stringify({ version: '8.7.0' })],
      [path.join(server, 'package.json'), JSON.stringify({ version: '10.6.6' })],
      [path.join(settings, 'package.json'), JSON.stringify({ version: '8.0.9' })],
      [path.join(settings, 'apks', 'settings_apk-debug.apk'), 'synthetic-unused-apk'],
      [path.join(server, 'apks', 'appium-uiautomator2-server-v10.6.6.apk'), 'synthetic-unused-apk'],
      [path.join(server, 'apks', 'appium-uiautomator2-server-debug-androidTest.apk'), 'synthetic-unused-apk'],
    ]);
    for (const [file, bytes] of files) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
    const configuration = process.platform === 'win32' ? createAndroidControlEnvironment() : { PATH: '/usr/bin:/bin' };
    const code = 'import cp from "node:child_process";import {syncBuiltinESMExports} from "node:module";import {readdir} from "node:fs/promises";' +
      'import {startOwnedAndroid} from ' + JSON.stringify(new URL('../device.mjs', import.meta.url).href) + ';' +
      'const options=' + JSON.stringify({ sdkRoot: sdk, javaHome: java, toolsRoot: tools, systemImagePath: image, outputDir: output }) + ';' +
      'const fixture=' + JSON.stringify(fixture) + ';const nativeSupported=process.platform==="win32"||process.platform==="linux";let spawns=0;const stages=[];cp.spawn=()=>{spawns++;throw Error("NATIVE_CHILD_NOT_EXPECTED")};syncBuiltinESMExports();' +
      'const initial=(await readdir(fixture)).sort();let hostRefused=false,cancelled=false,darwinRefused=false;const originalPlatform=Object.getOwnPropertyDescriptor(process,"platform");' +
      'try{Object.defineProperty(process,"platform",{value:"win32",configurable:true});delete process.env.GITHUB_ACTIONS;delete process.env.RUNNER_ENVIRONMENT;delete process.env.TESTLANE_ANDROID_PROOF_CI;' +
      'try{await startOwnedAndroid(options)}catch(error){hostRefused=error.message==="ANDROID_HOST_POLICY_REFUSED"}' +
      'const controller=new AbortController();controller.abort();try{await startOwnedAndroid({...options,signal:controller.signal})}catch(error){cancelled=error.message==="ANDROID_CANCELLED"}' +
      'Object.defineProperty(process,"platform",{value:"darwin",configurable:true});process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";process.env.TESTLANE_ANDROID_PROOF_CI="1";' +
      'try{await startOwnedAndroid(options)}catch(error){darwinRefused=error.message==="ANDROID_PROCESS_IDENTITY_UNSUPPORTED"}' +
      '}finally{Object.defineProperty(process,"platform",originalPlatform)}' +
      'const refusalUntouched=JSON.stringify(initial)===JSON.stringify((await readdir(fixture)).sort());' +
      'process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";process.env.TESTLANE_ANDROID_PROOF_CI="1";process.env.PATH="relative";' +
      'let builderRefused=false;try{await startOwnedAndroid({...options,onStage:stage=>stages.push(stage)})}catch(error){builderRefused=error.message===(nativeSupported?"ANDROID_DEVICE_ENV_INVALID":"ANDROID_PROCESS_IDENTITY_UNSUPPORTED")}' +
      'console.log(JSON.stringify({hostRefused,cancelled,darwinRefused,refusalUntouched,builderRefused,zeroTools:spawns===0,knownStage:JSON.stringify(stages)===JSON.stringify(nativeSupported?["sdk-and-pinned-tools-validated"]:[]),' +
      'rootRemoved:JSON.stringify((await readdir(fixture)).sort())===JSON.stringify(nativeSupported?["j","o","s","t"]:["j","s","t"]),' +
      'outputEmpty:nativeSupported?(await readdir(options.outputDir)).length===0:await readdir(options.outputDir).then(()=>false,error=>error.code==="ENOENT")}));';
    const env = { ...configuration, TMP: fixture, TEMP: fixture, TMPDIR: fixture,
      GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', TESTLANE_ANDROID_PROOF_CI: '1' };
    let stdout = ''; const done = Promise.withResolvers();
    child = childProcess.spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: fixture, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 1024) child.kill(); });
    child.once('error', () => done.reject(Error('ENV_CHILD_FAILED'))); child.once('close', code => code === 0 ? done.resolve() : done.reject(Error('ENV_CHILD_FAILED')));
    const timer = setTimeout(() => { child.kill(); done.reject(Error('ENV_CHILD_TIMEOUT')); }, 10000);
    try { await done.promise; } finally { clearTimeout(timer); }
    assert.deepEqual(JSON.parse(stdout), { hostRefused: true, cancelled: true, darwinRefused: true, refusalUntouched: true, builderRefused: true, zeroTools: true, knownStage: true, rootRemoved: true, outputEmpty: true });
  } finally {
    if (child && child.exitCode === null) child.kill();
    assert.equal(path.dirname(await realpath(fixture)), parent); assert.match(path.basename(fixture), /^tae[A-Za-z0-9]+$/);
    assert.equal((await lstat(fixture)).isSymbolicLink(), false); await rm(fixture, { recursive: true, force: false });
  }
});
