import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDemoChild } from '../native.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'testlane-demo-stop-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^testlane-demo-stop-[A-Za-z0-9]+$/);
    assert.equal((await lstat(root)).isSymbolicLink(), false); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}
async function readWhenPresent(file, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw Error('TEST_OWNED_CHILD_NOT_READY');
}
async function executing(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /.test(await readFile('/proc/' + pid + '/stat', 'utf8'))) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}
async function stopKnown(pids) {
  for (const pid of pids) if (Number.isSafeInteger(pid) && pid > 1 && await executing(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const until = Date.now() + 3000;
  for (const pid of pids) {
    while (await executing(pid) && Date.now() < until) await delay(25);
    assert.equal(await executing(pid), false, 'fixture must stop only its recorded owned process');
  }
}
async function parentWithChild(root, detached = false) {
  const entry = path.join(root, 'parent.cjs'), childEntry = path.join(root, 'child.cjs'), marker = path.join(root, 'parent.json'), childMarker = path.join(root, 'child.json');
  await writeFile(childEntry, 'require("node:fs").writeFileSync(' + JSON.stringify(childMarker) + ',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n');
  await writeFile(entry, [
    'const {spawn}=require("node:child_process"),fs=require("node:fs");',
    'const child=spawn(process.execPath,[' + JSON.stringify(childEntry) + '],{windowsHide:true,detached:' + JSON.stringify(detached) + ',stdio:"ignore"});',
    'fs.writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);',
  ].join('\n'));
  return { entry, marker, childMarker };
}

test('successful owned tree stop preserves the normal cancellation result', { timeout: 20_000 }, async t => {
  const root = await fixture(t), files = await parentWithChild(root), controller = new AbortController();
  const pending = runDemoChild({ entry: files.entry, cwd: root, timeoutMs: 10_000, signal: controller.signal }).then(() => null, error => error);
  let pids;
  try {
    pids = await readWhenPresent(files.marker); const child = await readWhenPresent(files.childMarker); assert.equal(child.pid, pids.child);
    controller.abort(); const error = await pending;
    assert.equal(error?.message, 'DEMO_CANCELLED'); assert.equal(error?.ownedChildPid, undefined);
    const until = Date.now() + 3000;
    for (const pid of [pids.parent, pids.child]) {
      while (await executing(pid) && Date.now() < until) await delay(25);
      assert.equal(await executing(pid), false);
    }
  } finally { controller.abort(); await pending; if (pids) await stopKnown([pids.parent, pids.child]); }
});

for (const outcome of ['nonzero', 'spawn-error']) {
  test('Windows ' + outcome + ' tree-killer cannot be confirmed by root close', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
    const root = await fixture(t), files = await parentWithChild(root, true), controller = new AbortController(), originalSpawn = childProcess.spawn;
    let calls = 0, pids;
    // Mock only the fixed tree-kill tool. The root and detached child are real
    // owned processes; no unrelated process lookup or broad termination occurs.
    childProcess.spawn = (entry, args, options) => {
      if (path.basename(entry).toLowerCase() !== 'taskkill.exe') return originalSpawn(entry, args, options);
      calls++; const tool = new EventEmitter(); tool.kill = () => false;
      queueMicrotask(() => outcome === 'nonzero' ? tool.emit('close', 1) : tool.emit('error', Error('TEST_TOOL_UNAVAILABLE')));
      return tool;
    };
    syncBuiltinESMExports();
    const pending = runDemoChild({ entry: files.entry, cwd: root, timeoutMs: 10_000, signal: controller.signal }).then(() => null, error => error);
    try {
      pids = await readWhenPresent(files.marker); const child = await readWhenPresent(files.childMarker); assert.equal(child.pid, pids.child);
      assert.equal(await executing(pids.parent), true); assert.equal(await executing(pids.child), true);
      controller.abort(); const error = await pending;
      assert.equal(calls, 1); assert.equal(error?.message, 'DEMO_CHILD_TERMINATION_UNCONFIRMED');
      assert.equal(error.ownedChildPid, pids.parent); assert.equal(await executing(pids.parent), false);
      // Some Windows job configurations also close descendants with the root.
      // That incidental behavior cannot turn a failed tree command into proof.
    } finally {
      childProcess.spawn = originalSpawn; syncBuiltinESMExports(); controller.abort(); await pending;
      if (pids) await stopKnown([pids.parent, pids.child]);
    }
  });
}
