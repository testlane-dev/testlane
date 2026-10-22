/** Node-only process fixtures; no Simulator, native tools or external service. */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = await readFile(new URL('../device.mjs', import.meta.url), 'utf8');
function section(from, to) {
  assert.equal(source.split(from).length, 2, 'source start anchor must be unique');
  assert.equal(source.split(to).length, 2, 'source end anchor must be unique');
  const start = source.indexOf(from), end = source.indexOf(to);
  assert.ok(end > start); return source.slice(start, end);
}
const releaseSource = section('function releaseUnknownChildHandles(state) {', '\n/** Requires installed Xcode/runtime');
const launchSource = section('function launch(executable, args, { cwd, env, capture }) {', '\nasync function stop(state) {');
const groupSource = section('  async function stopOwnedGroups(ownedState) {', '\n  async function containerFile() {');
const closeSource = section('  const recover = async (reason, failures = []) => {', '\n  const abortLifecycle = () => {');
const fixed = code => new Error(code);
let fixtureStage = 'host-start';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fixed('FIXTURE_TIMEOUT')), ms); })]); }
  finally { clearTimeout(timer); }
}
function controlled(extra = {}, helperSource = releaseSource) {
  const context = { Error, Map, Promise, Date, setTimeout, clearTimeout, sleep, fail: fixed,
    waitClosed: async () => {}, processInfo: async () => null, run: async () => { throw fixed('UNEXPECTED_COMMAND'); },
    process: { pid: 1, kill: () => { throw fixed('UNEXPECTED_SIGNAL'); } }, stop: async () => { throw fixed('UNEXPECTED_STOP'); }, ...extra };
  return vm.runInNewContext(helperSource + '\n' + groupSource + '\n({releaseUnknownChildHandles, stopOwnedGroups})', context);
}

async function descendant(port, nonce, reportParent) {
  // Every fixture exits independently even if its test harness is interrupted.
  const deadline = setTimeout(() => process.exit(2), 15000);
  process.stdout.write('fixture-pipe-open\n'); process.stderr.write('fixture-pipe-open\n');
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('error', () => process.exit(2));
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(JSON.stringify({ nonce, status: 'ready' }) + '\n'));
  let input = '';
  socket.on('data', chunk => {
    input += chunk;
    if (input.length > 1024) process.exit(2);
    while (input.includes('\n')) {
      const index = input.indexOf('\n'), message = input.slice(0, index); input = input.slice(index + 1);
      if (message === 'ACK') { if (reportParent) process.send({ status: 'ready' }); }
      else if (message === 'STOP') { clearTimeout(deadline); socket.end(); process.exit(0); }
      else process.exit(2);
    }
  });
}

async function rootFixture(mode, port, nonce) {
  if (mode === 'live') return descendant(port, nonce, false);
  const deadline = setTimeout(() => process.exit(2), 5000);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-descendant', String(port), nonce],
    { shell: false, windowsHide: true, detached: true, env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('error', () => process.exit(2));
  child.once('message', message => {
    if (message?.status !== 'ready') process.exit(2);
    clearTimeout(deadline); child.unref(); process.exit(0);
  });
}

async function hostFixture(mode, port, nonce, withoutRelease) {
  const childFactory = vm.runInNewContext(launchSource + '\n({launch, waitClosed})', { spawn, Promise, setTimeout, clearTimeout });
  const state = childFactory.launch(process.execPath,
    [fileURLToPath(import.meta.url), '--fixture-root', mode, String(port), nonce], { cwd: process.cwd(), env: {}, capture: () => {} });
  if (!await state.started) throw fixed('FIXTURE_CHILD_START_FAILED');
  const proceed = new Promise(resolve => process.once('message', message => {
    if (message?.status !== 'proceed') process.exit(2); resolve();
  }));
  process.send({ status: 'started' }); await proceed;
  fixtureStage = 'root-exit';
  if (mode === 'exited' && !state.exited) await once(state.child, 'exit');
  fixtureStage = 'root-open-pipes';
  assert.equal(state.closed, false);
  const signals = []; let identities = 0;
  const context = { waitClosed: childFactory.waitClosed,
    process: { pid: process.pid, kill: (...args) => signals.push(args) },
    processInfo: async () => ({ pid: state.pid, ppid: process.pid, pgid: state.pid, started: ++identities === 1 ? 'initial' : 'changed', zombie: false }),
    run: async () => ({ code: 1, stdout: '' }) };
  const stopGroups = controlled(context, withoutRelease ? 'function releaseUnknownChildHandles() {}' : releaseSource).stopOwnedGroups;
  const began = performance.now(); let rejected;
  fixtureStage = 'group-stop';
  try { await stopGroups(state); } catch (error) { rejected = error; }
  fixtureStage = 'group-rejection';
  assert.equal(rejected?.message, 'IOS_PROCESS_STOP_UNCONFIRMED');
  const stored = state.treeStop;
  await assert.rejects(stopGroups(state), error => error === rejected);
  fixtureStage = 'stored-latch';
  assert.equal(state.treeStop, stored);
  if (mode === 'live') { assert.ok(performance.now() - began >= 4900); assert.deepEqual(signals.map(row => row[1]), ['SIGSTOP']); }
  else assert.equal(signals.length, 0);
  process.send({ status: 'rejected', code: rejected.message, waited: mode === 'live', closed: state.closed,
    exited: state.exited, latchRetained: state.treeStop === stored });
  process.disconnect(); process.exitCode = 23;
}

async function processFixture(mode, withoutRelease = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tld-local-handles-'));
  const nonce = randomBytes(24).toString('hex');
  let socket, host, server, hostClosed = false, socketClosed = false, hostStarted = false, acknowledged = false, input = '';
  const ready = Promise.withResolvers(), result = Promise.withResolvers(), hostDone = Promise.withResolvers();
  const socketDone = Promise.withResolvers();
  const cleanupErrors = [];
  try {
    server = createServer(connection => {
      if (socket) { connection.destroy(); ready.reject(fixed('FIXTURE_EXTRA_CONNECTION')); return; }
      socket = connection; socket.setEncoding('utf8'); socket.on('error', () => ready.reject(fixed('FIXTURE_SOCKET_FAILED')));
      socket.once('close', () => { socketClosed = true; socketDone.resolve(); });
      socket.on('data', chunk => {
        input += chunk;
        if (input.length > 1024) { ready.reject(fixed('FIXTURE_INPUT_LIMIT')); return; }
        if (!input.endsWith('\n')) return;
        try { assert.deepEqual(JSON.parse(input), { nonce, status: 'ready' }); }
        catch { ready.reject(fixed('FIXTURE_HANDSHAKE_FAILED')); return; }
        socket.write('ACK\n'); acknowledged = true; ready.resolve();
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
    host = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-host', mode, String(server.address().port), nonce, withoutRelease ? 'control' : 'release'],
      { cwd: root, shell: false, windowsHide: true, env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let outputBytes = 0;
    for (const stream of [host.stdout, host.stderr]) stream.on('data', bytes => { outputBytes += bytes.length; });
    host.once('error', () => { ready.reject(fixed('FIXTURE_HOST_START_FAILED')); result.reject(fixed('FIXTURE_HOST_START_FAILED')); });
    host.once('close', (code, signal) => { hostClosed = true; hostDone.resolve({ code, signal }); });
    host.on('message', message => {
      if (message?.status === 'started') { hostStarted = true; ready.promise.then(() => host.send({ status: 'proceed' })).catch(() => {}); }
      else if (message?.status === 'rejected') result.resolve(message);
      else if (message?.status === 'failed' && ['host-start', 'root-exit', 'root-open-pipes', 'group-stop', 'group-rejection', 'stored-latch'].includes(message.stage)) result.reject(fixed('FIXTURE_HOST_' + message.stage.toUpperCase().replaceAll('-', '_')));
      else result.reject(fixed('FIXTURE_HOST_MESSAGE_FAILED'));
    });
    await bounded(ready.promise, 5000);
    const fact = await bounded(result.promise, mode === 'live' ? 8000 : 3000);
    assert.equal(hostStarted && acknowledged, true); assert.equal(fact.code, 'IOS_PROCESS_STOP_UNCONFIRMED');
    assert.equal(fact.latchRetained, true); assert.equal(fact.waited, mode === 'live');
    if (withoutRelease) {
      await sleep(200); assert.equal(hostClosed, false, 'without release inherited pipes keep the host alive');
    } else {
      assert.deepEqual(await bounded(hostDone.promise, 2500), { code: 23, signal: null });
      assert.equal(socketClosed, false, 'host exit does not prove descendant termination');
    }
    assert.equal(outputBytes, 0, 'fixture emits no raw child or process output');
    assert.equal(fact.exited, mode === 'exited');
  } finally {
    if (socket && !socketClosed) {
      // This capability is the retained nonce-bound socket, never a reported PID.
      socket.write('STOP\n');
      try { await bounded(socketDone.promise, 2500); } catch { cleanupErrors.push('FIXTURE_SOCKET_STOP_UNCONFIRMED'); socket.destroy(); }
    }
    if (host && !hostClosed) {
      try { await bounded(hostDone.promise, 2500); }
      catch {
        cleanupErrors.push('FIXTURE_HOST_STOP_UNCONFIRMED');
        host.kill(); try { await bounded(hostDone.promise, 2500); } catch { cleanupErrors.push('FIXTURE_HOST_CLOSE_UNCONFIRMED'); }
      }
    }
    if (server) await bounded(new Promise(resolve => server.close(resolve)), 2500);
    if (!cleanupErrors.length) await rm(root, { recursive: true, force: true });
    assert.deepEqual(cleanupErrors, [], 'fixture cleanup uncertainty cannot pass');
  }
}

const mode = process.argv[2];
if (mode === '--fixture-descendant') await descendant(Number(process.argv[3]), process.argv[4], true);
else if (mode === '--fixture-root') await rootFixture(process.argv[3], Number(process.argv[4]), process.argv[5]);
else if (mode === '--fixture-host') {
  try { await hostFixture(process.argv[3], Number(process.argv[4]), process.argv[5], process.argv[6] === 'control'); }
  catch { if (process.connected) process.send({ status: 'failed', stage: fixtureStage }); process.disconnect?.(); process.exitCode = 2; }
} else {
  const test = (name, callback) => nodeTest(name, { timeout: 25000 }, callback);

  test('local release independently attempts every owned stream/ref and changes no lifecycle facts', () => {
    const calls = [], done = Promise.withResolvers();
    const child = Object.fromEntries(['stdin', 'stdout', 'stderr'].map(name => [name, { destroy() { calls.push(name); throw fixed('FIXTURE_HANDLE_FAILED'); } }]));
    child.unref = () => { calls.push('unref'); throw fixed('FIXTURE_HANDLE_FAILED'); };
    const state = { child, spawned: true, exited: false, closed: false, code: null, done: done.promise };
    const api = controlled(); api.releaseUnknownChildHandles(state); api.releaseUnknownChildHandles(state);
    assert.deepEqual(calls, ['stdin', 'stdout', 'stderr', 'unref', 'stdin', 'stdout', 'stderr', 'unref']);
    assert.equal(state.exited, false); assert.equal(state.closed, false); assert.equal(state.code, null); assert.equal(state.done, done.promise);
    assert.equal(Object.keys(state).length, 6);
  });

  test('terminal rejection waits for discovery, retains original failure and never starts another stop', async () => {
    let releases = 0, inspections = 0, queries = 0;
    const pending = Promise.withResolvers(), original = fixed('IOS_PROCESS_STOP_UNCONFIRMED');
    const state = { spawned: true, pid: 123, exited: false, closed: false,
      child: { stdin: { destroy: () => releases++ }, stdout: { destroy: () => releases++ }, stderr: { destroy: () => releases++ }, unref: () => releases++ } };
    const api = controlled({ fail: () => original, process: { pid: 456, kill: () => {} },
      processInfo: async () => ({ pid: 123, pgid: 123, ppid: 456, started: ++inspections === 1 ? 'initial' : 'changed', zombie: false }),
      run: async () => { queries++; return pending.promise; } });
    const first = api.stopOwnedGroups(state), stored = state.treeStop, second = api.stopOwnedGroups(state);
    await sleep(0); assert.equal(releases, 0); assert.equal(queries, 1); assert.equal(state.treeStop, stored);
    pending.resolve({ code: 1, stdout: '' });
    for (const attempt of [first, second]) await assert.rejects(attempt, error => error === original);
    assert.equal(releases, 4); assert.equal(inspections, 2);
    state.closed = true; state.exited = true; // A later real event cannot renew the stored terminal outcome.
    await assert.rejects(api.stopOwnedGroups(state), error => error === original);
    assert.equal(state.treeStop, stored); assert.equal(releases, 4); assert.equal(inspections, 2); assert.equal(queries, 1);
  });

  test('successful proven group teardown releases no child handles', async () => {
    let releases = 0;
    const state = { spawned: true, pid: 123, exited: false, closed: false,
      child: { stdin: { destroy: () => releases++ }, stdout: { destroy: () => releases++ }, stderr: { destroy: () => releases++ }, unref: () => releases++ } };
    const info = { pid: 123, pgid: 123, ppid: 456, started: 'initial', zombie: false };
    const api = controlled({ processInfo: async () => info, run: async () => ({ code: 1, stdout: '' }),
      process: { pid: 456, kill: (_, signal) => { if (signal === 'SIGKILL') { state.exited = true; state.closed = true; } } } });
    await api.stopOwnedGroups(state); assert.equal(releases, 0);
  });

  test('later local close leaves exact cleanup failed and preserves owned recovery/storage sentinels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tld-local-recovery-'));
    try {
      const names = ['native-store-sentinel', 'consumer-sentinel', 'recovery-sentinel'];
      const contents = randomBytes(24); await Promise.all(names.map(name => writeFile(path.join(root, name), contents)));
      const state = { commandKind: 'owned-wda-prebuild', spawned: true, pid: 123, exited: true, closed: false,
        child: { stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} }, unref() {} } };
      const calls = [], context = { Error, Map, Set, Promise, Date, setTimeout, clearTimeout, sleep, fail: fixed,
        waitClosed: async () => {}, signal: undefined, commands: new Set([state]), diagnosticTasks: new Set(), closing: undefined,
        diagnosticPolicy: {finishPrewarm() {}}, startupDiagnosticLease: undefined,
        diagnosticCleanupUncertain: false, commandStopUnconfirmed: false, wdaBuildIncomplete: true, appium: { spawned: false },
        path, writeFile, output: root, root, deviceSetPath: root, IOS_DEVICE_SCOPE: 'hosted-standard-device-set',
        marker: { udid: 'owned-fixture', name: 'owned-fixture', baselineSHA256: 'a'.repeat(64) },
        processInfo: async () => { calls.push('identity'); throw fixed('UNEXPECTED_COMMAND'); },
        run: async () => { calls.push('command'); throw fixed('UNEXPECTED_COMMAND'); },
        assertRoot: async () => { calls.push('root'); }, rm: async () => { calls.push('remove'); },
        stop: async () => { calls.push('ordinary-stop'); } };
      const api = vm.runInNewContext(releaseSource + '\n' + groupSource + '\n' + closeSource + '\n({stopOwnedGroups,close})', context);
      await assert.rejects(api.stopOwnedGroups(state), /IOS_PROCESS_STOP_UNCONFIRMED/);
      state.closed = true; // Simulate a later actual local close, not process-group absence.
      await assert.rejects(api.close(), /IOS_DEVICE_CLEANUP_UNCONFIRMED/);
      await assert.rejects(api.close(), /IOS_DEVICE_CLEANUP_UNCONFIRMED/);
      assert.deepEqual(calls, []); assert.equal(context.wdaBuildIncomplete, true);
      for (const name of names) assert.deepEqual(await readFile(path.join(root, name)), contents);
      const recovery = JSON.parse(await readFile(path.join(root, 'ios-device-recovery.json'), 'utf8'));
      assert.equal(recovery.reason, 'process-stop-unconfirmed'); assert.equal(recovery.status, 'manual-inspection-required');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('real exited root with inherited descendant pipes keeps no-release host alive', () => processFixture('exited', true));
  test('terminal unknown releases local handles so real inherited-pipe host exits nonzero before descendant', () => processFixture('exited'));
  test('real live-root no-release control retains its host after the five-second terminal wait', () => processFixture('live', true));
  test('real live-root final failure waits five seconds, releases handles and retains unknown outcome', () => processFixture('live'));
}
