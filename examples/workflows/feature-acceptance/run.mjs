#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeatureWorkflow, parseTestEnvironmentReceipt } from './manifest.mjs';
import { deriveFeatureReport } from './report.mjs';
// runtime.mjs is loaded dynamically inside main(), not imported here at the
// top level: it statically imports ../authenticated-smoke/runtime.mjs, and if
// this template is ever copied without that sibling directory, a top-level
// import would throw ERR_MODULE_NOT_FOUND while Node is still resolving the
// module graph -- before any of this file's own code, and any try/catch in
// it, can run. See the dynamic import in main() below.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function usage() {
  process.stderr.write('usage: node run.mjs --manifest file --receipt file [--broker-cli file] [--output-dir dir] [--json]\n');
}

function argsOf(argv) {
  const out = {
    manifest: path.join(here, 'workflow.json'),
    receipt: undefined,
    brokerCli: path.join(root, 'dist', 'cli.js'),
    outputDir: path.resolve(process.cwd(), 'output'),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--receipt') out.receipt = argv[++i];
    else if (arg === '--broker-cli') out.brokerCli = argv[++i];
    else if (arg === '--output-dir') out.outputDir = argv[++i];
    else {
      usage();
      throw new Error('USAGE');
    }
  }
  return out;
}

/** Same run-id format as the smoke package: an ISO timestamp plus random hex. */
function runId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(6).toString('hex')}`;
}

/**
 * Maps a step's raw SmokeError code (and its already-classified status) to
 * the shared reason-code set. Exported (it was previously module-private)
 * purely so tests/launch-failure.test.mjs can assert this exact mapping
 * directly, without duplicating it (see tests/helpers.mjs's own documented
 * mirror of this function, which existing tests already rely on for the
 * other codes) or spinning up a browser-launch-failure fixture just to
 * exercise it end-to-end; no caller behaviour changes.
 */
export function reasonFor(code, status) {
  if (status === 'passed') return 'ok';
  if (status === 'cancelled' || code === 'CANCELLED') return 'cancelled';
  if (status === 'blocked') return 'blocked-prerequisite';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'PRODUCTION_REFUSED') return 'production-refused';
  if (code === 'LAUNCH_FAILED') return 'launch-failed';
  if (['BROKER_UNAVAILABLE', 'READINESS_UNAVAILABLE', 'PLAYWRIGHT_UNAVAILABLE'].includes(code)) return 'environment';
  if (['ORIGIN_MISMATCH', 'NON_LOOPBACK_TARGET', 'OFF_ORIGIN_PATH', 'STRATEGY_UNSUPPORTED', 'RECEIPT_INVALID', 'RECEIPT_MISMATCH', 'ENVIRONMENT_MISMATCH'].includes(code)) {
    return 'target-refused';
  }
  if (code === 'BROKER_COMMAND_FAILED') return 'process-failed';
  return 'assertion-failed';
}

async function loadReceipt(receiptPath) {
  if (receiptPath === undefined) return { receipt: null, receiptProblem: 'missing' };
  let raw;
  try {
    raw = await readFile(receiptPath, 'utf8');
  } catch {
    return { receipt: null, receiptProblem: 'missing' };
  }
  try {
    const receipt = parseTestEnvironmentReceipt(JSON.parse(raw));
    return { receipt, receiptProblem: null };
  } catch {
    return { receipt: null, receiptProblem: 'invalid' };
  }
}

export async function main(argv) {
  const options = argsOf(argv);
  const startedAt = new Date().toISOString();
  const id = runId();
  let deadline;
  const steps = [];
  let workflow;
  let actualBuild = null;
  let environmentRun = null;
  let cleanup = { status: 'complete', record: 'none' };
  let cancelled = false;
  const onSignal = () => { cancelled = true; deadline?.cancel(); };
  const onMessage = (message) => { if (message === 'testlane:workflow:cancel:v1') onSignal(); };
  process.on('message', onMessage);
  process.once('disconnect', onSignal);
  // The parent waits for this handshake before sending a cancellation. Keep
  // the flag above even while manifest/runtime loading precedes the deadline.
  if (process.connected && typeof process.send === 'function') {
    try { process.send('testlane:workflow:ready:v1', () => {}); } catch { onSignal(); }
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let runtime;
  try {
    runtime = await import('./runtime.mjs');
  } catch {
    process.removeListener('message', onMessage); process.removeListener('disconnect', onSignal);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.stderr.write(
      'feature acceptance failed before execution: examples/workflows/authenticated-smoke must be installed next to this template; see README\n',
    );
    return 1;
  }
  const { createDeadline, launchHintLine, browserInstallDirectory, runFeatureAcceptance, writeFeatureEvidence } = runtime;
  let launchHint = null;
  try {
    workflow = parseFeatureWorkflow(JSON.parse(await readFile(options.manifest, 'utf8')));
    const { receipt, receiptProblem } = await loadReceipt(options.receipt);
    deadline = createDeadline(workflow.timeoutMs);
    if (cancelled) deadline.cancel();
    try {
      const result = await runFeatureAcceptance({
        workflow,
        receipt,
        receiptProblem,
        brokerCli: options.brokerCli,
        deadline,
        onStep: (stepId, status, code, durationMs) => steps.push({ id: stepId, status, reasonCode: reasonFor(code, status), durationMs, attempt: 1 }),
      });
      actualBuild = result.actualBuild;
      environmentRun = result.environmentRun;
      cleanup = result.cleanup;
    } catch (error) {
      launchHint = launchHintLine(error, browserInstallDirectory(here));
      if (error?.cleanup) cleanup = error.cleanup;
      if (error?.actualBuild !== undefined) actualBuild = error.actualBuild;
      if (error?.environmentRun !== undefined) environmentRun = error.environmentRun;
    }
  } catch (error) {
    if (!workflow) {
      process.stderr.write('feature acceptance failed before execution\n');
      return 1;
    }
  } finally {
    process.removeListener('message', onMessage); process.removeListener('disconnect', onSignal);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  try {
    const report = deriveFeatureReport({
      schemaVersion: 1,
      kind: 'feature-acceptance-report',
      workflowId: workflow.id,
      runId: id,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceTree: null,
      target: { origin: workflow.target.origin, environment: workflow.target.environment, actualBuild },
      roles: { writer: workflow.roles.writer.profile, reader: workflow.roles.reader.profile },
      environmentRun,
      steps,
      cleanup: { status: cleanup.status, reasonCode: cleanup.status === 'failed' ? 'cleanup-failed' : 'ok', record: cleanup.record },
    });
    const evidence = await writeFeatureEvidence(options.outputDir, report);
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write(`${report.verdict} (${evidence.report})\n`);
    // Human-facing stderr only (also under --json, which keeps stdout pure JSON):
    // the report and evidence never carry error text.
    if (launchHint !== null) process.stderr.write(`feature acceptance hint: ${launchHint}\n`);
    if (report.verdict !== 'passed') {
      const stopped = report.steps.find((step) => step.status !== 'passed');
      const diagnostic = stopped ? `${stopped.id} (${stopped.reasonCode})` : report.cleanup.status === 'failed' ? 'cleanup (cleanup-failed)' : 'required checks incomplete';
      process.stderr.write(`feature acceptance ${report.verdict}: ${diagnostic}\n`);
    }
    return report.verdict === 'passed' ? 0 : 1;
  } catch {
    // Report validation and evidence I/O can fail too. Never swallow those
    // errors or print raw browser/broker/validation text containing inputs.
    process.stderr.write('feature acceptance failed while finalizing evidence\n');
    return 1;
  } finally {
    deadline?.dispose?.();
  }
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): on macOS the OS tmpdir is itself a symlink (/var ->
// /private/var), so a script invoked as `node /var/.../run.mjs` gets
// process.argv[1] === '/var/.../run.mjs' while import.meta.url resolves to
// the realpath '/private/var/.../run.mjs' -- a plain path.resolve() compare
// never matches, main() silently never runs, and the process exits 0 with no
// output.
function isEntryPoint(metaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

// See the identical guard (and the empirical justification for keeping it
// even after chromium.launch() is given its own `timeout`) in
// ../authenticated-smoke/run.mjs.
const FORCE_EXIT_GRACE_MS = 2_000;

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write('feature acceptance failed before evidence could be finalized\n');
    process.exitCode = 1;
  }
  if (process.connected) process.disconnect();
  setTimeout(() => process.exit(process.exitCode), FORCE_EXIT_GRACE_MS).unref();
}
