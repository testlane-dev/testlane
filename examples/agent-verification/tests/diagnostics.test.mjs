import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import VerificationReporter from '../reporter.mjs';
import { reconcile } from '../runtime.mjs';
import { diagnostic, validDiagnostic, runDiagnostics } from '../contracts.mjs';

const plan = { cases: [{ id: 'save-note', cleanup: { required: true } }] };
const execution = { exitCode: 1, cancelled: false, forced: false };

async function reported({ status = 'failed', body = 'failed', cleanup = 'completed', started = true,
  expectFailure = false, foreignLocation = false, globalError = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'testlane-safe-diagnostics-'));
  try {
    const secret = randomBytes(24).toString('base64url') + '+ /?' + String.fromCharCode(34, 92);
    const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
      new URLSearchParams({ v: secret }).toString().slice(2), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')];
    const observedError = { name: secret, message: variants.join('\n'), stack: root + '\n' + variants.join('\n'), cause: { private: secret } };
    const file = path.join(root, 'private-name.spec.mjs');
    const controlFile = path.join(root, 'control.json'), journalFile = path.join(root, 'journal.json');
    const helperHash = 'a'.repeat(64);
    await writeFile(controlFile, JSON.stringify({ helperVersion: '1', helperHash, cases: [{ id: 'save-note', spec: file }] }));
    const annotations = [{ type: 'testlane-case', description: 'save-note' }];
    if (started) annotations.push({ type: 'testlane-helper', description: '1:' + helperHash }, { type: 'testlane-started', description: 'save-note' });
    if (body !== null) annotations.push({ type: 'testlane-body', description: body });
    if (cleanup !== null) annotations.push({ type: 'testlane-cleanup', description: cleanup });
    const testCase = { id: secret, title: secret, location: { file }, annotations, expectedStatus: 'passed' };
    const result = { status, annotations, retry: 0, attachments: [], errors: [observedError] };
    const reporter = new VerificationReporter({ controlFile, journalFile });
    reporter.onBegin({ workers: 1, projects: [{ retries: 0 }] }, { allTests: () => [testCase] });
    reporter.onStdOut(variants.join('\n'), testCase, result);
    reporter.onStdErr(variants.join('\n'), testCase, result);
    // Ordinary action errors are not retained or classified by their text.
    reporter.onStepEnd(testCase, result, { category: 'pw:api', title: secret, error: observedError,
      location: { file, line: 9, column: 2 } });
    if (expectFailure) reporter.onStepEnd(testCase, result, { category: 'expect', error: observedError,
      location: { file: foreignLocation ? path.join(root, 'private-helper.mjs') : file, line: 12, column: 7 } });
    if (globalError) reporter.onError(observedError);
    reporter.onTestEnd(testCase, result);
    reporter.onEnd({ status: 'failed' });
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    const report = reconcile(plan, journal, execution);
    const retained = JSON.stringify({ journal, report });
    for (const value of [...variants, root, 'private-name.spec.mjs', 'private-helper.mjs']) assert.equal(retained.includes(value), false);
    return { journal, report };
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [name, options, code] of [
  ['throw without an expect', {}, 'CASE_BODY_FAILED'],
  ['setup before helper invocation', { started: false, body: null, cleanup: null }, 'CASE_SETUP_OR_CONTRACT_FAILED'],
  ['failed expect', { expectFailure: true }, 'ASSERTION_FAILED'],
  ['caught failed expect', { status: 'passed', body: 'completed', expectFailure: true }, 'ASSERTION_FAILED'],
  ['cleanup failure', { body: 'completed', cleanup: 'failed' }, 'CLEANUP_FAILED'],
  ['test timeout before helper completion', { status: 'timedOut', body: null, cleanup: null }, 'CASE_TIMED_OUT'],
  ['fixture teardown or code after the helper', { body: 'completed' }, 'CASE_AFTER_BODY_FAILED'],
]) test('fixed safe diagnostic for ' + name, async () => {
  const { report } = await reported(options);
  assert.notEqual(report.verdict, 'passed');
  assert.deepEqual(report.cases[0].diagnostic, diagnostic(code));
  assert.equal(validDiagnostic(report.cases[0].diagnostic), true);
  assert.equal(typeof report.cases[0].diagnostic.remedy, 'string');
});

test('only failed-expect coordinates in the bound planned spec are retained', async () => {
  const own = await reported({ expectFailure: true });
  assert.deepEqual(own.report.cases[0].failureLocation, { line: 12, column: 7 });
  const foreign = await reported({ expectFailure: true, foreignLocation: true });
  assert.equal(foreign.report.cases[0].failureLocation, null);
  assert.equal(foreign.report.cases[0].diagnostic.code, 'ASSERTION_FAILED');
});

test('run-level errors retain fixed recovery guidance and no observed values', async () => {
  const { report } = await reported({ globalError: true });
  assert.deepEqual(report.diagnostics, [diagnostic('GLOBAL_TEST_ERROR')]);
  const missing = reconcile(plan, null, { ...execution, startupFailed: true });
  assert.equal(missing.verdict, 'blocked');
  assert.ok(missing.diagnostics.some(value => value.code === 'RUNNER_START_FAILED'));
  assert.ok(missing.diagnostics.some(value => value.code === 'RUNNER_REPORT_UNAVAILABLE'));
  const timeout = reconcile(plan, { schemaVersion: 1, discovered: 0, errors: [], results: [], outcome: 'timedout' }, execution);
  assert.ok(timeout.diagnostics.some(value => value.code === 'RUN_TIMED_OUT'));
});

test('unknown or freeform diagnostic data is refused without echoing it', () => {
  const secret = randomBytes(32).toString('hex');
  assert.equal(validDiagnostic({ ...diagnostic('ASSERTION_FAILED'), summary: secret }), false);
  assert.equal(validDiagnostic({ ...diagnostic('ASSERTION_FAILED'), error: secret }), false);
  assert.equal(validDiagnostic({ code: secret, summary: secret, remedy: secret }), false);
  const row = { id: 'save-note', mapped: true, status: 'failed', expectedPassed: true, retry: 0,
    helper: true, started: true, cleanup: 'completed', assertionsObserved: 1, screenshots: [], unexpectedAttachments: false, diagnosticCode: secret };
  const report = reconcile(plan, { schemaVersion: 1, discovered: 1, errors: [], results: [row], outcome: 'failed' }, execution);
  assert.ok(report.reasonCodes.includes('REPORTER_INVALID'));
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(runDiagnostics(['PLAYWRIGHT_UNAVAILABLE', 'PLAYWRIGHT_UNAVAILABLE']), [diagnostic('PLAYWRIGHT_UNAVAILABLE')]);
});
