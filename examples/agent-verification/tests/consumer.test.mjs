import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, cp, rm, symlink, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runVerification } from '../runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
let modules;
for (const project of [process.env.TESTLANE_VERIFICATION_TEST_PROJECT, path.join(repo, 'output/agent-verification-evaluation'), path.join(repo, 'examples/playwright')].filter(Boolean)) {
  try { const metadata = createRequire(path.join(project, 'package.json')).resolve('@playwright/test/package.json'); modules = path.dirname(path.dirname(path.dirname(metadata))); break; } catch {}
}
const integration = (name, fn) => test(name, { skip: modules ? false : 'Install the existing Playwright example dependencies to run real consumer checks.' }, fn);
async function project(body, { required = true, screenshots = 'off', origin = 'http://127.0.0.1:3000' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'testlane-agent-consumer-'));
  await symlink(modules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'generated-verification-consumer', private: true, type: 'module' }));
  await cp(path.join(here, '../authoring.mjs'), path.join(root, 'testlane-authoring.mjs'));
  await writeFile(path.join(root, 'app.spec.mjs'), body);
  const plan = { schemaVersion: 1, status: 'reviewed', title: 'Private reviewed feature narrative', projectDir: '.',
    target: { baseUrl: origin, environment: 'testing' }, evidence: { screenshots },
    cases: [{ id: 'create-note', title: 'Private descriptive title', spec: 'app.spec.mjs', expected: ['Private intended application behavior'], cleanup: { required, description: required ? 'Remove and verify owned note' : 'No app mutation in this case' } }] };
  const planFile = path.join(root, 'plan.json'); await writeFile(planFile, JSON.stringify(plan));
  return { root, planFile, plan, run: signal => runVerification({ planFile, signal }), close: () => rm(root, { recursive: true, force: true }) };
}
function spec(body, { declaration = 'test', annotation = 'create-note', cleanup = 'async () => {}' } = {}) {
  return [
    "import { test, expect } from '@playwright/test';",
    "import { runCase } from './testlane-authoring.mjs';",
    declaration + "('runtime title must not be emitted', { annotation: { type: 'testlane-case', description: " + JSON.stringify(annotation) + " } }, async ({}, info) => {",
    "await runCase(info, 'create-note', { run: async () => {" + body + "}, cleanup: " + cleanup + " }); });",
  ].join('\n');
}
integration('real Playwright rejects zero tests, skips, expected failures and missing helper/cleanup', async t => {
  for (const [label, source] of [
    ['zero', "import { test } from '@playwright/test';"],
    ['skip', spec('', { declaration: 'test.skip' })],
    ['expected-failure', spec("test.fail(); throw new Error('unprinted browser value');")],
    ['missing-helper', "import { test } from '@playwright/test'; test('plain', { annotation: { type: 'testlane-case', description: 'create-note' } }, async () => {});"],
    ['missing-cleanup', spec('', { cleanup: 'undefined' })],
    ['cleanup-failure', spec('', { cleanup: "async () => { throw new Error('unprinted cleanup value'); }" })],
    ['empty-body', spec('')],
  ]) await t.test(label, async () => {
    const app = await project(source);
    try { const result = await app.run(); assert.notEqual(result.report.verdict, 'passed'); assert.equal(JSON.stringify(result.report).includes('unprinted'), false); }
    finally { await app.close(); }
  });
});
integration('a late fixture teardown failure overrides an otherwise passed body', async () => {
  const source = [
    "import { test as base, expect } from '@playwright/test';",
    "import { runCase } from './testlane-authoring.mjs';",
    "const test = base.extend({ late: [async ({}, use) => { await use(); throw new Error('private teardown diagnostic'); }, { auto: true }] });",
    "test('teardown check', { annotation: { type: 'testlane-case', description: 'create-note' } }, async ({}, info) => { await runCase(info, 'create-note', { run: async () => expect(1).toBe(1), cleanup: async () => {} }); });",
  ].join('\n');
  const app = await project(source);
  try { const result = await app.run(); assert.equal(result.report.verdict, 'failed'); assert.equal(result.report.cases[0].cleanup.status, 'completed'); assert.equal(JSON.stringify(result.report).includes('private teardown'), false); }
  finally { await app.close(); }
});
integration('a caught helper body failure still fails the report and completes cleanup', async () => {
  const source = [
    "import { test, expect } from '@playwright/test';",
    "import { writeFile } from 'node:fs/promises';",
    "import { runCase } from './testlane-authoring.mjs';",
    "test('caught error', { annotation: { type: 'testlane-case', description: 'create-note' } }, async ({}, info) => {",
    "try { await runCase(info, 'create-note', { run: async () => { expect(false, 'private assertion diagnostic').toBe(true); },",
    "cleanup: async () => { await writeFile(new URL('./cleaned', import.meta.url), '1'); } }); } catch {} });",
  ].join('\n');
  const app = await project(source);
  try {
    const result = await app.run();
    assert.equal(result.report.execution.exitCode, 0, 'Playwright itself sees the swallowed exception as passed');
    assert.equal(result.report.verdict, 'failed');
    assert.equal(result.report.cases[0].reason, 'CASE_FAILED');
    assert.equal(result.report.cases[0].cleanup.status, 'completed');
    assert.ok(result.report.cases[0].assertionsObserved >= 1);
    assert.equal(await readFile(path.join(app.root, 'cleaned'), 'utf8'), '1');
    assert.equal(JSON.stringify(result.report).includes('private assertion diagnostic'), false);
  } finally { await app.close(); }
});
integration('missing or duplicate helper outcome annotations cannot produce a pass', async t => {
  for (const [name, change] of [
    ['missing-body', "info.annotations.splice(info.annotations.findIndex(a => a.type === 'testlane-body'), 1);"],
    ['duplicate-body', "info.annotations.push({type:'testlane-body',description:'completed'});"],
    ['duplicate-started', "info.annotations.push({type:'testlane-started',description:'create-note'});"],
    ['duplicate-cleanup', "info.annotations.push({type:'testlane-cleanup',description:'completed'});"],
    ['duplicate-helper', "const helper = info.annotations.find(a => a.type === 'testlane-helper'); info.annotations.push({...helper});"],
  ]) await t.test(name, async () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "import { runCase } from './testlane-authoring.mjs';",
      "test('invalid annotations', { annotation: { type: 'testlane-case', description: 'create-note' } }, async ({}, info) => {",
      "await runCase(info, 'create-note', { run: async () => expect(1).toBe(1), cleanup: async () => {} });",
      change, '});',
    ].join('\n');
    const app = await project(source);
    try { const result = await app.run(); assert.equal(result.report.execution.exitCode, 0); assert.notEqual(result.report.verdict, 'passed'); }
    finally { await app.close(); }
  });
});
integration('same real Chromium spec fails broken behavior, passes fixed behavior and verifies cleanup in both', async () => {
  let broken = true; let notes = 0;
  const secret = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    if (req.url === '/notes' && req.method === 'POST') { notes += broken ? 2 : 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count: notes })); }
    else if (req.url === '/notes' && req.method === 'DELETE') { notes = 0; res.writeHead(204); res.end(); }
    else if (req.url === '/notes') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count: notes })); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Notes</h1><button>Add note</button><output>0</output><script>document.querySelector("button").onclick=async()=>{const r=await fetch("/notes",{method:"POST"});document.querySelector("output").textContent=(await r.json()).count}</script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const source = [
    "import { test, expect } from '@playwright/test';",
    "import { runCase, captureScreenshot } from './testlane-authoring.mjs';",
    "test('private runtime title', { annotation: { type: 'testlane-case', description: 'create-note' } }, async ({ page, request }, info) => {",
    "await runCase(info, 'create-note', { run: async () => {",
    "console.log(" + JSON.stringify(secret) + ");",
    "await page.goto('/'); await page.getByRole('button', { name: 'Add note', exact: true }).click();",
    "await expect(page.locator('output')).toHaveText('1', { timeout: 1000 });",
    "await captureScreenshot(info, page, 'note-created');",
    "}, cleanup: async () => { await request.delete('/notes'); const response = await request.get('/notes'); expect((await response.json()).count).toBe(0); } }); });",
  ].join('\n');
  const app = await project(source, { origin, screenshots: 'manual' });
  try {
    const failed = await app.run(); assert.equal(failed.report.verdict, 'failed'); assert.equal(failed.report.cases[0].cleanup.status, 'completed'); assert.equal(notes, 0);
    broken = false;
    const passed = await app.run(); assert.equal(passed.report.verdict, 'passed'); assert.equal(notes, 0);
    assert.equal(passed.report.plan.sha256, failed.report.plan.sha256); assert.deepEqual(passed.report.specs, failed.report.specs);
    assert.equal(passed.report.artifacts.length, 1); assert.equal(passed.report.artifacts[0].private, true); assert.equal(passed.report.artifacts[0].review, 'unreviewed');
    assert.equal(path.isAbsolute(passed.report.artifacts[0].path), false);
    assert.equal(JSON.stringify([failed.report, passed.report]).includes(secret), false);
    assert.equal(JSON.stringify(passed.report).includes('Private descriptive'), false);
    assert.equal(JSON.stringify(passed.report).includes(origin), false);
    for (const result of [failed, passed]) {
      for (const file of await readdir(path.join(result.directory, '.control'))) {
        const bytes = await readFile(path.join(result.directory, '.control', file));
        assert.equal(bytes.includes(Buffer.from(secret)), false);
      }
    }
  } finally { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
integration('cancellation is bounded and cannot claim a pass', async () => {
  const source = [
    "import { test } from '@playwright/test';",
    "import { writeFile } from 'node:fs/promises';",
    "import { runCase } from './testlane-authoring.mjs';",
    "test('cancellation', { annotation: { type: 'testlane-case', description: 'create-note' } }, async ({ page }, info) => {",
    "await runCase(info, 'create-note', { run: async () => { await writeFile(new URL('./started', import.meta.url), '1'); await page.waitForTimeout(60000); }, cleanup: async () => {} }); });",
  ].join('\n');
  const app = await project(source);
  const controller = new AbortController();
  try {
    const pending = app.run(controller.signal);
    for (let i = 0; i < 200; i++) { if (await readFile(path.join(app.root, 'started')).then(() => true, () => false)) break; await new Promise(r => setTimeout(r, 50)); }
    const before = Date.now(); controller.abort();
    const result = await pending;
    assert.equal(result.report.verdict, 'cancelled'); assert.ok(Date.now() - before < 12000);
    if (result.report.execution.forced) assert.equal(result.report.cases[0].cleanup.status, 'unknown');
  } finally { await app.close(); }
});
