/** Linux-only retained detached-group lifecycle; no process names or command lines. */
import { readFileSync } from 'node:fs';

const fail = () => new Error('ANDROID_PROCESS_TERMINATION_UNCONFIRMED');
const positivePid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const records = new WeakMap();
const children = new WeakSet();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Parse only immutable identity fields, never retain /proc's process name. */
export function parseLinuxProcessIdentity(text, pid) {
  if (!positivePid(pid) || typeof text !== 'string' || text.length > 8192) throw fail();
  const end = text.lastIndexOf(') ');
  if (!text.startsWith(String(pid) + ' (') || end < 0) throw fail();
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^[RSDZTtWXIP]$/.test(fields[0])) throw fail();
  const ppid = Number(fields[1]), pgid = Number(fields[2]), sid = Number(fields[3]);
  if (!positivePid(ppid) || !positivePid(pgid) || !positivePid(sid) || !/^[1-9]\d{0,24}$/.test(fields[19])) throw fail();
  return Object.freeze({ pid, ppid, pgid, sid, start: fields[19], zombie: fields[0] === 'Z' || fields[0] === 'X' });
}

function readIdentity(pid) {
  if (!positivePid(pid)) throw fail();
  let text;
  try { text = readFileSync('/proc/' + pid + '/stat', 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return undefined; throw fail(); }
  return parseLinuxProcessIdentity(text, pid);
}
export function linuxGroupExists(pgid, probe = process.kill) {
  if (!positivePid(pgid)) throw fail();
  try { probe(-pgid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw fail(); }
}
function signalGroup(pgid, signal) {
  if (!positivePid(pgid) || !['SIGTERM', 'SIGKILL'].includes(signal)) throw fail();
  try { process.kill(-pgid, signal); }
  catch (error) { if (error?.code !== 'ESRCH') throw fail(); }
}
const linuxOperations = Object.freeze({ readIdentity, groupExists: linuxGroupExists, signalGroup, now: () => performance.now(), sleep });

export function requireRetainedProcessGroupHost(platform = process.platform) {
  if (platform !== 'linux') throw new Error('ANDROID_PROCESS_IDENTITY_UNSUPPORTED');
  try { const identity = readIdentity(process.pid); if (!identity || identity.zombie) throw fail(); }
  catch { throw new Error('ANDROID_PROCESS_IDENTITY_UNSUPPORTED'); }
  return true;
}

function recordFor(state) {
  const record = records.get(state);
  if (!record || record.uncertain) throw fail();
  return record;
}
function absent(record) {
  if (!record.spawned) return record.startError && record.closed;
  const result = record.operations.groupExists(record.pid);
  if (typeof result !== 'boolean') throw fail();
  return !result;
}
function matchesLeader(record) {
  const identity = record.identity, actual = record.operations.readIdentity(record.pid);
  return identity && actual && !actual.zombie && actual.pid === identity.pid && actual.ppid === identity.ppid &&
    actual.pgid === identity.pgid && actual.sid === identity.sid && actual.start === identity.start &&
    identity.ppid === record.ownerPid && identity.pgid === record.pid && identity.sid === record.pid;
}
function releaseHandles(record) {
  // These are only the handles retained from our own spawn; releasing pipes is
  // never evidence that the numeric group or its members have stopped.
  for (const stream of ['stdin', 'stdout', 'stderr']) { try { record.child[stream]?.destroy(); } catch {} }
  try { record.child.unref(); } catch {}
}

/** A closed command may leave tracking only after its original numeric group is absent. */
export function confirmRetainedGroupAbsent(state) {
  const record = recordFor(state);
  try { if (record.closed && absent(record)) return true; }
  catch { throw fail(); }
  throw fail();
}

/**
 * Internal test seam. Production callers use retainDetachedChild below. Injected
 * operations let Windows unit tests exercise Linux lifecycle without native tools.
 */
export function createRetainedProcessGroupLifecycle({ platform = process.platform, ownerPid = process.pid, operations } = {}) {
  if (platform !== 'linux') throw new Error('ANDROID_PROCESS_IDENTITY_UNSUPPORTED');
  if (!positivePid(ownerPid)) throw fail();
  const ops = operations ?? linuxOperations;
  if (['readIdentity', 'groupExists', 'signalGroup', 'now', 'sleep'].some(key => typeof ops[key] !== 'function')) throw fail();
  function retain(child) {
    if (!child || typeof child.once !== 'function' || children.has(child)) throw fail();
    children.add(child);
    const record = { child, ownerPid, operations: ops, pid: null, spawned: false, exited: false,
      closed: false, code: null, startError: false, identity: undefined, uncertain: false, stopping: undefined };
    const state = { child };
    for (const key of ['pid', 'spawned', 'exited', 'closed', 'code', 'startError']) {
      Object.defineProperty(state, key, { enumerable: true, get: () => record[key] });
    }
    state.started = new Promise(resolve => {
      child.once('spawn', () => {
        record.spawned = true; record.pid = child.pid;
        try {
          const identity = positivePid(record.pid) ? ops.readIdentity(record.pid) : undefined;
          if (identity && identity.pid === record.pid && identity.ppid === ownerPid && identity.pgid === record.pid &&
              identity.sid === record.pid && typeof identity.start === 'string' && /^[1-9]\d{0,24}$/.test(identity.start) && !identity.zombie) {
            record.identity = Object.freeze({ pid: identity.pid, ppid: identity.ppid, pgid: identity.pgid, sid: identity.sid, start: identity.start });
          }
        } catch { /* Short commands may exit before metadata capture; absence is still required. */ }
        resolve(true);
      });
      child.once('error', () => { record.startError = true; resolve(false); });
    });
    child.once('exit', code => { record.exited = true; record.code = code; });
    state.done = new Promise(resolve => child.once('close', code => { record.closed = true; record.code = code; resolve(); }));
    records.set(state, record);
    return Object.freeze(state);
  }
  return Object.freeze({ retainDetachedChild: retain, confirmRetainedGroupAbsent, stopRetainedGroup });
}

/** Retain immediately after spawn(...,{detached:true}); callers own stdin/capture bounds. */
export function retainDetachedChild(child, options) {
  return createRetainedProcessGroupLifecycle(options).retainDetachedChild(child);
}

/**
 * Stop only this retained Linux group. A lost leader with a live group is unknown;
 * no guessed PID, parent-only fallback, process-name search or new-group authority.
 */
export async function stopRetainedGroup(state, { graceMs = 1500 } = {}) {
  const record = recordFor(state);
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 1500) throw fail();
  if (record.stopping) return record.stopping;
  record.stopping = (async () => {
    const ops = record.operations, deadline = ops.now() + graceMs + 5000;
    const complete = () => record.closed && absent(record);
    const wait = async until => {
      while (ops.now() < until) {
        if (complete()) return true;
        await ops.sleep(Math.min(25, until - ops.now()));
      }
      return complete();
    };
    try {
      while (!record.spawned && !record.startError && ops.now() < deadline) await ops.sleep(Math.min(25, deadline - ops.now()));
      const groupAbsent = absent(record);
      if (record.closed && groupAbsent) return true;
      // A currently absent group can be confirmed without captured metadata, but
      // a live/reused number must never become authority after its leader exits.
      if (!groupAbsent && record.spawned && positivePid(record.pid) && !record.exited && !record.closed && matchesLeader(record)) {
        ops.signalGroup(record.pid, 'SIGTERM');
        if (await wait(Math.min(deadline, ops.now() + graceMs))) return true;
        if (!absent(record) && !record.exited && !record.closed && matchesLeader(record)) ops.signalGroup(record.pid, 'SIGKILL');
      }
      if (await wait(deadline)) return true;
      throw fail();
    } catch {
      record.uncertain = true;
      releaseHandles(record);
      throw fail();
    }
  })();
  return record.stopping;
}
