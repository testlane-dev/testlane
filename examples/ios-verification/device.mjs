/** Own one new Simulator in a private device set and one private Appium server. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIosDeviceEnvironment } from './environment.mjs';

const UUID = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/;
const BUNDLE = 'dev.testlane.iosproof', MARKER = 'testlane-owned-simulator.json';
const LIMIT = 8 * 1024 * 1024;
const fail = code => new Error(code);
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fixed diagnostic labels only: never retain command arguments or environment.
function commandKind(executable, args) {
  if (executable === '/usr/bin/xcodebuild') return 'xcode-version';
  if (executable === '/usr/sbin/lsof') return 'loopback-listeners';
  if (executable === '/bin/ps') return 'process-identity';
  if (executable === '/usr/bin/pgrep') return args[0] === '-P' ? 'owned-descendants' : 'owned-process-group';
  if (executable !== '/usr/bin/xcrun' || args[0] !== 'simctl') return 'other';
  const index = args[1] === '--set' ? 3 : 1;
  if (args[index] === 'list') return { runtimes: 'runtime-list', devicetypes: 'device-type-list', devices: 'owned-device-list' }[args[index + 1]] ?? 'other';
  return { create: 'owned-device-create', boot: 'owned-device-boot', bootstatus: 'owned-device-bootstatus',
    shutdown: 'owned-device-shutdown', delete: 'owned-device-delete', install: 'owned-app-install',
    get_app_container: 'owned-app-container' }[args[index]] ?? 'other';
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
  if (!safePath(deviceSetPath) || !UUID.test(udid ?? '') || !['boot', 'shutdown', 'delete', 'install', 'get_app_container'].includes(command) ||
      !Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\r\n\0]/.test(value)) ||
      (['boot', 'shutdown', 'delete'].includes(command) && args.length !== 0) ||
      (command === 'install' && (args.length !== 1 || !safePath(args[0]) || !args[0].endsWith('.app'))) ||
      (command === 'get_app_container' && (args.length !== 2 || args[0] !== BUNDLE || args[1] !== 'data'))) throw fail('IOS_SIMCTL_SCOPE_REFUSED');
  return ['simctl', '--set', deviceSetPath, command, udid, ...args];
}

export function verifyOwnedSimulator({ expected, marker, devices, requireBooted = true }) {
  if (!expected || !/^[a-f0-9]{24}$/.test(expected.nonce ?? '') || expected.name !== 'testlane_ios_' + expected.nonce ||
      !UUID.test(expected.udid ?? '') || !Number.isSafeInteger(expected.ownerPid) || expected.ownerPid < 1 ||
      !marker || marker.schemaVersion !== 1 || ['nonce', 'name', 'udid', 'ownerPid', 'runtimeId', 'deviceType', 'deviceSetPath'].some(key => marker[key] !== expected[key]) ||
      !devices || typeof devices !== 'object' || Object.values(devices).some(list => !Array.isArray(list))) throw fail('IOS_OWNERSHIP_REFUSED');
  const rows = Object.entries(devices).flatMap(([runtimeId, list]) => Array.isArray(list) ? list.map(row => ({ ...row, runtimeId })) : []);
  if (rows.length !== 1 || rows[0].udid !== expected.udid || rows[0].name !== expected.name || rows[0].runtimeId !== expected.runtimeId ||
      rows[0].isAvailable === false || (requireBooted && rows[0].state !== 'Booted')) throw fail('IOS_OWNERSHIP_REFUSED');
  return rows[0];
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
export async function startOwnedIos({ toolsRoot, outputDir, signal, onStage = () => {}, runtimeId, deviceType } = {}) {
  if (process.platform !== 'darwin') throw fail('IOS_MACOS_REQUIRED');
  if (![toolsRoot, outputDir].every(safePath)) throw fail('IOS_DEVICE_INPUT_INVALID');
  if (signal?.aborted) throw fail('IOS_CANCELLED');
  let tools;
  try { tools = await realpath(toolsRoot); } catch { throw fail('IOS_TOOLS_MISSING'); }
  const appiumRoot = path.join(tools, 'node_modules', 'appium'), driverRoot = path.join(tools, 'node_modules', 'appium-xcuitest-driver');
  const wdaRoot = path.join(driverRoot, 'node_modules', 'appium-webdriveragent');
  let appiumPackage, driverPackage, wdaPackage;
  try { [appiumPackage, driverPackage, wdaPackage] = await Promise.all([appiumRoot, driverRoot, wdaRoot].map(dir => readFile(path.join(dir, 'package.json'), 'utf8').then(JSON.parse))); }
  catch { throw fail('IOS_TOOLS_MISSING'); }
  if (appiumPackage.version !== '3.8.0' || driverPackage.version !== '12.19.1' || wdaPackage.version !== '16.16.3') throw fail('IOS_TOOLS_VERSION_MISMATCH');
  try { await Promise.all([access('/usr/bin/xcrun'), access('/usr/bin/xcodebuild'), access(path.join(wdaRoot, 'WebDriverAgent.xcodeproj', 'project.pbxproj'))]); }
  catch { throw fail('IOS_XCODE_PREREQUISITE_MISSING'); }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  if ((await lstat(outputDir)).isSymbolicLink()) throw fail('IOS_OUTPUT_PATH_REFUSED');
  const output = await realpath(outputDir), ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [appiumPort, wdaPort, mjpegPort] = ports;
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-ios-'));
  const deviceSetPath = path.join(root, 'devices'), derivedDataPath = path.join(root, 'derived-data'), home = path.join(root, 'home'), appiumHome = path.join(root, 'appium');
  const marker = { schemaVersion: 1, nonce: randomBytes(12).toString('hex'), ownerPid: process.pid, name: '', udid: null, deviceSetPath, runtimeId: null, deviceType: null, appiumPid: null };
  marker.name = 'testlane_ios_' + marker.nonce;
  const commands = new Set(); let appium, closing, closed = false, ready = false, createAttempted = false, createSettled = false, captured = '', captureBytes = 0, captureFailed = false, target, xcodeVersion;
  let env;
  const capture = text => { const bytes = Buffer.byteLength(text); if (captureBytes + bytes > LIMIT) { captureFailed = true; return; } captured += text; captureBytes += bytes; };
  const writeMarker = () => writeFile(path.join(root, MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 });
  const live = (allowClosing = false) => { if (closed || (closing && !allowClosing) || signal?.aborted) throw fail('IOS_CANCELLED'); if (captureFailed) throw fail('IOS_CAPTURE_LIMIT'); if (ready && (!appium?.spawned || appium.closed)) throw fail('IOS_APPIUM_STOPPED'); };
  async function run(executable, args, { timeoutMs = 30000, ignoreSignal = false } = {}) {
    if (!ignoreSignal) live();
    let stdout = '', stderr = '', bytes = 0, overflow = false;
    const kind = commandKind(executable, args), began = performance.now();
    const state = launch(executable, args, { cwd: root, env, capture: () => {} });
    const diagnostic = event => capture('\nIOS_DEVICE_COMMAND ' + JSON.stringify({ kind, event, spawned: state.spawned,
      exited: state.exited, closed: state.closed, code: Number.isSafeInteger(state.code) ? state.code : null,
      elapsedMs: Math.max(0, Math.round(performance.now() - began)) }) + '\n');
    diagnostic('start');
    // Keep command streams separate without ever persisting their contents.
    stdout = ''; state.child.stdout.removeAllListeners('data'); state.child.stderr.removeAllListeners('data');
    for (const name of ['stdout', 'stderr']) state.child[name].on('data', chunk => { const text = chunk.toString('utf8'); capture(text); bytes += chunk.length;
      if (bytes > LIMIT) { overflow = true; return; } if (name === 'stdout') stdout += text; else stderr += text; });
    commands.add(state);
    if (!await state.started) { diagnostic('start-failed'); commands.delete(state); throw fail('IOS_COMMAND_START_FAILED'); }
    state.child.stdin.end(); const deadline = Date.now() + timeoutMs;
    let completed = false;
    try {
      while (!state.closed && Date.now() < deadline && !(signal?.aborted && !ignoreSignal) && !overflow && !captureFailed) await sleep(30);
      if (!state.closed) {
        diagnostic(signal?.aborted && !ignoreSignal ? 'cancelled-before-stop' : overflow || captureFailed ? 'capture-limit-before-stop' : 'timeout-before-stop');
        await stop(state); throw fail(signal?.aborted && !ignoreSignal ? 'IOS_CANCELLED' : overflow || captureFailed ? 'IOS_CAPTURE_LIMIT' : 'IOS_COMMAND_TIMEOUT');
      }
      if (overflow || captureFailed) throw fail('IOS_CAPTURE_LIMIT');
      completed = true;
      return { code: state.code, stdout, stderr };
    } finally { diagnostic(completed ? 'end' : 'error'); if (state.closed) commands.delete(state); }
  }
  const simctl = (args, options) => run('/usr/bin/xcrun', ['simctl', '--set', deviceSetPath, ...args], options);
  async function assertRoot() {
    if (await realpath(root) !== root || path.dirname(root) !== parent || !/^tld-ios-[a-zA-Z0-9]+$/.test(path.basename(root)) || (await lstat(root)).isSymbolicLink()) throw fail('IOS_OWNERSHIP_REFUSED');
    const current = JSON.parse(await readFile(path.join(root, MARKER), 'utf8'));
    if (Object.keys(marker).some(key => marker[key] !== current[key])) throw fail('IOS_OWNERSHIP_REFUSED');
    if (await realpath(deviceSetPath) !== deviceSetPath || (await lstat(deviceSetPath)).isSymbolicLink()) throw fail('IOS_OWNERSHIP_REFUSED');
    return current;
  }
  async function listOwned(ignoreSignal = false, timeoutMs = 30000) {
    const result = await simctl(['list', 'devices', '--json'], { ignoreSignal, timeoutMs });
    if (result.code !== 0) throw fail('IOS_SIMULATOR_LIST_FAILED');
    try { const parsed = JSON.parse(result.stdout); if (!parsed.devices || typeof parsed.devices !== 'object') throw fail(); return parsed.devices; } catch { throw fail('IOS_SIMULATOR_LIST_FAILED'); }
  }
  async function assertOwned(queryTimeoutMs = 30000) {
    live(); const current = await assertRoot(); const devices = await listOwned(false, queryTimeoutMs);
    verifyOwnedSimulator({ expected: marker, marker: current, devices });
    const ownDevice = path.join(deviceSetPath, marker.udid);
    if (await realpath(ownDevice) !== ownDevice || (await lstat(ownDevice)).isSymbolicLink()) throw fail('IOS_OWNERSHIP_REFUSED');
    if (ready) await assertListeners();
    live(); return true;
  }
  async function assertListeners({ absent = false } = {}) {
    for (const port of [appiumPort, wdaPort, mjpegPort]) {
      const result = await run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn'], { ignoreSignal: absent });
      if (result.code === 1 && !result.stdout.trim()) { if (!absent && port === appiumPort) throw fail('IOS_APPIUM_STOPPED'); continue; }
      if (result.code !== 0 || absent) throw fail(absent ? 'IOS_LISTENER_STOP_UNCONFIRMED' : 'IOS_LISTENER_BINDING_REFUSED');
      validateIosListener(result.stdout, port);
    }
  }
  async function processInfo(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
    const result = await run('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=,lstart=,command=', '-p', String(pid)], { ignoreSignal: true });
    if (result.code === 1 && !result.stdout.trim()) return null;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(result.stdout);
    if (result.code !== 0 || !match || Number(match[1]) !== pid) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
    return { pid, ppid: Number(match[2]), pgid: Number(match[3]), zombie: match[4].includes('Z'), started: match[5] };
  }
  async function stopAppiumGroups() {
    if (!appium?.spawned) return;
    if (appium.exited || appium.closed) throw fail('IOS_PROCESS_STOP_UNCONFIRMED');
    const groups = new Map(); let problem;
    try {
      const rootInfo = await processInfo(appium.pid);
      if (!rootInfo || rootInfo.zombie || rootInfo.pgid !== appium.pid || rootInfo.ppid !== process.pid) throw fail('IOS_PROCESS_OWNERSHIP_REFUSED');
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
      await descendants(appium.pid, 0);
    } catch (error) { problem = error; }
    // Xcodebuild deliberately creates its own process group. Freeze discovery
    // while Appium is retained, then stop only proven descendant groups, last
    // terminating Appium itself so no new detached build can escape discovery.
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
    if (!groups.has(appium.pid)) { try { await stop(appium); } catch (error) { problem ??= error; } }
    await waitClosed(appium, 5000);
    if (!appium.closed) problem ??= fail('IOS_PROCESS_STOP_UNCONFIRMED');
    if (problem) throw fail('IOS_PROCESS_STOP_UNCONFIRMED');
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
      ownedRoot: root, deviceSetPath, udid: marker.udid, name: marker.name, processes: failures }) + '\n', { flag: 'wx', mode: 0o600 }); } catch {}
  };
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      signal?.removeEventListener('abort', abortLifecycle);
      const failures = [];
      for (const [kind, state] of [...commands].map(state => ['command', state])) {
        try { await stop(state); } catch { failures.push({ kind, pid: state?.pid, exited: state?.exited, closed: state?.closed }); }
      }
      try { await stopAppiumGroups(); } catch { failures.push({ kind: 'appium-or-detached-build', pid: appium?.pid, exited: appium?.exited, closed: appium?.closed }); }
      if (failures.length) { await recover('process-stop-unconfirmed', failures); throw fail('IOS_DEVICE_CLEANUP_UNCONFIRMED'); }
      try {
        const current = await assertRoot(), devices = createAttempted ? await listOwned(true) : {};
        const rows = Object.entries(devices).flatMap(([runtime, list]) => list.map(row => ({ ...row, runtime })));
        if (rows.length) {
          if (!marker.udid && rows.length === 1 && rows[0].name === marker.name && rows[0].runtime === marker.runtimeId && UUID.test(rows[0].udid)) { marker.udid = rows[0].udid; await writeMarker(); }
          verifyOwnedSimulator({ expected: marker, marker: marker.udid === current.udid ? current : marker, devices, requireBooted: false });
          if (rows[0].state !== 'Shutdown') {
            const result = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'shutdown'), { ignoreSignal: true });
            if (result.code !== 0) throw fail('IOS_SIMULATOR_SHUTDOWN_UNCONFIRMED');
          }
          const shutdownDeadline = Date.now() + 30000;
          for (;;) {
            const row = verifyOwnedSimulator({ expected: marker, marker, devices: await listOwned(true), requireBooted: false });
            if (row.state === 'Shutdown') break;
            if (Date.now() > shutdownDeadline) throw fail('IOS_SIMULATOR_SHUTDOWN_UNCONFIRMED'); await sleep(200);
          }
          const deleted = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'delete'), { ignoreSignal: true });
          if (deleted.code !== 0 || Object.values(await listOwned(true)).some(list => list.length)) throw fail('IOS_SIMULATOR_DELETE_UNCONFIRMED');
          try { await lstat(path.join(deviceSetPath, marker.udid)); throw fail('IOS_SIMULATOR_DELETE_UNCONFIRMED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (createAttempted && !createSettled) throw fail('IOS_SIMULATOR_CREATE_UNSETTLED');
        if (ready) await assertListeners({ absent: true });
        await assertRoot(); await rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 }); closed = true;
      } catch { await recover('simulator-or-path-cleanup-unconfirmed'); throw fail('IOS_DEVICE_CLEANUP_UNCONFIRMED'); }
      if (captureFailed) throw fail('IOS_CAPTURE_LIMIT');
    })();
    return closing;
  }
  const abortLifecycle = () => { void close().catch(() => {}); };
  try {
    await writeMarker();
    await Promise.all([deviceSetPath, derivedDataPath, home, appiumHome, path.join(root, 'tmp'), path.join(root, 'cache')].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
    env = createIosDeviceEnvironment({ HOME: home, CFFIXED_USER_HOME: home, APPIUM_HOME: appiumHome,
      TMPDIR: path.join(root, 'tmp') + '/', XDG_CACHE_HOME: path.join(root, 'cache') });
    const version = await run('/usr/bin/xcodebuild', ['-version']);
    xcodeVersion = /^Xcode (\d+(?:\.\d+){0,2})\s*$/m.exec(version.stdout)?.[1];
    if (version.code !== 0 || !xcodeVersion) throw fail('IOS_XCODE_PREREQUISITE_FAILED');
    const runtimes = await run('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'], { timeoutMs: 120000 });
    const types = await run('/usr/bin/xcrun', ['simctl', 'list', 'devicetypes', '--json'], { timeoutMs: 120000 });
    if (runtimes.code !== 0 || types.code !== 0) throw fail('IOS_XCODE_PREREQUISITE_FAILED');
    try { target = selectIosTarget({ ...JSON.parse(runtimes.stdout), ...JSON.parse(types.stdout) }, { runtimeId, deviceType }); } catch (error) { throw /^IOS_/.test(error.message) ? error : fail('IOS_RUNTIME_METADATA_INVALID'); }
    marker.runtimeId = target.runtimeId; marker.deviceType = target.deviceType; await writeMarker(); onStage('xcode-runtime-and-pinned-tools-validated');
    createAttempted = true;
    const created = await simctl(['create', marker.name, marker.deviceType, marker.runtimeId]);
    if (created.code !== 0 || !UUID.test(created.stdout.trim())) throw fail('IOS_SIMULATOR_CREATE_FAILED');
    createSettled = true; marker.udid = created.stdout.trim(); await writeMarker();
    onStage('owned-simulator-created');
    const current = await assertRoot(); verifyOwnedSimulator({ expected: marker, marker: current, devices: await listOwned(), requireBooted: false });
    const boot = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'boot'));
    if (boot.code !== 0) throw fail('IOS_SIMULATOR_BOOT_FAILED');
    onStage('owned-simulator-boot-started');
    signal?.addEventListener('abort', abortLifecycle, { once: true });
    const bootStatus = await simctl(['bootstatus', marker.udid, '-b'], { timeoutMs: 180000 });
    if (bootStatus.code !== 0) throw fail('IOS_SIMULATOR_BOOT_TIMEOUT');
    // Hosted cold boot can finish before CoreSimulator answers its first device
    // inventory query promptly. Allow that single read-only startup query more
    // time; steady-state ownership checks and all mutation budgets stay fixed.
    await assertOwned(90000); onStage('owned-simulator-booted');
    const { Manifest } = await import(pathToFileURL(path.join(appiumRoot, 'build', 'lib', 'extension', 'manifest.js')).href);
    const manifest = new Manifest(appiumHome); await manifest.read(); manifest.addExtensionFromPackage(driverPackage, path.join(driverRoot, 'package.json'), 'local'); await manifest.write();
    live();
    appium = launch(process.execPath, [path.join(appiumRoot, 'index.js'), '--address', '127.0.0.1', '--port', String(appiumPort), '--base-path', '/',
      '--log-level', 'error', '--log-no-colors', '--use-drivers', 'xcuitest'], { cwd: root, env, capture });
    if (!await appium.started) throw fail('IOS_APPIUM_START_FAILED');
    appium.child.stdin.end(); marker.appiumPid = appium.pid; await writeMarker();
    const serverUrl = 'http://127.0.0.1:' + appiumPort + '/', deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      live(); if (appium.closed) throw fail('IOS_APPIUM_STOPPED');
      try { const response = await fetch(new URL('status', serverUrl), { signal: AbortSignal.timeout(1000) }); const body = await response.json(); ready = response.ok && body.value?.ready === true && body.value?.build?.version === '3.8.0'; } catch {}
      if (ready) break; await sleep(300);
    }
    if (!ready) throw fail('IOS_APPIUM_READY_TIMEOUT');
    await assertOwned(); onStage('private-appium-ready');
    return Object.freeze({ udid: marker.udid, serverUrl, deviceSetPath, derivedDataPath, wdaPort, mjpegPort,
      versions: Object.freeze({ appium: '3.8.0', xcuitest: '12.19.1', webdriveragent: '16.16.3', xcode: xcodeVersion, ios: target.platformVersion, runtimeId: target.runtimeId, deviceType: target.deviceType }),
      assertOwned: () => assertOwned(), capturedText: () => captured,
      async installApp(appPath) {
        if (!safePath(appPath) || !appPath.endsWith('.app') || !(await lstat(appPath)).isDirectory() || (await lstat(appPath)).isSymbolicLink()) throw fail('IOS_APP_INPUT_INVALID');
        await assertOwned(); live(); const result = await run('/usr/bin/xcrun', ownedSimctlArguments(marker, 'install', [await realpath(appPath)]), { timeoutMs: 120000 });
        if (result.code !== 0) throw fail('IOS_APP_INSTALL_FAILED'); return { installed: true };
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
    let code = /^IOS_[A-Z_]+$/.test(error.message) ? error.message : 'IOS_DEVICE_START_FAILED';
    try { await close(); } catch { code = 'IOS_DEVICE_CLEANUP_UNCONFIRMED'; }
    const result = fail(code); Object.defineProperty(result, 'capturedText', { value: () => captured }); throw result;
  }
}
