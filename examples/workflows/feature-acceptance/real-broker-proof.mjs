#!/usr/bin/env node
/**
 * Real-broker feature-acceptance proof: runs the UNMODIFIED
 * `examples/workflows/feature-acceptance/run.mjs` CLI as a child process,
 * against a real, running reference app and the real built broker CLI
 * (`dist/cli.js`), inside a throwaway scratch home. Mirrors
 * `test-support/smoke-real-broker-proof.mjs`.
 *
 *   happy           - correct passwords for both roles: all 13 steps pass,
 *                      the record is created then verifiably deleted, and
 *                      the real broker's audit log shows a successful check
 *                      and session for both the writer and the reader.
 *   deny-but-mutate  - the app applies a reader mutation but still answers
 *                      403 (`readerMutation: 'deny-but-mutate'`):
 *                      `unchanged-after-denial` fails, but cleanup still
 *                      deletes and verifies the record.
 *   missing-receipt  - no `--receipt` is given: `environment-receipt` blocks
 *                      before any broker session is issued or the app sees
 *                      a login.
 *   wrong-identity   - the app reports a different role for the writer
 *                      (`identityRoleOverride`); the real broker's own
 *                      `check` asks the app and gets that wrong role, so
 *                      `writer-session` fails before any browser opens.
 *
 * Every case is booleans-only for leaked secrets and session tokens (see
 * verifyNoLeaks()). Exit 0 only when every case met its expectations, 1 when
 * any failed, 2 when a prerequisite (platform support, the built
 * broker/contracts, or Chromium) is missing -- never a green skip.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFERENCE_FORM, REFERENCE_PATHS, REFERENCE_ROLES, startReferenceApp } from '../test-support/reference-app.mjs';
import { createRealBrokerHarness, realBrokerSupport, referenceProfiles } from '../test-support/real-broker.mjs';
import { issueReceipt } from '../test-support/receipt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const runPath = path.join(here, 'run.mjs');
const defaultBrokerCli = path.join(repoRoot, 'dist', 'cli.js');
const contractsPath = path.join(repoRoot, 'dist', 'workflows', 'feature-contracts.js');

const MAX_CAPTURE = 64 * 1024;
const CASE_NAMES = ['happy', 'deny-but-mutate', 'missing-receipt', 'wrong-identity'];
const RUN_TIMEOUT_MS = 120_000;

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_CAPTURE) : '';
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function randomSecret() {
  return randomBytes(18).toString('base64url');
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

function checkPrerequisites() {
  const support = realBrokerSupport();
  const reasons = [];
  if (!support.supported) reasons.push(`real broker unsupported: ${support.reason}`);
  if (!existsSync(defaultBrokerCli)) reasons.push(`missing built broker CLI: run "npm run build" (expected ${defaultBrokerCli})`);
  if (!existsSync(contractsPath)) reasons.push(`missing built feature-workflow contracts: run "npm run build" (expected ${contractsPath})`);
  if (!existsSync(runPath)) reasons.push(`missing feature-acceptance runner: ${runPath}`);

  let chromiumExecutable = null;
  try {
    const requireFromPackage = createRequire(path.join(here, 'package.json'));
    const playwright = requireFromPackage('playwright');
    chromiumExecutable = playwright.chromium.executablePath();
  } catch {
    reasons.push('playwright is not installed in examples/workflows/feature-acceptance (npm install there)');
  }
  if (chromiumExecutable !== null && !existsSync(chromiumExecutable)) {
    reasons.push('chromium is not installed (npx playwright install chromium)');
  }

  return { support, ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Running the unmodified feature-acceptance CLI as a child process
// ---------------------------------------------------------------------------

function runChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: RUN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: boundedText(stdout), stderr: boundedText(stderr) }));
  });
}

async function listEvidence(dir) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  const reportName = entries.find((f) => f.endsWith('.report.json'));
  const logName = entries.find((f) => f.endsWith('.log') && !f.endsWith('.report.json'));
  const exitName = entries.find((f) => f.endsWith('.exit'));
  return {
    reportPath: reportName !== undefined ? path.join(dir, reportName) : null,
    logPath: logName !== undefined ? path.join(dir, logName) : null,
    exitPath: exitName !== undefined ? path.join(dir, exitName) : null,
  };
}

async function readTextOrEmpty(file) {
  if (file === null) return '';
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Audit log inspection (booleans / counts only; never prints row contents)
// ---------------------------------------------------------------------------

function auditRows(auditText) {
  const rows = [];
  for (const line of auditText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // malformed line: ignored, never surfaced
    }
  }
  return rows;
}

function countAuditEvents(auditText, profile, event, ok) {
  return auditRows(auditText).filter((row) => row?.profile === profile && row?.event === event && row?.ok === ok).length;
}

// ---------------------------------------------------------------------------
// Leak checks: booleans only, never a comparison that could echo a value
// ---------------------------------------------------------------------------

function textContainsAny(haystack, needles) {
  return needles.some((needle) => typeof needle === 'string' && needle.length > 0 && haystack.includes(needle));
}

async function verifyNoLeaks({ secrets, tokens, runResult, evidence, manifestPath, receiptPath, registryPath, auditText }) {
  const needles = [...secrets, ...tokens];
  const [reportText, logText, exitText, manifestText, receiptText, registryText] = await Promise.all([
    readTextOrEmpty(evidence.reportPath),
    readTextOrEmpty(evidence.logPath),
    readTextOrEmpty(evidence.exitPath),
    readTextOrEmpty(manifestPath),
    readTextOrEmpty(receiptPath),
    readTextOrEmpty(registryPath),
  ]);
  return {
    stdout: textContainsAny(runResult.stdout, needles),
    stderr: textContainsAny(runResult.stderr, needles),
    report: textContainsAny(reportText, needles),
    log: textContainsAny(logText, needles),
    exit: textContainsAny(exitText, needles),
    manifest: textContainsAny(manifestText, needles),
    receipt: textContainsAny(receiptText, needles),
    registry: textContainsAny(registryText, needles),
    auditLog: textContainsAny(auditText, needles),
  };
}

function leaksAreClean(leaks) {
  return Object.values(leaks).every((value) => value === false);
}

// ---------------------------------------------------------------------------
// One case: fresh app + fresh harness, disposed in `finally`
// ---------------------------------------------------------------------------

async function runCase(caseName, { support, brokerCli, outputDir }) {
  const namespace = `feat-${randomHex(4)}`;
  const buildId = `build-${randomHex(3)}`;
  const envRunId = `${caseName}-${randomHex(4)}`;
  const environment = 'testing';
  const dataScope = `scope-${randomHex(3)}`;

  const writerAccount = { email: `writer-${randomHex(3)}@example.test`, role: REFERENCE_ROLES.writer, password: randomSecret() };
  const readerAccount = { email: `reader-${randomHex(3)}@example.test`, role: REFERENCE_ROLES.reader, password: randomSecret() };
  const writerProfile = `${namespace}:local:writer`;
  const readerProfile = `${namespace}:local:reader`;

  const faults = {};
  if (caseName === 'wrong-identity') faults.identityRoleOverride = { [writerAccount.email]: 'Impersonator' };
  if (caseName === 'deny-but-mutate') faults.readerMutation = 'deny-but-mutate';

  const app = await startReferenceApp({ accounts: [writerAccount, readerAccount], buildId, environment, runId: envRunId, dataScope, faults });
  let harness;
  const notes = [];

  try {
    const registry = referenceProfiles({ namespace, origin: app.origin, writer: writerAccount, reader: readerAccount });
    harness = await createRealBrokerHarness({ brokerCli, registry, support });

    await harness.seed(writerProfile, writerAccount.password);
    await harness.seed(readerProfile, readerAccount.password);

    const manifest = {
      schemaVersion: 1,
      kind: 'feature-acceptance',
      id: `feature-acceptance-real-broker-${caseName}`,
      target: { origin: app.origin, environment, buildId },
      roles: {
        writer: { profile: writerProfile, email: writerAccount.email, role: writerAccount.role },
        reader: { profile: readerProfile, email: readerAccount.email, role: readerAccount.role },
      },
      checks: { readinessPath: REFERENCE_PATHS.ready, identityPath: REFERENCE_PATHS.me, environmentPath: REFERENCE_PATHS.environment },
      record: {
        collectionPath: REFERENCE_PATHS.records,
        createPagePath: REFERENCE_PATHS.newRecord,
        form: REFERENCE_FORM,
      },
      timeoutMs: 60_000,
      cleanupTimeoutMs: 10_000,
    };
    const manifestPath = path.join(harness.root, `workflow-${caseName}.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    let receiptPath = null;
    if (caseName !== 'missing-receipt') {
      const issued = await issueReceipt({ directory: harness.root, workflowId: manifest.id, runId: envRunId, environment, origin: app.origin, buildId, dataScope });
      receiptPath = issued.path;
    } else {
      notes.push('no --receipt is given for this case: environment-receipt must block before any session is issued.');
    }

    const runOutputDir = path.join(harness.root, 'run-output');
    await mkdir(runOutputDir, { recursive: true });

    const runArgs = ['--manifest', manifestPath, '--broker-cli', brokerCli, '--output-dir', runOutputDir, '--json'];
    if (receiptPath !== null) runArgs.push('--receipt', receiptPath);
    const runResult = await runChild(runArgs, harness.env);

    let report = null;
    try {
      report = JSON.parse(runResult.stdout.trim());
    } catch {
      report = null;
    }

    const evidence = await listEvidence(runOutputDir);
    const stats = app.stats();
    const records = app.records();
    const auditText = await harness.auditText();
    const tokens = app.issuedSessionTokens();
    const secrets = [writerAccount.password, readerAccount.password];

    const leaks = await verifyNoLeaks({ secrets, tokens, runResult, evidence, manifestPath, receiptPath, registryPath: harness.profilesFile, auditText });

    const observed = {
      exitCode: runResult.code,
      verdict: report?.verdict ?? null,
      steps: (report?.steps ?? []).map((step) => ({ id: step.id, status: step.status, reasonCode: step.reasonCode })),
      cleanup: report?.cleanup ?? null,
      actualBuild: report?.target?.actualBuild ?? null,
      appStats: { requests: stats.requests, logins: stats.logins, creates: stats.creates, deletes: stats.deletes },
      recordCount: records.length,
    };

    const stepStatus = (id) => observed.steps.find((step) => step.id === id)?.status;
    const auditEventCounts = {
      writerCheckOk: countAuditEvents(auditText, writerProfile, 'check', true),
      writerSessionOk: countAuditEvents(auditText, writerProfile, 'session', true),
      readerCheckOk: countAuditEvents(auditText, readerProfile, 'check', true),
      readerSessionOk: countAuditEvents(auditText, readerProfile, 'session', true),
    };

    let assertions;
    let expected;
    if (caseName === 'happy') {
      expected = { exitCode: 0, verdict: 'passed', steps: '13/13 passed', cleanupRecord: 'deleted-verified', auditBothProfiles: true };
      assertions = {
        exitCode: observed.exitCode === 0,
        verdict: observed.verdict === 'passed',
        allStepsPassed: observed.steps.length === 13 && observed.steps.every((step) => step.status === 'passed'),
        actualBuildMatches: observed.actualBuild === buildId,
        cleanupDeletedVerified: observed.cleanup?.status === 'complete' && observed.cleanup?.record === 'deleted-verified',
        auditWriterOk: auditEventCounts.writerCheckOk >= 1 && auditEventCounts.writerSessionOk >= 1,
        auditReaderOk: auditEventCounts.readerCheckOk >= 1 && auditEventCounts.readerSessionOk >= 1,
        recordGone: records.length === 0,
        evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
        noLeaks: leaksAreClean(leaks),
      };
    } else if (caseName === 'deny-but-mutate') {
      expected = { exitCode: 1, verdict: 'failed', unchangedAfterDenialStatus: 'failed', cleanupRecord: 'deleted-verified' };
      assertions = {
        exitCode: observed.exitCode === 1,
        verdict: observed.verdict === 'failed',
        readerMutationDeniedPassed: stepStatus('reader-mutation-denied') === 'passed',
        unchangedAfterDenialFailed: stepStatus('unchanged-after-denial') === 'failed',
        cleanupDeletedVerified: observed.cleanup?.status === 'complete' && observed.cleanup?.record === 'deleted-verified',
        recordGone: records.length === 0,
        evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
        noLeaks: leaksAreClean(leaks),
      };
    } else if (caseName === 'missing-receipt') {
      expected = { exitCode: 1, verdict: 'blocked', environmentReceiptStatus: 'blocked', appLogins: 0, cleanupRecord: 'none' };
      assertions = {
        exitCode: observed.exitCode === 1,
        verdict: observed.verdict === 'blocked',
        environmentReceiptBlocked: stepStatus('environment-receipt') === 'blocked',
        appHasNoLogins: stats.logins === 0,
        cleanupRecordNone: observed.cleanup?.record === 'none',
        evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
        noLeaks: leaksAreClean(leaks),
      };
    } else {
      expected = { exitCode: 1, verdict: 'failed', writerSessionStatus: 'failed', cleanupRecord: 'none' };
      assertions = {
        exitCode: observed.exitCode === 1,
        verdict: observed.verdict === 'failed',
        writerSessionFailed: stepStatus('writer-session') === 'failed',
        cleanupRecordNone: observed.cleanup?.record === 'none',
        evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
        noLeaks: leaksAreClean(leaks),
      };
    }

    const met = Object.values(assertions).every(Boolean);

    return {
      name: caseName,
      met,
      expected,
      observed,
      assertions,
      leaks,
      auditEventCounts,
      evidence: {
        report: evidence.reportPath !== null ? path.basename(evidence.reportPath) : null,
        log: evidence.logPath !== null ? path.basename(evidence.logPath) : null,
        exit: evidence.exitPath !== null ? path.basename(evidence.exitPath) : null,
      },
      notes,
    };
  } finally {
    await harness?.dispose();
    await app.close();
  }
}

// ---------------------------------------------------------------------------
// Proof evidence (create-only; never overwrites, never prints a case's raw
// stdout/stderr/report bytes -- only the derived summary above).
// ---------------------------------------------------------------------------

async function writeProofEvidence(outputDir, summary) {
  await mkdir(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:.TZ]/gu, '');
  const stem = `real-broker-feature-proof-${ts}-${randomHex(3)}`;
  const jsonPath = path.join(outputDir, `${stem}.json`);
  const logPath = path.join(outputDir, `${stem}.log`);
  const exitPath = path.join(outputDir, `${stem}.exit`);
  const exitCode = summary.verdict === 'passed' ? 0 : summary.verdict === 'blocked' ? 2 : 1;
  const logLines =
    summary.cases.length > 0
      ? summary.cases.map((c) => `${c.name}: met=${c.met} exit=${c.observed.exitCode} verdict=${c.observed.verdict}`)
      : [`blocked: ${summary.prerequisites.reasons.join('; ') || '(unknown)'}`];
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(logPath, `${logLines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(exitPath, `${exitCode}\n`, { encoding: 'utf8', flag: 'wx' });
  return { exitCode, jsonPath, logPath, exitPath };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runFeatureRealBrokerProof(options = {}) {
  const outputDir = options.outputDir ?? path.resolve(process.cwd(), 'output');
  const brokerCli = options.brokerCli ?? defaultBrokerCli;
  const startedAt = new Date().toISOString();
  const prereq = checkPrerequisites();

  if (!prereq.ok) {
    const summary = {
      schemaVersion: 1,
      kind: 'real-broker-feature-proof',
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      store: prereq.support.store,
      prerequisites: { ok: false, reasons: prereq.reasons },
      verdict: 'blocked',
      cases: [],
    };
    const evidence = await writeProofEvidence(outputDir, summary);
    return { exitCode: 2, summary, evidence };
  }

  const cases = [];
  for (const caseName of CASE_NAMES) {
    cases.push(await runCase(caseName, { support: prereq.support, brokerCli, outputDir }));
  }
  const allMet = cases.every((c) => c.met);

  const summary = {
    schemaVersion: 1,
    kind: 'real-broker-feature-proof',
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    store: prereq.support.store,
    prerequisites: { ok: true, reasons: [] },
    verdict: allMet ? 'passed' : 'failed',
    cases,
  };
  const evidence = await writeProofEvidence(outputDir, summary);
  return { exitCode: allMet ? 0 : 1, summary, evidence };
}

function usage() {
  process.stderr.write('usage: node real-broker-proof.mjs [--output-dir dir] [--json]\n');
}

function argsOf(argv) {
  const out = { outputDir: path.resolve(process.cwd(), 'output'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--output-dir') out.outputDir = argv[++i];
    else {
      usage();
      throw new Error('USAGE');
    }
  }
  return out;
}

async function main(argv) {
  const options = argsOf(argv);
  const { exitCode, summary, evidence } = await runFeatureRealBrokerProof(options);
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stdout.write(`${summary.verdict} (${evidence.jsonPath})\n`);
  return exitCode;
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): on macOS the OS tmpdir is itself a symlink (/var ->
// /private/var), so a script invoked as `node /var/.../real-broker-proof.mjs`
// gets process.argv[1] === '/var/.../real-broker-proof.mjs' while
// import.meta.url resolves to the realpath '/private/var/...' -- a plain
// path.resolve() compare never matches, main() silently never runs, and the
// process exits 0 with no output.
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

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : 'real-broker-proof failed'}\n`);
    process.exitCode = 1;
  }
}
