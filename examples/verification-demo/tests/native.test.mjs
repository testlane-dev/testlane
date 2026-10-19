import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoTemporaryDirectory, demoStorePolicy, removeDemoTemporaryDirectory, runDemoChild } from '../native.mjs';

const demoDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('native-store policy requires explicit acknowledgement outside Windows', () => {
  assert.deepEqual(demoStorePolicy({ platform: 'win32' }), { store: 'dpapi', usesUserKeychain: false });
  for (const platform of ['linux', 'darwin']) {
    assert.throws(() => demoStorePolicy({ platform }), /DEMO_USER_KEYCHAIN_ACKNOWLEDGEMENT_REQUIRED/);
    assert.equal(demoStorePolicy({ platform, allowUserKeychain: true }).usesUserKeychain, true);
  }
  assert.throws(() => demoStorePolicy({ platform: 'other', allowUserKeychain: true }), /DEMO_PLATFORM_UNSUPPORTED/);
});

test('subprocess helper delivers generated input on stdin and returns bounded private output', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'testlane-demo-child-'));
  try {
    const entry = path.join(root, 'stdin.mjs'), input = randomBytes(32).toString('base64url');
    await writeFile(entry, "let input=''; for await(const bytes of process.stdin) input+=bytes; process.stdout.write(JSON.stringify({argv:process.argv.slice(2),length:input.trim().length}));\n");
    const result = await runDemoChild({ entry, args: ['public-marker'], cwd: root, input });
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { argv: ['public-marker'], length: input.length });
    assert.equal(result.stdout.includes(input), false);
  } finally {
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('testlane-demo-child-')) throw new Error('TEST_SCRATCH_INVALID');
    await rm(root, { recursive: true });
  }
});

test('hanging child is stopped at its bounded timeout without printing its output', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'testlane-demo-child-'));
  try {
    const entry = path.join(root, 'hang.mjs'); await writeFile(entry, 'setInterval(()=>{},1000);\n');
    const started = Date.now();
    await assert.rejects(runDemoChild({ entry, cwd: root, timeoutMs: 150 }), /DEMO_CHILD_TIMEOUT/);
    assert.ok(Date.now() - started < 8000);
  } finally {
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('testlane-demo-child-')) throw new Error('TEST_SCRATCH_INVALID');
    await rm(root, { recursive: true });
  }
});

test('temporary cleanup refuses nonempty or unowned paths and preserves evidence', async () => {
  const temporary = await createDemoTemporaryDirectory(), file = path.join(temporary.root, 'owned-evidence.txt');
  try {
    await writeFile(file, 'owned test evidence');
    await assert.rejects(removeDemoTemporaryDirectory(temporary), /DEMO_TEMP_CLEANUP_INCOMPLETE/);
    assert.equal(await readFile(file, 'utf8'), 'owned test evidence');
    await assert.rejects(removeDemoTemporaryDirectory({ root: demoDirectory, parent: path.dirname(demoDirectory) }), /DEMO_TEMP_CLEANUP_INCOMPLETE/);
    await unlink(file);
  } finally { await removeDemoTemporaryDirectory(temporary); }
});

test('standalone entry through a filesystem alias still rejects invalid arguments', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'testlane-demo-child-')), alias = path.join(root, 'demo-alias');
  try {
    await symlink(demoDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await runDemoChild({ entry: path.join(alias, 'run.mjs'), args: ['--invalid-demo-argument'], cwd: root });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Testlane verification demo: DEMO_ARGUMENTS_INVALID\n');
  } finally {
    await unlink(alias).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('testlane-demo-child-')) throw new Error('TEST_SCRATCH_INVALID');
    await rm(root, { recursive: true });
  }
});

let browserModule;
try {
  const project = process.env.TESTLANE_VERIFICATION_TEST_PROJECT ?? path.resolve(demoDirectory, '../playwright');
  const require = createRequire(path.join(project, 'package.json'));
  browserModule = require.resolve('playwright');
  if (!existsSync(require('playwright').chromium.executablePath())) browserModule = undefined;
} catch { /* A source-only focused test; CI browser jobs install this dependency. */ }
test('Chromium launches from a deep output project using its short private temporary root', {
  skip: browserModule ? false : 'Install the Playwright example dependencies and Chromium for this browser smoke test.',
}, async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'testlane-demo-child-'));
  const temporary = await createDemoTemporaryDirectory();
  try {
    let project = root;
    while (project.length < 210) project = path.join(project, 'deep-owned-output');
    await mkdir(project, { recursive: true });
    const entry = path.join(project, 'browser.mjs');
    const body = `import {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\nconst {chromium}=require(${JSON.stringify(browserModule)});\nlet browser;\ntry{browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.setContent('<h1>Local browser smoke</h1>');if(await page.locator('h1').textContent()!=='Local browser smoke')throw Error('SMOKE_FAILED');process.stdout.write('browser-smoke-passed');}finally{await browser?.close();}\n`;
    await writeFile(entry, body);
    const result = await runDemoChild({ entry, cwd: project, timeoutMs: 20_000,
      env: { ...process.env, TMP: temporary.root, TEMP: temporary.root, TMPDIR: temporary.root, DEBUG: '', PWDEBUG: '', NODE_DEBUG: '' } });
    assert.equal(result.code, 0); assert.equal(result.stdout, 'browser-smoke-passed'); assert.equal(result.stderr, '');
    assert.deepEqual(await readdir(temporary.root), []);
  } finally {
    await removeDemoTemporaryDirectory(temporary);
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('testlane-demo-child-')) throw new Error('TEST_SCRATCH_INVALID');
    await rm(root, { recursive: true });
  }
});
