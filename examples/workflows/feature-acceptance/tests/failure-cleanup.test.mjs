import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import http from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { cleanupReceiptDirs, createDeadline, reportFor, runCase, setupCase, stepFor } from './helpers.mjs';
import { writeFeatureEvidence } from '../runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureBroker = path.join(here, 'fixtures', 'issuance-broker.mjs');
const runMjs = path.resolve(here, '..', 'run.mjs');
after(cleanupReceiptDirs);

async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'testlane-feature-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function assertEvidence(setup, report, outputDir) {
  const paths = await writeFeatureEvidence(outputDir, report);
  const texts = await Promise.all(Object.values(paths).map((file) => readFile(file, 'utf8')));
  assert.equal(texts.length, 3);
  assert.equal(await readFile(paths.exit, 'utf8'), '1\n');
  assert.equal(JSON.parse(await readFile(paths.report, 'utf8')).verdict, report.verdict);
  const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
  assert.equal(texts.some((text) => needles.some((secret) => text.includes(secret))), false);
}

for (const field of ['idLabel', 'titleLabel']) {
  for (const mode of ['failed', 'cancelled']) {
    test(`${mode} during ${field} fill produces a valid report and verified absence evidence`, async (t) => {
      const setup = await setupCase();
      t.after(() => setup.app.close());
      const dir = await scratch(t);
      const deadline = createDeadline(setup.workflow.timeoutMs);
      let reachedFill = false;
      const run = await runCase(setup, {
        deadline,
        loadBrowser: async () => {
          const real = await import('playwright');
          return { chromium: { launch: async (options) => {
            const browser = await real.chromium.launch(options);
            const newContext = browser.newContext.bind(browser);
            browser.newContext = async (contextOptions) => {
              const context = await newContext(contextOptions);
              const newPage = context.newPage.bind(context);
              context.newPage = async () => {
                const page = await newPage();
                const getByLabel = page.getByLabel.bind(page);
                page.getByLabel = (label, locatorOptions) => {
                  const locator = getByLabel(label, locatorOptions);
                  if (label === setup.workflow.record.form[field]) locator.fill = async () => {
                    reachedFill = true;
                    if (mode === 'cancelled') { deadline.cancel(); return new Promise(() => {}); }
                    throw new Error(setup.writer.password); // Reflected input must not reach evidence.
                  };
                  return locator;
                };
                return page;
              };
              return context;
            };
            return browser;
          } } };
        },
      });
      assert.equal(reachedFill, true);
      assert.equal(stepFor(run.steps, 'browser-create')?.status, mode);
      assert.equal(stepFor(run.steps, 'api-readback'), undefined);
      assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'absent-verified' });
      assert.equal(setup.app.stats().creates, 0);
      const report = reportFor(setup, run);
      assert.equal(report.verdict, mode);
      await assertEvidence(setup, report, path.join(dir, 'evidence'));
    });
  }
}

for (const role of ['writer', 'reader']) {
  for (const mode of ['failed', 'cancelled', 'invalid-state']) {
    test(`${role} issuance ${mode} after file creation removes every owned session directory`, async (t) => {
      const setup = await setupCase();
      t.after(() => setup.app.close());
      const deadline = createDeadline(setup.workflow.timeoutMs);
      const roots = [];
      const server = http.createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        const observed = JSON.parse(text);
        roots.push(observed.root);
        res.end('ok');
        if (observed.profile === setup.workflow.roles[role].profile && mode === 'cancelled') deadline.cancel();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
      let retainedBeforeCleanup = false;
      const run = await runCase(setup, {
        deadline,
        brokerCli: fixtureBroker,
        ipcConfig: { ...setup.ipcConfig, observer: `http://127.0.0.1:${server.address().port}/`, faultProfile: setup.workflow.roles[role].profile, fault: mode },
        cleanupHook: async () => { retainedBeforeCleanup = (await Promise.all(roots.map((root) => access(path.join(root, 'session.json')).then(() => true, () => false)))).every(Boolean); },
      });
      assert.equal(roots.length, role === 'writer' ? 1 : 2);
      assert.equal(retainedBeforeCleanup, true, 'fixture must actually write each session before failing');
      for (const root of roots) await assert.rejects(access(root), { code: 'ENOENT' });
      assert.equal(stepFor(run.steps, `${role}-session`)?.status, mode === 'cancelled' ? 'cancelled' : 'failed');
      assert.equal(stepFor(run.steps, 'writer-identity'), undefined);
      assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'none' });
      assert.equal(reportFor(setup, run).verdict, mode === 'cancelled' ? 'cancelled' : 'failed');
    });
  }
}

async function cliCase(t, setup, { cancel = false, invalidOutput = false } = {}) {
  const dir = await scratch(t);
  const manifest = path.join(dir, 'workflow.json');
  const receipt = path.join(dir, 'receipt.json');
  const config = path.join(dir, 'test-broker.json');
  const output = path.join(dir, 'evidence');
  await writeFile(manifest, JSON.stringify({ ...setup.manifest, record: { ...setup.manifest.record, form: { ...setup.manifest.record.form, idLabel: 'Missing regression label' } } }));
  await writeFile(receipt, JSON.stringify(setup.receipt));
  await writeFile(config, JSON.stringify(setup.ipcConfig));
  if (invalidOutput) await writeFile(output, 'not a directory');
  const child = fork(runMjs, ['--manifest', manifest, '--receipt', receipt, '--broker-cli', invalidOutput ? path.join(dir, 'missing-broker.mjs') : fixtureBroker, '--output-dir', output, '--json'], { silent: true, windowsHide: true, env: { ...process.env, TESTLANE_FEATURE_TEST_CONFIG: config } });
  let stdout = ''; let stderr = ''; let cancellationSent = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const guard = setTimeout(() => child.kill('SIGKILL'), 45000);
  const poll = cancel ? setInterval(() => {
    if (!cancellationSent && setup.app.stats().byPath[setup.workflow.record.createPagePath]) {
      cancellationSent = true;
      setTimeout(() => { if (child.connected) child.send('testlane:workflow:cancel:v1'); }, 100);
    }
  }, 10) : null;
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(guard); clearInterval(poll);
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.equal(stdout.includes(setup.writer.password) || stderr.includes(setup.writer.password), false);
  if (invalidOutput) {
    assert.equal(stdout, '');
    assert.equal(stderr, 'feature acceptance failed while finalizing evidence\n');
    return;
  }
  const report = JSON.parse(stdout);
  assert.equal(stepFor(report.steps, 'browser-create')?.status, cancel ? 'cancelled' : 'failed');
  assert.equal(stepFor(report.steps, 'browser-create')?.reasonCode, cancel ? 'cancelled' : 'timeout');
  assert.equal(report.verdict, cancel ? 'cancelled' : 'failed');
  assert.deepEqual(report.cleanup, { status: 'complete', reasonCode: 'ok', record: 'absent-verified' });
  assert.ok(stderr.includes(`feature acceptance ${report.verdict}: browser-create (`));
  assert.equal((await readdir(output)).length, 3);
  const stored = await readFile(path.join(output, `feature-acceptance-${report.runId}.report.json`), 'utf8');
  assert.deepEqual(JSON.parse(stored), report);
  const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
  for (const text of [stdout, stderr, ...await Promise.all((await readdir(output)).map((name) => readFile(path.join(output, name), 'utf8')))]) assert.equal(needles.some((secret) => text.includes(secret)), false);
}

for (const cancel of [false, true]) {
  test(`CLI ${cancel ? 'cancellation' : 'timeout'} before the first fill completes writes all evidence and a diagnostic`, async (t) => {
    // Leave cold CI browser startup ample room; the missing label, rather
    // than an earlier identity step, must be the operation that times out.
    const setup = await setupCase({ timeoutMs: 20000 });
    t.after(() => setup.app.close());
    await cliCase(t, setup, { cancel });
  });
}

test('CLI evidence I/O failure emits a fixed diagnostic rather than exiting silently', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  await cliCase(t, setup, { invalidOutput: true });
});
