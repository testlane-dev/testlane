import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAndroidProof } from '../build.mjs';

async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tl-android-preflight-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^tl-android-preflight-test-[A-Za-z0-9]+$/);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
  });
  const sdk = path.join(root, 'sdk'), jdk = path.join(root, 'jdk'), temporary = path.join(root, 'temporary');
  await mkdir(sdk); await mkdir(jdk); await mkdir(temporary);
  const previous = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = temporary;
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const file = async (base, relative, contents = 'preflight fixture only\n') => { const target = path.join(base, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents); };
  const outputDir = path.join(root, 'new-output-parent', 'output');
  const refusesBeforeAllocation = async (sdkRoot = sdk) => {
    await assert.rejects(buildAndroidProof({ outputDir, sdkRoot, javaHome: jdk }), /^Error: ANDROID_SDK_PREREQUISITE_MISSING$/);
    await assert.rejects(lstat(path.dirname(outputDir)), { code: 'ENOENT' });
    assert.deepEqual(await readdir(temporary), []);
  };
  return { root, sdk, jdk, temporary, outputDir, file, refusesBeforeAllocation };
}

async function completeTools(f) {
  const executable = process.platform === 'win32' ? '.exe' : '';
  const host = { win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[process.platform];
  for (const file of [
    'platforms/android-37.0/android.jar', 'platforms/android-37.0/source.properties',
    'build-tools/37.0.0/source.properties', 'build-tools/37.0.0/aapt2' + executable,
    'build-tools/37.0.0/zipalign' + executable, 'build-tools/37.0.0/lib/d8.jar', 'build-tools/37.0.0/lib/apksigner.jar',
    'ndk/27.1.12297006/source.properties', 'ndk/27.1.12297006/build/cmake/android.toolchain.cmake',
    'ndk/27.1.12297006/toolchains/llvm/prebuilt/' + host + '/bin/clang' + executable,
    'cmake/3.22.1/source.properties', 'cmake/3.22.1/bin/cmake' + executable, 'cmake/3.22.1/bin/ninja' + executable,
  ]) await f.file(f.sdk, file);
  for (const name of ['java', 'javac']) await f.file(f.jdk, 'bin/' + name + executable);
}

test('an absent SDK refuses before creating output or a temporary build root', async t => {
  const f = await fixture(t);
  await f.refusesBeforeAllocation(path.join(f.root, 'absent-sdk'));
});

test('a newer aapt2 cannot substitute for the pinned build-tools prerequisite', async t => {
  const f = await fixture(t), executable = process.platform === 'win32' ? '.exe' : '';
  await f.file(f.sdk, 'platforms/android-37.0/android.jar');
  await f.file(f.sdk, 'platforms/android-37.0/source.properties');
  await f.file(f.sdk, 'build-tools/37.0.0/source.properties');
  await f.file(f.sdk, 'build-tools/99.0.0/aapt2' + executable);
  await f.refusesBeforeAllocation();
});

test('missing pinned CMake refuses before dependency installation or temporary allocation', async t => {
  const f = await fixture(t), executable = process.platform === 'win32' ? '.exe' : '';
  await completeTools(f);
  await rm(path.join(f.sdk, 'cmake/3.22.1/bin/cmake' + executable));
  await f.refusesBeforeAllocation();
});

test('an absolute npm_execpath outside the Node directory is used without a shell', async t => {
  const f = await fixture(t); await completeTools(f);
  const previous = process.env.npm_execpath;
  t.after(() => { if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous; });
  const relative = 'separate-node-distribution/share/npm/bin/npm-cli.js';
  await f.file(f.root, relative, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(73);\n");
  process.env.npm_execpath = path.join(f.root, relative);
  await assert.rejects(buildAndroidProof({ outputDir: f.outputDir, sdkRoot: f.sdk, javaHome: f.jdk }), error =>
    error.message === 'ANDROID_BUILD_STAGE_FAILED' && error.stage === 'npm-ci');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.outputDir, 'npm-ci.log'), 'utf8')), ['ci', '--no-audit', '--no-fund']);
  const recovery = JSON.parse(await readFile(path.join(f.outputDir, 'recovery.json'), 'utf8'));
  assert.equal(path.dirname(recovery.buildRoot), await realpath(f.temporary));
  assert.equal((await lstat(recovery.buildRoot)).isDirectory(), true);
});

test('a pre-aborted build refuses before allocating output or a temporary root', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(buildAndroidProof({ outputDir: f.outputDir, sdkRoot: f.sdk, javaHome: f.jdk, signal: controller.signal }), /^Error: ANDROID_BUILD_CANCELLED$/);
  await assert.rejects(lstat(path.dirname(f.outputDir)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.temporary), []);
});

test('cancellation confirms the owned npm process tree stopped and retains private recovery', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await completeTools(f);
  const previous = process.env.npm_execpath;
  t.after(() => { if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous; });
  const marker = path.join(f.root, 'owned-processes.json'), relative = 'separate-node-distribution/npm-cli.js';
  await f.file(f.root, relative, [
    "const {spawn}=require('node:child_process'), {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e',\"process.send('ready');setInterval(()=>{},1000)\"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});",
    'child.once("message",()=>writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({parent:process.pid,child:child.pid})));',
    'setInterval(()=>{},1000);',
  ].join('\n'));
  process.env.npm_execpath = path.join(f.root, relative);
  const controller = new AbortController();
  const building = buildAndroidProof({ outputDir: f.outputDir, sdkRoot: f.sdk, javaHome: f.jdk, signal: controller.signal })
    .then(() => ({ error: null }), error => ({ error }));
  try {
    let pids;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(marker, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(Number.isSafeInteger(pids?.parent), true); assert.equal(Number.isSafeInteger(pids?.child), true);
    controller.abort();
    const { error } = await building;
    assert.equal(error?.message, 'ANDROID_BUILD_CANCELLED'); assert.equal(error?.stage, 'npm-ci');
    for (const pid of [pids.parent, pids.child]) {
      let running = true;
      const until = Date.now() + 3000;
      while (running && Date.now() < until) {
        try {
          process.kill(pid, 0);
          // A killed orphan can briefly remain a non-running zombie until its
          // external reaper acts. It cannot execute or retain an open build file.
          if (process.platform === 'linux' && /\) Z /.test(await readFile('/proc/' + pid + '/stat', 'utf8'))) running = false;
        } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) running = false; else throw error; }
        if (running) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(running, false, 'owned process must no longer execute');
    }
    const recovery = JSON.parse(await readFile(path.join(f.outputDir, 'recovery.json'), 'utf8'));
    assert.equal(recovery.cancelled, true); assert.equal(recovery.childTermination, 'confirmed'); assert.equal(recovery.stage, 'npm-ci');
    assert.equal(path.dirname(recovery.buildRoot), await realpath(f.temporary));
    assert.equal((await lstat(recovery.buildRoot)).isDirectory(), true);
    assert.equal((await lstat(path.join(f.outputDir, 'npm-ci.log'))).isFile(), true);
  } finally { controller.abort(); await building; }
});
