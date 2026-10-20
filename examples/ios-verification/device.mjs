/** Own one nonce-bound Simulator in an ephemeral hosted Mac's standard device set. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIosDeviceEnvironment } from './environment.mjs';
import { IOS_DEVICE_SCOPE, validateIosDeviceBinding, normalizeIosDeviceInventory,
  snapshotIosForeignDevices, assertIosForeignSnapshot } from './device-scope.mjs';
import { hashIosTree } from '../mobile-approval-app/build-ios.mjs';
import { verifyPinnedWdaStartupPatch } from './tools/wda-startup-patch.mjs';
import { verifyPinnedIosNativePrerequisite } from './tools/setup.mjs';
import { createIosStartupFailure, fixedIosDeviceFailureCode, retainIosStartupFailure, tagIosCommandFailure } from './failure-facts.mjs';

const UUID = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/;
const BUNDLE = 'dev.testlane.iosproof', MARKER = 'testlane-owned-simulator.json';
const LIMIT = 8 * 1024 * 1024;
const fail = code => new Error(code);
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => createHash('sha256').update(value).digest('hex');
const WDA_BUILD_MS = 600000;

/** One cold-start observation window. Callbacks settle; no timer races detach work. */
export async function runIosColdBoot({ boot, bootStatus, confirmOwned, onBootStarted = () => {}, signal, now = () => performance.now() }) {
  if (signal?.aborted) throw fail('IOS_CANCELLED');
  if (![boot, bootStatus, confirmOwned, onBootStarted, now].every(callback => typeof callback === 'function')) throw fail('IOS_DEVICE_INPUT_INVALID');
  let observed = now();
  if (!Number.isFinite(observed) || observed < 0) throw fail('IOS_SIMULATOR_BOOT_TIMEOUT');
  const deadline = observed + 600000;
  const clock = () => {
    if (signal?.aborted) throw fail('IOS_CANCELLED');
    const current = now();
    if (!Number.isFinite(current) || current < observed) throw fail('IOS_SIMULATOR_BOOT_TIMEOUT');
    observed = current; return current;
  };
  const step = async (kind, cap, callback, accept) => {
    try {
      const began = clock(), deadlineAt = Math.min(deadline, began + cap);
      const remainingMs = () => {
        const remaining = Math.floor(deadlineAt - clock());
        if (remaining < 1) throw fail('IOS_SIMULATOR_BOOT_TIMEOUT');
        return remaining;
      };
      const budget = Object.freeze({ timeoutMs: remainingMs(), deadlineAt, remainingMs, check: () => { remainingMs(); } });
      const result = await callback(budget);
      budget.check(); accept(result);
    } catch (error) { throw tagIosCommandFailure(error, kind); }
  };
  await step('owned-device-boot', 30000, boot, result => {
    if (result?.code !== 0) throw fail('IOS_SIMULATOR_BOOT_FAILED');
  });
  onBootStarted();
  await step('owned-device-bootstatus', 600000, bootStatus, result => {
    if (result?.code !== 0) throw fail('IOS_SIMULATOR_BOOT_TIMEOUT');
  });
  await step('owned-device-list', 90000, confirmOwned, result => {
    if (result !== true) throw fail('IOS_OWNERSHIP_REFUSED');
  });
  try { if (clock() >= deadline) throw fail('IOS_SIMULATOR_BOOT_TIMEOUT'); }
  catch (error) { throw tagIosCommandFailure(error, 'owned-device-list'); }
  return true;
}

const TRANSIENT_COMMAND_PAYLOADS = new Set(['owned-device-list', 'loopback-listeners', 'process-identity', 'owned-descendants', 'owned-process-group']);
export const retainIosCommandPayload = kind => !TRANSIENT_COMMAND_PAYLOADS.has(kind);

/** The same fixed aggregate bound applies to retained native logs and markers. */
export function createIosDeviceCapture() {
  let captured = '', bytes = 0, overflowed = false;
  return Object.freeze({
    append(text) {
      const length = Buffer.byteLength(text);
      if (bytes + length > LIMIT) { overflowed = true; return; }
      captured += text; bytes += length;
    },
    text: () => captured,
    overflowed: () => overflowed,
  });
}

/** Omitting aggregate retention never changes the transient parser input. */
export function captureIosCommandOutput(capture, kind, text) {
  if (retainIosCommandPayload(kind)) capture(text);
  return text;
}

export function ownedIosWdaBuildArguments({ projectPath, derivedDataPath, udid, platformVersion }) {
  if (!safePath(projectPath) || path.basename(projectPath) !== 'WebDriverAgent.xcodeproj' ||
      !safePath(derivedDataPath) || path.basename(derivedDataPath) !== 'derived-data' ||
      !/^tld-ios-[A-Za-z0-9]+$/.test(path.basename(path.dirname(derivedDataPath))) || !UUID.test(udid ?? '') ||
      typeof platformVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(platformVersion)) throw fail('IOS_WDA_PREPARE_INPUT_INVALID');
  return ['build-for-testing', '-project', projectPath, '-scheme', 'WebDriverAgentRunner', '-derivedDataPath', derivedDataPath,
    '-destination', 'id=' + udid, 'IPHONEOS_DEPLOYMENT_TARGET=' + platformVersion.split('.').slice(0, 2).join('.'),
    'GCC_TREAT_WARNINGS_AS_ERRORS=0', 'COMPILER_INDEX_STORE_ENABLE=NO', 'APPIUM_XCODEBUILD_WDA_MARKER=1'];
}

export function validateIosWdaBundleMetadata({ app, test, architecture, platform, expectedArchitecture }) {
  if (!app || app.CFBundleIdentifier !== 'com.facebook.WebDriverAgentRunner.xctrunner' || app.CFBundleExecutable !== 'WebDriverAgentRunner-Runner' ||
      app.DTPlatformName !== 'iphonesimulator' || JSON.stringify(app.CFBundleSupportedPlatforms) !== JSON.stringify(['iPhoneSimulator']) ||
      !test || test.CFBundleIdentifier !== 'com.facebook.WebDriverAgentRunner' || test.CFBundleExecutable !== 'WebDriverAgentRunner' ||
      test.DTPlatformName !== 'iphonesimulator' || JSON.stringify(test.CFBundleSupportedPlatforms) !== JSON.stringify(['iPhoneSimulator']) ||
      !['arm64', 'x86_64'].includes(expectedArchitecture) || architecture !== expectedArchitecture || typeof platform !== 'string' ||
      !/platform\s+IOSSIMULATOR\b/.test(platform)) throw fail('IOS_WDA_ARTIFACT_INVALID');
  return true;
}

export function validateIosWdaPreparation(value) {
  const fields = ['schemaVersion', 'wdaPrepared', 'buildBudgetMs', 'buildMs', 'webdriveragent', 'projectSHA256', 'packageSHA256', 'runnerSHA256', 'xctestrunSHA256'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 || value.wdaPrepared !== true ||
      value.buildBudgetMs !== WDA_BUILD_MS || !Number.isSafeInteger(value.buildMs) || value.buildMs < 0 || value.buildMs > WDA_BUILD_MS ||
      value.webdriveragent !== '16.16.3' || fields.filter(key => key.endsWith('SHA256')).some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key]))) throw fail('IOS_WDA_PREPARE_FAILED');
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

const PREWARM_DIAGNOSTIC_KINDS = new Set(['owned-device-list', 'owned-proof-app-prewarm']);
export function iosPrewarmDiagnosticDue({ diagnostics, kind, elapsedMs, state }) {
  return diagnostics === true && PREWARM_DIAGNOSTIC_KINDS.has(kind) && Number.isFinite(elapsedMs) && elapsedMs >= 15000 &&
    state?.spawned === true && state.exited === false && state.closed === false && Number.isSafeInteger(state.pid) && state.pid > 1;
}

/** Sampling permission is independent of Appium verbosity and cannot be renewed. */
export function createIosDiagnosticPolicy({ diagnostics = false, prewarmDiagnostics = false } = {}) {
  if (typeof diagnostics !== 'boolean' || typeof prewarmDiagnostics !== 'boolean') throw fail('IOS_DEVICE_INPUT_INVALID');
  let prewarm = 'unused', activeLease;
  return Object.freeze({
    appiumLogLevel: diagnostics ? 'debug' : 'error',
    beginPrewarm() {
      if (prewarm !== 'unused') return undefined;
      prewarm = 'in-flight';
      let active = true, claimed = false;
      const canSample = kind => active && !claimed && (diagnostics || prewarmDiagnostics) && PREWARM_DIAGNOSTIC_KINDS.has(kind);
      const lease = Object.freeze({
        canSample,
        claimSample(kind) { if (!canSample(kind)) return false; claimed = true; return true; },
      });
      activeLease = { lease, revoke: () => { active = false; } };
      return lease;
    },
    finishPrewarm(lease) {
      if (!activeLease || activeLease.lease !== lease) return;
      activeLease.revoke(); prewarm = 'consumed';
    },
  });
}

export function verifyIosDiagnosticIdentity(state, info, { ownerPid, started } = {}) {
  if (!state || state.spawned !== true || state.exited !== false || state.closed !== false || state.pid !== state.child?.pid ||
      !Number.isSafeInteger(state.pid) || state.pid < 2 || !Number.isSafeInteger(ownerPid) || ownerPid < 1 ||
      !info || info.pid !== state.pid || info.ppid !== ownerPid || info.pgid !== state.pid || info.zombie !== false ||
      typeof info.started !== 'string' || !/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(info.started) ||
      (started !== undefined && info.started !== started)) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
  return info.started;
}

export function iosPrewarmDiagnosticFailure(error) {
  return Object.freeze({ status: 'unavailable',
    code: ['IOS_PROCESS_STOP_UNCONFIRMED', 'IOS_PROCESS_OWNERSHIP_REFUSED', 'IOS_COMMAND_TIMEOUT', 'IOS_CANCELLED'].includes(error?.message) ? error.message : 'IOS_PREAUTH_DIAGNOSTIC_FAILED' });
}

export function requireIosHostedDevice({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'darwin') throw fail('IOS_MACOS_REQUIRED');
  if (!env || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.TESTLANE_IOS_PROOF_CI !== '1') throw fail('IOS_HOSTED_CI_REQUIRED');
}

// Neither an environment override nor an arbitrary caller path can select the
// shared set. Refuse aliases and missing components instead of creating them.
export async function canonicalIosStandardSet(nativeHome) {
  if (!safePath(nativeHome) || path.resolve(nativeHome) !== nativeHome) throw fail('IOS_STANDARD_DEVICE_SET_REFUSED');
  const deviceSetPath = path.join(nativeHome, 'Library', 'Developer', 'CoreSimulator', 'Devices');
  let cursor = path.parse(nativeHome).root;
  for (const part of deviceSetPath.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cursor) !== cursor) throw Error(); }
    catch { throw fail('IOS_STANDARD_DEVICE_SET_REFUSED'); }
  }
  return deviceSetPath;
}

// Fixed diagnostic labels only: never retain command arguments or environment.
function commandKind(executable, args) {
  if (executable === '/usr/bin/xcodebuild') return args[0] === 'build-for-testing' ? 'owned-wda-prebuild' : 'xcode-version';
  if (executable === '/usr/sbin/lsof') return 'loopback-listeners';
  if (executable === '/bin/ps') return 'process-identity';
  if (executable === '/usr/bin/sample') return 'owned-prewarm-stack-sample';
  if (executable === '/usr/bin/pgrep') return args[0] === '-P' ? 'owned-descendants' : 'owned-process-group';
  if (executable !== '/usr/bin/xcrun' || args[0] !== 'simctl') return 'other';
  const index = args[1] === '--set' ? 3 : 1;
  if (args[index] === 'list') return { runtimes: 'runtime-list', devicetypes: 'device-type-list', devices: 'owned-device-list' }[args[index + 1]] ?? 'other';
  return { create: 'owned-device-create', boot: 'owned-device-boot', bootstatus: 'owned-device-bootstatus',
    shutdown: 'owned-device-shutdown', delete: 'owned-device-delete', install: 'owned-app-install',
    launch: 'owned-proof-app-prewarm', get_app_container: 'owned-app-container' }[args[index]] ?? 'other';
}

export function selectIosTarget({ runtimes, devicetypes }, { runtimeId = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' } = {}) {
  if (!/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+-\d+(?:-\d+)?$/.test(runtimeId) ||
      !/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[A-Za-z0-9-]+$/.test(deviceType)) throw fail('IOS_TARGET_SELECTOR_INVALID');
  if (!Array.isArray(runtimes) || !Array.isArray(devicetypes)) throw fail('IOS_RUNTIME_METADATA_INVALID');
  const runtime = runtimes.filter(item => item.identifier === runtimeId && item.isAvailable === true);
  const type = devicetypes.filter(item => item.identifier === deviceType);
  if (runtime?.length !== 1) throw fail('IOS_RUNTIME_UNAVAILABLE');
  if (type?.length !== 1) throw fail('IOS_DEVICE_TYPE_UNAVAILABLE');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(runtime[0].version ?? '')) throw fail('IOS_RUNTIME_METADATA_INVALID');
  if (Array.isArray(runtime[0].supportedDeviceTypes) && !runtime[0].supportedDeviceTypes.some(item => item.identifier === deviceType)) throw fail('IOS_TARGET_INCOMPATIBLE');
  return Object.freeze({ runtimeId, deviceType, platformVersion: runtime[0].version });
}

export function ownedSimctlArguments({ deviceSetPath, udid }, command, args = []) {
  if (!safePath(deviceSetPath) || !UUID.test(udid ?? '') || !['boot', 'shutdown', 'delete', 'install', 'launch', 'get_app_container'].includes(command) ||
      !Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\r\n\0]/.test(value)) ||
      (['boot', 'shutdown', 'delete'].includes(command) && args.length !== 0) ||
      (command === 'install' && (args.length !== 1 || !safePath(args[0]) || !args[0].endsWith('.app'))) ||
      (command === 'launch' && (args.length !== 1 || args[0] !== BUNDLE)) ||
      (command === 'get_app_container' && (args.length !== 2 || args[0] !== BUNDLE || args[1] !== 'data'))) throw fail('IOS_SIMCTL_SCOPE_REFUSED');
  return ['simctl', '--set', deviceSetPath, command, udid, ...args];
}

export function acknowledgedIosCreate(result) {
  if (!result || result.code !== 0 || typeof result.stdout !== 'string' || !UUID.test(result.stdout.trim())) throw fail('IOS_SIMULATOR_CREATE_FAILED');
  return result.stdout.trim();
}

export function acknowledgedIosProofLaunch(result) {
  if (!result || result.code !== 0 || typeof result.stdout !== 'string' ||
      !/^dev\.testlane\.iosproof: [1-9][0-9]{0,9}$/.test(result.stdout.trim())) throw fail('IOS_APP_LAUNCH_FAILED');
  // The PID is an acknowledgement only, never a later process-kill authority.
  return Object.freeze({ appPrewarmed: true });
}

export function verifyOwnedSimulator({ expected, marker, devices, baseline, requireBooted = true, verifyForeign = true }) {
  if (!expected || !/^[a-f0-9]{24}$/.test(expected.nonce ?? '') || expected.name !== 'testlane_ios_' + expected.nonce ||
      !UUID.test(expected.udid ?? '') || !Number.isSafeInteger(expected.ownerPid) || expected.ownerPid < 1 ||
      !marker || marker.schemaVersion !== 2 || marker.scope !== IOS_DEVICE_SCOPE || ['nonce', 'name', 'udid', 'ownerPid', 'runtimeId', 'deviceType', 'deviceSetPath', 'nativeHome', 'privateRoot', 'baselineSHA256'].some(key => marker[key] !== expected[key])) throw fail('IOS_OWNERSHIP_REFUSED');
  let rows; try { rows = normalizeIosDeviceInventory(devices); } catch { throw fail('IOS_OWNERSHIP_REFUSED'); }
  const owned = rows.filter(row => row.udid === expected.udid);
  if (owned.length !== 1 || owned[0].name !== expected.name || owned[0].runtimeId !== expected.runtimeId ||
      owned[0].deviceTypeIdentifier !== expected.deviceType || owned[0].isAvailable !== true ||
      (requireBooted && owned[0].state !== 'Booted')) throw fail('IOS_OWNERSHIP_REFUSED');
  if (verifyForeign) assertIosForeignSnapshot(devices, baseline, expected.udid);
  return owned[0];
}

/** Read-only preparation policy: never authorizes booted or transitional targets. */
export function verifyOwnedWdaPreparationSimulator({ expected, marker, devices, baseline }) {
  const owned = verifyOwnedSimulator({ expected, marker, devices, baseline, requireBooted: false });
  if (owned.state !== 'Shutdown') throw fail('IOS_OWNERSHIP_REFUSED');
  return owned;
}

export function validateIosContainer({ deviceSetPath, udid, containerPath }) {
  if (!safePath(deviceSetPath) || !UUID.test(udid ?? '') || !safePath(containerPath)) throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED');
  const base = path.join(deviceSetPath, udid, 'data', 'Containers', 'Data', 'Application');
  if (path.dirname(containerPath) !== base || !UUID.test(path.basename(containerPath))) throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED');
  return path.join(containerPath, 'Documents', 'testlane-bootstrap.json');
}

export function validateIosListener(text, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof text !== 'string') throw fail('IOS_LISTENER_BINDING_REFUSED');
  const addresses = text.split(/\r?\n/).filter(line => line.startsWith('n')).map(line => line.slice(1));
  if (!addresses.length || addresses.some(address => address !== '127.0.0.1:' + port)) throw fail('IOS_LISTENER_BINDING_REFUSED');
  return true;
}

export function iosListenerQuery(ports) {
  if (!Array.isArray(ports) || ports.length !== 3 || new Set(ports).size !== 3 ||
    ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw fail('IOS_LISTENER_BINDING_REFUSED');
  // One comma-list is one lsof search argument: any matching derivation makes
  // that argument found, allowing absent optional ports without a partial-error
  // exit. Separate -i arguments have different missing-argument exit semantics.
  // Do not filter by loopback: wildcard/foreign binds must remain visible.
  return ['-nP', '-a', '-iTCP:' + ports.join(','), '-sTCP:LISTEN', '-Fpn'];
}

export function validateIosListenerSnapshot(result, ports, { absent = false } = {}) {
  iosListenerQuery(ports);
  if (typeof absent !== 'boolean') throw fail('IOS_LISTENER_BINDING_REFUSED');
  if (typeof result?.stdout !== 'string' || typeof result?.stderr !== 'string' || result.stderr !== '') {
    throw fail(absent ? 'IOS_LISTENER_STOP_UNCONFIRMED' : 'IOS_LISTENER_BINDING_REFUSED');
  }
  if (result.code === 1 && !result.stdout.trim()) {
    if (absent) return true;
    throw fail('IOS_APPIUM_STOPPED');
  }
  if (absent) throw fail('IOS_LISTENER_STOP_UNCONFIRMED');
  if (result.code !== 0) throw fail('IOS_LISTENER_BINDING_REFUSED');
  const selected = new Map(ports.map(port => ['127.0.0.1:' + port, []]));
  const addresses = result.stdout.split(/\r?\n/).filter(line => line.startsWith('n')).map(line => line.slice(1));
  if (!addresses.length) throw fail('IOS_LISTENER_BINDING_REFUSED');
  for (const address of addresses) {
    if (!selected.has(address)) throw fail('IOS_LISTENER_BINDING_REFUSED');
    selected.get(address).push('n' + address);
  }
  // Appium must exist; WDA/MJPEG can legitimately be absent before a session.
  if (!selected.get('127.0.0.1:' + ports[0]).length) throw fail('IOS_APPIUM_STOPPED');
  for (const port of ports) {
    const lines = selected.get('127.0.0.1:' + port);
    if (lines.length) validateIosListener(lines.join('\n'), port);
  }
  return true;
}

export async function queryIosListeners(run, ports, { absent = false } = {}) {
  if (typeof run !== 'function' || typeof absent !== 'boolean') throw fail('IOS_LISTENER_BINDING_REFUSED');
  const result = await run('/usr/sbin/lsof', iosListenerQuery(ports), { ignoreSignal: absent });
  return validateIosListenerSnapshot(result, ports, { absent });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
function launch(executable, args, { cwd, env, capture }) {
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, pid: null, spawned: false, exited: false, closed: false, code: null };
  state.started = new Promise(resolve => { child.once('spawn', () => { state.pid = child.pid; state.spawned = true; resolve(true); }); child.once('error', () => resolve(false)); });
  child.once('exit', code => { state.exited = true; state.code = code; });
  state.done = new Promise(resolve => child.once('close', code => { state.closed = true; state.code = code; resolve(); }));
  child.stdin.on('error', () => {});
  child.stdout.on('data', bytes => capture(bytes.toString('utf8'))); child.stderr.on('data', bytes => capture(bytes.toString('utf8')));
  return state;
}
async function waitClosed(state, timeoutMs) {
  if (state.closed) return;
  let timer; try { await Promise.race([state.done, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); } finally { clearTimeout(timer); }
}
async function stop(state) {
  if (!state || !state.spawned || state.closed) return;
  try { process.kill(-state.pid, 'SIGTERM'); } catch { state.child.kill('SIGTERM'); }
  await waitClosed(state, 2000);
  if (!state.closed) { try { process.kill(-state.pid, 'SIGKILL'); } catch { state.child.kill('SIGKILL'); } await waitClosed(state, 5000); }
  if (!state.closed) { state.child.stdin.destroy(); state.child.stdout.destroy(); state.child.stderr.destroy(); state.child.unref(); throw fail('IOS_PROCESS_STOP_UNCONFIRMED'); }
}

/** Requires installed Xcode/runtime and explicit pinned tooling; downloads nothing. */
export async function startOwnedIos({ toolsRoot, outputDir, signal, onStage = () => {}, runtimeId, deviceType, diagnostics = false, prewarmDiagnostics = false } = {}) {
  requireIosHostedDevice();
  const diagnosticPolicy = createIosDiagnosticPolicy({ diagnostics, prewarmDiagnostics });
  if (![toolsRoot, outputDir].every(safePath)) throw fail('IOS_DEVICE_INPUT_INVALID');
  if (signal?.aborted) throw fail('IOS_CANCELLED');
  const nativeHome = os.userInfo().homedir;
  const deviceSetPath = await canonicalIosStandardSet(nativeHome);
  let tools;
  try { tools = await realpath(toolsRoot); } catch { throw fail('IOS_TOOLS_MISSING'); }
  const appiumRoot = path.join(tools, 'node_modules', 'appium'), driverRoot = path.join(tools, 'node_modules', 'appium-xcuitest-driver');
  const wdaRoot = path.join(driverRoot, 'node_modules', 'appium-webdriveragent');
  let appiumPackage, driverPackage, wdaPackage;
  try { [appiumPackage, driverPackage, wdaPackage] = await Promise.all([appiumRoot, driverRoot, wdaRoot].map(dir => readFile(path.join(dir, 'package.json'), 'utf8').then(JSON.parse))); }
  catch { throw fail('IOS_TOOLS_MISSING'); }
  if (appiumPackage.version !== '3.8.0' || driverPackage.version !== '12.19.1' || wdaPackage.version !== '16.16.3') throw fail('IOS_TOOLS_VERSION_MISMATCH');
  const wdaStartupPatch = await verifyPinnedWdaStartupPatch({ toolsRoot: tools });
  await verifyPinnedIosNativePrerequisite({ toolsRoot: tools });
  try { await Promise.all([access('/usr/bin/xcrun'), access('/usr/bin/xcodebuild'), access(path.join(wdaRoot, 'WebDriverAgent.xcodeproj', 'project.pbxproj'))]); }
  catch { throw fail('IOS_XCODE_PREREQUISITE_MISSING'); }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  if ((await lstat(outputDir)).isSymbolicLink()) throw fail('IOS_OUTPUT_PATH_REFUSED');
  const output = await realpath(outputDir), ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [appiumPort, wdaPort, mjpegPort] = ports;
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-ios-'));
  const derivedDataPath = path.join(root, 'derived-data'), appiumHome = path.join(root, 'appium');
  const marker = { schemaVersion: 2, scope: IOS_DEVICE_SCOPE, nativeHome, privateRoot: root, nonce: randomBytes(12).toString('hex'), ownerPid: process.pid, name: '', udid: null, deviceSetPath, runtimeId: null, deviceType: null, appiumPid: null, baselineSHA256: null, wdaPreparationSHA256: null };
  marker.name = 'testlane_ios_' + marker.nonce;
  const commands = new Set(), diagnosticTasks = new Set(); let diagnosticCleanupUncertain = false, wdaBuildIncomplete = false;
  let appium, closing, closed = false, ready = false, createAttempted = false, createSettled = false, target, xcodeVersion;
  let env, baseline, wdaPreparation;
  const captured = createIosDeviceCapture(), capture = captured.append;
  const writeMarker = () => writeFile(path.join(root, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
  const live = (allowClosing = false) => { if (closed || (closing && !allowClosing) || signal?.aborted) throw fail('IOS_CANCELLED'); if (captured.overflowed()) throw fail('IOS_CAPTURE_LIMIT'); if (ready && (!appium?.spawned || appium.closed)) throw fail('IOS_APPIUM_STOPPED'); };
  async function run(executable, args, { timeoutMs = 30000, ignoreSignal = false, prewarmDiagnostic, deadlineAt } = {}) {
    if (!ignoreSignal) live();
    let stdout = '', stderr = '', bytes = 0, overflow = false;
    const kind = commandKind(executable, args), began = performance.now();
    // Cold-start and WDA preparation callers supply an absolute monotonic deadline.
    // Each command also keeps its own cap, including retained-child acquisition.
    const monotonicDeadline = deadlineAt === undefined ? undefined : Math.min(deadlineAt, began + timeoutMs);
    if (monotonicDeadline !== undefined && !(monotonicDeadline > began)) throw tagIosCommandFailure(fail('IOS_COMMAND_TIMEOUT'), kind);
    const state = launch(executable, args, { cwd: root, env, capture: () => {} });
    state.commandKind = kind;
    const diagnostic = event => capture('\nIOS_DEVICE_COMMAND ' + JSON.stringify({ kind, event, spawned: state.spawned,
      exited: state.exited, closed: state.closed, code: Number.isSafeInteger(state.code) ? state.code : null,
      elapsedMs: Math.max(0, Math.round(performance.now() - began)) }) + '\n');
    diagnostic('start');
    // Full command streams remain transient and bounded for live validation.
    // Repeated host inventory/process payloads do not fill the retained log;
    // fixed kind/status/timing markers remain available for every command.
    stdout = ''; state.child.stdout.removeAllListeners('data'); state.child.stderr.removeAllListeners('data');
    for (const name of ['stdout', 'stderr']) state.child[name].on('data', chunk => { const text = captureIosCommandOutput(capture, kind, chunk.toString('utf8')); bytes += chunk.length;
      if (bytes > LIMIT) { overflow = true; return; } if (name === 'stdout') stdout += text; else stderr += text; });
    commands.add(state);
    if (!await state.started) { diagnostic('start-failed'); commands.delete(state); throw tagIosCommandFailure(fail('IOS_COMMAND_START_FAILED'), kind); }
    state.child.stdin.end(); const deadline = Date.now() + timeoutMs;
    const remaining = () => monotonicDeadline === undefined ? deadline - Date.now() : monotonicDeadline - performance.now();
    let diagnosticTask;
    if (prewarmDiagnostic?.canSample(kind) === true) {
      // Only the retained child of this fixed pre-auth command may be sampled.
      // There is no timer callback that could launch work after run()/close().
      diagnosticTask = (async () => {
        let started;
        try {
          if (closing || signal?.aborted || state.exited || state.closed) return;
          started = verifyIosDiagnosticIdentity(state, await processInfo(state.pid, { timeoutMs: 1000 }), { ownerPid: process.pid });
          while (remaining() > 0 && !closing && !signal?.aborted && !state.exited && !state.closed) {
            if (iosPrewarmDiagnosticDue({ diagnostics: prewarmDiagnostic.canSample(kind), kind, elapsedMs: performance.now() - began, state })) break;
            await sleep(30);
          }
          if (closing || signal?.aborted || !iosPrewarmDiagnosticDue({ diagnostics: prewarmDiagnostic.canSample(kind), kind, elapsedMs: performance.now() - began, state })) return;
          verifyIosDiagnosticIdentity(state, await processInfo(state.pid, { timeoutMs: 1000 }), { ownerPid: process.pid, started });
          if (closing || signal?.aborted || state.exited || state.closed || remaining() < 6000) return;
          // Inventory and launch share one claim; eligibility/identity probes do
          // not consume it. An attempted sample can never be repeated later.
          if (!prewarmDiagnostic.claimSample(kind)) return;
          const result = await run('/usr/bin/sample', [String(state.pid), '1', '1', '-file', '/dev/stdout'], { timeoutMs: 5000 });
          capture('\nIOS_PREWARM_DIAGNOSTIC ' + JSON.stringify({ status: result.code === 0 ? 'captured' : 'unavailable' }) + '\n');
        } catch (error) {
          if (error?.message === 'IOS_PROCESS_STOP_UNCONFIRMED') diagnosticCleanupUncertain = true;
          capture('\nIOS_PREWARM_DIAGNOSTIC ' + JSON.stringify(iosPrewarmDiagnosticFailure(error)) + '\n');
        }
      })();
      diagnosticTasks.add(diagnosticTask);
      // The task catches its errors and always settles before it is forgotten.
      void diagnosticTask.then(() => diagnosticTasks.delete(diagnosticTask));
    }
    let completed = false;
    try {
      while (!state.closed && remaining() > 0 && !(signal?.aborted && !ignoreSignal) && !overflow && !captured.overflowed()) await sleep(30);
      if (!state.closed) {
        diagnostic(signal?.aborted && !ignoreSignal ? 'cancelled-before-stop' : overflow || captured.overflowed() ? 'capture-limit-before-stop' : 'timeout-before-stop');
        if (kind === 'owned-wda-prebuild') await stopOwnedGroups(state);
        else await stop(state);
        throw fail(signal?.aborted && !ignoreSignal ? 'IOS_CANCELLED' : overflow || captured.overflowed() ? 'IOS_CAPTURE_LIMIT' : 'IOS_COMMAND_TIMEOUT');
      }
      if (overflow || captured.overflowed()) throw fail('IOS_CAPTURE_LIMIT');
      if (monotonicDeadline !== undefined && remaining() <= 0) throw fail('IOS_COMMAND_TIMEOUT');
      completed = true;
      return { code: state.code, stdout, stderr };
    } catch (error) { throw tagIosCommandFailure(error, kind); }
    finally { if (diagnosticTask) await diagnosticTask; diagnostic(completed ? 'end' : 'error'); if (state.closed) commands.delete(state); }
  }
  const simctl = (args, options) => run('/usr/bin/xcrun', ['simctl', '--set', deviceSetPath, ...args], options);
  async function assertRoot() {
    if (await realpath(root) !== root || path.dirname(root) !== parent || !/^tld-ios-[a-zA-Z0-9]+$/.test(path.basename(root)) || (await lstat(root)).isSymbolicLink()) throw fail('IOS_OWNERSHIP_REFUSED');
    const markerFile = path.join(root, MARKER), markerInfo = await lstat(markerFile);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || (markerInfo.mode & 0o077) !== 0) throw fail('IOS_OWNERSHIP_REFUSED');
    const current = JSON.parse(await readFile(markerFile, 'utf8'));
    if (Object.keys(current).length !== Object.keys(marker).length || Object.keys(marker).some(key => marker[key] !== current[key])) throw fail('IOS_OWNERSHIP_REFUSED');
    if (await canonicalIosStandardSet(nativeHome) !== deviceSetPath) throw fail('IOS_OWNERSHIP_REFUSED');
    if (baseline) {
      const file = path.join(root, 'foreign-inventory.json'), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        digest(JSON.parse(await readFile(file, 'utf8'))) !== marker.baselineSHA256 || digest(baseline) !== marker.baselineSHA256) throw fail('IOS_OWNERSHIP_REFUSED');
    } else if (marker.baselineSHA256 !== null) throw fail('IOS_OWNERSHIP_REFUSED');
    if (wdaPreparation) {
      const file = path.join(root, 'wda-preparation.json'), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        digest(JSON.parse(await readFile(file, 'utf8'))) !== marker.wdaPreparationSHA256 || digest(wdaPreparation) !== marker.wdaPreparationSHA256) throw fail('IOS_OWNERSHIP_REFUSED');
    } else if (marker.wdaPreparationSHA256 !== null) throw fail('IOS_OWNERSHIP_REFUSED');
    return current;
  }
  async function listOwned(ignoreSignal = false, timeoutMs = 30000, prewarmDiagnostic, deadlineAt) {
    const result = await simctl(['list', 'devices', '--json'], { ignoreSignal, timeoutMs, prewarmDiagnostic, deadlineAt });
    if (result.code !== 0) throw fail('IOS_SIMULATOR_LIST_FAILED');
    try { const parsed = JSON.parse(result.stdout); if (!parsed.devices || typeof parsed.devices !== 'object') throw fail(); return parsed.devices; } catch { throw fail('IOS_SIMULATOR_LIST_FAILED'); }
  }
  async function assertOwned(queryTimeoutMs = 30000, prewarmDiagnostic, coldBootBudget) {
    const checked = async callback => { coldBootBudget?.check(); const result = await callback(); coldBootBudget?.check(); return result; };
    live(); const current = await checked(assertRoot);
    const devices = await checked(() => listOwned(false, coldBootBudget ? Math.min(queryTimeoutMs, coldBootBudget.remainingMs()) : queryTimeoutMs, prewarmDiagnostic, coldBootBudget?.deadlineAt));
    verifyOwnedSimulator({ expected: marker, marker: current, devices, baseline });
    const ownDevice = path.join(deviceSetPath, marker.udid);
    if (await checked(() => realpath(ownDevice)) !== ownDevice || (await checked(() => lstat(ownDevice))).isSymbolicLink()) throw fail('IOS_OWNERSHIP_REFUSED');
    if (ready) await assertListeners();
    coldBootBudget?.check();
    live(); return true;
  }
  // This private guard is confined to build-only preparation before first boot.
  // Public ownership and prepared-artifact checks remain Booted-only.
  async function assertWdaPreparationOwned() {
    live(); const current = await assertRoot();
    verifyOwnedWdaPreparationSimulator({ expected: marker, marker: current, devices: await listOwned(), baseline });
    const ownDevice = path.join(deviceSetPath, marker.udid);
    if (await realpath(ownDevice) !== ownDevice || (await lstat(ownDevice)).isSymbolicLink()) throw fail('IOS_OWNERSHIP_REFUSED');
    live(); return true;
  }
  async function assertListeners({ absent = false } = {}) {
    await queryIosListeners(run, [appiumPort, wdaPort, mjpegPort], { absent });
  }
  async function wdaSourceBinding() {
    const project = path.join(wdaRoot, 'WebDriverAgent.xcodeproj'), projectFile = path.join(project, 'project.pbxproj'), packageFile = path.join(wdaRoot, 'package.json');
    if (!inside(tools, wdaRoot)) throw fail('IOS_WDA_PROJECT_REFUSED');
    for (const file of [wdaRoot, project, projectFile, packageFile]) {
      const info = await lstat(file);
      if (info.isSymbolicLink() || await realpath(file) !== file || !((file === wdaRoot || file === project) ? info.isDirectory() : info.isFile()) ||
          (info.isFile() && info.size > 16 * 1024 * 1024)) throw fail('IOS_WDA_PROJECT_REFUSED');
    }
    const bytes = await readFile(packageFile), candidate = JSON.parse(bytes);
    if (candidate.version !== '16.16.3') throw fail('IOS_WDA_PROJECT_REFUSED');
    return { projectPath: project, projectSHA256: sha(await readFile(projectFile)), packageSHA256: sha(bytes) };
  }
  async function wdaArtifactBinding() {
    const products = path.join(derivedDataPath, 'Build', 'Products'), runner = path.join(products, 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app');
    const test = path.join(runner, 'PlugIns', 'WebDriverAgentRunner.xctest');
    for (const folder of [derivedDataPath, path.dirname(products), products, path.dirname(runner), runner, path.dirname(test), test]) {
      const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw fail('IOS_WDA_ARTIFACT_INVALID');
    }
    const runs = (await readdir(products)).filter(name => /^WebDriverAgentRunner_[A-Za-z0-9._-]+\.xctestrun$/.test(name));
    if (runs.length !== 1) throw fail('IOS_WDA_ARTIFACT_INVALID');
    const runFile = path.join(products, runs[0]), runInfo = await lstat(runFile);
    if (!runInfo.isFile() || runInfo.isSymbolicLink() || await realpath(runFile) !== runFile || runInfo.size < 1 || runInfo.size > 16 * 1024 * 1024) throw fail('IOS_WDA_ARTIFACT_INVALID');
    const plist = async folder => {
      const file = path.join(folder, 'Info.plist'), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw fail('IOS_WDA_ARTIFACT_INVALID');
      const result = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
      if (result.code !== 0) throw fail('IOS_WDA_ARTIFACT_INVALID'); return JSON.parse(result.stdout);
    };
    const appInfo = await plist(runner), testInfo = await plist(test), binary = path.join(runner, 'WebDriverAgentRunner-Runner');
    const binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || await realpath(binary) !== binary) throw fail('IOS_WDA_ARTIFACT_INVALID');
    const architecture = await run('/usr/bin/xcrun', ['lipo', '-archs', binary]), platform = await run('/usr/bin/xcrun', ['vtool', '-show-build', binary]);
    if (architecture.code !== 0 || platform.code !== 0) throw fail('IOS_WDA_ARTIFACT_INVALID');
    validateIosWdaBundleMetadata({ app: appInfo, test: testInfo, architecture: architecture.stdout.trim(), platform: platform.stdout,
      expectedArchitecture: process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null });
    const runnerSHA256 = (await hashIosTree(runner, { signal })).sha256;
    return { runnerSHA256, xctestrunSHA256: sha(await readFile(runFile)) };
  }
  async function prepareWda() {
    await assertWdaPreparationOwned(); const before = await wdaSourceBinding(); live();
    const began = performance.now(); wdaBuildIncomplete = true;
    const result = await run('/usr/bin/xcodebuild', ownedIosWdaBuildArguments({ projectPath: before.projectPath, derivedDataPath, udid: marker.udid, platformVersion: target.platformVersion }), { timeoutMs: WDA_BUILD_MS, deadlineAt: began + WDA_BUILD_MS });
    // A fractional overrun must not round back into an accepted preparation.
    const buildMs = Math.ceil(performance.now() - began);
    if (result.code !== 0 || buildMs > WDA_BUILD_MS) throw fail('IOS_WDA_PREPARE_FAILED');
    await assertWdaPreparationOwned(); const after = await wdaSourceBinding();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw fail('IOS_WDA_PROJECT_REFUSED');
    const artifacts = await wdaArtifactBinding(); await assertWdaPreparationOwned();
    wdaPreparation = validateIosWdaPreparation({ schemaVersion: 1, wdaPrepared: true, buildBudgetMs: WDA_BUILD_MS, buildMs,
      webdriveragent: '16.16.3', projectSHA256: before.projectSHA256, packageSHA256: before.packageSHA256, ...artifacts });
    marker.wdaPreparationSHA256 = digest(wdaPreparation);
    await writeFile(path.join(root, 'wda-preparation.json'), JSON.stringify(wdaPreparation) + '\n', { flag: 'wx', mode: 0o600 });
    await writeMarker(); await assertRoot(); wdaBuildIncomplete = false;
  }
  async function assertWdaPrepared() {
    await assertOwned();
    await verifyPinnedWdaStartupPatch({ toolsRoot: tools });
    if (!wdaPreparation?.wdaPrepared) throw fail('IOS_WDA_PREPARE_FAILED');
    const source = await wdaSourceBinding(), artifacts = await wdaArtifactBinding();
    if (source.projectSHA256 !== wdaPreparation.projectSHA256 || source.packageSHA256 !== wdaPreparation.packageSHA256 ||
        artifacts.runnerSHA256 !== wdaPreparation.runnerSHA256 || artifacts.xctestrunSHA256 !== wdaPreparation.xctestrunSHA256) throw fail('IOS_WDA_ARTIFACT_CHANGED');
    await assertOwned(); return true;
  }
  async function processInfo(pid, { timeoutMs = 30000 } = {}) {
    if (!Number.isSafeInteger(pid) || pid < 2) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
    const result = await run('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=,lstart=,command=', '-p', String(pid)], { ignoreSignal: true, timeoutMs });
    if (result.code === 1 && !result.stdout.trim()) return null;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(result.stdout);
    if (result.code !== 0 || !match || Number(match[1]) !== pid) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
    return { pid, ppid: Number(match[2]), pgid: Number(match[3]), zombie: match[4].includes('Z'), started: match[5] };
  }
  async function stopOwnedGroups(ownedState) {
    if (!ownedState?.spawned) return;
    if (ownedState.treeStop) return ownedState.treeStop;
    ownedState.treeStop = (async () => {
    if (ownedState.exited || ownedState.closed) throw fail('IOS_PROCESS_STOP_UNCONFIRMED');
    const groups = new Map(); let problem;
    try {
      const rootInfo = await processInfo(ownedState.pid);
      if (!rootInfo || rootInfo.zombie || rootInfo.pgid !== ownedState.pid || rootInfo.ppid !== process.pid) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
      groups.set(rootInfo.pid, rootInfo); process.kill(-rootInfo.pgid, 'SIGSTOP');
      let visited = 0;
      async function descendants(parentPid, depth) {
        if (++visited > 64 || depth > 8) throw fail('IOS_PROCESS_TREE_LIMIT');
        const result = await run('/usr/bin/pgrep', ['-P', String(parentPid)], { ignoreSignal: true });
        if (result.code === 1 && !result.stdout.trim()) return;
        if (result.code !== 0 || !/^\s*\d+(?:\s+\d+)*\s*$/.test(result.stdout)) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
        for (const value of result.stdout.trim().split(/\s+/)) {
          const child = await processInfo(Number(value)); if (!child || child.zombie) continue;
          if (child.ppid !== parentPid) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
          if (!groups.has(child.pgid)) {
            if (child.pid !== child.pgid) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
            groups.set(child.pid, child); process.kill(-child.pgid, 'SIGSTOP');
          }
          await descendants(child.pid, depth + 1);
        }
      }
      await descendants(ownedState.pid, 0);
    } catch (error) { problem = error; }
    // Xcodebuild deliberately creates its own process group. Freeze discovery
    // while its parent is retained, then stop only proven descendant groups,
    // last terminating the retained parent. No shared SDK daemon is selected
    // by name/path and successful build completion claims no daemon teardown.
    for (const entry of [...groups.values()].reverse()) {
      try {
        const current = await processInfo(entry.pid);
        if (!current) continue;
        if (current.pgid !== entry.pgid || current.started !== entry.started) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
        process.kill(-entry.pgid, 'SIGKILL');
        const deadline = Date.now() + 5000;
        for (;;) {
          const memberList = await run('/usr/bin/pgrep', ['-g', String(entry.pgid)], { ignoreSignal: true });
          if (memberList.code === 1 && !memberList.stdout.trim()) break;
          if (memberList.code !== 0 || !/^\s*\d+(?:\s+\d+)*\s*$/.test(memberList.stdout)) throw fail('IOS_PROCESS_STOP_UNCONFIRMED');
          const members = await Promise.all(memberList.stdout.trim().split(/\s+/).map(value => processInfo(Number(value))));
          if (members.every(member => !member || member.zombie)) break;
          if (Date.now() > deadline) throw fail('IOS_PROCESS_STOP_UNCONFIRMED'); await sleep(50);
        }
      } catch (error) { problem ??= error; }
    }
    if (!groups.has(ownedState.pid)) { try { await stop(ownedState); } catch (error) { problem ??= error; } }
    await waitClosed(ownedState, 5000);
    if (!ownedState.closed) problem ??= fail('IOS_PROCESS_STOP_UNCONFIRMED');
    if (problem) throw fail('IOS_PROCESS_STOP_UNCONFIRMED');
    })();
    return ownedState.treeStop;
  }
  async function containerFile() {
    await assertOwned();
    const result = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'get_app_container', [BUNDLE, 'data']));
    if (result.code !== 0) throw fail('IOS_BOOTSTRAP_CONTAINER_UNAVAILABLE');
    const containerPath = result.stdout.trim(), file = validateIosContainer({ ...marker, containerPath });
    if (await realpath(containerPath) !== containerPath) throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED');
    const base = path.join(deviceSetPath, marker.udid);
    for (const part of path.relative(base, containerPath).split(path.sep)) {
      if (!part || part === '..') throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED');
    }
    let cursor = base;
    for (const part of path.relative(base, containerPath).split(path.sep)) { cursor = path.join(cursor, part); const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED'); }
    const documents = path.dirname(file);
    try { await mkdir(documents, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED'); }
    if (await realpath(documents) !== documents || (await lstat(documents)).isSymbolicLink()) throw fail('IOS_BOOTSTRAP_CONTAINER_REFUSED');
    live(); return file;
  }
  const recover = async (reason, failures = []) => {
    try { await writeFile(path.join(output, 'ios-device-recovery.json'), JSON.stringify({ schemaVersion: 1, status: 'manual-inspection-required', reason,
      scope: IOS_DEVICE_SCOPE, ownedRoot: root, deviceSetPath, udid: marker.udid, name: marker.name, baselineSHA256: marker.baselineSHA256,
      processes: failures }) + '\n', { flag: 'wx', mode: 0o600 }); } catch {}
  };
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      signal?.removeEventListener('abort', abortLifecycle);
      const failures = [];
      for (const [kind, state] of [...commands].map(state => ['command', state])) {
        try { if (state.commandKind === 'owned-wda-prebuild') await stopOwnedGroups(state); else await stop(state); }
        catch { failures.push({ kind, pid: state?.pid, exited: state?.exited, closed: state?.closed }); }
      }
      // Marking closing prevents a diagnostic from creating another child.
      // Its current sampler/identity command is included in commands above.
      await Promise.allSettled([...diagnosticTasks]);
      if (diagnosticCleanupUncertain) failures.push({ kind: 'prewarm-diagnostic' });
      if (wdaBuildIncomplete) failures.push({ kind: 'wda-prebuild-incomplete' });
      try { await stopOwnedGroups(appium); } catch { failures.push({ kind: 'appium-or-detached-build', pid: appium?.pid, exited: appium?.exited, closed: appium?.closed }); }
      if (failures.length) { await recover('process-stop-unconfirmed', failures); throw fail('IOS_DEVICE_CLEANUP_UNCONFIRMED'); }
      try {
        await assertRoot();
        let devices = baseline ? await listOwned(true) : null;
        let rows = devices ? normalizeIosDeviceInventory(devices) : [], foreignChanged = false;
        if (!marker.udid && createAttempted) {
          // The owned command has been stopped/closed above. Only one new row
          // with our unguessable nonce and exact target may be reconciled.
          const known = new Set(baseline.map(row => row.udid));
          const candidates = rows.filter(row => !known.has(row.udid) && row.name === marker.name && row.runtimeId === marker.runtimeId && row.deviceTypeIdentifier === marker.deviceType);
          if (candidates.length > 1) throw fail('IOS_OWNERSHIP_REFUSED');
          if (candidates.length === 1) { marker.udid = candidates[0].udid; await writeMarker(); }
        }
        const observeForeign = inventory => { try { assertIosForeignSnapshot(inventory, baseline, marker.udid ?? undefined); } catch { foreignChanged = true; } };
        if (baseline) observeForeign(devices);
        const ownedRow = marker.udid ? rows.find(row => row.udid === marker.udid) : null;
        if (ownedRow) {
          const verified = verifyOwnedSimulator({ expected: marker, marker: await assertRoot(), devices, baseline, requireBooted: false, verifyForeign: false });
          if (verified.state !== 'Shutdown') {
            const result = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'shutdown'), { ignoreSignal: true });
            if (result.code !== 0) throw fail('IOS_SIMULATOR_SHUTDOWN_UNCONFIRMED');
          }
          const shutdownDeadline = Date.now() + 30000;
          for (;;) {
            devices = await listOwned(true); observeForeign(devices);
            const row = verifyOwnedSimulator({ expected: marker, marker: await assertRoot(), devices, baseline, requireBooted: false, verifyForeign: false });
            if (row.state === 'Shutdown') break;
            if (Date.now() > shutdownDeadline) throw fail('IOS_SIMULATOR_SHUTDOWN_UNCONFIRMED'); await sleep(200);
          }
          // Recheck the nonce-bound marker and target immediately before this
          // exact UUID deletion. Foreign drift is recorded, never repaired.
          verifyOwnedSimulator({ expected: marker, marker: await assertRoot(), devices: await listOwned(true), baseline, requireBooted: false, verifyForeign: false });
          const deleted = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'delete'), { ignoreSignal: true });
          devices = await listOwned(true); observeForeign(devices);
          if (deleted.code !== 0 || normalizeIosDeviceInventory(devices).some(row => row.udid === marker.udid)) throw fail('IOS_SIMULATOR_DELETE_UNCONFIRMED');
        }
        if (marker.udid) try { await lstat(path.join(deviceSetPath, marker.udid)); throw fail('IOS_SIMULATOR_DELETE_UNCONFIRMED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (createAttempted && !createSettled) throw fail('IOS_SIMULATOR_CREATE_UNSETTLED');
        if (foreignChanged) throw fail('IOS_FOREIGN_INVENTORY_CHANGED');
        if (ready) await assertListeners({ absent: true });
        await assertRoot(); await rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 }); closed = true;
      } catch { await recover('simulator-or-path-cleanup-unconfirmed'); throw fail('IOS_DEVICE_CLEANUP_UNCONFIRMED'); }
      if (captured.overflowed()) throw fail('IOS_CAPTURE_LIMIT');
    })();
    return closing;
  }
  const abortLifecycle = () => { void close().catch(() => {}); };
  let startupStage = 'owned-simulator-start';
  const startupAt = name => { startupStage = 'device-' + name; onStage(name); };
  try {
    await writeMarker();
    await Promise.all([derivedDataPath, appiumHome, path.join(root, 'tmp'), path.join(root, 'cache')].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
    // Native frameworks and JS helpers use the canonical account home that owns
    // the standard device set; Appium/build/temp paths stay explicitly private.
    env = createIosDeviceEnvironment({ nativeHome, APPIUM_HOME: appiumHome,
      TMPDIR: path.join(root, 'tmp') + '/', XDG_CACHE_HOME: path.join(root, 'cache') });
    const version = await run('/usr/bin/xcodebuild', ['-version']);
    xcodeVersion = /^Xcode (\d+(?:\.\d+){0,2})\s*$/m.exec(version.stdout)?.[1];
    if (version.code !== 0 || !xcodeVersion) throw fail('IOS_XCODE_PREREQUISITE_FAILED');
    const runtimes = await run('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'], { timeoutMs: 120000 });
    const types = await run('/usr/bin/xcrun', ['simctl', 'list', 'devicetypes', '--json'], { timeoutMs: 120000 });
    if (runtimes.code !== 0 || types.code !== 0) throw fail('IOS_XCODE_PREREQUISITE_FAILED');
    try { target = selectIosTarget({ ...JSON.parse(runtimes.stdout), ...JSON.parse(types.stdout) }, { runtimeId, deviceType }); } catch (error) { throw /^IOS_/.test(error.message) ? error : fail('IOS_RUNTIME_METADATA_INVALID'); }
    marker.runtimeId = target.runtimeId; marker.deviceType = target.deviceType; await writeMarker(); startupAt('xcode-runtime-and-pinned-tools-validated');
    baseline = snapshotIosForeignDevices(await listOwned());
    marker.baselineSHA256 = digest(baseline);
    await writeFile(path.join(root, 'foreign-inventory.json'), JSON.stringify(baseline) + '\n', { flag: 'wx', mode: 0o600 });
    await writeMarker(); await assertRoot(); assertIosForeignSnapshot(await listOwned(), baseline);
    createAttempted = true;
    const created = await simctl(['create', marker.name, marker.deviceType, marker.runtimeId]);
    const acknowledgedUdid = acknowledgedIosCreate(created);
    // A closed client with a nonzero/malformed response is not a completion
    // fence for the CoreSimulator service. Reconciliation may clean its row,
    // but createSettled remains false and cleanup cannot claim completion.
    createSettled = true; marker.udid = acknowledgedUdid; await writeMarker();
    startupAt('owned-simulator-created');
    await assertWdaPreparationOwned();
    startupAt('wda-build-for-testing'); await prepareWda(); startupAt('wda-prepared');
    await runIosColdBoot({ signal,
      boot: ({ timeoutMs, deadlineAt }) => run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'boot'), { timeoutMs, deadlineAt }),
      onBootStarted: () => { startupAt('owned-simulator-boot-started'); signal?.addEventListener('abort', abortLifecycle, { once: true }); },
      bootStatus: ({ timeoutMs, deadlineAt }) => simctl(['bootstatus', marker.udid, '-b'], { timeoutMs, deadlineAt }),
      confirmOwned: budget => assertOwned(budget.timeoutMs, undefined, budget),
    });
    startupAt('owned-simulator-booted');
    await assertWdaPrepared();
    const { Manifest } = await import(pathToFileURL(path.join(appiumRoot, 'build', 'lib', 'extension', 'manifest.js')).href);
    const manifest = new Manifest(appiumHome); await manifest.read(); manifest.addExtensionFromPackage(driverPackage, path.join(driverRoot, 'package.json'), 'local'); await manifest.write();
    live();
    appium = launch(process.execPath, [path.join(appiumRoot, 'index.js'), '--address', '127.0.0.1', '--port', String(appiumPort), '--base-path', '/',
      '--log-level', diagnosticPolicy.appiumLogLevel, '--log-no-colors', '--use-drivers', 'xcuitest'], { cwd: root, env, capture });
    if (!await appium.started) throw fail('IOS_APPIUM_START_FAILED');
    appium.child.stdin.end(); marker.appiumPid = appium.pid; await writeMarker();
    const serverUrl = 'http://127.0.0.1:' + appiumPort + '/', deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      live(); if (appium.closed) throw fail('IOS_APPIUM_STOPPED');
      try { const response = await fetch(new URL('status', serverUrl), { signal: AbortSignal.timeout(1000) }); const body = await response.json(); ready = response.ok && body.value?.ready === true && body.value?.build?.version === '3.8.0'; } catch {}
      if (ready) break; await sleep(300);
    }
    if (!ready) throw fail('IOS_APPIUM_READY_TIMEOUT');
    await assertOwned(); startupAt('private-appium-ready');
    const deviceBinding = validateIosDeviceBinding({ schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome, deviceSetPath, privateRoot: root, udid: marker.udid, nonce: marker.nonce });
    return Object.freeze({ udid: marker.udid, serverUrl, deviceSetPath, derivedDataPath, deviceBinding, wdaPreparation, wdaPort, mjpegPort,
      versions: Object.freeze({ appium: '3.8.0', xcuitest: '12.19.1', webdriveragent: '16.16.3', xcode: xcodeVersion, ios: target.platformVersion, runtimeId: target.runtimeId, deviceType: target.deviceType }), wdaStartupPatch,
      assertOwned: () => assertOwned(), assertWdaPrepared: () => assertWdaPrepared(), capturedText: captured.text,
      async installApp(appPath) {
        if (!safePath(appPath) || !appPath.endsWith('.app') || !(await lstat(appPath)).isDirectory() || (await lstat(appPath)).isSymbolicLink()) throw fail('IOS_APP_INPUT_INVALID');
        await assertOwned(); live(); const result = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'install', [await realpath(appPath)]), { timeoutMs: 120000 });
        if (result.code !== 0) throw fail('IOS_APP_INSTALL_FAILED'); return { installed: true };
      },
      async prewarmProofApp(...args) {
        if (args.length !== 0) throw fail('IOS_APP_INPUT_INVALID');
        // This fixed public app is still signed out: no backend, account or
        // bootstrap has been allocated by the controller at this stage.
        const prewarmDiagnostic = diagnosticPolicy.beginPrewarm();
        try {
          await assertOwned(30000, prewarmDiagnostic); live();
          const result = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'launch', [BUNDLE]), { timeoutMs: 30000, prewarmDiagnostic });
          return acknowledgedIosProofLaunch(result);
        } finally { diagnosticPolicy.finishPrewarm(prewarmDiagnostic); }
      },
      async writeBootstrap(payload) {
        if (typeof payload !== 'string' || Buffer.byteLength(payload) > 65536 || payload.includes('\0')) throw fail('IOS_BOOTSTRAP_INPUT_INVALID');
        try { const parsed = JSON.parse(payload); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(); } catch { throw fail('IOS_BOOTSTRAP_INPUT_INVALID'); }
        const file = await containerFile(); live();
        let handle; try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.writeFile(payload, 'utf8'); await handle.sync(); }
        catch { throw fail('IOS_BOOTSTRAP_WRITE_FAILED'); } finally { await handle?.close(); }
        const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size !== Buffer.byteLength(payload)) throw fail('IOS_BOOTSTRAP_WRITE_FAILED');
        return { written: true };
      },
      async assertBootstrapAbsent() { const file = await containerFile(); try { await lstat(file); throw fail('IOS_BOOTSTRAP_CLEANUP_UNCONFIRMED'); } catch (error) { if (error.code !== 'ENOENT') throw fail('IOS_BOOTSTRAP_CLEANUP_UNCONFIRMED'); } return { absent: true }; },
      close,
    });
  } catch (error) {
    const startupFailure = createIosStartupFailure({ stage: startupStage, error });
    let code = fixedIosDeviceFailureCode(error);
    try { await close(); } catch { code = 'IOS_DEVICE_CLEANUP_UNCONFIRMED'; }
    const result = retainIosStartupFailure(fail(code), startupFailure);
    Object.defineProperty(result, 'capturedText', { value: captured.text }); throw result;
  }
}
