import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildIosProof, createIosBuildRoot, hashIosTree, removeIosBuildRoot, runIosBuildChild } from '../build-ios.mjs';

async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tl-ios-helper-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^tl-ios-helper-test-[A-Za-z0-9]+$/);
    assert.equal((await lstat(root)).isSymbolicLink(), false); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
  });
  return root;
}
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

test('iOS build refuses a non-macOS host before output or temporary build allocation', async t => {
  if (process.platform === 'darwin') { t.skip('This refusal is specific to non-macOS hosts; actual builds belong to the macOS proof.'); return; }
  const root = await fixture(t), output = path.join(root, 'never-created');
  await assert.rejects(buildIosProof({ outputDir: output }), /^Error: IOS_BUILD_MACOS_REQUIRED$/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('a pre-aborted iOS build allocates no output', async t => {
  const root = await fixture(t), output = path.join(root, 'never-created'), controller = new AbortController(); controller.abort();
  await assert.rejects(buildIosProof({ outputDir: output, signal: controller.signal }), /^Error: IOS_BUILD_CANCELLED$/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('owned build removal requires the exact canonical parent, directory and token', async t => {
  const root = await fixture(t), owner = await createIosBuildRoot(root);
  await writeFile(path.join(owner.root, 'retained.txt'), 'owned file');
  await assert.rejects(removeIosBuildRoot({ ...owner, token: randomUUID() }), /^Error: IOS_BUILD_OWNERSHIP_INVALID$/);
  assert.equal(await readFile(path.join(owner.root, 'retained.txt'), 'utf8'), 'owned file');
  await assert.rejects(removeIosBuildRoot({ ...owner, root }), /^Error: IOS_BUILD_OWNERSHIP_INVALID$/);
  await removeIosBuildRoot(owner); await assert.rejects(lstat(owner.root), { code: 'ENOENT' });
});

test('a build-root alias cannot redirect owned recursive removal', async t => {
  const root = await fixture(t), owner = await createIosBuildRoot(root), alias = path.join(root, 'tl-ios-build-alias');
  await writeFile(path.join(owner.root, 'retained.txt'), 'owned file');
  await symlink(owner.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeIosBuildRoot({ ...owner, root: alias }), /^Error: IOS_BUILD_OWNERSHIP_INVALID$/);
  assert.equal(await readFile(path.join(owner.root, 'retained.txt'), 'utf8'), 'owned file');
  await rm(alias); await removeIosBuildRoot(owner);
});

test('full tree hash detects nested binary changes and added files deterministically', async t => {
  const root = await fixture(t), app = path.join(root, 'Synthetic.app'); await mkdir(path.join(app, 'Frameworks/Example.framework'), { recursive: true });
  await writeFile(path.join(app, 'main.jsbundle'), 'embedded source');
  await writeFile(path.join(app, 'Frameworks/Example.framework/Example'), Buffer.from([1, 2, 3]));
  const original = await hashIosTree(app), same = await hashIosTree(app);
  assert.deepEqual(same, original); assert.equal(original.totalBytes, 18);
  assert.deepEqual(original.entries.filter(item => item.type === 'file').map(item => item.path), ['Frameworks/Example.framework/Example', 'main.jsbundle']);
  await writeFile(path.join(app, 'Frameworks/Example.framework/Example'), Buffer.from([1, 2, 4]));
  assert.notEqual((await hashIosTree(app)).sha256, original.sha256);
  const changed = await hashIosTree(app); await writeFile(path.join(app, 'additional-resource'), 'extra');
  assert.notEqual((await hashIosTree(app)).sha256, changed.sha256);
});

test('tree hashes preserve valid internal relative links and reject escaping links', async t => {
  const root = await fixture(t), app = path.join(root, 'Synthetic.app'); await mkdir(app);
  await writeFile(path.join(app, 'main.jsbundle'), 'embedded source');
  try { await symlink('main.jsbundle', path.join(app, 'bundle-link'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not grant file-symlink creation; macOS build still validates every actual link.'); return; } throw error; }
  const hashed = await hashIosTree(app), link = hashed.entries.find(item => item.path === 'bundle-link');
  assert.equal(link.type, 'symlink'); assert.equal(link.target, 'main.jsbundle');
  assert.equal(hashed.entries.filter(item => item.type === 'file').length, 1);
  await writeFile(path.join(root, 'outside.txt'), 'outside scope');
  await symlink('../outside.txt', path.join(app, 'escape'), 'file');
  await assert.rejects(hashIosTree(app), /^Error: IOS_BUILD_TREE_LINK_INVALID$/);
});

test('tree hash rejects an absolute junction instead of traversing another tree', async t => {
  const root = await fixture(t), app = path.join(root, 'Synthetic.app'), outside = path.join(root, 'outside'); await mkdir(app); await mkdir(outside);
  await writeFile(path.join(outside, 'outside.txt'), 'outside scope');
  await symlink(outside, path.join(app, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(hashIosTree(app), /^Error: IOS_BUILD_TREE_LINK_INVALID$/);
  assert.equal(await readFile(path.join(outside, 'outside.txt'), 'utf8'), 'outside scope');
});

test('build child treats shell syntax as literal argv and writes bounded private output', async t => {
  const root = await fixture(t), logFile = path.join(root, 'child.log'), literal = 'value with spaces; $(not-a-command)';
  const result = await runIosBuildChild(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', literal], { cwd: root, timeoutMs: 5000, logFile });
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.output), [literal]);
  assert.equal(await readFile(logFile, 'utf8'), result.output);
});

test('build child timeout is a stopped failure rather than a completed stage', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  await assert.rejects(runIosBuildChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 150 }), error =>
    error.message === 'IOS_BUILD_CHILD_TIMEOUT' && error.terminationConfirmed === true);
});

test('build cancellation confirms the owned parent and its sleeping child stop', { timeout: 20_000 }, async t => {
  const root = await fixture(t), script = path.join(root, 'sleeping build.cjs'), marker = path.join(root, 'owned-processes.json');
  await writeFile(script, [
    "const {spawn}=require('node:child_process'), {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e',\"process.send('ready');setInterval(()=>{},1000)\"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});",
    'child.once("message",()=>writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({parent:process.pid,child:child.pid})));',
    'setInterval(()=>{},1000);',
  ].join('\n'));
  const controller = new AbortController(), pending = runIosBuildChild(process.execPath, [script], { cwd: root, timeoutMs: 10_000, signal: controller.signal, logFile: path.join(root, 'cancelled.log') })
    .then(() => null, error => error);
  try {
    let pids; const until = Date.now() + 7000;
    while (Date.now() < until) {
      try { pids = JSON.parse(await readFile(marker, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await pause();
    }
    assert.equal(Number.isSafeInteger(pids?.parent), true); assert.equal(Number.isSafeInteger(pids?.child), true);
    controller.abort(); const error = await pending;
    assert.equal(error?.message, 'IOS_BUILD_CANCELLED'); assert.equal(error?.terminationConfirmed, true);
    for (const pid of [pids.parent, pids.child]) {
      let running = true; const deadline = Date.now() + 3000;
      while (running && Date.now() < deadline) {
        try { process.kill(pid, 0); if (process.platform === 'linux' && /\) Z /.test(await readFile('/proc/' + pid + '/stat', 'utf8'))) running = false; }
        catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) running = false; else throw error; }
        if (running) await pause();
      }
      assert.equal(running, false, 'owned process must no longer execute');
    }
    assert.equal((await lstat(path.join(root, 'cancelled.log'))).isFile(), true);
  } finally { controller.abort(); await pending; }
});
