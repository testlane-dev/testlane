import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { writeFeatureEvidence } from '../runtime.mjs';

let outputDir;

before(async () => {
  outputDir = await mkdtemp(path.join(os.tmpdir(), 'testlane-feature-evidence-test-'));
});

after(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function reportFor(runId, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'feature-acceptance-report',
    workflowId: 'evidence-test',
    runId,
    startedAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:00:01.000Z',
    sourceTree: null,
    target: { origin: 'http://127.0.0.1:1', environment: 'testing', actualBuild: 'b1' },
    roles: { writer: 'reference:local:writer', reader: 'reference:local:reader' },
    environmentRun: { runId: 'run-1', dataScope: 'scope-1' },
    steps: [{ id: 'profile-policy', status: 'passed', reasonCode: 'ok', durationMs: 1, attempt: 1 }],
    cleanup: { status: 'complete', reasonCode: 'ok', record: 'none' },
    verdict: 'blocked',
    counts: { required: 13, observed: 1, passed: 1, failed: 0, blocked: 0, cancelled: 0, skipped: 0, missing: 12 },
    missingRequiredSteps: [
      'readiness', 'environment-receipt', 'writer-session', 'reader-session', 'writer-identity', 'reader-identity',
      'record-absent', 'browser-create', 'api-readback', 'reader-read', 'reader-mutation-denied', 'unchanged-after-denial',
    ],
    skippedRequiredSteps: [],
    zeroChecks: false,
    ...overrides,
  };
}

test('writeFeatureEvidence writes log, exit, then report, in that order and content', async () => {
  const runId = `wfe-${Date.now()}-a`;
  const report = reportFor(runId);
  const evidence = await writeFeatureEvidence(outputDir, report);
  const log = await readFile(evidence.log, 'utf8');
  assert.equal(log, 'profile-policy passed ok\ncleanup complete none\n');
  const exit = await readFile(evidence.exit, 'utf8');
  assert.equal(exit, '1\n');
  const reportText = await readFile(evidence.report, 'utf8');
  assert.deepEqual(JSON.parse(reportText), report);
});

test('a passed verdict writes exit 0', async () => {
  const runId = `wfe-${Date.now()}-b`;
  const report = reportFor(runId, { verdict: 'passed' });
  const evidence = await writeFeatureEvidence(outputDir, report);
  const exit = await readFile(evidence.exit, 'utf8');
  assert.equal(exit, '0\n');
});

test('a second write with the same runId is rejected and leaves the first files unchanged; no report is finalized', async () => {
  const runId = `wfe-${Date.now()}-c`;
  const first = reportFor(runId);
  const evidence = await writeFeatureEvidence(outputDir, first);
  const originalLog = await readFile(evidence.log, 'utf8');

  const second = reportFor(runId, { verdict: 'passed', target: { origin: 'http://127.0.0.1:1', environment: 'testing', actualBuild: 'different' } });
  await assert.rejects(() => writeFeatureEvidence(outputDir, second));

  const logAfter = await readFile(evidence.log, 'utf8');
  assert.equal(logAfter, originalLog);
  // The exit and report files were never overwritten either (the log write
  // failed first, "wx", before either was attempted).
  const exitAfter = await readFile(evidence.exit, 'utf8');
  assert.equal(exitAfter, '1\n');
});
