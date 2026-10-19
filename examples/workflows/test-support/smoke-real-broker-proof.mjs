#!/usr/bin/env node
/**
 * Real-broker smoke proof: runs the UNMODIFIED
 * `examples/workflows/authenticated-smoke/run.mjs` CLI as a child process,
 * against a real, running reference app and the real built broker CLI
 * (`dist/cli.js`), inside a throwaway scratch home. Three cases exercise the
 * runner's actual production behaviour end to end:
 *
 *   happy            - correct password: all 8 required steps pass.
 *   wrong-secret      - a different generated password is stored: the
 *                       broker-check step fails (credentials rejected).
 *   production-host   - the registry also declares a production-tagged
 *                       profile on the target's loopback host: refused
 *                       before the app sees a single request.
 *
 * Every case is booleans-only for leaked secrets (never prints or compares a
 * raw value); see verifyNoLeaks(). Exit 0 only when every case met its
 * expectations, 1 when any failed, 2 when a prerequisite (platform support,
 * the built broker/contracts, or Chromium) is missing -- never a green skip.
 *
 * KNOWN INTERFACE DISCREPANCY (see the `production-host` case below): the
 * real broker's registry loader (src/profiles.ts productionOverlapIssues)
 * refuses to load ANY registry that mixes a production-tagged profile with a
 * non-production profile on the same hostname (ports are ignored), which is
 * exactly the configuration this case needs. That refusal fires earlier than,
 * and instead of, the workflow runner's own client-side PRODUCTION_REFUSED
 * check (which requires that same hostname collision to detect it, and so is
 * structurally unreachable here with a real registry). The case still ends
 * in a failed verdict with the `profile-policy` step failed and zero app
 * requests -- the safety property holds -- but the observed reasonCode is
 * `process-failed` (the registry never loads) rather than
 * `production-refused`. This proof asserts the real, observed behaviour
 * rather than the unreachable one.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFERENCE_HEADING, REFERENCE_PATHS, REFERENCE_ROLES, startReferenceApp } from './reference-app.mjs';
import { createRealBrokerHarness, realBrokerSupport, referenceProfiles } from './real-broker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const smokeDir = path.resolve(here, '../authenticated-smoke');
const smokeRunPath = path.join(smokeDir, 'run.mjs');
const defaultBrokerCli = path.join(repoRoot, 'dist', 'cli.js');
const contractsPath = path.join(repoRoot, 'dist', 'workflows', 'contracts.js');

const MAX_CAPTURE = 64 * 1024;
const CASE_NAMES = ['happy', 'wrong-secret', 'production-host'];
const SMOKE_TIMEOUT_MS = 90_000;

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
  if (!existsSync(contractsPath)) reasons.push(`missing built workflow contracts: run "npm run build" (expected ${contractsPath})`);
  if (!existsSync(smokeRunPath)) reasons.push(`missing smoke runner: ${smokeRunPath}`);

  let chromiumExecutable = null;
  try {
    const requireFromSmoke = createRequire(path.join(smokeDir, 'package.json'));
    const playwright = requireFromSmoke('playwright');
    chromiumExecutable = playwright.chromium.executablePath();
  } catch {
    reasons.push('playwright is not installed in examples/workflows/authenticated-smoke (npm install there)');
  }
  if (chromiumExecutable !== null && !existsSync(chromiumExecutable)) {
    reasons.push('chromium is not installed (npx playwright install chromium)');
  }

  return { support, ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Running the unmodified smoke CLI as a child process
// ---------------------------------------------------------------------------

function runSmokeChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeRunPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: SMOKE_TIMEOUT_MS,
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

async function listSmokeEvidence(dir) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  const reportName = entries.find((f) => f.endsWith('.report.json'));
  const logName = entries.find((f) => f.endsWith('.log'));
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

async function verifyNoLeaks({ secrets, tokens, smokeResult, evidence, manifestPath, registryPath, auditText }) {
  const needles = [...secrets, ...tokens];
  const [reportText, logText, exitText, manifestText, registryText] = await Promise.all([
    readTextOrEmpty(evidence.reportPath),
    readTextOrEmpty(evidence.logPath),
    readTextOrEmpty(evidence.exitPath),
    readTextOrEmpty(manifestPath),
    readTextOrEmpty(registryPath),
  ]);
  return {
    stdout: textContainsAny(smokeResult.stdout, needles),
    stderr: textContainsAny(smokeResult.stderr, needles),
    report: textContainsAny(reportText, needles),
    log: textContainsAny(logText, needles),
    exit: textContainsAny(exitText, needles),
    manifest: textContainsAny(manifestText, needles),
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
  const namespace = `ref-${randomHex(4)}`;
  const buildId = `build-${randomHex(3)}`;
  const runId = `${caseName}-${randomHex(4)}`;
  const environment = 'testing';
  const dataScope = `scope-${randomHex(3)}`;

  const writerAccount = { email: `writer-${randomHex(3)}@example.test`, role: REFERENCE_ROLES.writer, password: randomSecret() };
  const readerAccount = { email: `reader-${randomHex(3)}@example.test`, role: REFERENCE_ROLES.reader, password: randomSecret() };
  const writerProfile = `${namespace}:local:writer`;

  const app = await startReferenceApp({ accounts: [writerAccount, readerAccount], buildId, environment, runId, dataScope });
  let harness;
  const notes = [];
  let wrongPassword;

  try {
    let registry = referenceProfiles({ namespace, origin: app.origin, writer: writerAccount, reader: readerAccount });
    if (caseName === 'production-host') {
      registry = referenceProfiles({
        namespace,
        origin: app.origin,
        writer: writerAccount,
        reader: readerAccount,
        extra: {
          [`${namespace}:local:production`]: {
            app: 'testlane-reference-app',
            environment: 'production',
            baseUrl: app.origin,
            strategy: 'form-post',
            account: { email: '', role: '' },
            session: { ttlMinutes: 0 },
          },
        },
      });
      notes.push(
        'the extra production profile shares the target loopback hostname on purpose (see the module-level ' +
          'KNOWN INTERFACE DISCREPANCY note); the registry never loads, so store set is skipped for this case.',
      );
    }

    harness = await createRealBrokerHarness({ brokerCli, registry, support });

    if (caseName === 'happy') {
      await harness.seed(writerProfile, writerAccount.password);
    } else if (caseName === 'wrong-secret') {
      wrongPassword = randomSecret();
      await harness.seed(writerProfile, wrongPassword);
    }

    const manifest = {
      schemaVersion: 1,
      kind: 'authenticated-smoke',
      id: `test-support-real-broker-${caseName}`,
      profile: writerProfile,
      target: { origin: app.origin, environment, buildId },
      identity: { email: writerAccount.email, role: writerAccount.role },
      checks: {
        readinessPath: REFERENCE_PATHS.ready,
        identityPath: REFERENCE_PATHS.me,
        protectedPath: REFERENCE_PATHS.workspace,
        protectedHeading: REFERENCE_HEADING,
        apiPath: REFERENCE_PATHS.data,
      },
      timeoutMs: 60_000,
    };
    const manifestPath = path.join(harness.root, `workflow-${caseName}.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    const smokeOutputDir = path.join(harness.root, 'smoke-output');
    await mkdir(smokeOutputDir, { recursive: true });

    const smokeArgs = ['--manifest', manifestPath, '--broker-cli', brokerCli, '--output-dir', smokeOutputDir, '--json'];
    const smokeResult = await runSmokeChild(smokeArgs, harness.env);

    let report = null;
    try {
      report = JSON.parse(smokeResult.stdout.trim());
    } catch {
      report = null;
    }

    const evidence = await listSmokeEvidence(smokeOutputDir);
    const stats = app.stats();
    const auditText = await harness.auditText();
    const tokens = app.issuedSessionTokens();
    const secrets = [writerAccount.password, readerAccount.password];
    if (wrongPassword !== undefined) secrets.push(wrongPassword);

    const leaks = await verifyNoLeaks({
      secrets,
      tokens,
      smokeResult,
      evidence,
      manifestPath,
      registryPath: harness.profilesFile,
      auditText,
    });

    const observed = {
      exitCode: smokeResult.code,
      verdict: report?.verdict ?? null,
      steps: (report?.steps ?? []).map((step) => ({ id: step.id, status: step.status, reasonCode: step.reasonCode })),
      actualBuild: report?.target?.actualBuild ?? null,
      appStats: { requests: stats.requests, logins: stats.logins, failedLogins: stats.failedLogins },
    };

    const stepStatus = (id) => observed.steps.find((step) => step.id === id)?.status;
    const auditEventCounts = {
      checkOk: countAuditEvents(auditText, writerProfile, 'check', true),
      sessionOk: countAuditEvents(auditText, writerProfile, 'session', true),
    };

    let assertions;
    let expected;
    if (caseName === 'happy') {
      expected = { exitCode: 0, verdict: 'passed', steps: '8/8 passed', actualBuild: buildId, auditCheckOk: '>=1', auditSessionOk: '>=1' };
      assertions = {
        exitCode: observed.exitCode === 0,
        verdict: observed.verdict === 'passed',
        allStepsPassed: observed.steps.length === 8 && observed.steps.every((step) => step.status === 'passed'),
        actualBuildMatches: observed.actualBuild === buildId,
        auditCheckOk: auditEventCounts.checkOk >= 1,
        auditSessionOk: auditEventCounts.sessionOk >= 1,
        evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
        noLeaks: leaksAreClean(leaks),
      };
    } else if (caseName === 'wrong-secret') {
      expected = { exitCode: 1, verdict: 'failed', brokerCheckStatus: 'failed', appFailedLogins: '>=1', appSuccessfulLogins: 0 };
      assertions = {
        exitCode: observed.exitCode === 1,
        verdict: observed.verdict === 'failed',
        brokerCheckFailed: stepStatus('broker-check') === 'failed',
        appHasFailedLogin: stats.failedLogins >= 1,
        appHasNoSuccessfulLogin: stats.logins === 0,
        evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
        noLeaks: leaksAreClean(leaks),
      };
    } else {
      expected = {
        exitCode: 1,
        verdict: 'failed',
        profilePolicyStatus: 'failed',
        appRequests: 0,
        note: 'reasonCode is process-failed, not production-refused: see the module-level KNOWN INTERFACE DISCREPANCY note',
      };
      assertions = {
        exitCode: observed.exitCode === 1,
        verdict: observed.verdict === 'failed',
        profilePolicyFailed: stepStatus('profile-policy') === 'failed',
        appSawNoRequests: stats.requests === 0,
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
  const stem = `real-broker-smoke-proof-${ts}-${randomHex(3)}`;
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

export async function runSmokeRealBrokerProof(options = {}) {
  const outputDir = options.outputDir ?? path.resolve(process.cwd(), 'output');
  const brokerCli = options.brokerCli ?? defaultBrokerCli;
  const startedAt = new Date().toISOString();
  const prereq = checkPrerequisites();

  if (!prereq.ok) {
    const summary = {
      schemaVersion: 1,
      kind: 'real-broker-smoke-proof',
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
    kind: 'real-broker-smoke-proof',
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
  process.stderr.write('usage: node smoke-real-broker-proof.mjs [--output-dir dir] [--json]\n');
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
  const { exitCode, summary, evidence } = await runSmokeRealBrokerProof(options);
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stdout.write(`${summary.verdict} (${evidence.jsonPath})\n`);
  return exitCode;
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): on macOS the OS tmpdir is itself a symlink (/var ->
// /private/var), so a script invoked as
// `node /var/.../smoke-real-broker-proof.mjs` gets process.argv[1] ===
// '/var/.../smoke-real-broker-proof.mjs' while import.meta.url resolves to
// the realpath '/private/var/...' -- a plain path.resolve() compare never
// matches, main() silently never runs, and the process exits 0 with no
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

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : 'smoke-real-broker-proof failed'}\n`);
    process.exitCode = 1;
  }
}
