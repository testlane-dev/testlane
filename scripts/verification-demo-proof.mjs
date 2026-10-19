#!/usr/bin/env node
/** Real-store acceptance of the demo and verification commands from an installed package. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoLeaks, consumerProject } from '../examples/playwright/tests/consumer.mjs';
import { createRealBrokerHarness, realBrokerSupport } from '../examples/workflows/test-support/real-broker.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const CASE_IDS = ['editor-browser-total', 'editor-cannot-approve', 'reviewer-approves', 'duplicate-approval-unchanged', 'anonymous-denied'];
const FAULT_CASE_IDS = ['editor-browser-total', 'reviewer-approves'];

async function digestTree(root) {
  const hash = createHash('sha256');
  const walk = async directory => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      assert.equal(item.isSymbolicLink(), false, 'installed package contains no symlink');
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) { hash.update(path.relative(root, file)); hash.update(await readFile(file)); }
    }
  };
  await walk(root);
  return hash.digest('hex');
}

async function textTree(root) {
  let text = '';
  const walk = async directory => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      assert.equal(item.isSymbolicLink(), false, 'proof output contains no symlink');
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) text += await readFile(file, 'utf8');
    }
  };
  await walk(root);
  return text;
}

function demoProfiles({ namespace, origin, editor, reviewer }) {
  const entry = account => ({
    app: 'testlane-verification-demo', environment: 'testing', baseUrl: origin, strategy: 'form-post',
    account: { email: account.email, role: account.role }, session: { ttlMinutes: 30 },
    options: { loginPath: '/api/login', bodyFormat: 'json', fields: '{"email":"{{email}}","password":"{{secret}}"}', sessionCookieName: 'tldemo_session', mePath: '/api/me' },
  });
  return { version: 1, profiles: { [namespace + ':testing:editor']: entry(editor), [namespace + ':testing:reviewer']: entry(reviewer) } };
}

/** Reuse a fresh consumer already installed by the launch proof; never import the checkout demo. */
export async function runVerificationDemoProof({ consumer, support = realBrokerSupport(), onStage = () => {} }) {
  assert.ok(support.supported, 'real verification proof needs Windows DPAPI or explicitly isolated Linux Secret Service');
  let app, harness, cli, receipt, terminationUnconfirmed = false;
  let captured = '';
  const attempted = new Set(), passwords = [];
  const output = path.join(consumer.root, 'verification-demo-proof');
  const checks = {};
  let activeStage = 'installed-demo';
  const stage = name => { activeStage = name; onStage(name); };
  try {
    stage('installed-demo');
    const packageRoot = await realpath(consumer.packageRoot);
    const before = await digestTree(packageRoot);
    const installedModule = async name => {
      const file = await realpath(path.join(packageRoot, 'examples', 'verification-demo', name));
      assert.equal(path.relative(packageRoot, file).startsWith('..'), false, 'demo module resolves inside installed package');
      return import(pathToFileURL(file).href);
    };
    const { startDemoApp } = await installedModule('app.mjs');
    const { prepareDemoSuite } = await installedModule('suite.mjs');
    const { runDemoChild } = await installedModule('native.mjs');
    const { diagnostic, validDiagnostic } = await import(pathToFileURL(path.join(packageRoot, 'examples', 'agent-verification', 'contracts.mjs')).href);
    const expectedAssertionDiagnostic = diagnostic('ASSERTION_FAILED');
    assert.equal(typeof startDemoApp, 'function');
    assert.equal(typeof prepareDemoSuite, 'function');
    assert.equal(typeof runDemoChild, 'function');
    checks.installedDemo = true;

    const namespace = 'verify-demo-' + randomBytes(8).toString('hex');
    const editor = { email: namespace + '-editor@example.test', role: 'Editor', password: randomBytes(32).toString('base64url') };
    const reviewer = { email: namespace + '-reviewer@example.test', role: 'Reviewer', password: randomBytes(32).toString('base64url') };
    passwords.push(editor.password, reviewer.password);
    stage('scratch-store');
    app = await startDemoApp({ accounts: { editor, reviewer } });
    harness = await createRealBrokerHarness({ brokerCli: consumer.brokerCli, support, registry: demoProfiles({ namespace, origin: app.origin, editor, reviewer }) });
    const editorProfile = namespace + ':testing:editor', reviewerProfile = namespace + ':testing:reviewer';
    await mkdir(output, { mode: 0o700 });
    // Playwright otherwise retains its transform cache in TMPDIR. Keep that private
    // generated code in the scanned proof output, separate from session-file cleanup.
    const env = { ...harness.env, DEBUG: '', PWDEBUG: '', NODE_DEBUG: '', TMP: consumer.sessionTemp, TEMP: consumer.sessionTemp, TMPDIR: consumer.sessionTemp,
      PWTEST_CACHE_DIR: path.join(output, 'playwright-transform-cache') };
    delete env.FORCE_COLOR;
    cli = async (args, options = {}) => {
      try {
        const result = await runDemoChild({ entry: consumer.brokerCli, args, cwd: consumer.root, env, timeoutMs: 210_000, ...options });
        captured += result.stdout + result.stderr;
        return result;
      } catch (error) {
        if (error.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') terminationUnconfirmed = true;
        throw error;
      }
    };
    // Track an attempt before starting it: a timed-out seed may already have written
    // a keychain entry. Every native operation is bounded and captures private output.
    for (const [profile, password] of [[editorProfile, editor.password], [reviewerProfile, reviewer.password]]) {
      attempted.add(profile);
      const seeded = await cli(['store', 'set', profile], { input: password, timeoutMs: 35_000 });
      assert.equal(seeded.code, 0, 'unique native profile is seeded through stdin');
    }
    const brief = path.join(output, 'brief.md');
    await writeFile(brief, 'Verify the disposable approval demo: three items at 1,400 cents total 4,200 cents; only a reviewer approves, once; denied changes preserve state; anonymous access is refused; delete every run-owned request.\n', { flag: 'wx', mode: 0o600 });

    stage('init-draft-refusal');
    const initialized = await cli(['verify', 'init', '--brief', brief, '--target', app.origin, '--profile', editorProfile, '--environment', 'testing', '--output-dir', 'e2e/draft-demo', '--json']);
    assert.equal(initialized.code, 0, 'installed verify init succeeds');
    const draft = JSON.parse(initialized.stdout);
    assert.equal(draft.status, 'draft');
    const draftPlan = path.join(consumer.root, draft.directory, 'plan.json');
    const draftRun = await cli(['verify', 'run', '--plan', draftPlan, '--output-dir', output, '--json']);
    const draftReport = JSON.parse(draftRun.stdout);
    assert.equal(draftRun.code, 2, 'draft cannot be reported as a pass');
    assert.equal(draftReport.verdict, 'blocked');
    assert.ok(draftReport.reasonCodes.includes('PLAN_NOT_REVIEWED'));
    assert.ok(draftReport.diagnostics.some(item => item.code === 'RUNNER_CONFIGURATION_BLOCKED' && validDiagnostic(item)), 'draft report supplies fixed setup guidance');
    assert.equal(app.records().length, 0);
    checks.initAndDraftRefusal = true;

    stage('prepared-suite');
    const suite = await prepareDemoSuite({ projectRoot: consumer.root, packageRoot, origin: app.origin, editorProfile, reviewerProfile, editor, reviewer });
    const planFile = await realpath(suite.planFile), specFile = await realpath(suite.specFile);
    const planBytes = await readFile(planFile), specBytes = await readFile(specFile);
    const planHash = sha256(planBytes), specHash = sha256(specBytes);
    const plan = JSON.parse(planBytes);
    assert.equal(plan.status, 'reviewed');
    assert.deepEqual(plan.cases.map(item => item.id).sort(), [...CASE_IDS].sort(), 'demo covers all intended business cases');
    const projectRoot = await realpath(path.resolve(path.dirname(planFile), plan.projectDir));
    assert.equal(projectRoot, await realpath(consumer.root));
    for (const item of plan.cases) assert.equal(await realpath(path.join(projectRoot, item.spec)), specFile, 'planned cases bind the reviewed demo spec');
    const specId = sha256(plan.cases[0].spec);
    const runs = [];
    for (const [name, defect] of [['positive', false], ['fault', true], ['corrected', false]]) {
      stage(name);
      await app.setDefect(defect);
      const result = await cli(['verify', 'run', '--plan', planFile, '--output-dir', output, '--json']);
      const report = JSON.parse(result.stdout);
      assert.equal(result.code, defect ? 1 : 0, 'installed verification command returns the expected exit status');
      assert.equal(report.verdict, defect ? 'failed' : 'passed', 'same reviewed suite detects the injected total error');
      assert.equal(report.plan.sha256, planHash);
      assert.deepEqual(report.specs, [{ id: specId, sha256: specHash }]);
      assert.deepEqual(report.cases.map(item => item.id).sort(), [...CASE_IDS].sort());
      for (const item of report.cases) {
        assert.ok(item.assertionsObserved > 0, 'each case observes real Playwright assertions');
        assert.equal(item.cleanup.status, item.id === 'anonymous-denied' ? 'not-required' : 'completed', 'reported cleanup matches the case contract');
        assert.equal(item.attempts, 1, 'proof has no skipped, duplicated or retried cases');
        if (defect && FAULT_CASE_IDS.includes(item.id)) {
          assert.equal(item.status, 'failed');
          assert.equal(item.reason, 'CASE_FAILED', 'injected defect fails a business assertion, not startup or cleanup');
          assert.deepEqual(item.diagnostic, expectedAssertionDiagnostic, 'failure diagnostics contain only the installed static catalogue');
          assert.ok(Number.isSafeInteger(item.failureLocation?.line) && item.failureLocation.line > 0);
        } else assert.equal(item.status, 'passed');
      }
      assert.equal(app.records().length, 0, 'independent app controller confirms zero owned records after every run');
      assert.equal(sha256(await readFile(planFile)), planHash, 'plan stays unchanged across all phases');
      assert.equal(sha256(await readFile(specFile)), specHash, 'business assertions stay unchanged across all phases');
      assert.equal(await digestTree(packageRoot), before, 'installed package stays unchanged across all phases');
      assert.equal(report.artifacts.length, 0, 'proof requests no screenshots');
      const reportFile = path.resolve(output, report.reportPath);
      assert.equal((await stat(reportFile)).isFile(), true);
      const rendered = await cli(['verify', 'report', '--report', reportFile, '--plan', planFile, '--json']);
      assert.equal(rendered.code, 0, 'installed verify report renders each phase');
      assert.equal(JSON.parse(rendered.stdout).status, 'rendered');
      const html = await readFile(path.join(path.dirname(reportFile), 'summary.html'), 'utf8');
      assert.ok(html.includes('Testlane verification summary') && html.includes(planHash), 'HTML report carries the reviewed input binding');
      if (defect) assert.ok(html.includes('ASSERTION_FAILED') && html.includes(expectedAssertionDiagnostic.summary) && html.includes(expectedAssertionDiagnostic.remedy), 'failed HTML report includes static actionable guidance');
      runs.push({ phase: name, verdict: report.verdict, passed: report.cases.filter(item => item.status === 'passed').length, failed: report.cases.filter(item => item.status === 'failed').length, recordsRemaining: app.records().length, planSha256: report.plan.sha256, specSha256: specHash });
    }
    checks.positiveFaultCorrected = true;
    checks.meaningfulFault = true;
    checks.safeFailureDiagnostics = true;
    checks.samePlanAndSpec = true;
    checks.verifiedAppCleanup = true;
    checks.htmlReports = true;
    stage('recovery-journal-cleanup');
    const recovery = path.join(consumer.root, 'output', 'testlane-demo-recovery');
    checks.noRetainedRecoveryJournals = (await readdir(recovery)).length === 0;
    assert.ok(checks.noRetainedRecoveryJournals, 'all owned-record recovery journals are removed after verified deletion');
    stage('audit-presence');
    const audit = await harness.auditText();
    const tokens = app.issuedSessionTokens();
    assert.ok(tokens.length > 0 && audit.length > 0, 'proof actually issues sessions and records broker audit');
    stage('session-file-cleanup');
    checks.noRetainedSessionFiles = (await readdir(consumer.sessionTemp)).length === 0;
    assert.ok(checks.noRetainedSessionFiles, 'all session temporary files are removed');
    stage('final-package-check');
    checks.packageUnchanged = before === await digestTree(packageRoot);
    assert.ok(Object.values(checks).every(Boolean), 'all installed verification-demo checks pass');
    receipt = { passed: true, nativeStore: support.store, checks, runs };
  } finally {
    const phaseBeforeCleanup = activeStage;
    try {
      if (harness) {
        stage('native-store-cleanup');
        let cleanupFailed = terminationUnconfirmed;
        for (const profile of attempted) {
          try { if ((await cli(['store', 'delete', profile], { timeoutMs: 35_000 })).code !== 0) cleanupFailed = true; }
          catch { cleanupFailed = true; }
          try { if ((await cli(['check', profile], { timeoutMs: 35_000 })).code !== 4) cleanupFailed = true; }
          catch { cleanupFailed = true; }
        }
        cleanupFailed ||= terminationUnconfirmed;
        // Include delete/check output and the final audit, not only the test phases.
        stage('credential-leak-scan');
        let recoveryText = '';
        try { recoveryText = await textTree(path.join(consumer.root, 'output', 'testlane-demo-recovery')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        assertNoLeaks(captured + await textTree(output) + await textTree(consumer.sessionTemp) + recoveryText + await harness.auditText(), [...passwords, ...app.issuedSessionTokens()]);
        checks.noCredentialLeak = true;
        checks.nativeStoreCleanup = !cleanupFailed;
        if (cleanupFailed) { stage('native-store-cleanup'); throw new Error('Native proof cleanup is incomplete; scratch recovery metadata is preserved'); }
        // No harness.seed/run calls are used, so its dispose has no unbounded native
        // operations left: it only removes metadata after our verified deletions.
        stage('scratch-home-cleanup');
        await harness.dispose();
        checks.scratchHomeRemoved = await stat(harness.root).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) === null;
        assert.ok(checks.scratchHomeRemoved, 'scratch native-store metadata is removed after successful cleanup');
      }
    } finally {
      try { await app?.close(); }
      catch (error) { stage('app-stop'); throw error; }
    }
    // Successful teardown must not relabel an earlier test/setup failure.
    stage(phaseBeforeCleanup);
  }
  return receipt;
}

function isEntryPoint() {
  try {
    const entry = realpathSync(process.argv[1]), self = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
  } catch { return false; }
}

if (isEntryPoint()) {
  const support = realBrokerSupport();
  if (!support.supported) {
    console.error('BLOCKED verification demo proof: requires Windows DPAPI or explicitly isolated Linux Secret Service; never macOS.');
    process.exitCode = 2;
  } else {
    let consumer, phase = 'consumer-install';
    try {
      consumer = await consumerProject({ tarball: process.env.TESTLANE_PACKAGE_TARBALL });
      const result = await runVerificationDemoProof({ consumer, support, onStage: name => { phase = name; } });
      console.log(JSON.stringify(result));
    } catch {
      console.error('FAIL verification demo proof at fixed stage: ' + phase);
      process.exitCode = 1;
    } finally {
      try { await consumer?.dispose(); }
      catch { console.error('FAIL verification demo proof cleanup: consumer'); process.exitCode = 1; }
    }
  }
}
