import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { confirmRetainedGroupAbsent, createRetainedProcessGroupLifecycle, linuxGroupExists,
  parseLinuxProcessIdentity, requireRetainedProcessGroupHost, stopRetainedGroup } from '../process-group.mjs';

const ownerPid = 101, pid = 202;
const identity = () => ({ pid, ppid: ownerPid, pgid: pid, sid: pid, start: '123456', zombie: false });
const refused = error => error instanceof Error && error.message === 'ANDROID_PROCESS_TERMINATION_UNCONFIRMED';
function fixture(options = {}) {
  const child = new EventEmitter(); child.pid = pid;
  const released = [];
  for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = { destroy() { released.push(stream); } };
  child.unref = () => released.push('unref');
  const world = { now: 0, exists: true, identity: identity(), signals: [], released, afterSleep: undefined };
  const operations = {
    readIdentity: () => options.readIdentity ? options.readIdentity(world) : world.identity,
    groupExists: group => { assert.equal(group, pid); return options.groupExists ? options.groupExists(world) : world.exists; },
    signalGroup: (group, signal) => { assert.equal(group, pid); world.signals.push(signal); options.onSignal?.(signal, world, child); },
    now: () => world.now,
    sleep: async ms => { assert.ok(ms > 0 && ms <= 25); world.now += ms; world.afterSleep?.(world, child); },
  };
  const lifecycle = createRetainedProcessGroupLifecycle({ platform: 'linux', ownerPid, operations });
  const state = lifecycle.retainDetachedChild(child);
  const spawn = () => child.emit('spawn');
  const close = () => { child.emit('exit', 0); child.emit('close', 0); };
  return { child, world, state, spawn, close, lifecycle };
}

test('Linux stat parser binds PID/parent/group/session/start without retaining process text', () => {
  const name = randomBytes(18).toString('hex');
  const fields = ['S', '101', '202', '202', ...Array(15).fill('0'), '123456', '0'];
  const actual = parseLinuxProcessIdentity('202 (' + name + ' ) bracket) ' + fields.join(' '), pid);
  assert.deepEqual(actual, identity()); assert.equal(Object.isFrozen(actual), true);
  assert.equal(JSON.stringify(actual).includes(name), false);
  for (const text of ['203 (x) ' + fields.join(' '), '202 (x) S 101 202', '202 (x) ' + fields.map((value, index) => index === 19 ? 'not-a-start' : value).join(' ')]) {
    assert.throws(() => parseLinuxProcessIdentity(text, pid), refused);
  }
});

test('negative-group absence accepts ESRCH only; EPERM and unknown failures stay unknown', () => {
  const seen = [];
  assert.equal(linuxGroupExists(pid, (group, signal) => { seen.push([group, signal]); }), true);
  assert.equal(linuxGroupExists(pid, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  for (const code of ['EPERM', 'EACCES', undefined]) assert.throws(() => linuxGroupExists(pid, () => { throw Object.assign(new Error(), { code }); }), refused);
  assert.deepEqual(seen, [[-pid, 0]]);
});

test('closed parent and pipes with a live descendant group never confirm or receive guessed signals', async () => {
  const f = fixture(); f.spawn(); f.close(); f.world.identity = undefined;
  assert.throws(() => confirmRetainedGroupAbsent(f.state), refused);
  await assert.rejects(stopRetainedGroup(f.state), refused);
  assert.deepEqual(f.world.signals, []); assert.equal(f.world.now, 6500);
  assert.deepEqual(f.world.released, ['stdin', 'stdout', 'stderr', 'unref']);
  f.world.exists = false;
  assert.throws(() => confirmRetainedGroupAbsent(f.state), refused, 'uncertainty cannot later be silently reclassified');
});

test('short command whose metadata capture raced exit can retire only after close and group absence', async () => {
  const f = fixture({ readIdentity: () => undefined }); f.spawn(); f.close(); f.world.exists = false;
  assert.equal(confirmRetainedGroupAbsent(f.state), true);
  assert.equal(await stopRetainedGroup(f.state), true); assert.deepEqual(f.world.signals, []); assert.equal(f.world.now, 0);
});

test('live leader receives group TERM and success requires both child close and absence', async () => {
  const f = fixture({ onSignal(signal, world, child) {
    if (signal === 'SIGTERM') { world.exists = false; child.emit('exit', 0); child.emit('close', 0); }
  } });
  f.spawn();
  assert.equal(await stopRetainedGroup(f.state), true); assert.deepEqual(f.world.signals, ['SIGTERM']);
  assert.equal(confirmRetainedGroupAbsent(f.state), true); assert.deepEqual(f.world.released, []);
});

test('KILL escalation requires the still-live original leader and stays inside the existing stop ceiling', async () => {
  const f = fixture({ onSignal(signal, world, child) {
    if (signal === 'SIGKILL') { world.exists = false; child.emit('exit', null); child.emit('close', null); }
  } }); f.spawn();
  assert.equal(await stopRetainedGroup(f.state), true);
  assert.deepEqual(f.world.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.world.now, 1500);
});

test('leader loss during grace never grants KILL authority over surviving or reused group', async () => {
  const f = fixture({ onSignal(signal, world, child) {
    if (signal === 'SIGTERM') { child.emit('exit', 0); child.emit('close', 0); world.identity = { ...identity(), start: '987654' }; }
  } }); f.spawn();
  await assert.rejects(stopRetainedGroup(f.state), refused);
  assert.deepEqual(f.world.signals, ['SIGTERM']); assert.equal(f.world.now, 6500);
});

test('PID/parent/group/session/start mismatch and zombies refuse signal authority', async () => {
  for (const mutation of [{ pid: 303 }, { ppid: 303 }, { pgid: 303 }, { sid: 303 }, { start: '987654' }, { zombie: true }]) {
    const f = fixture(); f.spawn(); f.world.identity = { ...identity(), ...mutation };
    await assert.rejects(stopRetainedGroup(f.state, { graceMs: 0 }), refused);
    assert.deepEqual(f.world.signals, []); assert.equal(f.world.now, 5000);
  }
});

test('permission/inspection failure is fixed and does not fall back to child.kill or expose thrown data', async () => {
  const privateValue = randomBytes(32).toString('hex');
  const f = fixture({ groupExists() { throw Object.assign(new Error(privateValue), { code: 'EPERM' }); } }); f.spawn();
  let caught;
  try { await stopRetainedGroup(f.state); } catch (error) { caught = error; }
  assert.ok(refused(caught)); assert.equal(String(caught).includes(privateValue), false); assert.deepEqual(f.world.signals, []);
});

test('group absence without retained child close is incomplete; cancellation still joins one owned stop', async () => {
  const f = fixture({ onSignal(signal, world, child) {
    if (signal === 'SIGTERM') { world.exists = false; child.emit('exit', 0); }
  } }); f.spawn();
  await assert.rejects(stopRetainedGroup(f.state, { graceMs: 0 }), refused);
  assert.equal(f.world.now, 5000); assert.deepEqual(f.world.signals, ['SIGTERM']);
  const controller = new AbortController();
  const g = fixture(); g.spawn();
  let cleanup;
  controller.signal.addEventListener('abort', () => { cleanup = stopRetainedGroup(g.state, { graceMs: 0 }); }, { once: true });
  g.world.afterSleep = (world, child) => { world.exists = false; child.emit('exit', 0); child.emit('close', 0); };
  controller.abort();
  const concurrent = stopRetainedGroup(g.state, { graceMs: 0 });
  assert.equal(await cleanup, true); assert.equal(await concurrent, true);
  assert.deepEqual(g.world.signals, ['SIGTERM', 'SIGKILL']);
});

test('pending spawn and spawn failure are settled before cleanup can succeed', async () => {
  const f = fixture(); f.world.afterSleep = (world, child) => {
    child.emit('error', new Error()); child.emit('close', null); world.exists = false;
  };
  assert.equal(await stopRetainedGroup(f.state, { graceMs: 0 }), true);
  assert.deepEqual(f.world.signals, []); assert.equal(f.state.spawned, false); assert.equal(f.state.startError, true);
  const g = fixture();
  await assert.rejects(stopRetainedGroup(g.state, { graceMs: 0 }), refused); assert.equal(g.world.now, 5000);
});

test('actual unsupported POSIX hosts refuse instead of falling back to parent-only termination', () => {
  assert.throws(() => requireRetainedProcessGroupHost('darwin'), { message: 'ANDROID_PROCESS_IDENTITY_UNSUPPORTED' });
  assert.throws(() => createRetainedProcessGroupLifecycle({ platform: 'darwin', ownerPid }), { message: 'ANDROID_PROCESS_IDENTITY_UNSUPPORTED' });
  const f = fixture(); f.spawn();
  assert.equal(Object.isFrozen(f.state), true); assert.throws(() => { f.state.pid = 303; }, TypeError);
  assert.throws(() => confirmRetainedGroupAbsent({ ...f.state }), refused);
});
