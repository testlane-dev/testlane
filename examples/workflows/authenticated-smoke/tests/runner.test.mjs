import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveReport } from '../report.mjs';
import { runSelfTest } from '../self-test.mjs';

function reportFor(result) {
  const reason = (step) => step.status === 'passed' ? 'ok' : step.status === 'blocked' ? 'blocked-prerequisite' : step.status === 'cancelled' ? 'cancelled' : step.code === 'TIMEOUT' ? 'timeout' : 'assertion-failed';
  return deriveReport({ schemaVersion: 1, kind: 'authenticated-smoke-report', workflowId: result.workflow.id, runId: 'runner-regression', startedAt: '2026-09-25T00:00:00.000Z', finishedAt: '2026-09-25T00:00:01.000Z', sourceTree: null, target: { origin: result.workflow.target.origin, environment: result.workflow.target.environment, actualBuild: result.actualBuild ?? null }, profile: result.workflow.profile, steps: result.steps.map((step) => ({ id: step.id, status: step.status, reasonCode: reason(step), durationMs: step.durationMs, attempt: 1 })), cleanup: result.cleanup.status === 'failed' ? { status: 'failed', reasonCode: 'cleanup-failed' } : { status: 'complete', reasonCode: 'ok' } });
}

test('real Chromium happy path passes all required checks', async () => {
  const result = await runSelfTest();
  const report = reportFor(result);
  assert.equal(result.exitCode, 0);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.counts.passed, 8);
  assert.equal(result.cleanup.status, 'complete');
});

test('configured build identity is recorded only after readiness header matches', async () => {
  const result = await runSelfTest({ caseName: 'build-id' });
  assert.equal(result.exitCode, 0);
  assert.equal(reportFor(result).target.actualBuild, 'synthetic-build');
});

test('unexpected build headers are not provenance', async () => {
  const result = await runSelfTest({ caseName: 'unexpected-header' });
  const report = reportFor(result);
  assert.equal(result.exitCode, 0);
  assert.equal(report.target.actualBuild, null);
  assert.equal(JSON.stringify(report).includes('unobserved-canary'), false);
});

for (const [caseName, failedStep, expectedVerdict, expectedReason] of [
  ['wrong-role', 'identity', 'failed', 'assertion-failed'],
  ['auth-denied', 'identity', 'failed', 'assertion-failed'],
  ['off-origin', 'protected-page', 'failed', 'assertion-failed'],
  ['readiness-fail', 'readiness', 'blocked', 'blocked-prerequisite'],
  ['timeout', 'readiness', 'failed', 'timeout'],
  ['identity-timeout', 'identity', 'failed', 'timeout'],
  ['api-timeout', 'api', 'failed', 'timeout'],
]) {
  test(`${caseName} remains a nonzero ${expectedVerdict} report`, async () => {
    const result = await runSelfTest({ caseName });
    const report = reportFor(result);
    assert.equal(result.exitCode, 1);
    assert.equal(report.verdict, expectedVerdict);
    const observed = report.steps.find((step) => step.id === failedStep);
    assert.equal(observed?.id, failedStep);
    assert.equal(observed?.status, expectedVerdict === 'blocked' ? 'blocked' : 'failed');
    assert.equal(observed?.reasonCode, expectedReason);
    assert.equal(result.cleanup.status, 'complete');
  });
}

test('cancellation after session creation is cancelled and cleans up', async () => {
  const result = await runSelfTest({ caseName: 'cancel-after-session' });
  const report = reportFor(result);
  assert.equal(result.exitCode, 1);
  assert.equal(report.verdict, 'cancelled');
  assert.equal(report.steps.find((step) => step.id === 'session')?.status, 'passed');
  assert.equal(result.cleanup.status, 'complete');
});

test('cleanup failure cannot produce a false pass after successful checks', async () => {
  const result = await runSelfTest({ caseName: 'cleanup-failure' });
  const report = reportFor(result);
  assert.equal(result.exitCode, 1);
  assert.equal(report.verdict, 'failed');
  assert.equal(result.cleanup.status, 'failed');
  assert.equal(report.counts.passed, 8);
});

test('production-labelled metadata is refused before app contact', async () => {
  const result = await runSelfTest({ caseName: 'production-metadata' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.code, 'PRODUCTION_REFUSED');
  assert.equal(result.requests, 0);
  assert.equal(result.cleanup.status, 'complete');
});

test('unrelated production profile metadata does not block the selected loopback target', async () => {
  const result = await runSelfTest({ caseName: 'unrelated-production' });
  assert.equal(result.exitCode, 0);
  assert.equal(reportFor(result).verdict, 'passed');
});
