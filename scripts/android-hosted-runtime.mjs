/** Ephemeral hosted Linux only. Never connects to the desktop session bus. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, lstat, mkdir, open, opendir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { requireHostedAndroid, hostedAndroidEnvironment } from './android-hosted-setup.mjs';
import { retainDetachedChild, stopRetainedGroup, confirmRetainedGroupAbsent } from '../examples/android-verification/process-group.mjs';
import { validateHostedRuntimeScanFact } from './android-hosted-failure.mjs';

const PREFIX = 'ANDROID_HOSTED_RUNTIME_';
const fail = code => new Error(PREFIX + code);
const MAX_CAPTURE = 8 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stages = new Set(['host-validation', 'private-runtime', 'bus-start', 'keyring-start', 'keyring-canary', 'proof', 'cleanup']);
const codes = new Set(['HOST_REFUSED', 'PATH_REFUSED', 'OWNERSHIP_REFUSED', 'PREREQUISITE_REFUSED', 'ABORTED',
  'START_FAILED', 'START_TIMEOUT', 'COMMAND_FAILED', 'COMMAND_TIMEOUT', 'OUTPUT_LIMIT', 'PROCESS_UNCONFIRMED',
  'CANARY_FAILED', 'PROOF_FAILED', 'PROOF_RECEIPT_REFUSED', 'LISTENER_UNCONFIRMED', 'STORAGE_UNCONFIRMED', 'LEAK_DETECTED', 'SCAN_TIMEOUT', 'FAILED']);
function fixedCode(error) {
  const code = String(error?.message ?? '').slice(PREFIX.length);
  return String(error?.message ?? '').startsWith(PREFIX) && codes.has(code) ? code : 'FAILED';
}
function checkAbort(signal) { if (signal?.aborted) throw fail('ABORTED'); }
export function retainedHostedServiceLive(state) {
  return state?.spawned === true && state.exited === false && state.closed === false && state.startError === false &&
    state.child?.exitCode === null && state.child?.signalCode === null;
}
export async function verifyHostedServiceOwners({ bus, keyring, queryPid, signal }) {
  const services = [['org.freedesktop.DBus',bus],['org.freedesktop.secrets',keyring]];
  const live = () => services.every(([,state]) => retainedHostedServiceLive(state));
  checkAbort(signal); if (!live()) throw fail('START_FAILED');
  for (const [name, state] of services) {
    const actual = await queryPid(name, signal);
    checkAbort(signal);
    if (!live() || actual !== state.pid) throw fail('START_FAILED');
  }
  return true;
}
function safePath(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value ||
      /[\0-\x20\x7f\\,&<>"']/.test(value)) throw fail('PATH_REFUSED');
  return value;
}
export function assertRuntimeSecretsAbsent(text, secrets) {
  if (typeof text !== 'string' || !Array.isArray(secrets)) throw fail('LEAK_DETECTED');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 24) throw fail('LEAK_DETECTED');
    const bytes = Buffer.from(secret);
    for (const value of new Set([secret, encodeURIComponent(secret), bytes.toString('base64'), bytes.toString('base64url')])) {
      if (text.includes(value)) throw fail('LEAK_DETECTED');
    }
  }
  return true;
}
const scanFacts = new WeakMap();
export const HOSTED_RUNTIME_SCAN_LIMITS = Object.freeze({ chunkBytes: 64 * 1024, totalBytes: 512 * 1024 * 1024, entriesPerTree: 10000, milliseconds: 30000 });
/** Fixed facts only; readers and secrets remain private to the trusted parent. */
export async function scanHostedRuntimeSecrets({ captured, overflow, readProofOutput, readPrivateRuntime, signal, now = () => performance.now() }, { unlock, canary }) {
  let scope = 'captured';
  try {
    if (overflow) throw fail('OUTPUT_LIMIT');
    const deadline = now() + HOSTED_RUNTIME_SCAN_LIMITS.milliseconds;
    let consumedBytes = 0;
    const control = Object.freeze({ buffer: Buffer.alloc(HOSTED_RUNTIME_SCAN_LIMITS.chunkBytes),
      checkpoint() { checkAbort(signal); if (now() >= deadline) throw fail('SCAN_TIMEOUT'); },
      ensureBytes(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > HOSTED_RUNTIME_SCAN_LIMITS.totalBytes - consumedBytes) throw fail('OUTPUT_LIMIT'); },
      takeBytes(bytes) { this.ensureBytes(bytes); consumedBytes += bytes; },
    });
    control.checkpoint();
    const variants = [];
    for (const [secret, value] of [['unlock',unlock],['canary',canary]]) {
      if (typeof value !== 'string' || value.length < 24) throw fail('LEAK_DETECTED');
      const bytes = Buffer.from(value), seen = new Set();
      for (const [encoding, encoded] of [['raw',value],['uri',encodeURIComponent(value)],['base64',bytes.toString('base64')],['base64url',bytes.toString('base64url')]]) {
        if (!seen.has(encoded)) { seen.add(encoded); variants.push({secret,encoding,encoded}); }
      }
    }
    const retain = Math.max(...variants.map(row => row.encoded.length)) - 1;
    let tail = '', tailScopes = [];
    const inspect = text => {
      if (typeof text !== 'string') throw fail('LEAK_DETECTED');
      const recordMatch = (row, matchedScope) => {
        const error = fail('LEAK_DETECTED');
        scanFacts.set(error, validateHostedRuntimeScanFact({scope:matchedScope,kind:'match',code:'LEAK_DETECTED',secret:row.secret,encoding:row.encoding}));
        throw error;
      };
      for (const row of variants) if (text.includes(row.encoded)) recordMatch(row, scope);
      // Preserve matches spanning the old concatenation without building a
      // second full aggregate: at most two encoded-secret lengths are copied.
      const boundary = tail + text.slice(0, retain);
      for (const row of variants) {
        const start = boundary.indexOf(row.encoded); if (start < 0) continue;
        const end = start + row.encoded.length, sources = new Set(); let offset = 0;
        for (const part of [...tailScopes,{scope,length:Math.min(text.length,retain)}]) {
          if (offset < end && offset + part.length > start) sources.add(part.scope);
          offset += part.length;
        }
        recordMatch(row, sources.size > 1 ? 'combined-boundary' : [...sources][0]);
      }
      tail = text.length >= retain ? text.slice(-retain) : (tail + text).slice(-retain);
      if (text.length) {
        if (tailScopes.at(-1)?.scope === scope) tailScopes.at(-1).length += text.length;
        else tailScopes.push({scope,length:text.length});
      }
      let trim = tailScopes.reduce((total,part) => total + part.length, 0) - tail.length;
      while (trim > 0) { const removed = Math.min(trim,tailScopes[0].length); tailScopes[0].length -= removed; trim -= removed; if (!tailScopes[0].length) tailScopes.shift(); }
    };
    const inspectText = (text, countBytes = true) => {
      if (typeof text !== 'string') throw fail('LEAK_DETECTED');
      if (countBytes) control.takeBytes(Buffer.byteLength(text));
      for (let offset = 0; offset < text.length; offset += HOSTED_RUNTIME_SCAN_LIMITS.chunkBytes) {
        control.checkpoint(); inspect(text.slice(offset, offset + HOSTED_RUNTIME_SCAN_LIMITS.chunkBytes));
      }
    };
    if (typeof captured !== 'string') throw fail('LEAK_DETECTED');
    if (Buffer.byteLength(captured) > MAX_CAPTURE) throw fail('OUTPUT_LIMIT');
    inspectText(captured);
    for (const [name, reader] of [['proof-output',readProofOutput],['private-runtime',readPrivateRuntime]]) {
      scope = name; control.checkpoint(); const input = await reader(control); control.checkpoint();
      if (typeof input === 'string') { inspectText(input); continue; }
      if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw fail('STORAGE_UNCONFIRMED');
      const iterator = input[Symbol.asyncIterator](); let primary;
      try {
        for (;;) {
          control.checkpoint(); const result = await iterator.next(); control.checkpoint();
          if (result.done) break;
          if (typeof result.value !== 'string' || result.value.length > HOSTED_RUNTIME_SCAN_LIMITS.chunkBytes + 3) throw fail('OUTPUT_LIMIT');
          inspectText(result.value, false);
        }
      } catch (error) { primary = error; throw error; }
      finally {
        let closeError; try { control.checkpoint(); } catch (error) { closeError = error; }
        try { await iterator.return?.(); } catch (error) { closeError ??= error; }
        try { control.checkpoint(); } catch (error) { closeError ??= error; }
        if (!primary && closeError) throw closeError;
      }
    }
    control.checkpoint();
    return true;
  } catch (error) {
    if (scanFacts.has(error)) throw error;
    const observed = fixedCode(error), code = ['OUTPUT_LIMIT','STORAGE_UNCONFIRMED','OWNERSHIP_REFUSED','LEAK_DETECTED','SCAN_TIMEOUT','ABORTED'].includes(observed) ? observed : 'FAILED';
    const wrapped = fail(code);
    scanFacts.set(wrapped, validateHostedRuntimeScanFact({scope,kind:'incomplete',code}));
    throw wrapped;
  }
}

/** Pure sequencing seam for unit tests; it grants no process or filesystem authority. */
export async function exerciseHostedSecretService(ops, { signal, onStage = () => {} } = {}) {
  let stage = 'private-runtime', primary, proofExitCode = null, attempted = false, canaryRemoved = false;
  let privateBusStopped = false, keyringStopped = false, processGroupsAbsent = false, listenersAbsent = false;
  let scanPassed = false, runtimeStorageRemoved = false, scanFact;
  const at = name => { stage = name; onStage(name); };
  try {
    checkAbort(signal);
    at('bus-start'); await ops.startBus(signal);
    at('keyring-start'); await ops.startKeyring(signal);
    at('keyring-canary'); attempted = true;
    await ops.storeCanary(signal);
    await ops.lookupCanary(signal);
    await ops.removeCanary(); canaryRemoved = true;
    checkAbort(signal);
    at('proof'); proofExitCode = await ops.runProof(signal);
    if (proofExitCode !== 0) throw fail('PROOF_FAILED');
    checkAbort(signal);
    await ops.verifyProof();
    checkAbort(signal);
  } catch (error) { primary = { stage, code: fixedCode(error) }; }
  finally {
    at('cleanup');
    // A timed-out mutation is never reconciled by an immediate absence check.
    if (attempted && !canaryRemoved && !ops.uncertain()) {
      try { await ops.removeCanary(); canaryRemoved = true; } catch { /* Incomplete below. */ }
    }
    try { await ops.stopCommands(); } catch { primary ??= { stage, code: 'PROCESS_UNCONFIRMED' }; }
    try { await ops.stopKeyring(); keyringStopped = true; } catch { primary ??= { stage, code: 'PROCESS_UNCONFIRMED' }; }
    try { await ops.stopBus(); privateBusStopped = true; } catch { primary ??= { stage, code: 'PROCESS_UNCONFIRMED' }; }
    try { await ops.confirmGroupsAbsent(); processGroupsAbsent = true; } catch { primary ??= { stage, code: 'PROCESS_UNCONFIRMED' }; }
    try { await ops.confirmListenersAbsent(); listenersAbsent = true; } catch { primary ??= { stage, code: 'LISTENER_UNCONFIRMED' }; }
    try { await ops.scan(); scanPassed = true; } catch (error) { scanFact = scanFacts.get(error); primary ??= { stage, code: 'LEAK_DETECTED' }; }
    if (signal?.aborted) primary ??= { stage, code: 'ABORTED' };
    if (!primary && !ops.uncertain() && privateBusStopped && keyringStopped && processGroupsAbsent &&
        listenersAbsent && scanPassed && canaryRemoved && proofExitCode === 0) {
      try { await ops.removeStorage(); runtimeStorageRemoved = true; }
      catch { primary = { stage, code: 'STORAGE_UNCONFIRMED' }; }
    }
  }
  if (signal?.aborted) primary ??= { stage: 'cleanup', code: 'ABORTED' };
  if (!primary && runtimeStorageRemoved) return Object.freeze({
    schemaVersion: 1, privateBusStopped, keyringStopped, processGroupsAbsent,
    runtimeStorageRemoved, canaryRemoved, unlockSecretLeakScanPassed: scanPassed, proofExitCode,
  });
  const failure = Object.freeze({ schemaVersion: 1, purpose: 'fixed-hosted-runtime-failure', stage: primary?.stage ?? 'cleanup',
    code: primary?.code ?? 'STORAGE_UNCONFIRMED', proofExitCode, recoveryRetained: !runtimeStorageRemoved,
    ...(scanFact ? {scanFact} : {}) });
  await ops.writeFailure(failure);
  throw fail(failure.code);
}

async function privateDirectory(directory, uid) {
  if (await realpath(directory) !== directory) throw fail('OWNERSHIP_REFUSED');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077)) throw fail('OWNERSHIP_REFUSED');
}
async function ordinaryFile(file, maximum = 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw fail('OWNERSHIP_REFUSED');
  return readFile(file);
}
async function absent(file) {
  try { await lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function socketAbsent(file) {
  // Connecting after all original groups are absent is a read-only listener probe.
  await new Promise((resolve, reject) => {
    const client = createConnection({ path: file });
    const done = error => { clearTimeout(timer); client.destroy(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => done(fail('LISTENER_UNCONFIRMED')), 1500);
    client.once('connect', () => done(fail('LISTENER_UNCONFIRMED')));
    client.once('error', error => done(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? undefined : fail('LISTENER_UNCONFIRMED')));
  });
}
async function walkOwned(root, uid) {
  const sockets = []; let count = 0;
  async function walk(file) {
    if (++count > 10000) throw fail('STORAGE_UNCONFIRMED');
    const info = await lstat(file);
    if (info.isSymbolicLink() || info.uid !== uid) throw fail('STORAGE_UNCONFIRMED');
    if (info.isDirectory()) {
      // Privacy is enforced at the canonical outer 0700 boundary. npm and GNOME
      // may create ordinary 0755 descendants; they remain inside that boundary.
      for (const name of await readdir(file)) await walk(path.join(file, name));
    } else if (info.isSocket()) sockets.push(file);
    else if (!info.isFile()) throw fail('STORAGE_UNCONFIRMED');
  }
  await walk(root);
  return { sockets };
}
/** Complete bounded inventory; the caller binds roots and supplies one shared byte/deadline control. */
export async function* streamHostedRuntimeScanTree(root, uid, control) {
  let entries = 1;
  const checked = async action => { control.checkpoint(); const result = await action(); control.checkpoint(); return result; };
  const same = (left, right) => ['dev','ino','uid','size','mtimeNs','ctimeNs'].every(key => left[key] === right[key]);
  const canonical = async file => { if (await checked(() => realpath(file)) !== file) throw fail('STORAGE_UNCONFIRMED'); };
  async function closeOwned(handle, primary) {
    let failure; try { control.checkpoint(); } catch (error) { failure = error; }
    try { await handle.close(); } catch (error) { failure ??= error; }
    try { control.checkpoint(); } catch (error) { failure ??= error; }
    if (!primary && failure) throw failure;
  }
  async function* visit(file) {
    await canonical(file);
    const before = await checked(() => lstat(file, {bigint:true}));
    if (before.isSymbolicLink() || before.uid !== BigInt(uid)) throw fail('STORAGE_UNCONFIRMED');
    if (before.isDirectory()) {
      control.checkpoint(); const directory = await opendir(file, {bufferSize:32,encoding:'buffer'}); let primary;
      try {
        control.checkpoint();
        const names = [];
        for (;;) {
          const item = await checked(() => directory.read()); if (!item) break;
          if (++entries > HOSTED_RUNTIME_SCAN_LIMITS.entriesPerTree) throw fail('OUTPUT_LIMIT');
          if (!Buffer.isBuffer(item.name)) throw fail('STORAGE_UNCONFIRMED');
          const name = item.name.toString('utf8');
          if (!Buffer.from(name).equals(item.name) || path.basename(name) !== name || name === '.' || name === '..') throw fail('STORAGE_UNCONFIRMED');
          names.push({name,bytes:item.name});
        }
        names.sort((left,right) => Buffer.compare(left.bytes,right.bytes));
        for (const {name} of names) yield* visit(path.join(file, name));
        await canonical(file);
        if (!same(before, await checked(() => lstat(file, {bigint:true})))) throw fail('STORAGE_UNCONFIRMED');
      } catch (error) { primary = error; throw error; }
      finally { await closeOwned(directory, primary); }
    } else if (before.isFile()) {
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('OUTPUT_LIMIT');
      control.ensureBytes(Number(before.size));
      control.checkpoint(); const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); let primary;
      try {
        control.checkpoint();
        const opened = await checked(() => handle.stat({bigint:true}));
        if (!opened.isFile() || !same(before, opened)) throw fail('STORAGE_UNCONFIRMED');
        const decoder = new StringDecoder('utf8'); let offset = 0;
        for (;;) {
          const result = await checked(() => handle.read(control.buffer, 0, control.buffer.length, offset));
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > control.buffer.length) throw fail('STORAGE_UNCONFIRMED');
          if (!result.bytesRead) break;
          control.takeBytes(result.bytesRead); offset += result.bytesRead;
          if (BigInt(offset) > opened.size) throw fail('STORAGE_UNCONFIRMED');
          yield decoder.write(control.buffer.subarray(0, result.bytesRead));
        }
        await canonical(file);
        const after = await checked(() => lstat(file, {bigint:true})), end = await checked(() => handle.stat({bigint:true}));
        if (!after.isFile() || after.isSymbolicLink() || !same(opened, after) || !same(opened, end) || BigInt(offset) !== opened.size) throw fail('STORAGE_UNCONFIRMED');
        yield decoder.end() + '\n';
      } catch (error) { primary = error; throw error; }
      finally { await closeOwned(handle, primary); }
    } else if (!before.isSocket()) throw fail('STORAGE_UNCONFIRMED');
  }
  yield* visit(root);
}

export async function runHostedAndroidRuntime({ root, proofOutput, signal, onStage = () => {} }) {
  checkAbort(signal);
  onStage('host-validation');
  try { requireHostedAndroid({ osRelease: process.platform === 'linux' ? await readFile('/etc/os-release', 'utf8') : '' }); }
  catch { throw fail('HOST_REFUSED'); }
  const uid = process.getuid(), envInput = process.env;
  const runnerTemp = safePath(await realpath(envInput.RUNNER_TEMP));
  const expected = path.join(runnerTemp, 'testlane-android-' + envInput.GITHUB_RUN_ID + '-' + envInput.GITHUB_RUN_ATTEMPT);
  if (safePath(root) !== expected) throw fail('PATH_REFUSED');
  const repo = safePath(await realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const workspace = safePath(await realpath(envInput.GITHUB_WORKSPACE));
  if (workspace !== repo || safePath(proofOutput) !== path.join(workspace, 'output/android-proof') || !(await absent(proofOutput))) throw fail('PATH_REFUSED');
  const outputParent = path.dirname(proofOutput), outputParentInfo = await lstat(outputParent);
  if (await realpath(outputParent) !== outputParent || !outputParentInfo.isDirectory() || outputParentInfo.isSymbolicLink() ||
      outputParentInfo.uid !== uid || (outputParentInfo.mode & 0o022)) throw fail('OWNERSHIP_REFUSED');
  await privateDirectory(root, uid);
  const markerFile = path.join(root, 'testlane-hosted-android.json'), markerBytes = await ordinaryFile(markerFile, 32768);
  const marker = JSON.parse(markerBytes);
  if (Object.keys(marker).sort().join() !== ['schemaVersion','purpose','nonce','runId','runAttempt','root'].sort().join() ||
      marker.schemaVersion !== 1 || marker.purpose !== 'ephemeral-hosted-android-proof' || !/^[a-f0-9]{24}$/.test(marker.nonce) ||
      marker.root !== root || marker.runId !== envInput.GITHUB_RUN_ID || marker.runAttempt !== envInput.GITHUB_RUN_ATTEMPT) throw fail('OWNERSHIP_REFUSED');
  const java = safePath(await realpath(envInput.JAVA_HOME_21_X64)), node = safePath(await realpath(process.execPath));
  const npm = safePath(await realpath(path.join(path.dirname(node), 'npm')));
  if (!npm.endsWith('/node_modules/npm/bin/npm-cli.js')) throw fail('PREREQUISITE_REFUSED');
  for (const entry of ['/usr/bin/dbus-daemon','/usr/bin/dbus-send','/usr/bin/gnome-keyring-daemon','/usr/bin/secret-tool',
    path.join(java, 'bin/java'), path.join(java, 'bin/javac')]) await access(entry, constants.X_OK);
  const sdk = path.join(root, 'sdk'), tools = path.join(root, 'tools'), apk = path.join(root, 'build/testlane-android-proof.apk');
  for (const directory of [sdk, tools, path.join(root, 'build')]) await privateDirectory(directory, uid);
  const apkInfo = await lstat(apk);
  if (!apkInfo.isFile() || apkInfo.isSymbolicLink() || apkInfo.size > 512 * 1024 * 1024) throw fail('PREREQUISITE_REFUSED');
  checkAbort(signal);
  const privateRoot = path.join(root, 'secret-service');
  const socket = path.join(privateRoot, 'bus');
  if (Buffer.byteLength(socket) > 100) throw fail('PATH_REFUSED');
  await mkdir(privateRoot, { mode: 0o700 }); await privateDirectory(privateRoot, uid);
  const nonce = randomBytes(12).toString('hex'), unlock = randomBytes(48).toString('base64url'), canary = randomBytes(48).toString('base64url');
  const privateMarker = JSON.stringify({ schemaVersion: 1, purpose: 'owned-hosted-secret-service', nonce, parentNonce: marker.nonce,
    ownerPid: process.pid, runId: marker.runId, runAttempt: marker.runAttempt, root: privateRoot });
  const privateMarkerFile = path.join(privateRoot, 'owner.json');
  await writeFile(privateMarkerFile, privateMarker, { flag: 'wx', mode: 0o600 });
  const baseEnv = hostedAndroidEnvironment({ root: privateRoot, sdk, java, node });
  for (const name of ['home','tmp','cache','config','data','android','control','run','proof-temp']) await mkdir(path.join(privateRoot, name), { mode: 0o700 });
  const env = Object.freeze({ ...baseEnv, XDG_RUNTIME_DIR: path.join(privateRoot, 'run'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + socket,
    DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=' + socket,
    GNOME_KEYRING_CONTROL: path.join(privateRoot, 'control'), GIO_USE_VFS: 'local', GSETTINGS_BACKEND: 'memory' });
  const proofEnv = Object.freeze({ ...env, TMPDIR: path.join(privateRoot, 'proof-temp'), TMP: path.join(privateRoot, 'proof-temp'),
    TEMP: path.join(privateRoot, 'proof-temp'), npm_execpath: npm, npm_config_cache: path.join(privateRoot, 'cache/npm'),
    NODE_DISABLE_COMPILE_CACHE: '1', TESTLANE_REAL_KEYCHAIN: '1', TESTLANE_ANDROID_PROOF_CI: '1', GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_RUN_ID: marker.runId, GITHUB_RUN_ATTEMPT: marker.runAttempt });
  const config = '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n' +
    '<busconfig><type>session</type><listen>unix:path=' + socket + '</listen><auth>EXTERNAL</auth>' +
    '<policy context="default"><deny user="*"/><allow user="' + uid + '"/></policy>' +
    '<policy user="' + uid + '"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>\n';
  const configFile = path.join(privateRoot, 'bus.conf');
  await writeFile(configFile, config, { flag: 'wx', mode: 0o600 });
  let captured = '', overflow = false, uncertain = false, bus, keyring;
  const retained = [], commands = new Set();
  const append = chunk => {
    if (Buffer.byteLength(captured) + chunk.length > MAX_CAPTURE) overflow = true;
    else captured += chunk.toString('utf8');
  };
  async function assertOwned() {
    await privateDirectory(root, uid); await privateDirectory(privateRoot, uid);
    if (!(await ordinaryFile(markerFile, 32768)).equals(markerBytes) ||
        (await ordinaryFile(privateMarkerFile, 32768)).toString() !== privateMarker) throw fail('OWNERSHIP_REFUSED');
  }
  function launch(entry, args, { input, childEnv = env, lookup = false } = {}) {
    const child = spawn(entry, args, { cwd: repo, env: childEnv, detached: true, shell: false, stdio: ['pipe','pipe','pipe'] });
    const state = retainDetachedChild(child); retained.push(state);
    let stdout = '', stderr = '', bytes = 0;
    const collect = (chunk, isOut) => {
      bytes += chunk.length;
      if (bytes > MAX_CAPTURE) overflow = true;
      else if (isOut) stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      // Expected canary lookup output is private delivery, not retained diagnostics.
      if (!(lookup && isOut)) append(chunk);
    };
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false));
    child.stdin.on('error', () => {}); child.stdin.end(input);
    return { state, result: () => ({ code: state.code, stdout, stderr }) };
  }
  async function command(entry, args, { input, activeSignal, milliseconds = 15000, lookup = false, childEnv } = {}) {
    checkAbort(activeSignal); await assertOwned();
    checkAbort(activeSignal);
    const item = launch(entry, args, { input, lookup, childEnv }); commands.add(item.state);
    const deadline = performance.now() + milliseconds;
    try {
      while (!item.state.closed) {
        if (activeSignal?.aborted || overflow || performance.now() >= deadline) {
          uncertain = true;
          try { await stopRetainedGroup(item.state); } catch { throw fail('PROCESS_UNCONFIRMED'); }
          throw fail(activeSignal?.aborted ? 'ABORTED' : overflow ? 'OUTPUT_LIMIT' : 'COMMAND_TIMEOUT');
        }
        await sleep(25);
      }
      confirmRetainedGroupAbsent(item.state); commands.delete(item.state);
      if (item.state.startError) throw fail('START_FAILED');
      if (overflow) throw fail('OUTPUT_LIMIT');
      return item.result();
    } catch (error) {
      if (error?.message === 'ANDROID_PROCESS_TERMINATION_UNCONFIRMED') { uncertain = true; throw fail('PROCESS_UNCONFIRMED'); }
      throw error;
    }
  }
  async function pidFor(name, activeSignal) {
    const result = await command('/usr/bin/dbus-send', ['--session','--print-reply','--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus','org.freedesktop.DBus.GetConnectionUnixProcessID','string:' + name], { activeSignal, milliseconds: 2000 });
    const match = /^\s*method return [^\n]*\n\s*uint32 ([1-9][0-9]*)\s*$/.exec(result.stdout);
    return result.code === 0 && !result.stderr && match ? Number(match[1]) : null;
  }
  async function health(activeSignal) {
    return verifyHostedServiceOwners({ bus: bus?.state, keyring: keyring?.state, queryPid: pidFor, signal: activeSignal });
  }
  async function waitReady(item, name, activeSignal) {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      checkAbort(activeSignal);
      if (overflow) throw fail('OUTPUT_LIMIT');
      if (item.state.closed || item.state.exited || item.state.startError || item.state.child.exitCode !== null || item.state.child.signalCode !== null) throw fail('START_FAILED');
      if (item.state.spawned) {
        const actual = await pidFor(name, activeSignal);
        checkAbort(activeSignal);
        if (!retainedHostedServiceLive(item.state)) throw fail('START_FAILED');
        if (actual === item.state.pid) return;
      }
      await sleep(100);
    }
    throw fail('START_TIMEOUT');
  }
  const ops = {
    uncertain: () => uncertain,
    startBus: async activeSignal => {
      await assertOwned(); checkAbort(activeSignal);
      bus = launch('/usr/bin/dbus-daemon', ['--nofork','--nopidfile','--nosyslog','--config-file=' + configFile]);
      await waitReady(bus, 'org.freedesktop.DBus', activeSignal);
    },
    startKeyring: async activeSignal => {
      await assertOwned(); checkAbort(activeSignal);
      keyring = launch('/usr/bin/gnome-keyring-daemon',
        ['--foreground','--unlock','--components=secrets','--control-directory=' + path.join(privateRoot, 'control')], { input: unlock });
      await waitReady(keyring, 'org.freedesktop.secrets', activeSignal);
    },
    storeCanary: async activeSignal => {
      await health(activeSignal);
      const result = await command('/usr/bin/secret-tool', ['store','--label=Testlane-hosted-canary','testlane_scope',nonce],
        { input: canary, activeSignal });
      if (result.code !== 0 || result.stdout || result.stderr) throw fail('CANARY_FAILED');
    },
    lookupCanary: async activeSignal => {
      const result = await command('/usr/bin/secret-tool', ['lookup','testlane_scope',nonce], { activeSignal, lookup: true });
      if (result.code !== 0 || result.stdout !== canary || result.stderr) {
        append(Buffer.from(result.stdout)); throw fail('CANARY_FAILED');
      }
      await health(activeSignal);
    },
    removeCanary: async () => {
      const cleared = await command('/usr/bin/secret-tool', ['clear','testlane_scope',nonce]);
      const missing = await command('/usr/bin/secret-tool', ['lookup','testlane_scope',nonce]);
      if (cleared.code !== 0 || cleared.stdout || cleared.stderr || missing.code !== 1 || missing.stdout || missing.stderr) throw fail('CANARY_FAILED');
      await health();
    },
    runProof: async activeSignal => {
      await health(activeSignal);
      const result = await command(node, [path.join(repo, 'scripts/android-proof.mjs'), '--apk', apk, '--output-dir', proofOutput,
        '--tools-root', tools, '--sdk-root', sdk, '--java-home', java, '--system-image', path.join(sdk, 'system-images/android-34/google_apis/x86_64')],
      { childEnv: proofEnv, activeSignal, milliseconds: 40 * 60 * 1000 });
      await health(activeSignal); return result.code;
    },
    verifyProof: async () => {
      const receipt = JSON.parse(await ordinaryFile(path.join(proofOutput, 'receipt.json')));
      if (receipt.passed !== true || receipt.cleanupVerified !== true || receipt.credentialLeakScanPassed !== true ||
          receipt.nativeStore !== 'secret-service') throw fail('PROOF_RECEIPT_REFUSED');
      if ((await readdir(path.join(privateRoot, 'proof-temp'))).length) throw fail('STORAGE_UNCONFIRMED');
    },
    stopCommands: async () => {
      const results = await Promise.allSettled([...commands].map(state => stopRetainedGroup(state)));
      if (results.some(item => item.status !== 'fulfilled')) { uncertain = true; throw fail('PROCESS_UNCONFIRMED'); }
    },
    stopKeyring: async () => { if (keyring) await stopRetainedGroup(keyring.state); },
    stopBus: async () => { if (bus) await stopRetainedGroup(bus.state); },
    confirmGroupsAbsent: async () => { for (const state of retained) confirmRetainedGroupAbsent(state); },
    confirmListenersAbsent: async () => {
      await assertOwned();
      const { sockets } = await walkOwned(privateRoot, uid);
      for (const file of new Set([socket, ...sockets])) await socketAbsent(file);
    },
    scan: async () => {
      await scanHostedRuntimeSecrets({ captured, overflow, signal,
        readProofOutput: async control => await absent(proofOutput) ? '' : streamHostedRuntimeScanTree(proofOutput, uid, control),
        readPrivateRuntime: control => streamHostedRuntimeScanTree(privateRoot, uid, control) }, {unlock,canary});
    },
    removeStorage: async () => {
      await assertOwned();
      if (uncertain || (await readdir(path.join(privateRoot, 'proof-temp'))).length) throw fail('STORAGE_UNCONFIRMED');
      await walkOwned(privateRoot, uid);
      await rm(privateRoot, { recursive: true, force: false });
      if (!(await absent(privateRoot))) throw fail('STORAGE_UNCONFIRMED');
    },
    writeFailure: async failure => {
      if (await absent(proofOutput)) await mkdir(proofOutput, { mode: 0o700 });
      await privateDirectory(proofOutput, uid);
      await writeFile(path.join(proofOutput, 'linux-runtime-failure.json'), JSON.stringify(failure, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    },
  };
  onStage('private-runtime');
  const receipt = await exerciseHostedSecretService(ops, { signal, onStage });
  await privateDirectory(proofOutput, uid);
  checkAbort(signal);
  await writeFile(path.join(proofOutput, 'linux-runtime-cleanup.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  checkAbort(signal);
  return receipt;
}

function isEntry() { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isEntry()) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    if (process.argv.length !== 4) throw fail('PATH_REFUSED');
    await runHostedAndroidRuntime({ root: process.argv[2], proofOutput: process.argv[3], signal: controller.signal,
      onStage: stage => { if (stages.has(stage)) console.log('ANDROID_HOSTED_RUNTIME_STAGE ' + stage); } });
  } catch (error) { console.error(PREFIX + fixedCode(error)); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
