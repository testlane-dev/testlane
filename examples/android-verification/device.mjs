/** Own a new disposable Android emulator, private ADB server and local Appium server. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { androidDeviceDirectories, createAndroidControlEnvironment, createAndroidDeviceEnvironment, requireAndroidProofHost } from './environment.mjs';
import { confirmRetainedGroupAbsent, requireRetainedProcessGroupHost, retainDetachedChild, stopRetainedGroup } from './process-group.mjs';

const PREFIX = 'tld-android-';
const MARKER = 'testlane-owned-device.json';
const CAPTURE_LIMIT = 8 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => new Error(code);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value);

export function ownedAdbArguments({ adbPort, serial }, args) {
  const console = /^emulator-(\d{4})$/.exec(serial ?? '');
  const emulatorPort = console ? Number(console[1]) : 0;
  if (!Number.isSafeInteger(adbPort) || adbPort < 1024 || adbPort > 65535 || adbPort === 5037 ||
      !console || emulatorPort < 5554 || emulatorPort > 5584 || emulatorPort % 2 !== 0 || !Array.isArray(args) || !args.length ||
      args.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !['shell', 'exec-out', 'install', 'reverse', 'forward', 'get-state'].includes(args[0])) throw fail('ANDROID_ADB_SCOPE_REFUSED');
  return ['-H', '127.0.0.1', '-P', String(adbPort), '-s', serial, ...args];
}

export function verifyOwnedIdentity({ expected, marker, alive, qemu, avdName }) {
  if (!alive || !/^[a-f0-9]{24}$/.test(expected.nonce ?? '') || expected.avdName !== 'testlane_' + expected.nonce ||
      !Number.isSafeInteger(expected.ownerPid) || expected.ownerPid < 1 ||
      !Number.isSafeInteger(expected.emulatorPid) || expected.emulatorPid < 1 ||
      !marker || marker.schemaVersion !== 1 || marker.nonce !== expected.nonce ||
      marker.avdName !== expected.avdName || marker.serial !== expected.serial ||
      marker.ownerPid !== expected.ownerPid || marker.emulatorPid !== expected.emulatorPid ||
      marker.adbPort !== expected.adbPort || qemu !== '1' || avdName !== expected.avdName) {
    throw fail('ANDROID_OWNERSHIP_REFUSED');
  }
  return true;
}

export function ownedAvdConfiguration({ avdName, image, apiLevel }) {
  if (!/^testlane_[a-f0-9]{24}$/.test(avdName ?? '') || !safePath(image) || !/^\d{2}$/.test(String(apiLevel))) throw fail('ANDROID_AVD_CONFIGURATION_REFUSED');
  return [
    'AvdId=' + avdName, 'avd.ini.encoding=UTF-8', 'avd.ini.displayname=Testlane owned disposable device',
    'PlayStore.enabled=false', 'abi.type=x86_64', 'hw.cpu.arch=x86_64', 'hw.cpu.ncore=2',
    'hw.ramSize=2048', 'vm.heapSize=256', 'disk.dataPartition.size=2G',
    'hw.gpu.enabled=yes', 'hw.gpu.mode=swiftshader_indirect', 'hw.keyboard=yes', 'hw.sdCard=no',
    'hw.audioInput=no', 'hw.audioOutput=no', 'hw.camera.back=none', 'hw.camera.front=none',
    'hw.lcd.width=480', 'hw.lcd.height=800', 'hw.lcd.density=160', 'hw.initialOrientation=Portrait',
    'image.sysdir.1=' + image.replaceAll('\\', '/') + '/', 'tag.id=google_apis', 'tag.display=Google APIs',
    'target=android-' + apiLevel, 'showDeviceFrame=no', 'runtime.network.latency=none', 'runtime.network.speed=full', '',
  ].join('\n');
}

async function freePort(wanted = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: wanted, exclusive: true }, () => {
      const port = server.address().port; server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function consolePort() {
  const start = randomBytes(1)[0] % 16;
  for (let offset = 0; offset < 16; offset++) {
    const port = 5554 + ((start + offset) % 16) * 2;
    try { await freePort(port); await freePort(port + 1); return port; } catch {}
  }
  throw fail('ANDROID_EMULATOR_PORT_UNAVAILABLE');
}

function launch(executable, args, { cwd, env, capture }) {
  const controlEnvironment = process.platform === 'win32' ? createAndroidControlEnvironment(env) : undefined;
  const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let state;
  if (process.platform === 'win32') {
    state = { child, controlEnvironment, pid: null, spawned: false, exited: false, closed: false, code: null, startError: false };
    state.started = new Promise(resolve => {
      child.once('spawn', () => { state.spawned = true; state.pid = child.pid; resolve(true); });
      child.once('error', () => { state.startError = true; resolve(false); });
    });
    child.once('exit', code => { state.exited = true; state.code = code; });
    state.done = new Promise(resolve => child.once('close', code => { state.closed = true; state.code = code; resolve(); }));
  } else state = retainDetachedChild(child);
  child.stdin.on('error', () => {});
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => capture(chunk.toString('utf8')));
  return state;
}

async function stopProcess(state, graceMs = 1500) {
  if (process.platform !== 'win32') return state ? stopRetainedGroup(state, { graceMs }) : true;
  if (!state || state.closed || !state.spawned) return true;
  if (process.platform === 'win32') {
    // Killing a Windows parent first can orphan QEMU. Terminate its owned tree
    // while that retained parent handle is still alive, then confirm close.
    if (state.exited || state.child.exitCode !== null || state.child.signalCode !== null) {
      state.child.stdin?.destroy(); state.child.stdout?.destroy(); state.child.stderr?.destroy(); state.child.unref();
      throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED');
    }
    let controlEnvironment;
    try { controlEnvironment = createAndroidControlEnvironment(state.controlEnvironment); }
    catch { throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED'); }
    const system = controlEnvironment.SystemRoot;
    const killer = spawn(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(state.pid), '/T', '/F'], {
      windowsHide: true, shell: false, stdio: 'ignore', env: controlEnvironment,
    });
    await new Promise(resolve => {
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', done); killer.once('close', done);
    });
  }
  await Promise.race([state.done, sleep(5000)]);
  if (!state.closed) {
    state.child.stdin.destroy(); state.child.stdout.destroy(); state.child.stderr.destroy(); state.child.unref();
    throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED');
  }
  return true;
}

/** Internal lifecycle seam: test the real retained tree without starting an AVD. */
export async function stopOwnedAndroidProcesses({ commands = [], appium, emulator, adbServer, gracefulEmulatorShutdown }, { platform = process.platform } = {}) {
  // Keep each retained leader alive for tree/group ownership checks. A console
  // shutdown could lose that identity before either platform's stopper runs.
  const failures = [];
  const pending = typeof commands === 'function' ? commands() : commands;
  for (const [kind, state] of [...pending.map(state => ['command', state]), ['appium', appium], ['emulator', emulator], ['adb', adbServer]]) {
    try { await stopProcess(state); }
    catch {
      failures.push({ kind, pid: state?.pid ?? null, spawned: state?.spawned === true, exited: state?.exited === true,
        closed: state?.closed === true, exitCode: Number.isInteger(state?.code) ? state.code : null });
    }
  }
  return failures;
}

/** Refuse existing AVDs/devices and never download SDK components or drivers here. */
export async function startOwnedAndroid({ sdkRoot, javaHome, toolsRoot, systemImagePath, outputDir, signal, onStage = () => {} }) {
  if ([sdkRoot, javaHome, toolsRoot, systemImagePath, outputDir].some(value => !safePath(value))) throw fail('ANDROID_DEVICE_INPUT_INVALID');
  if (signal?.aborted) throw fail('ANDROID_CANCELLED');
  requireAndroidProofHost();
  if (process.platform !== 'win32') requireRetainedProcessGroupHost();
  const sdk = await realpath(sdkRoot), java = await realpath(javaHome), tools = await realpath(toolsRoot), image = await realpath(systemImagePath);
  const nodeExecutable = await realpath(process.execPath);
  if (process.platform === 'win32') createAndroidControlEnvironment();
  if (!inside(path.join(sdk, 'system-images'), image)) throw fail('ANDROID_SYSTEM_IMAGE_REFUSED');
  const properties = Object.fromEntries((await readFile(path.join(image, 'source.properties'), 'utf8')).split(/\r?\n/).filter(line => /^[A-Za-z]/.test(line) && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (properties['SystemImage.Abi'] !== 'x86_64' || properties['SystemImage.TagId'] !== 'google_apis' || !/^\d{2}$/.test(properties['AndroidVersion.ApiLevel'] ?? '')) throw fail('ANDROID_SYSTEM_IMAGE_UNSUPPORTED');
  const exe = name => name + (process.platform === 'win32' ? '.exe' : '');
  const adbPath = path.join(sdk, 'platform-tools', exe('adb')), emulatorPath = path.join(sdk, 'emulator', exe('emulator'));
  await Promise.all([access(adbPath), access(emulatorPath), access(path.join(java, 'bin', exe('java'))), access(path.join(image, 'kernel-ranchu')), access(path.join(image, 'userdata.img'))]);
  const appiumRoot = path.join(tools, 'node_modules', 'appium'), driverRoot = path.join(tools, 'node_modules', 'appium-uiautomator2-driver');
  const serverRoot = path.join(driverRoot, 'node_modules', 'appium-uiautomator2-server');
  const settingsRoot = path.join(driverRoot, 'node_modules', 'io.appium.settings');
  const [appiumPackage, driverPackage] = await Promise.all([readFile(path.join(appiumRoot, 'package.json'), 'utf8').then(JSON.parse), readFile(path.join(driverRoot, 'package.json'), 'utf8').then(JSON.parse)]);
  if (appiumPackage.version !== '3.8.0' || driverPackage.version !== '8.7.0') throw fail('ANDROID_TOOLS_VERSION_MISMATCH');
  const [serverPackage, settingsPackage] = await Promise.all([readFile(path.join(serverRoot, 'package.json'), 'utf8').then(JSON.parse), readFile(path.join(settingsRoot, 'package.json'), 'utf8').then(JSON.parse)]);
  if (serverPackage.version !== '10.6.6' || settingsPackage.version !== '8.0.9') throw fail('ANDROID_TOOLS_VERSION_MISMATCH');
  const automationApks = [
    { file: 'settings.apk', source: path.join(settingsRoot, 'apks', 'settings_apk-debug.apk'), version: '8.0.9' },
    { file: 'uiautomator2-server.apk', source: path.join(serverRoot, 'apks', 'appium-uiautomator2-server-v10.6.6.apk'), version: '10.6.6' },
    { file: 'uiautomator2-test.apk', source: path.join(serverRoot, 'apks', 'appium-uiautomator2-server-debug-androidTest.apk'), version: '10.6.6' },
  ];
  for (const item of automationApks) {
    if (process.platform === 'win32' && item.source.length > 240) throw fail('ANDROID_TOOLS_PATH_TOO_DEEP');
    const info = await lstat(item.source), actual = await realpath(item.source);
    if (!info.isFile() || info.isSymbolicLink() || !inside(tools, actual)) throw fail('ANDROID_AUTOMATION_APK_REFUSED');
    item.sha256 = createHash('sha256').update(await readFile(actual)).digest('hex');
  }
  onStage('sdk-and-pinned-tools-validated');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const output = await realpath(outputDir);
  if ((await lstat(outputDir)).isSymbolicLink()) throw fail('ANDROID_OUTPUT_PATH_REFUSED');
  // Fail port allocation before creating an owned device root so an exhausted
  // console range cannot leave unmarked temporary device state behind.
  const ports = { consolePort: await consolePort(), adbPort: await freePort(), appiumPort: await freePort(), systemPort: await freePort() };
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, PREFIX));
  const nonce = randomBytes(12).toString('hex'), avdName = 'testlane_' + nonce;
  const androidHome = path.join(root, 'android'), avdHome = path.join(androidHome, 'avd'), avd = path.join(avdHome, avdName + '.avd'), appiumHome = path.join(root, 'appium');
  const serial = 'emulator-' + ports.consolePort, markerPath = path.join(root, MARKER);
  const marker = { schemaVersion: 1, nonce, ownerPid: process.pid, avdName, serial, adbPort: ports.adbPort, emulatorPid: null, adbPid: null, appiumPid: null };
  let captured = '', captureBytes = 0, captureFailed = false, processUncertain = false, closing, ready = false, closed = false, ownershipChecks;
  let emulator, adbServer, appium;
  const commands = new Set();
  const capture = value => {
    const size = Buffer.byteLength(value);
    if (captureBytes + size > CAPTURE_LIMIT) { captureFailed = true; return; }
    captured += value; captureBytes += size;
  };
  let env;
  const writeMarker = () => writeFile(markerPath, JSON.stringify(marker) + '\n', { mode: 0o600 });
  const ensureLive = (allowClosing = false) => {
    if (closed || (closing && !allowClosing) || signal?.aborted) throw fail('ANDROID_CANCELLED');
    if (processUncertain) throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED');
    if (captureFailed) throw fail('ANDROID_CAPTURE_LIMIT');
    if (!adbServer?.spawned || adbServer.closed) throw fail('ANDROID_ADB_SERVER_STOPPED');
    if (!emulator?.spawned || emulator.closed) throw fail('ANDROID_EMULATOR_STOPPED');
    if (ready && (!appium?.spawned || appium.closed)) throw fail('ANDROID_OWNED_PROCESS_STOPPED');
  };
  // command-specific streams remain bounded by the same process-wide capture cap.
  const raw = async (executable, args, options) => {
    const localSignal = options?.signal === null ? undefined : options?.signal ?? signal;
    if (localSignal?.aborted) throw fail('ANDROID_CANCELLED');
    if (processUncertain) throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED');
    let stdout = '', stderr = '';
    const before = commands;
    const collect = launch(executable, args, { cwd: root, env, capture }); before.add(collect);
    collect.child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    collect.child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
    if (!await collect.started) { if (process.platform === 'win32') before.delete(collect); throw fail('ANDROID_COMMAND_START_FAILED'); }
    collect.child.stdin.end(options?.input === undefined ? undefined : options.input);
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let cancelled = localSignal?.aborted === true;
    const abort = () => { cancelled = true; }; localSignal?.addEventListener('abort', abort, { once: true });
    let retired = false;
    try {
      while (!collect.closed && !cancelled && Date.now() < deadline && !captureFailed) await sleep(30);
      if (!collect.closed) {
        try { await stopProcess(collect, 0); }
        catch { processUncertain = true; throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED'); }
        throw fail(cancelled ? 'ANDROID_CANCELLED' : captureFailed ? 'ANDROID_CAPTURE_LIMIT' : 'ANDROID_COMMAND_TIMEOUT');
      }
      if (process.platform !== 'win32') {
        try { confirmRetainedGroupAbsent(collect); }
        catch { processUncertain = true; throw fail('ANDROID_PROCESS_TERMINATION_UNCONFIRMED'); }
      }
      retired = true;
      if (captureFailed) throw fail('ANDROID_CAPTURE_LIMIT');
      return { code: collect.code, stdout, stderr };
    } finally { localSignal?.removeEventListener('abort', abort); if (collect.closed && (process.platform === 'win32' || retired)) before.delete(collect); }
  };
  const rawAdb = (args, options) => raw(adbPath, ['-H', '127.0.0.1', '-P', String(ports.adbPort), '-s', serial, ...args], options);
  async function assertRoot() {
    const current = await realpath(root);
    if (!same(current, root) || path.dirname(current) !== parent || !/^tld-android-[a-zA-Z0-9]+$/.test(path.basename(root)) || (await lstat(root)).isSymbolicLink()) throw fail('ANDROID_OWNERSHIP_REFUSED');
    const actual = JSON.parse(await readFile(markerPath, 'utf8'));
    if (actual.schemaVersion !== 1 || actual.nonce !== nonce || actual.ownerPid !== process.pid || actual.avdName !== avdName || actual.serial !== serial ||
        actual.adbPort !== marker.adbPort || actual.adbPid !== marker.adbPid || actual.emulatorPid !== marker.emulatorPid || actual.appiumPid !== marker.appiumPid) throw fail('ANDROID_OWNERSHIP_REFUSED');
    return actual;
  }
  async function assertOwned(allowClosing = false) {
    ensureLive(allowClosing); const actual = await assertRoot();
    ensureLive(allowClosing);
    const [state, qemu, name] = await Promise.all([
      rawAdb(['get-state']), rawAdb(['shell', 'getprop', 'ro.kernel.qemu']),
      rawAdb(['shell', 'getprop', 'ro.boot.qemu.avd_name']),
    ]);
    // The system image exposes the random AVD name through this boot property.
    // It binds the guest to the same 96-bit nonce as our new marker and retained
    // process handles; arbitrary custom qemu properties are filtered by Android.
    ownershipChecks = { stateDevice: state.stdout.trim() === 'device', allQueriesSucceeded: [state, qemu, name].every(result => result.code === 0),
      qemuMatches: qemu.stdout.trim() === '1', avdNamePresent: Boolean(name.stdout.trim()), avdNameMatches: name.stdout.trim() === avdName,
      avdNameNonceMatches: name.stdout.trim() === 'testlane_' + nonce,
      markerPidMatches: actual.emulatorPid === marker.emulatorPid, markerNonceMatches: actual.nonce === nonce };
    if ([state, qemu, name].some(result => result.code !== 0) || state.stdout.trim() !== 'device') throw fail('ANDROID_OWNERSHIP_REFUSED');
    verifyOwnedIdentity({ expected: marker, marker: actual, alive: !emulator.closed && !adbServer.closed,
      qemu: qemu.stdout.trim(), avdName: name.stdout.trim() });
    ensureLive(allowClosing);
    return true;
  }
  const adb = async (args, options) => { const scoped = ownedAdbArguments({ adbPort: ports.adbPort, serial }, args); await assertOwned(); ensureLive(); return raw(adbPath, scoped, options); };
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      signal?.removeEventListener('abort', abortLifecycle);
      // The caller closes Appium sessions first. Windows must retain the live
      // emulator parent until taskkill /T has terminated the complete owned tree.
      const failures = await stopOwnedAndroidProcesses({ commands: () => [...commands], appium, emulator, adbServer,
        gracefulEmulatorShutdown: ready && !signal?.aborted ? async () => { await assertOwned(true); await rawAdb(['emu', 'kill'], { signal: null, timeoutMs: 5000 }); } : undefined });
      const recovery = async reason => {
        try {
          await writeFile(path.join(output, 'android-device-recovery.json'), JSON.stringify({ schemaVersion: 1, status: 'manual-inspection-required', reason, ownedRoot: root, avdName, serial,
            pids: [...commands].map(item => item.pid).concat([appium?.pid, emulator?.pid, adbServer?.pid]).filter(Boolean), processFailures: failures }) + '\n', { flag: 'wx', mode: 0o600 });
        } catch { /* Preserve the owned root even if recovery metadata cannot be written. */ }
      };
      if (failures.length) { await recovery('process-stop-unconfirmed'); throw fail('ANDROID_DEVICE_CLEANUP_UNCONFIRMED'); }
      try {
        await assertRoot();
        // Canonical root + fresh marker + confirmed stopped handles are required.
        await rm(root, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
      } catch { await recovery('owned-path-removal-unconfirmed'); throw fail('ANDROID_DEVICE_CLEANUP_UNCONFIRMED'); }
      closed = true;
      if (captureFailed) throw fail('ANDROID_CAPTURE_LIMIT');
    })();
    return closing;
  }
  const abortLifecycle = () => { void close().catch(() => {}); };
  try {
    await writeMarker();
    const directories = androidDeviceDirectories(root);
    await Promise.all([avd, appiumHome, ...Object.values(directories)].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
    env = createAndroidDeviceEnvironment({ root, sdkRoot: sdk, javaHome: java, nodeExecutable, adbPort: ports.adbPort });
    await writeFile(path.join(avd, 'config.ini'), ownedAvdConfiguration({ avdName, image, apiLevel: properties['AndroidVersion.ApiLevel'] }), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(avdHome, avdName + '.ini'), ['avd.ini.encoding=UTF-8', 'path=' + avd.replaceAll('\\', '/'), 'target=android-' + properties['AndroidVersion.ApiLevel'], ''].join('\n'), { flag: 'wx', mode: 0o600 });
    const generated = await raw(adbPath, ['keygen', env.ADB_VENDOR_KEYS]);
    if (generated.code !== 0) throw fail('ANDROID_ADB_KEY_SETUP_FAILED');
    // Register only the already installed pinned local driver. No npm invocation,
    // package download, global extension home or default Appium config is involved.
    const { Manifest } = await import(pathToFileURL(path.join(appiumRoot, 'build', 'lib', 'extension', 'manifest.js')).href);
    const manifest = new Manifest(appiumHome); await manifest.read();
    manifest.addExtensionFromPackage(driverPackage, path.join(driverRoot, 'package.json'), 'local'); await manifest.write();
    if (signal?.aborted) throw fail('ANDROID_CANCELLED');
    // ADB 36 accepts the literal "localhost" for its loopback listener, but not
    // "127.0.0.1" in a -L bind specification. Clients still use exact IPv4 -H.
    adbServer = launch(adbPath, ['-L', 'tcp:localhost:' + ports.adbPort, '--one-device', serial, 'server', 'nodaemon'], { cwd: root, env, capture });
    if (!await adbServer.started) throw fail('ANDROID_ADB_SERVER_START_FAILED');
    adbServer.child.stdin.end(); marker.adbPid = adbServer.pid; await writeMarker();
    onStage('private-adb-started');
    if (signal?.aborted) throw fail('ANDROID_CANCELLED');
    emulator = launch(emulatorPath, ['-avd', avdName, '-port', String(ports.consolePort), '-sysdir', image,
      '-datadir', avd, '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect',
      ...(process.platform === 'linux' ? ['-accel', 'on'] : []),
      '-camera-front', 'none', '-camera-back', 'none', '-memory', '2048', '-cores', '2'], { cwd: root, env, capture });
    if (!await emulator.started) throw fail('ANDROID_EMULATOR_START_FAILED');
    emulator.child.stdin.end(); marker.emulatorPid = emulator.pid; await writeMarker();
    onStage('owned-emulator-started');
    signal?.addEventListener('abort', abortLifecycle, { once: true });
    const bootDeadline = Date.now() + 180_000;
    let booted = false;
    while (Date.now() < bootDeadline) {
      ensureLive();
      try { const result = await rawAdb(['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 5000 }); booted = result.code === 0 && result.stdout.trim() === '1'; } catch (error) { if (signal?.aborted || captureFailed) throw error; }
      if (booted) break; await sleep(1000);
    }
    if (!booted) throw fail('ANDROID_EMULATOR_BOOT_TIMEOUT');
    await assertOwned();
    onStage('owned-emulator-booted');
    appium = launch(process.execPath, [path.join(appiumRoot, 'index.js'), '--address', '127.0.0.1', '--port', String(ports.appiumPort),
      '--base-path', '/', '--log-level', 'error', '--log-no-colors', '--use-drivers', 'uiautomator2', '--deny-insecure', '*:adb_shell'], { cwd: root, env, capture });
    if (!await appium.started) throw fail('ANDROID_APPIUM_START_FAILED');
    appium.child.stdin.end(); marker.appiumPid = appium.pid; await writeMarker();
    const serverUrl = 'http://127.0.0.1:' + ports.appiumPort + '/';
    const serverDeadline = Date.now() + 45_000;
    while (Date.now() < serverDeadline) {
      ensureLive(); if (appium.closed) throw fail('ANDROID_APPIUM_STOPPED');
      try { const response = await fetch(new URL('status', serverUrl), { signal: AbortSignal.timeout(1000) }); const body = await response.json(); ready = response.ok && body.value?.ready === true && body.value?.build?.version === '3.8.0'; } catch {}
      if (ready) break; await sleep(500);
    }
    if (!ready) throw fail('ANDROID_APPIUM_READY_TIMEOUT');
    await assertOwned();
    onStage('private-appium-ready');
    return Object.freeze({ serial, adbPath, serverUrl, adbPort: ports.adbPort, systemPort: ports.systemPort, env,
      versions: Object.freeze({ appium: '3.8.0', uiautomator2: '8.7.0', androidApi: properties['AndroidVersion.ApiLevel'], systemImageRevision: properties['Pkg.Revision'],
        automationApks: Object.freeze(automationApks.map(({ file, version, sha256 }) => Object.freeze({ file, version, sha256 }))) }),
      assertOwned: () => assertOwned(), adb, capturedText: () => captured,
      async installApk(apkPath) {
        ensureLive();
        if (!safePath(apkPath) || path.extname(apkPath).toLowerCase() !== '.apk' || (await lstat(apkPath)).isSymbolicLink() || !(await lstat(apkPath)).isFile()) throw fail('ANDROID_APK_INPUT_INVALID');
        const localApk = path.join(root, 'proof-app.apk');
        await copyFile(await realpath(apkPath), localApk);
        const result = await adb(['install', '-t', '-r', localApk], { timeoutMs: 120_000 });
        if (result.code !== 0 || !/^Success\s*$/m.test(result.stdout)) throw fail('ANDROID_APK_INSTALL_FAILED');
        return { installed: true };
      },
      async writeBootstrap(payload) {
        if (typeof payload !== 'string' || Buffer.byteLength(payload) > 64 * 1024 || payload.includes('\0')) throw fail('ANDROID_BOOTSTRAP_INPUT_INVALID');
        try { const value = JSON.parse(payload); if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('ANDROID_BOOTSTRAP_INPUT_INVALID'); }
        catch { throw fail('ANDROID_BOOTSTRAP_INPUT_INVALID'); }
        // ADB joins shell arguments. Explicit fixed remote quoting keeps redirection
        // inside the app's run-as shell; the credential JSON travels only on stdin.
        const result = await adb(['shell', '-T', 'run-as', 'dev.testlane.androidproof', 'sh', '-c', "'umask 077; mkdir -p files; cat > files/testlane-bootstrap.json'"], { input: payload });
        if (result.code !== 0) throw fail('ANDROID_BOOTSTRAP_WRITE_FAILED');
        const checked = await adb(['shell', '-T', 'run-as', 'dev.testlane.androidproof', 'sh', '-c', "'wc -c < files/testlane-bootstrap.json'"]);
        if (checked.code !== 0 || checked.stdout.trim() !== String(Buffer.byteLength(payload))) throw fail('ANDROID_BOOTSTRAP_WRITE_FAILED');
        return { written: true };
      },
      async assertBootstrapAbsent() {
        const result = await adb(['shell', '-T', 'run-as', 'dev.testlane.androidproof', 'sh', '-c', "'test ! -e files/testlane-bootstrap.json'"]);
        if (result.code !== 0) throw fail('ANDROID_BOOTSTRAP_CLEANUP_UNCONFIRMED');
        return { absent: true };
      },
      close,
    });
  } catch (error) {
    let code = /^ANDROID_[A-Z_]+$/.test(error.message) ? error.message : 'ANDROID_DEVICE_START_FAILED';
    try { await close(); } catch { code = 'ANDROID_DEVICE_CLEANUP_UNCONFIRMED'; }
    const result = fail(code);
    // Private in-memory diagnostics only. Error serialization keeps the fixed code;
    // a controller can inspect/scan this buffer without publishing raw tool logs.
    Object.defineProperty(result, 'capturedText', { value: () => captured });
    Object.defineProperty(result, 'ownershipChecks', { value: ownershipChecks });
    throw result;
  }
}
