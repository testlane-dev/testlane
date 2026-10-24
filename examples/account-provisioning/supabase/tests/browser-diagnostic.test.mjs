/** Exact spec fragments and fixed sidecar contracts; no browser or services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { types } from 'node:util';
import VerificationReporter from '../../../agent-verification/reporter.mjs';
import { reconcile } from '../../../agent-verification/runtime.mjs';
import { readBrowserDiagnostic, writeBrowserDiagnostic } from '../browser-gate.mjs';
const source = () => readFile(new URL('../browser.spec.mjs', import.meta.url), 'utf8');
const normalized = value => JSON.parse(JSON.stringify(value));
async function owned(run) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'testlane-browser-diagnostic-'));
  try { return await run(root); } finally {
    assert.equal(path.dirname(await realpath(root)), parent); assert.ok(path.basename(root).startsWith('testlane-browser-diagnostic-'));
    await rm(root, { recursive: true, force: false });
  }
}
const facts = () => ({ creationStarted: true, responseObserved: true, responseCreated: true, bodyDecoded: true, idValid: true,
  journalWritten: true, captureFulfilled: true, clickFulfilled: true, rolesOpenedMs: 2, creationStartedMs: 3,
  responseMs: 4, decodeMs: 5, journalMs: 6, clickMs: 4, elapsedMs: 7, testTimeoutObserved: false });

test('exclusive nonce-bound fixed diagnostic distinguishes missing evidence from a complete snapshot', async () => owned(async root => {
  const nonce = randomBytes(24).toString('hex'); assert.equal(await readBrowserDiagnostic(root, nonce), null);
  await writeBrowserDiagnostic(root, nonce, facts()); assert.deepEqual(await readBrowserDiagnostic(root, nonce), facts());
  await assert.rejects(writeBrowserDiagnostic(root, nonce, facts()), { message: 'BROWSER_DIAGNOSTIC_REFUSED' });
  await assert.rejects(readBrowserDiagnostic(root, randomBytes(24).toString('hex')), { message: 'BROWSER_DIAGNOSTIC_REFUSED' });
  await assert.rejects(readBrowserDiagnostic(root + path.sep + '..' + path.sep + path.basename(root), nonce), { message: 'BROWSER_DIAGNOSTIC_REFUSED' });
}));
test('diagnostic refuses accessors, proxies, extra data, nonintegers and malformed/cross-case bytes without retaining values', async () => owned(async root => {
  const nonce = randomBytes(24).toString('hex'), canary = randomBytes(32).toString('base64url'); let invoked = 0;
  const getter = facts(); Object.defineProperty(getter, 'responseCreated', { enumerable: true, get() { invoked++; throw Error(canary); } });
  const proxy = new Proxy(facts(), { ownKeys() { invoked++; throw Error(canary); } });
  for (const value of [getter, proxy, { ...facts(), raw: canary }, { ...facts(), elapsedMs: 1.5 }, { ...facts(), elapsedMs: 180001 },
    { ...facts(), responseMs: 8 }, { ...facts(), bodyDecoded: canary }])
    await assert.rejects(writeBrowserDiagnostic(root, nonce, value), { message: 'BROWSER_DIAGNOSTIC_REFUSED' });
  assert.equal(invoked, 0); assert.equal(await readBrowserDiagnostic(root, nonce), null);
  for (const text of [JSON.stringify({ schemaVersion: 1, nonce, caseId: 'another-case', facts: facts() }) + '\n',
    JSON.stringify({ schemaVersion: 1, nonce, caseId: 'provisioned-browser-lifecycle', facts: { ...facts(), raw: canary } }) + '\n',
    '{"schemaVersion":1,"schemaVersion":1,"nonce":' + JSON.stringify(nonce) + '}\n', canary]) {
    await writeFile(path.join(root, 'creation-diagnostic.json'), text);
    await assert.rejects(readBrowserDiagnostic(root, nonce), { message: 'BROWSER_DIAGNOSTIC_REFUSED' });
  }
}));
test('actual reader maps retained-handle close rejection to a fixed refusal without raw error data', async () => owned(async root => {
  const nonce = randomBytes(24).toString('hex'), canary = randomBytes(32).toString('base64url');
  await writeBrowserDiagnostic(root, nonce, facts()); const bytes = await readFile(path.join(root, 'creation-diagnostic.json'));
  const code = (await readFile(new URL('../browser-gate.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export async function ', 'async function ');
  let closes = 0; const info = { size: BigInt(bytes.length), dev: 1n, ino: 2n, isFile: () => true, isSymbolicLink: () => false };
  const read = vm.runInNewContext(code + '\nreadBrowserDiagnostic;', { assert, path, types, constants, Buffer,
    realpath: async value => value, lstat: async () => info,
    open: async () => ({ stat: async () => info, read: async buffer => { bytes.copy(buffer); return { bytesRead: bytes.length }; },
      close: async () => { closes++; throw Error(canary); } }) });
  await assert.rejects(read(root, nonce), { message: 'BROWSER_DIAGNOSTIC_REFUSED' }); assert.equal(closes, 1);
}));

async function fragments() {
  const text = await source(), setupStart = text.indexOf('  let editor, reviewer, recordId, creation, actionPromise;'), setupEnd = text.indexOf('  await runCase(', setupStart);
  const createStart = text.indexOf('    diagnostic.creationStarted = true;'), createEnd = text.indexOf('\n    await expect(editor.page.locator', createStart);
  assert.ok(setupStart > 0 && setupEnd > setupStart && createStart > setupEnd && createEnd > createStart);
  const fixed = text.split('\n').find(line => line.startsWith('const fixed = ')); assert.ok(fixed);
  return { text, setup: text.slice(setupStart, setupEnd), create: text.slice(createStart, createEnd), fixed };
}
for (const mode of ['success', 'response-failed', 'decode-failed', 'journal-failed', 'click-failed', 'invalid-id', 'not-created']) {
  test('actual creation fragment exposes only fixed boundary facts: ' + mode, async () => owned(async root => {
    const part = await fragments(), secret = randomBytes(32).toString('base64url'), id = randomUUID(), clock = { value: 1000 }, observations = [], writes = [];
    const specFile = path.join(root, 'browser.spec.mjs'), helperHash = randomBytes(32).toString('hex'), control = path.join(root, 'control.json');
    await writeFile(control, JSON.stringify({ cases: [{ id: 'provisioned-browser-lifecycle', spec: specFile }], helperVersion: '1', helperHash }));
    const reporter = new VerificationReporter({ controlFile: control, journalFile: path.join(root, 'journal.json') });
    const item = { id: 'fixed-case', location: { file: specFile }, expectedStatus: 'passed', annotations: [{ type: 'testlane-case', description: 'provisioned-browser-lifecycle' }] };
    const result = { status: mode === 'success' ? 'passed' : 'failed', retry: 0, attachments: [], annotations: [
      { type: 'testlane-helper', description: '1:' + helperHash }, { type: 'testlane-started', description: 'provisioned-browser-lifecycle' },
      { type: 'testlane-body', description: mode === 'success' ? 'completed' : 'failed' }, { type: 'testlane-cleanup', description: mode === 'success' ? 'completed' : 'failed' }] };
    reporter.onBegin({ workers: 1, projects: [{ retries: 0 }] }, { allTests: () => [item] });
    let clickCount = 0;
    const advance = value => { clock.value = Math.max(clock.value, value); };
    const response = { url: () => 'http://127.0.0.1:43123/api/records', request: () => ({ method: () => 'POST' }), status: () => mode === 'not-created' ? 400 : 201,
      json: async () => { advance(13000); if (mode === 'decode-failed') throw Error(secret); return mode === 'invalid-id' ? {} : { id }; } };
    const fakeEditor = { page: { waitForResponse: predicate => { assert.equal(predicate(response), true); advance(12000); return mode === 'response-failed' ? Promise.reject(Error(secret)) : Promise.resolve(response); },
      getByRole: (kind, options) => { assert.equal(kind, 'button'); assert.deepEqual(normalized(options), { name: 'Create record', exact: true }); return {
        click: async () => { clickCount++; advance(12000); if (mode === 'click-failed') throw Error(secret); } }; } } };
    const context = { path, Promise, Map, JSON, Error, config: { gateDirectory: root, nonce: randomBytes(24).toString('hex'), fixture: { baseURL: 'http://127.0.0.1:43123' } },
      info: { status: 'passed' }, performance: { now: () => clock.value }, fakeEditor, clock,
      writeFile: async () => { advance(14000); if (mode === 'journal-failed') throw Error(secret); },
      writeBrowserDiagnostic: async (...args) => writes.push(normalized(args)),
      expect: (actual, message) => ({ toBe: expected => {
        assert.equal(typeof actual, 'boolean'); observations.push({ message, actual });
        const candidates = part.text.split('\n').map((line, i) => ({ line, i })).filter(value => value.line.includes(JSON.stringify(message).slice(1, -1)));
        const chosen = candidates.find(value => actual === false ? value.line.includes('expect(false,') : value.line.includes('expect(true,')) ?? candidates[0]; assert.ok(chosen);
        reporter.onStepEnd(item, result, { category: 'expect', error: actual === expected ? undefined : {}, location: { file: specFile, line: chosen.i + 1, column: 1 } });
        if (actual !== expected) throw Error('CONTROLLED_ASSERTION');
      } }) };
    const run = vm.runInNewContext('(async()=>{' + part.fixed + '\n' + part.setup + '\neditor=fakeEditor;diagnostic.rolesOpenedMs=9000;clock.value=11000;let failed=false;try{await fixed(async()=>{' + part.create + '});}catch{failed=true;}await recordDiagnostic();return {failed,diagnostic};})', context);
    const observed = normalized(await run()); reporter.onTestEnd(item, result);
    assert.equal(observed.failed, mode !== 'success'); assert.equal(clickCount, 1); assert.equal(writes.length, 1);
    assert.equal(observed.diagnostic.creationStartedMs, 10000); assert.equal(observed.diagnostic.testTimeoutObserved, false);
    assert.equal(JSON.stringify({ observed, observations, writes, report: reporter.results }).includes(secret), false);
    if (mode === 'response-failed') { assert.equal(observed.diagnostic.responseObserved, false); assert.equal(observed.diagnostic.bodyDecoded, null); }
    if (mode === 'decode-failed') assert.equal(observed.diagnostic.bodyDecoded, false);
    if (mode === 'journal-failed') { assert.equal(observed.diagnostic.idValid, true); assert.equal(observed.diagnostic.journalWritten, false); }
    if (mode === 'click-failed') assert.equal(observed.diagnostic.clickFulfilled, false);
    if (mode === 'invalid-id') assert.equal(observed.diagnostic.idValid, false);
    if (mode === 'not-created') assert.equal(observed.diagnostic.responseCreated, false);
    if (mode !== 'success') assert.equal(observations.find(value => !value.actual)?.message, {
      'response-failed': 'Editor creation response arrived', 'decode-failed': 'Editor creation response JSON decoded',
      'journal-failed': 'Editor owned-record journal written', 'click-failed': 'Editor creation click settled',
      'invalid-id': 'Editor creates a journaled owned record', 'not-created': 'Editor creates a journaled owned record',
    }[mode]);
    const report = reconcile({ cases: [{ id: 'provisioned-browser-lifecycle', cleanup: { required: true } }] },
      { schemaVersion: 1, discovered: 1, errors: [], outcome: result.status, results: reporter.results }, { exitCode: mode === 'success' ? 0 : 1, cancelled: false, forced: false });
    assert.equal(report.cases[0].reason, mode === 'success' ? 'CASE_PASSED' : 'CLEANUP_FAILED');
    assert.equal(report.cases[0].failureLocation !== null, mode !== 'success');
  }));
}
test('actual cleanup diagnostic joins capture and click, records timeout observation separately, and never replaces the original failure', async () => {
  const part = await fragments(), clock = { value: 1000 }, writes = []; let captureDone, clickDone;
  const capture = new Promise(resolve => { captureDone = resolve; }), click = new Promise(resolve => { clickDone = resolve; });
  const context = { path, Promise, Map, JSON, config: { gateDirectory: path.resolve('owned'), nonce: randomBytes(24).toString('hex') },
    info: { status: 'timedOut' }, performance: { now: () => clock.value }, writeBrowserDiagnostic: async (...args) => { writes.push(normalized(args)); throw Error('CONTROLLED_WRITE_FAILURE'); } };
  const methods = vm.runInNewContext('(()=>{' + part.setup + '\nreturn {finish:recordDiagnostic,set:(a,b)=>{creation=a;actionPromise=b;}};})()', context);
  const author = await readFile(new URL('../../../agent-verification/authoring.mjs', import.meta.url), 'utf8');
  const begin = author.indexOf('export async function runCase'), end = author.indexOf('\n/**', begin + 10); assert.ok(begin > 0 && end > begin);
  const runCase = vm.runInNewContext('(' + author.slice(begin, end).replace('export ', '') + ')', {
    control: () => ({ cases: [{ id: 'provisioned-browser-lifecycle', cleanupRequired: true }] }), active: new WeakMap(),
    AUTHORING_VERSION: '1', selfHash: randomBytes(32).toString('hex'), fail: code => Error(code),
    annotate: (info, type, description) => info.annotations.push({ type, description }) });
  const original = Error('CONTROLLED_BODY_FAILURE'), info = { annotations: [{ type: 'testlane-case', description: 'provisioned-browser-lifecycle' }] };
  methods.set(capture, click); clock.value = 32000;
  const joined = runCase(info, 'provisioned-browser-lifecycle', { run: async () => { throw original; }, cleanup: () => methods.finish() });
  const outcome = assert.rejects(joined, error => error === original);
  await Promise.resolve(); assert.equal(writes.length, 0);
  captureDone(); await Promise.resolve(); assert.equal(writes.length, 0); clickDone(); await outcome;
  assert.equal(writes.length, 1); assert.equal(writes[0][2].elapsedMs, 31000); assert.equal(writes[0][2].testTimeoutObserved, true);
  assert.equal(writes[0][2].captureFulfilled, true); assert.equal(writes[0][2].clickFulfilled, true);
  assert.ok(part.text.indexOf('await recordDiagnostic();') < part.text.indexOf('if (recordId) {', part.text.indexOf('cleanup:')));
  assert.ok(part.text.includes("expect(response.status() === 201 && Boolean(recordId), 'Editor creates a journaled owned record').toBe(true);"));
});
test('elapsed time alone is not promoted to a timeout and an unstarted creation remains explicit incomplete evidence', async () => {
  const part = await fragments(), clock = { value: 1000 }, writes = [];
  const context = { path, Promise, Map, JSON, config: { gateDirectory: path.resolve('owned'), nonce: randomBytes(24).toString('hex') },
    info: { status: 'passed' }, performance: { now: () => clock.value }, writeBrowserDiagnostic: async (...args) => writes.push(normalized(args)) };
  const finish = vm.runInNewContext('(()=>{' + part.setup + '\nreturn recordDiagnostic;})()', context);
  clock.value = 32000; await finish();
  assert.equal(writes.length, 1); const value = writes[0][2]; assert.equal(value.elapsedMs, 31000);
  assert.equal(value.testTimeoutObserved, false); assert.equal(value.creationStarted, false);
  for (const key of ['responseCreated', 'bodyDecoded', 'idValid', 'journalWritten', 'captureFulfilled', 'clickFulfilled', 'creationStartedMs']) assert.equal(value[key], null);
});
