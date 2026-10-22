import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startOwnedAndroid, stopOwnedAndroidProcesses } from '../device.mjs';
import { requireRetainedProcessGroupHost, retainDetachedChild } from '../process-group.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

test('supported hosts retain the native tree/group; unsupported POSIX hosts refuse before allocation', { timeout: 20000 }, async () => {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    assert.throws(() => requireRetainedProcessGroupHost(), { message: 'ANDROID_PROCESS_IDENTITY_UNSUPPORTED' });
    await assert.rejects(startOwnedAndroid({ sdkRoot: '/synthetic/sdk', javaHome: '/synthetic/java', toolsRoot: '/synthetic/tools',
      systemImagePath: '/synthetic/image', outputDir: '/synthetic/output' }), { message: 'ANDROID_PROCESS_IDENTITY_UNSUPPORTED' });
    return;
  }
  const source = `
    const {spawn}=require('node:child_process');
    const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true});
    grandchild.once('spawn',()=>process.send({pid:grandchild.pid}));
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['-e', source], { windowsHide: true, shell: false,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const state = process.platform === 'win32' ? { child, pid: child.pid, spawned: false, exited: false, closed: false, code: null } : retainDetachedChild(child);
  child.stdout.resume(); child.stderr.resume(); child.stdin.on('error', () => {});
  let started = state.started;
  if (process.platform === 'win32') {
    started = new Promise((resolve, reject) => { child.once('spawn', () => { state.spawned = true; state.pid = child.pid; resolve(); }); child.once('error', reject); });
    child.once('exit', code => { state.exited = true; state.code = code; });
    state.done = new Promise(resolve => child.once('close', code => { state.closed = true; state.code = code; resolve(); }));
  }
  let grandchildPid, gracefulCalls = 0, readyTimer;
  const announced = new Promise(resolve => child.once('message', message => resolve(message.pid)));
  try {
    await started;
    grandchildPid = await Promise.race([announced, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('owned child did not start')), 5000); })]);
    clearTimeout(readyTimer);
    assert.ok(Number.isInteger(grandchildPid)); assert.equal(gone(state.pid), false); assert.equal(gone(grandchildPid), false);
    const failures = await stopOwnedAndroidProcesses({ emulator: state, gracefulEmulatorShutdown: async () => {
      gracefulCalls++; child.kill(); // This would strand the grandchild's inherited pipes.
    } }, { platform: process.platform });
    assert.equal(gracefulCalls, 0, 'teardown must retain the leader until its owned tree/group stops');
    assert.deepEqual(failures, []); assert.equal(state.closed, true);
    const deadline = Date.now() + 3000;
    while (!gone(grandchildPid) && Date.now() < deadline) await sleep(25);
    assert.equal(gone(state.pid), true); assert.equal(gone(grandchildPid), true);
  } finally {
    clearTimeout(readyTimer);
    if (!state.closed) await stopOwnedAndroidProcesses({ emulator: state }, { platform: process.platform });
    // Test recovery names only the grandchild this test created; never any AVD.
    if (grandchildPid && !gone(grandchildPid)) { process.kill(grandchildPid, 'SIGKILL'); await sleep(100); }
  }
});
