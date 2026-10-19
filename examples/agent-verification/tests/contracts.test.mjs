import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePlan } from '../contracts.mjs';
import { reconcile, runVerification } from '../runtime.mjs';
import { runCase, captureScreenshot } from '../authoring.mjs';
import VerificationReporter from '../reporter.mjs';

const fixture = () => ({ schemaVersion: 1, status: 'reviewed', title: 'Check a disposable note', target: { baseUrl: 'http://127.0.0.1:3000', environment: 'testing' },
  cases: [{ id: 'create-note', title: 'Create a note', spec: 'note.spec.mjs', expected: ['One note is visible'], cleanup: { required: true, description: 'Delete and verify absence' } }] });
const row = () => ({ id: 'create-note', mapped: true, status: 'passed', expectedPassed: true, retry: 0, assertionsObserved: 1, helper: true, started: true, cleanup: 'completed', screenshots: [], unexpectedAttachments: false });
const journal = rows => ({ schemaVersion: 1, discovered: rows.length, errors: [], outcome: 'passed', results: rows });
const execution = { exitCode: 0, cancelled: false, forced: false };
test('valid origins and explicit screenshot policy are normalized', () => {
  assert.equal(validatePlan(fixture()).evidence.screenshots, 'off');
  const plan = fixture(); plan.target.baseUrl = 'https://example.test/'; plan.evidence = { screenshots: 'manual' };
  assert.equal(validatePlan(plan).target.baseUrl, 'https://example.test');
});
for (const [name, change] of [
  ['zero cases', p => { p.cases = []; }], ['duplicate IDs', p => p.cases.push({ ...p.cases[0] })],
  ['production label', p => { p.target.environment = 'production'; }], ['remote HTTP', p => { p.target.baseUrl = 'http://example.test'; }],
  ['production hostname', p => { p.target.baseUrl = 'https://production.example.test'; }],
  ['live hostname', p => { p.target.baseUrl = 'https://live.example.test'; }],
  ['numeric ID', p => { p.cases[0].id = 7; }],
  ['origin credentials', p => { p.target.baseUrl = 'https://name:password@example.test'; }],
  ['origin query', p => { p.target.baseUrl = 'https://example.test/?private=value'; }],
  ['origin fragment', p => { p.target.baseUrl = 'https://example.test/#private'; }],
  ['target path', p => { p.target.baseUrl = 'https://example.test/page'; }],
  ['arbitrary config', p => { p.command = 'anything'; }], ['missing expectations', p => { p.cases[0].expected = []; }],
  ['implicit cleanup', p => { delete p.cases[0].cleanup; }],
]) test('invalid plan refuses ' + name, () => { const p = fixture(); change(p); assert.throws(() => validatePlan(p), /PLAN_INVALID/); });
test('a real passing result with completed cleanup can pass', () => assert.equal(reconcile(fixture(), journal([row()]), execution).verdict, 'passed'));
for (const [name, mutate] of [
  ['skipped', r => { r.status = 'skipped'; }], ['expected failure', r => { r.expectedPassed = false; }],
  ['retry', r => { r.retry = 1; }], ['missing helper', r => { r.helper = false; }],
  ['no helper invocation', r => { r.started = false; }], ['cleanup missing', r => { r.cleanup = 'unknown'; }],
  ['cleanup opted out despite plan', r => { r.cleanup = 'not-required'; }],
  ['cleanup failure', r => { r.cleanup = 'failed'; }], ['test failure', r => { r.status = 'failed'; }],
  ['timeout', r => { r.status = 'timedOut'; }], ['unapproved attachment', r => { r.unexpectedAttachments = true; }],
  ['unknown case', r => { r.id = 'unknown'; }], ['mapping invalid', r => { r.mapped = false; }],
  ['action-only case', r => { r.assertionsObserved = 0; }],
]) test('cannot pass ' + name, () => { const r = row(); mutate(r); assert.notEqual(reconcile(fixture(), journal([r]), execution).verdict, 'passed'); });
test('zero tests, missing, duplicated, global errors and process failure fail closed', () => {
  assert.notEqual(reconcile(fixture(), journal([]), execution).verdict, 'passed');
  assert.notEqual(reconcile(fixture(), journal([row(), row()]), execution).verdict, 'passed');
  assert.notEqual(reconcile(fixture(), { ...journal([row()]), errors: ['GLOBAL_TEST_ERROR'] }, execution).verdict, 'passed');
  assert.notEqual(reconcile(fixture(), journal([row()]), { ...execution, exitCode: 1 }).verdict, 'passed');
  assert.notEqual(reconcile(fixture(), null, execution).verdict, 'passed');
});
test('forced cancellation cannot retain a completed-cleanup claim', () => {
  const report = reconcile(fixture(), journal([row()]), { exitCode: null, cancelled: true, forced: true });
  assert.equal(report.verdict, 'cancelled'); assert.equal(report.cases[0].cleanup.status, 'unknown');
});
test('optional cleanup requires the explicit not-required result', () => {
  const p = fixture(); p.cases[0].cleanup.required = false;
  const r = row(); r.cleanup = 'not-required';
  assert.equal(reconcile(p, journal([r]), execution).verdict, 'passed');
});

test('only a valid numeric failure location is emitted for an unambiguous failed case', () => {
  const failed = { ...row(), status: 'failed', failureLocation: { line: 12, column: 7 } };
  const report = reconcile(fixture(), journal([failed]), execution);
  assert.equal(report.verdict, 'failed');
  assert.deepEqual(report.cases[0].failureLocation, { line: 12, column: 7 });
  assert.equal(reconcile(fixture(), journal([row()]), execution).cases[0].failureLocation, null, 'old rows remain compatible');
  assert.equal(reconcile(fixture(), journal([failed, failed]), execution).cases[0].failureLocation, null, 'duplicate cases cannot select an ambiguous location');
  assert.equal(reconcile(fixture(), journal([failed]), { exitCode: null, cancelled: true, forced: true }).cases[0].failureLocation, null);
});
for (const location of [
  'private observed value', [], { line: 0, column: 1 }, { line: 1.5, column: 1 },
  { line: 1, column: 1000001 }, { line: 1, column: -1 }, { line: '12', column: 1 },
  { line: 1, column: 1, file: 'private-source.mjs' }, { line: 1 },
]) test('invalid failure location is blocked without retaining its value: ' + JSON.stringify(location), () => {
  const result = reconcile(fixture(), journal([{ ...row(), status: 'failed', failureLocation: location }]), execution);
  assert.ok(result.reasonCodes.includes('REPORTER_INVALID'));
  assert.equal(result.cases[0].failureLocation, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('reporter retains only the first valid failed-expect coordinates in the exact planned spec', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'testlane-reporter-location-'));
  try {
    const specFile = path.join(root, 'note.spec.mjs');
    const controlFile = path.join(root, 'control.json');
    const journalFile = path.join(root, 'journal.json');
    const helperHash = 'a'.repeat(64);
    await writeFile(controlFile, JSON.stringify({ helperVersion: '1', helperHash, cases: [{ id: 'create-note', spec: specFile }] }));
    const reporter = new VerificationReporter({ controlFile, journalFile });
    const annotations = [
      { type: 'testlane-case', description: 'create-note' },
      { type: 'testlane-helper', description: '1:' + helperHash },
      { type: 'testlane-started', description: 'create-note' },
      { type: 'testlane-body', description: 'completed' },
      { type: 'testlane-cleanup', description: 'completed' },
    ];
    const testCase = { id: 'test-1', location: { file: specFile }, annotations, expectedStatus: 'passed' };
    const result = { status: 'passed', annotations, retry: 0, attachments: [] };
    reporter.onBegin({ workers: 1, projects: [{ retries: 0 }] }, { allTests: () => [testCase] });
    for (const location of [
      { file: path.join(root, 'imported-helper.mjs'), line: 1, column: 1 },
      { file: specFile, line: 0, column: 1 }, { file: specFile, line: 1, column: 1000001 },
      { file: specFile, line: 12, column: 7 }, { file: specFile, line: 24, column: 8 },
    ]) reporter.onStepEnd(testCase, result, { category: 'expect', error: { message: 'private error value' }, location });
    reporter.onTestEnd(testCase, result);
    reporter.onEnd({ status: 'passed' });
    const recorded = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.equal(recorded.results[0].status, 'failed', 'caught expect stays failed despite completed helper body');
    assert.deepEqual(recorded.results[0].failureLocation, { line: 12, column: 7 });
    assert.equal(JSON.stringify(recorded).includes(root), false);
    assert.equal(JSON.stringify(recorded).includes('private error value'), false);
    assert.equal(JSON.stringify(recorded).includes('imported-helper'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function authoringContext(required, screenshots, run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'testlane-authoring-unit-'));
  const file = path.join(parent, 'control.json'), artifactDir = path.join(parent, 'artifacts');
  await mkdir(artifactDir);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, origin: 'http://127.0.0.1:3000', screenshots, artifactDir, cases: [{ id: 'create-note', cleanupRequired: required }] }));
  const previous = process.env.TESTLANE_VERIFICATION_CONTROL;
  process.env.TESTLANE_VERIFICATION_CONTROL = file;
  try { await run({ annotations: [{ type: 'testlane-case', description: 'create-note' }] }, artifactDir); }
  finally {
    if (previous === undefined) delete process.env.TESTLANE_VERIFICATION_CONTROL; else process.env.TESTLANE_VERIFICATION_CONTROL = previous;
    await rm(parent, { recursive: true, force: true });
  }
}
test('cleanup runs after assertion failure and its own failure is visible', async () => authoringContext(true, 'off', async info => {
  let cleaned = false;
  await assert.rejects(runCase(info, 'create-note', { run: async () => { throw new Error('private test error'); }, cleanup: async () => { cleaned = true; } }));
  assert.equal(cleaned, true); assert.equal(info.annotations.find(a => a.type === 'testlane-cleanup').description, 'completed');
  assert.equal(info.annotations.some(a => a.description.includes('private test error')), false);
}));
test('cleanup failure overrides an otherwise successful body', async () => authoringContext(true, 'off', async info => {
  await assert.rejects(runCase(info, 'create-note', { run: async () => {}, cleanup: async () => { throw new Error('private cleanup error'); } }), /CLEANUP_FAILED/);
  assert.equal(info.annotations.find(a => a.type === 'testlane-cleanup').description, 'failed');
}));
test('body error is preserved when cleanup also fails', async () => authoringContext(true, 'off', async info => {
  const original = new Error('private original diagnostic');
  await assert.rejects(runCase(info, 'create-note', { run: async () => { throw original; }, cleanup: async () => { throw new Error('private cleanup diagnostic'); } }), error => error === original);
  assert.equal(info.annotations.find(a => a.type === 'testlane-cleanup').description, 'failed');
  assert.equal(info.annotations.find(a => a.type === 'testlane-body').description, 'failed');
}));
test('required cleanup cannot be silently omitted', async () => authoringContext(true, 'off', async info => {
  let ran = false;
  await assert.rejects(runCase(info, 'create-note', { run: async () => { ran = true; } }), /CLEANUP_REQUIRED/);
  assert.equal(ran, false);
}));
test('screenshots require explicit reviewed manual opt-in', async () => authoringContext(false, 'off', async info => {
  await runCase(info, 'create-note', { run: async () => { await assert.rejects(captureScreenshot(info, {}, 'page'), /SCREENSHOT_NOT_ALLOWED/); } });
}));
test('draft plans create unique blocked reports without resolving Playwright or running code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'testlane-draft-unit-'));
  try {
    const plan = fixture(); plan.status = 'draft';
    const file = path.join(root, 'plan.json'); await writeFile(file, JSON.stringify(plan));
    const a = await runVerification({ planFile: file }), b = await runVerification({ planFile: file });
    assert.equal(a.report.verdict, 'blocked'); assert.deepEqual(a.report.reasonCodes, ['PLAN_NOT_REVIEWED']);
    assert.notEqual(a.directory, b.directory);
    assert.equal(a.report.plan.sha256, createHash('sha256').update(await readFile(file)).digest('hex'));
    assert.equal(JSON.stringify(a.report).includes(plan.title), false);
    assert.equal(JSON.stringify(a.report).includes(plan.target.baseUrl), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
