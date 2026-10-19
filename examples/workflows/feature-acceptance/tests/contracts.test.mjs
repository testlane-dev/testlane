import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseFeatureWorkflow } from '../manifest.mjs';
import { deriveFeatureReport, parseFeatureReport } from '../report.mjs';
import { reasonFor, reportFor, runCase, setupCase } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(here, '..', 'workflow.json');

test('the example workflow.json parses as a valid feature-acceptance manifest', async () => {
  const raw = JSON.parse(await readFile(workflowPath, 'utf8'));
  const workflow = parseFeatureWorkflow(raw);
  assert.equal(workflow.kind, 'feature-acceptance');
  assert.equal(workflow.target.origin, 'http://127.0.0.1:4310');
  assert.notEqual(workflow.roles.writer.profile, workflow.roles.reader.profile);
});

test('deriveFeatureReport round-trips a runner report (a real happy run), and parseFeatureReport accepts it', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.equal(run.error, null, run.error?.message);

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'passed');

  // Re-deriving from the report's own (non-derived) fields must reproduce it exactly.
  const { verdict: _v, counts: _c, missingRequiredSteps: _m, skippedRequiredSteps: _s, zeroChecks: _z, ...draft } = report;
  const rederived = deriveFeatureReport(draft);
  assert.deepEqual(rederived, report);

  const parsed = parseFeatureReport(report);
  assert.deepEqual(parsed, report);
});

test('parseFeatureReport rejects a report with a forged verdict', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.equal(run.error, null, run.error?.message);
  const report = reportFor(setup, run);
  const forged = { ...report, verdict: 'passed' === report.verdict ? 'failed' : 'passed' };
  assert.throws(() => parseFeatureReport(forged));
});

test('reasonFor maps a blocked step to blocked-prerequisite regardless of its code', () => {
  assert.equal(reasonFor('RECEIPT_MISSING', 'blocked'), 'blocked-prerequisite');
  assert.equal(reasonFor('BROKER_COMMAND_FAILED', 'failed'), 'process-failed');
  assert.equal(reasonFor('PRODUCTION_REFUSED', 'failed'), 'production-refused');
  assert.equal(reasonFor('TIMEOUT', 'failed'), 'timeout');
  assert.equal(reasonFor('CANCELLED', 'cancelled'), 'cancelled');
  assert.equal(reasonFor('SOMETHING_ELSE', 'failed'), 'assertion-failed');
});
