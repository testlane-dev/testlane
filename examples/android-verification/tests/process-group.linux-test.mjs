/** Run explicitly on the ephemeral Linux CI host, before any SDK/tool allocation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmRetainedGroupAbsent, linuxGroupExists, parseLinuxProcessIdentity,
  requireRetainedProcessGroupHost, retainDetachedChild, stopRetainedGroup } from '../process-group.mjs';

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.TESTLANE_ANDROID_PROOF_CI !== '1') throw new Error('LINUX_PROCESS_TEST_HOST_REFUSED');
requireRetainedProcessGroupHost();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const refused = error => error?.message === 'ANDROID_PROCESS_TERMINATION_UNCONFIRMED';
async function identity(pid) {
  try { return parseLinuxProcessIdentity(await readFile('/proc/' + pid + '/stat', 'utf8'), pid); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error; }
}
async function waitFor(predicate, ms = 5000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { if (await predicate()) return true; await sleep(25); }
  return predicate();
}
async function fixture() {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-pg-test-'));
  const nonce = randomBytes(12).toString('hex');
  await writeFile(path.join(root, 'owner.json'), JSON.stringify({ ownerPid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
  const code = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},shell:false,stdio:'ignore'});
    child.once('spawn',()=>process.send({pid:child.pid}));
    process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));child.kill('SIGTERM')});
    process.on('message',message=>{if(message?.exit===true)process.exit(0)});
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['-e', code], { cwd: root, env: {}, shell: false,
    detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const state = retainDetachedChild(child); child.stdin.on('error', () => {}); child.stdin.end(); child.stdout.resume(); child.stderr.resume();
  let descendant, descendantIdentity;
  const announced = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LINUX_PROCESS_FIXTURE_TIMEOUT')), 5000);
    child.once('message', message => { clearTimeout(timer); resolve(message?.pid); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('LINUX_PROCESS_FIXTURE_FAILED')); });
  });
  async function close() {
    let uncertain = false;
    // A still-live retained leader remains the only group signal authority.
    if (!state.closed) { try { await stopRetainedGroup(state, { graceMs: 0 }); } catch { uncertain = true; } }
    if (descendantIdentity) {
      const actual = await identity(descendant);
      if (actual) {
        if (actual.pid !== descendantIdentity.pid || actual.pgid !== descendantIdentity.pgid || actual.sid !== descendantIdentity.sid || actual.start !== descendantIdentity.start) uncertain = true;
        else {
          // Fixture recovery targets only the exact descendant captured while its
          // retained parent was live. It never grants the helper lost-group authority.
          try { process.kill(descendant, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') uncertain = true; }
        }
      }
      if (!await waitFor(async () => !await identity(descendant))) uncertain = true;
    }
    if (!state.closed || linuxGroupExists(state.pid)) uncertain = true;
    // A deliberate lost-parent refusal is recoverable only after the one known
    // fixture descendant and group are independently absent.
    if (state.closed && !linuxGroupExists(state.pid) && (!descendant || !await identity(descendant))) uncertain = false;
    if (uncertain) {
      await writeFile(path.join(root, 'recovery.json'), JSON.stringify({ schemaVersion: 1, status: 'manual-inspection-required',
        ownerPid: process.pid, parentPid: state.pid, descendantPid: descendant ?? null, descendantStart: descendantIdentity?.start ?? null }), { mode: 0o600 });
      throw new Error('LINUX_PROCESS_FIXTURE_CLEANUP_UNCONFIRMED');
    }
    const marker = JSON.parse(await readFile(path.join(root, 'owner.json'), 'utf8'));
    if (await realpath(root) !== root || path.dirname(root) !== parent || !/^tld-pg-test-[A-Za-z0-9]+$/.test(path.basename(root)) ||
        (await lstat(root)).isSymbolicLink() || marker.ownerPid !== process.pid || marker.nonce !== nonce) throw new Error('LINUX_PROCESS_FIXTURE_ROOT_REFUSED');
    await rm(root, { recursive: true, force: false });
  }
  try {
    assert.equal(await state.started, true);
    descendant = await announced; assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
    descendantIdentity = await identity(descendant);
    assert.ok(descendantIdentity); assert.equal(descendantIdentity.ppid, state.pid);
    assert.equal(descendantIdentity.pgid, state.pid); assert.equal(descendantIdentity.sid, state.pid);
    return { child, state, descendant, descendantIdentity, close };
  } catch (error) { await close(); throw error; }
}

test('Linux retained live group termination closes parent and descendant without SDK/native services', { timeout: 20000 }, async () => {
  const owned = await fixture();
  try {
    assert.equal(await stopRetainedGroup(owned.state), true);
    assert.equal(confirmRetainedGroupAbsent(owned.state), true); assert.equal(linuxGroupExists(owned.state.pid), false);
    assert.equal(await identity(owned.descendant), undefined);
  } finally { await owned.close(); }
});

test('Linux closed parent and closed pipes cannot hide a live descendant; recovery is exact fixture child only', { timeout: 20000 }, async () => {
  const owned = await fixture();
  try {
    owned.child.send({ exit: true }); await owned.state.done;
    assert.equal(owned.state.closed, true); assert.ok(await identity(owned.descendant));
    assert.throws(() => confirmRetainedGroupAbsent(owned.state), refused);
    await assert.rejects(stopRetainedGroup(owned.state, { graceMs: 0 }), refused);
    assert.ok(await identity(owned.descendant), 'lost leader must not authorize a guessed negative-group signal');
  } finally { await owned.close(); }
});

test('Linux cancellation joins retained group stop rather than abandoning its owned child', { timeout: 20000 }, async () => {
  const owned = await fixture(), controller = new AbortController(); let stopping;
  controller.signal.addEventListener('abort', () => { stopping = stopRetainedGroup(owned.state); }, { once: true });
  try {
    controller.abort(); assert.equal(await stopping, true);
    assert.equal(confirmRetainedGroupAbsent(owned.state), true); assert.equal(await identity(owned.descendant), undefined);
  } finally { await owned.close(); }
});
