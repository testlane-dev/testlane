#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow } from './manifest.mjs';
import { deriveReport } from './report.mjs';
import { createDeadline, launchHintLine, browserInstallDirectory, runAuthenticatedChecks, runId, writeEvidence } from './runtime.mjs';
import { runSelfTest } from './self-test.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function usage() {
  process.stderr.write('usage: node run.mjs [--manifest file] [--broker-cli file] [--output-dir dir] [--json]\n');
}

function argsOf(argv) {
  const out = { manifest: path.join(here, 'workflow.json'), brokerCli: path.join(root, 'dist', 'cli.js'), outputDir: path.resolve(process.cwd(), 'output'), json: false, selfTest: false, selfTestCase: 'happy' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--broker-cli') out.brokerCli = argv[++i];
    else if (arg === '--output-dir') out.outputDir = argv[++i];
    else if (arg === '--self-test-case') out.selfTestCase = argv[++i];
    else { usage(); throw new Error('USAGE'); }
  }
  return out;
}

function reasonFor(code, status) {
  if (status === 'passed') return 'ok';
  if (status === 'cancelled' || code === 'CANCELLED') return 'cancelled';
  if (status === 'blocked') return 'blocked-prerequisite';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'PRODUCTION_REFUSED') return 'production-refused';
  if (code === 'LAUNCH_FAILED') return 'launch-failed';
  if (['BROKER_UNAVAILABLE', 'READINESS_UNAVAILABLE', 'PLAYWRIGHT_UNAVAILABLE'].includes(code)) return 'environment';
  if (['ORIGIN_MISMATCH', 'NON_LOOPBACK_TARGET', 'OFF_ORIGIN_PATH', 'STRATEGY_UNSUPPORTED'].includes(code)) return 'target-refused';
  if (code === 'BROKER_COMMAND_FAILED') return 'process-failed';
  return 'assertion-failed';
}

export async function main(argv) {
  const options = argsOf(argv);
  const startedAt = new Date().toISOString();
  const id = runId();
  let deadline;
  const steps = [];
  let workflow;
  let actualBuild = null;
  let cleanup = { status: 'complete', reasonCode: 'ok' };
  let launchHint = null;
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
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    if (options.selfTest) {
      const result = await runSelfTest({ caseName: options.selfTestCase });
      workflow = result.workflow;
      launchHint = launchHintLine({ code: result.code, hint: result.hint }, browserInstallDirectory(here));
      cleanup = result.cleanup?.status === 'failed' ? { status: 'failed', reasonCode: 'cleanup-failed' } : { status: 'complete', reasonCode: 'ok' };
      for (const observed of result.steps) steps.push({ id: observed.id, status: observed.status, reasonCode: reasonFor(observed.code, observed.status), durationMs: observed.durationMs, attempt: 1 });
      if (result.expectedFailure && result.code && steps.length === 0) steps.push({ id: 'profile-policy', status: 'failed', reasonCode: reasonFor(result.code, 'failed'), durationMs: 0, attempt: 1 });
    } else {
      workflow = parseWorkflow(JSON.parse(await readFile(options.manifest, 'utf8')));
      deadline = createDeadline(workflow.timeoutMs);
      if (cancelled) deadline.cancel();
      try {
        const result = await runAuthenticatedChecks({ workflow, brokerCli: options.brokerCli, deadline, onStep: (id, status, code, durationMs) => steps.push({ id, status, reasonCode: reasonFor(code, status), durationMs, attempt: 1 }) });
        actualBuild = result.actualBuild;
      } catch (error) {
        launchHint = launchHintLine(error, browserInstallDirectory(here));
        if (error?.code === 'CLEANUP_FAILED') cleanup = { status: 'failed', reasonCode: 'cleanup-failed' };
        else if (deadline.isCancelled()) cleanup = { status: 'complete' };
      }
    }
  } catch (error) {
    if (!workflow) {
      process.stderr.write('workflow smoke failed before execution\n');
      return 1;
    }
    if (deadline.isCancelled()) cleanup = { status: 'complete', reasonCode: 'cancelled' };
  } finally {
    process.removeListener('message', onMessage); process.removeListener('disconnect', onSignal);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  const report = deriveReport({ schemaVersion: 1, kind: 'authenticated-smoke-report', workflowId: workflow.id, runId: id, startedAt, finishedAt: new Date().toISOString(), sourceTree: null, target: { origin: workflow.target.origin, environment: workflow.target.environment, actualBuild }, profile: workflow.profile, steps, cleanup });
  deadline?.dispose?.();
  const evidence = await writeEvidence(options.outputDir, report);
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`); else process.stdout.write(`${report.verdict} (${evidence.report})\n`);
  // Human-facing stderr only (also under --json, which keeps stdout pure JSON):
  // the report and evidence never carry error text.
  if (launchHint !== null) process.stderr.write(`workflow smoke hint: ${launchHint}\n`);
  return report.verdict === 'passed' ? 0 : 1;
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

// Grace period for `process.exit()` below: long enough for a normal stdout
// flush, short enough not to matter to any caller's own timeout.
const FORCE_EXIT_GRACE_MS = 2_000;

if (isEntryPoint(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch { process.exitCode = 1; }
  // By the time main() resolves it has already derived the report, written
  // its evidence files and printed its own output: every piece of work this
  // run does is done. Empirically (see
  // examples/workflows/authenticated-smoke/tests/launch-failure.test.mjs's
  // hanging-binary case), passing chromium.launch() its own `timeout` is not
  // enough on its own: when that internal timeout and the run's outer
  // deadline race to fire at (by construction) almost the same instant, our
  // own deadline can win the race and let main() return while Playwright's
  // side of the same race is still mid-flight -- the promise this code is
  // still awaiting has moved on, but whatever Playwright leaves referenced
  // while it separately unwinds keeps Node's event loop alive with no work
  // left for this process to do (confirmed: without this, the process
  // measurably never exits on its own after such a race, even though the
  // report above is already complete and printed). Rather than let that hang
  // until whatever external timeout the caller happens to enforce
  // (clean-room's own child-process timeout, a CI job timeout, ...) kills it
  // with no evidence of why, force the exit on a short, fixed grace period.
  // `.unref()` means this never adds latency to the normal path: if nothing
  // else is keeping the loop alive, Node exits immediately and this timer
  // never fires at all.
  if (process.connected) process.disconnect();
  setTimeout(() => process.exit(process.exitCode), FORCE_EXIT_GRACE_MS).unref();
}
