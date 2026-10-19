/** Installed-package launch proof: diagnostics, real MCP file delivery and both workflow commands. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { consumerProject, assertNoLeaks } from '../examples/playwright/tests/consumer.mjs';
import { createRealBrokerHarness, realBrokerSupport, referenceProfiles } from '../examples/workflows/test-support/real-broker.mjs';
import { REFERENCE_FORM, REFERENCE_HEADING, REFERENCE_PATHS, startReferenceApp } from '../examples/workflows/test-support/reference-app.mjs';
import { issueReceipt } from '../examples/workflows/test-support/receipt.mjs';

const execute = promisify(execFile);
const support = realBrokerSupport();
async function digestTree(root) {
  const hash = createHash('sha256');
  async function walk(dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) { hash.update(path.relative(root, file)); hash.update(await readFile(file)); }
    }
  }
  await walk(root); return hash.digest('hex');
}
async function gone(file) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await stat(file).catch(() => null) === null) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

if (!support.supported) {
  console.error('BLOCKED launch proof: requires Windows DPAPI or an explicitly isolated Linux Secret Service keyring; never macOS.');
  process.exitCode = 2;
} else {
  let consumer, app, harness, client, browser, context;
  let phase = 'consumer-install';
  let captured = '';
  const checks = {};
  try {
    consumer = await consumerProject({ tarball: process.env.TESTLANE_PACKAGE_TARBALL });
    const installed = consumer.packageRoot;
    const before = await digestTree(installed);
    const namespace = 'launch-' + randomBytes(8).toString('hex');
    const writer = { email: 'writer@example.test', role: 'Writer', password: randomBytes(32).toString('base64url') };
    const reader = { email: 'reader@example.test', role: 'Reader', password: randomBytes(32).toString('base64url') };
    app = await startReferenceApp({ accounts: [writer, reader], buildId: namespace, runId: namespace, dataScope: namespace, environment: 'testing' });
    harness = await createRealBrokerHarness({ brokerCli: consumer.brokerCli, support, registry: referenceProfiles({ namespace, origin: app.origin, writer, reader }) });
    const writerProfile = namespace + ':local:writer';
    const readerProfile = namespace + ':local:reader';
    await harness.seed(writerProfile, writer.password); await harness.seed(readerProfile, reader.password);
    const env = { ...harness.env, DEBUG: '', PWDEBUG: '', NODE_DEBUG: '', TMP: consumer.sessionTemp, TEMP: consumer.sessionTemp, TMPDIR: consumer.sessionTemp };
    delete env.FORCE_COLOR;
    async function cli(args) {
      try {
        const result = await execute(process.execPath, [consumer.brokerCli, ...args], { cwd: consumer.root, env, timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
        captured += result.stdout + result.stderr; return { ...result, code: 0 };
      } catch (error) { captured += (error.stdout ?? '') + (error.stderr ?? ''); return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
    }
    phase = 'doctor';
    const doctor = await cli(['doctor', '--check', writerProfile, '--json']);
    const diagnostic = JSON.parse(doctor.stdout);
    checks.diagnostics = doctor.code === 0 && diagnostic.ok && diagnostic.checks.some(c => c.code === 'authentication.verified') && diagnostic.checks.some(c => c.code === 'browser.dependency_available');
    assert.ok(checks.diagnostics, 'diagnostics checks pass');

    phase = 'stdio-file-delivery';
    const transport = new StdioClientTransport({ command: process.execPath, args: [consumer.brokerCli, 'mcp'], cwd: consumer.root, env: Object.fromEntries(Object.entries(env).filter(([,v]) => typeof v === 'string')), stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { captured += chunk.toString(); });
    transport.onmessage = message => { captured += JSON.stringify(message); };
    client = new Client({ name: 'testlane-launch-proof', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'session_file', arguments: { profile: writerProfile } });
    assert.equal(Boolean(result.isError), false, 'MCP file delivery succeeds');
    const receipt = result.structuredContent;
    assert.ok(receipt && typeof receipt.path === 'string', 'MCP returns local path metadata');
    const projectRequire = createRequire(path.join(consumer.root, 'package.json'));
    const { chromium } = projectRequire('@playwright/test');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ storageState: receipt.path });
    const released = await client.callTool({ name: 'release_session_file', arguments: { id: receipt.id } });
    checks.explicitRelease = released.structuredContent?.released === true && await gone(receipt.path);
    const response = await context.request.get(app.origin + REFERENCE_PATHS.me, { maxRedirects: 0 });
    const identity = await response.json();
    const page = await context.newPage(); await page.goto(app.origin + REFERENCE_PATHS.workspace);
    checks.mcpBrowser = response.status() === 200 && identity.email === writer.email && await page.getByRole('heading', { name: REFERENCE_HEADING, exact: true }).isVisible();
    await context.close(); context = undefined; await browser.close(); browser = undefined;
    const unreleased = await client.callTool({ name: 'session_file', arguments: { profile: readerProfile, format: 'curl' } });
    const closePath = unreleased.structuredContent?.path;
    assert.ok(typeof closePath === 'string', 'second file delivered');
    await client.close(); client = undefined;
    checks.disconnectCleanup = await gone(closePath) && await gone(path.dirname(closePath));

    phase = 'workflow-smoke';
    const target = { origin: app.origin, environment: 'testing', buildId: namespace };
    const smoke = { schemaVersion: 1, kind: 'authenticated-smoke', id: namespace + '-smoke', profile: writerProfile, target, identity: { email: writer.email, role: writer.role }, checks: { readinessPath: REFERENCE_PATHS.ready, identityPath: REFERENCE_PATHS.me, protectedPath: REFERENCE_PATHS.workspace, protectedHeading: REFERENCE_HEADING, apiPath: REFERENCE_PATHS.data }, timeoutMs: 60000 };
    const smokePath = path.join(consumer.root, 'smoke.json');
    await writeFile(smokePath, JSON.stringify(smoke));
    const smokeResult = await cli(['workflow', 'smoke', '--manifest', smokePath, '--json']);
    const smokeReport = JSON.parse(smokeResult.stdout);
    checks.smokeCommand = smokeResult.code === 0 && smokeReport.verdict === 'passed' && smokeReport.steps.length === 8;
    if (!checks.smokeCommand) console.error(JSON.stringify({ stage: 'smoke', code: smokeResult.code, verdict: smokeReport.verdict, steps: smokeReport.steps.map(({ id,status,reasonCode }) => ({ id,status,reasonCode })) }));

    phase = 'workflow-feature';
    const feature = { schemaVersion: 1, kind: 'feature-acceptance', id: namespace + '-feature', target, roles: { writer: { profile: writerProfile, email: writer.email, role: writer.role }, reader: { profile: readerProfile, email: reader.email, role: reader.role } }, checks: { readinessPath: REFERENCE_PATHS.ready, identityPath: REFERENCE_PATHS.me, environmentPath: REFERENCE_PATHS.environment }, record: { collectionPath: REFERENCE_PATHS.records, createPagePath: REFERENCE_PATHS.newRecord, form: REFERENCE_FORM }, timeoutMs: 60000, cleanupTimeoutMs: 10000 };
    const featurePath = path.join(consumer.root, 'feature.json');
    await writeFile(featurePath, JSON.stringify(feature));
    const receiptFile = await issueReceipt({ directory: consumer.root, workflowId: feature.id, runId: namespace, environment: 'testing', origin: app.origin, buildId: namespace, dataScope: namespace });
    const featureResult = await cli(['--profiles', harness.profilesFile, 'workflow', 'feature', '--manifest', featurePath, '--receipt', receiptFile.path, '--json']);
    const featureReport = JSON.parse(featureResult.stdout);
    checks.featureCommand = featureResult.code === 0 && featureReport.verdict === 'passed' && featureReport.steps.length === 13 && app.records().length === 0;
    if (!checks.featureCommand) console.error(JSON.stringify({ stage: 'feature', code: featureResult.code, verdict: featureReport.verdict, steps: featureReport.steps.map(({ id,status,reasonCode }) => ({ id,status,reasonCode })) }));
    phase = 'artifact-validation';
    checks.packageUnchanged = before === await digestTree(installed);
    checks.noRetainedSessionFiles = (await readdir(consumer.sessionTemp)).length === 0;
    let evidence = '';
    for (const file of await readdir(path.join(consumer.root, 'output'))) evidence += await readFile(path.join(consumer.root, 'output', file), 'utf8');
    assertNoLeaks(captured + evidence + await harness.auditText(), [writer.password, reader.password, ...app.issuedSessionTokens()]);
    checks.noCredentialLeak = true;
    console.log(JSON.stringify({ passed: Object.values(checks).every(Boolean), nativeStore: support.store, checks }));
    assert.ok(Object.values(checks).every(Boolean), 'all launch consumer checks pass');
  } catch {
    console.error('FAIL launch consumer proof at fixed stage: ' + phase);
    process.exitCode = 1;
  } finally {
    for (const [name, cleanup] of [['browser-context', () => context?.close()], ['browser', () => browser?.close()], ['mcp', () => client?.close()], ['scratch-store', () => harness?.dispose()], ['reference-app', () => app?.close()], ['consumer', () => consumer?.dispose()]]) {
      try { await cleanup(); } catch { process.exitCode = 1; console.error('FAIL launch proof cleanup: ' + name); }
    }
  }
}
