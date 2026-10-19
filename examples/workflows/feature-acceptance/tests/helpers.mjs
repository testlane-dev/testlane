/**
 * Shared test-only glue: builds a reference app, a matching feature-acceptance
 * manifest, a broker-double profile registry, and a trusted receipt, then
 * drives `runFeatureAcceptance` against them. Not itself a `*.test.mjs` file,
 * so `node --test tests/*.test.mjs` never runs it directly.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BROKER_DOUBLE_PATH, brokerDoubleConfig } from '../../test-support/broker-double.mjs';
import { issueReceipt } from '../../test-support/receipt.mjs';
import { REFERENCE_FORM, REFERENCE_PATHS, REFERENCE_ROLES, startReferenceApp } from '../../test-support/reference-app.mjs';
import { createDeadline } from '../../authenticated-smoke/runtime.mjs';
import { parseFeatureWorkflow } from '../manifest.mjs';
import { deriveFeatureReport } from '../report.mjs';
import { runFeatureAcceptance } from '../runtime.mjs';

export { BROKER_DOUBLE_PATH, createDeadline, runFeatureAcceptance };

export function hex(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

export function accountPair() {
  return {
    writer: { email: `writer-${hex(3)}@example.test`, role: REFERENCE_ROLES.writer, password: hex(9) },
    reader: { email: `reader-${hex(3)}@example.test`, role: REFERENCE_ROLES.reader, password: hex(9) },
  };
}

export function buildManifest({ origin, buildId, environment = 'testing', id, writer, reader, timeoutMs = 20_000, cleanupTimeoutMs = 8_000 }) {
  return {
    schemaVersion: 1,
    kind: 'feature-acceptance',
    id: id ?? `feature-test-${hex(4)}`,
    target: { origin, environment, buildId },
    roles: {
      writer: { profile: 'reference:local:writer', email: writer.email, role: writer.role },
      reader: { profile: 'reference:local:reader', email: reader.email, role: reader.role },
    },
    checks: { readinessPath: REFERENCE_PATHS.ready, identityPath: REFERENCE_PATHS.me, environmentPath: REFERENCE_PATHS.environment },
    record: { collectionPath: REFERENCE_PATHS.records, createPagePath: REFERENCE_PATHS.newRecord, form: REFERENCE_FORM },
    timeoutMs,
    cleanupTimeoutMs,
  };
}

export function buildProfiles({ origin, environment, writer, reader, extra = [] }) {
  return [
    { name: 'reference:local:writer', email: writer.email, role: writer.role, environment, baseUrl: origin, strategy: 'form-post' },
    { name: 'reference:local:reader', email: reader.email, role: reader.role, environment, baseUrl: origin, strategy: 'form-post' },
    ...extra,
  ];
}

const receiptDirs = new Set();

/** A throwaway directory for `issueReceipt`'s create-only file, tracked for cleanup. */
async function receiptDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'testlane-feature-test-receipt-'));
  receiptDirs.add(dir);
  return dir;
}

export async function cleanupReceiptDirs() {
  await Promise.all([...receiptDirs].map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  receiptDirs.clear();
}

/**
 * Assembles one case: a reference app, a parsed workflow, a broker-double
 * `ipcConfig`, and (unless `receiptProblem` is set) a matching receipt.
 * `manifestOverrides`/`receiptOverrides` are shallow-merged onto the default
 * shape so a case can, for example, target the wrong buildId deliberately.
 */
export async function setupCase({
  faults = {},
  environment = 'testing',
  manifestOverrides = {},
  extraProfiles = [],
  profilesFactory,
  receiptOverrides = {},
  receiptProblem = null,
  buildId: buildIdOverride,
  timeoutMs,
  cleanupTimeoutMs,
} = {}) {
  const buildId = buildIdOverride ?? `build-${hex(3)}`;
  const appRunId = `run-${hex(4)}`;
  const dataScope = `scope-${hex(3)}`;
  const { writer, reader } = accountPair();
  const app = await startReferenceApp({ accounts: [writer, reader], buildId, environment, runId: appRunId, dataScope, faults });

  const manifest = { ...buildManifest({ origin: app.origin, buildId, environment, writer, reader, timeoutMs, cleanupTimeoutMs }), ...manifestOverrides };
  const workflow = parseFeatureWorkflow(manifest);

  const profiles = profilesFactory
    ? profilesFactory({ origin: app.origin, environment, writer, reader })
    : buildProfiles({ origin: app.origin, environment, writer, reader, extra: extraProfiles });
  const ipcConfig = brokerDoubleConfig({ app, profiles });

  let receipt = null;
  if (receiptProblem === null) {
    const dir = await receiptDir();
    const issued = await issueReceipt({
      directory: dir,
      workflowId: manifest.id,
      runId: appRunId,
      environment,
      origin: app.origin,
      buildId,
      dataScope,
      ...receiptOverrides,
    });
    receipt = issued.receipt;
  }

  return { app, workflow, manifest, profiles, ipcConfig, receipt, receiptProblem, writer, reader, buildId, appRunId, dataScope };
}

/**
 * Runs `runFeatureAcceptance`, capturing steps, and returns `{ steps, result,
 * error, deadline }` (exactly one of `result`/`error` is set). `onStepExtra`
 * (id, status, code, durationMs, deadline) fires in addition to the built-in
 * step recorder, letting a test cancel the deadline or mutate the app's
 * faults at a precise point in the run (e.g. "right after browser-create
 * passes").
 */
export async function runCase(setup, { onStepExtra, ...overrides } = {}) {
  const steps = [];
  const deadline = overrides.deadline ?? createDeadline(setup.workflow.timeoutMs);
  const base = {
    workflow: setup.workflow,
    receipt: setup.receipt,
    receiptProblem: setup.receiptProblem,
    brokerCli: BROKER_DOUBLE_PATH,
    deadline,
    ipcConfig: setup.ipcConfig,
    onStep: (id, status, code, durationMs) => {
      steps.push({ id, status, code, durationMs });
      onStepExtra?.(id, status, code, durationMs, deadline);
    },
  };
  try {
    const result = await runFeatureAcceptance({ ...base, ...overrides });
    return { steps, result, error: null, deadline };
  } catch (error) {
    return { steps, result: null, error, deadline };
  }
}

export function stepFor(steps, id) {
  return steps.find((step) => step.id === id);
}

/** Mirrors run.mjs's own (unexported) reasonFor mapping, for building a report-shaped object in tests. */
export function reasonFor(code, status) {
  if (status === 'passed') return 'ok';
  if (status === 'cancelled' || code === 'CANCELLED') return 'cancelled';
  if (status === 'blocked') return 'blocked-prerequisite';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'PRODUCTION_REFUSED') return 'production-refused';
  if (['BROKER_UNAVAILABLE', 'READINESS_UNAVAILABLE', 'PLAYWRIGHT_UNAVAILABLE'].includes(code)) return 'environment';
  if (['ORIGIN_MISMATCH', 'NON_LOOPBACK_TARGET', 'OFF_ORIGIN_PATH', 'STRATEGY_UNSUPPORTED', 'RECEIPT_INVALID', 'RECEIPT_MISMATCH', 'ENVIRONMENT_MISMATCH'].includes(code)) {
    return 'target-refused';
  }
  if (code === 'BROKER_COMMAND_FAILED') return 'process-failed';
  return 'assertion-failed';
}

/** Builds the same report shape run.mjs would, from a `runCase()` result, via the real `deriveFeatureReport`. */
export function reportFor(setup, run) {
  const cleanup = run.error?.cleanup ?? run.result?.cleanup ?? { status: 'complete', record: 'none' };
  const actualBuild = run.result?.actualBuild ?? run.error?.actualBuild ?? null;
  const environmentRun = run.result?.environmentRun ?? run.error?.environmentRun ?? null;
  return deriveFeatureReport({
    schemaVersion: 1,
    kind: 'feature-acceptance-report',
    workflowId: setup.workflow.id,
    runId: `test-${hex(4)}`,
    startedAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:00:01.000Z',
    sourceTree: null,
    target: { origin: setup.workflow.target.origin, environment: setup.workflow.target.environment, actualBuild },
    roles: { writer: setup.workflow.roles.writer.profile, reader: setup.workflow.roles.reader.profile },
    environmentRun,
    steps: run.steps.map((step) => ({ id: step.id, status: step.status, reasonCode: reasonFor(step.code, step.status), durationMs: step.durationMs, attempt: 1 })),
    cleanup: { status: cleanup.status, reasonCode: cleanup.status === 'failed' ? 'cleanup-failed' : 'ok', record: cleanup.record },
  });
}
