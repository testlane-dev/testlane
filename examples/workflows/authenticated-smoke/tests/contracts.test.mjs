import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveReport, parseReport } from '../report.mjs';
import { parseWorkflow, REQUIRED_SMOKE_STEPS } from '../manifest.mjs';

const workflow = parseWorkflow({ schemaVersion: 1, kind: 'authenticated-smoke', id: 'unit-smoke', profile: 'unit:local:admin', target: { origin: 'http://127.0.0.1:4311', environment: 'testing' }, identity: { email: 'unit@example.test', role: 'Admin' }, checks: { readinessPath: '/ready', identityPath: '/identity', protectedPath: '/protected', protectedHeading: 'Protected', apiPath: '/api/data' }, timeoutMs: 1000 });
const base = { schemaVersion: 1, kind: 'authenticated-smoke-report', workflowId: workflow.id, runId: 'unit-run', startedAt: '2026-09-25T00:00:00.000Z', finishedAt: '2026-09-25T00:00:01.000Z', sourceTree: null, target: { origin: workflow.target.origin, environment: workflow.target.environment, actualBuild: null }, profile: workflow.profile, cleanup: { status: 'complete', reasonCode: 'ok' } };
const passedSteps = REQUIRED_SMOKE_STEPS.map((id) => ({ id, status: 'passed', reasonCode: 'ok', durationMs: 1, attempt: 1 }));

test('manifest enforces profile, loopback target and bounded timeout', () => {
  assert.equal(workflow.profile, 'unit:local:admin');
  assert.throws(() => parseWorkflow({ ...workflow, target: { ...workflow.target, origin: 'https://production.example.test' } }));
  assert.throws(() => parseWorkflow({ ...workflow, timeoutMs: 999 }));
});

test('report verdict and counts are derived, and a failed assertion stays failed with missing later checks', () => {
  const report = deriveReport({ ...base, steps: [{ id: 'profile-policy', status: 'passed', reasonCode: 'ok', durationMs: 1, attempt: 1 }, { id: 'readiness', status: 'failed', reasonCode: 'assertion-failed', durationMs: 1, attempt: 1 }] });
  assert.equal(report.verdict, 'failed');
  assert.equal(report.counts.missing, 6);
  assert.deepEqual(parseReport(report).counts, report.counts);
});

test('complete report has exactly the eight required checks', () => {
  const report = deriveReport({ ...base, steps: passedSteps });
  assert.equal(report.verdict, 'passed');
  assert.equal(report.counts.passed, 8);
  assert.equal(report.zeroChecks, false);
});
