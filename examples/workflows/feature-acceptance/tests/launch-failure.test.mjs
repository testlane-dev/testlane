/**
 * Regression coverage for a raw chromium.launch()/newContext() failure
 * during `writer-identity`: before the fix, `safeError()` mapped anything
 * that wasn't already a SmokeError to the generic PROCESS_ERROR code, which
 * `reasonFor()` turns into "assertion-failed" -- indistinguishable from a
 * real app bug. It should instead get the dedicated LAUNCH_FAILED code
 * (reasonCode "launch-failed"), the same as authenticated-smoke's identical
 * fix.
 *
 * Uses the existing `loadBrowser` test-only injection seam already exercised
 * by 'a throwing loadBrowser (Playwright unavailable) blocks writer-identity'
 * in tests/runner.test.mjs, so no browser fixture/subprocess is needed here
 * (unlike authenticated-smoke, which has no equivalent seam and so drives a
 * real `run.mjs` child process instead -- see
 * ../../authenticated-smoke/tests/launch-failure.test.mjs). The difference
 * from that existing PLAYWRIGHT_UNAVAILABLE test is exactly the thing under
 * test: there, `loadBrowser` itself throws (playwright is unavailable, a
 * blocked prerequisite); here, `loadBrowser` succeeds and it is
 * `chromium.launch()` that throws (the browser tooling failed to come up).
 *
 * It also covers the ONE stderr hint line the runner prints for such a
 * failure (the expected executable path and the exact fix when the browser is
 * not installed, the first line of the error otherwise), in-process via
 * `launchHintLine()` and end to end through the real `run.mjs` CLI.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { after } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupReceiptDirs, reportFor, runCase, setupCase, stepFor } from './helpers.mjs';
import { reasonFor } from '../run.mjs';
import { launchHintLine } from '../runtime.mjs';

const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runMjs = path.join(templateDir, 'run.mjs');

after(async () => {
  await cleanupReceiptDirs();
});

test("run.mjs's reasonFor maps LAUNCH_FAILED to the shared 'launch-failed' reason code", () => {
  assert.equal(reasonFor('LAUNCH_FAILED', 'failed'), 'launch-failed');
});

test('a raw chromium.launch() failure in writer-identity is LAUNCH_FAILED, not assertion-failed; verdict failed, cleanup record none', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    loadBrowser: async () => ({
      chromium: {
        launch: async () => { throw new Error('mock: browser process did not start (simulated AV lock / crashed startup)'); },
      },
    }),
  });

  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'writer-identity')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'writer-identity')?.code, 'LAUNCH_FAILED');
  assert.notEqual(stepFor(run.steps, 'writer-identity')?.code, 'PROCESS_ERROR');
  assert.equal(stepFor(run.steps, 'reader-identity'), undefined);
  assert.equal(run.error.code, 'LAUNCH_FAILED');
  assert.equal(run.error.cleanup.status, 'complete');
  assert.equal(run.error.cleanup.record, 'none');

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'failed');
  assert.notEqual(report.verdict, 'blocked');
  assert.equal(report.counts.passed, 5); // profile-policy, readiness, environment-receipt, writer-session, reader-session

  // The runner's stderr hint carries the first line of the launch error
  // (nothing after it) -- the report above has no error text.
  assert.equal(
    launchHintLine(run.error, templateDir),
    'the browser could not be started (mock: browser process did not start (simulated AV lock / crashed startup)).',
  );
  assert.equal(JSON.stringify(report).includes('mock:'), false);
});

test('a launch that fails because the browser is not installed gets a hint naming the expected executable and the exact fix', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const executable = path.join(os.tmpdir(), 'fixture ms-playwright', 'chromium_headless_shell-1243', 'chrome-linux', 'headless_shell');
  const run = await runCase(setup, {
    loadBrowser: async () => ({
      chromium: {
        launch: async () => {
          throw new Error(`browserType.launch: Executable doesn't exist at ${executable}\n╔═══╗\n║ Please run the following command to download new browsers: ║\n║     npx playwright install ║\n╚═══╝`);
        },
      },
    }),
  });

  assert.ok(run.error);
  assert.equal(run.error.code, 'LAUNCH_FAILED');
  assert.equal(stepFor(run.steps, 'writer-identity')?.code, 'LAUNCH_FAILED');
  assert.equal(
    launchHintLine(run.error, templateDir),
    `Chromium is not installed (expected executable: ${executable}). Fix: run "npx playwright install chromium" inside ${templateDir} (Ubuntu: "npx playwright install --with-deps chromium"), then retry.`,
  );
  const reportText = JSON.stringify(reportFor(setup, run));
  assert.equal(reportText.includes('fixture ms-playwright'), false, 'the executable path stays out of the report');
  assert.equal(reportText.includes('npx playwright'), false);
});

test('a raw browser.newContext() failure in writer-identity is also LAUNCH_FAILED', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    loadBrowser: async () => ({
      chromium: {
        launch: async () => ({
          newContext: async () => { throw new Error('mock: browser context did not come up'); },
          close: async () => {},
        }),
      },
    }),
  });

  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'writer-identity')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'writer-identity')?.code, 'LAUNCH_FAILED');
  assert.equal(run.error.code, 'LAUNCH_FAILED');
  assert.equal(run.error.cleanup.record, 'none');

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'failed');

  // newContext({ storageState }) reads the session file, so no text from its
  // error may reach the stderr hint.
  const line = launchHintLine(run.error, templateDir);
  assert.equal(line.includes('mock: browser context did not come up'), false);
  assert.equal(line, 'the browser started but could not open a context or page; its error text is not printed.');
});

test('a raw context.newPage() failure in writer-identity is also LAUNCH_FAILED, not PROCESS_ERROR', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    loadBrowser: async () => ({
      chromium: {
        launch: async () => ({
          newContext: async () => ({
            on() {},
            route: async () => {},
            newPage: async () => { throw new Error('mock: browser context could not open a page'); },
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }),
  });

  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'writer-identity')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'writer-identity')?.code, 'LAUNCH_FAILED');
  assert.notEqual(stepFor(run.steps, 'writer-identity')?.code, 'PROCESS_ERROR');
  assert.equal(stepFor(run.steps, 'reader-identity'), undefined);
  assert.equal(run.error.code, 'LAUNCH_FAILED');
  assert.equal(run.error.cleanup.status, 'complete');
  assert.equal(run.error.cleanup.record, 'none');

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'failed');
  assert.notEqual(report.verdict, 'blocked');

  const line = launchHintLine(run.error, templateDir);
  assert.equal(line.includes('mock: browser context could not open a page'), false);
  assert.equal(line, 'the browser started but could not open a context or page; its error text is not printed.');
});

/**
 * A plain-spawn (no IPC) broker double for the real `run.mjs` CLI, which never
 * passes an `ipcConfig`: profiles/check/session answered from a temp JSON file
 * named by an env var (the session cookies are generated by the test's own
 * reference app, never a real secret, and never go through argv).
 */
async function writeFixtureBroker(dir) {
  const brokerPath = path.join(dir, 'fixture-broker.mjs');
  await writeFile(
    brokerPath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const config = JSON.parse(readFileSync(process.env.LAUNCH_FAILURE_BROKER_CONFIG, 'utf8'));",
      'const args = process.argv.slice(2);',
      "const command = args.find((arg) => !arg.startsWith('-'));",
      'const profile = config.profiles.find((candidate) => candidate.name === args[args.indexOf(command) + 1]);',
      "if (command === 'profiles') { process.stdout.write(JSON.stringify({ profiles: config.profiles })); process.exit(0); }",
      "if (command === 'check' && profile) { process.stdout.write(JSON.stringify({ ok: true, email: profile.email, role: profile.role })); process.exit(0); }",
      "if (command === 'session' && profile) {",
      '  const session = config.sessions[profile.name];',
      "  const out = args[args.indexOf('--out') + 1];",
      "  writeFileSync(out, JSON.stringify({ cookies: [{ name: session.cookieName, value: session.cookieValue, domain: new URL(config.origin).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));",
      '  process.stdout.write(JSON.stringify({ path: out }));',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  return brokerPath;
}

function runTemplate({ manifestPath, receiptPath, brokerPath, outputDir, browsersDir, configPath }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [runMjs, '--manifest', manifestPath, '--receipt', receiptPath, '--broker-cli', brokerPath, '--output-dir', outputDir, '--json'],
      { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir, LAUNCH_FAILURE_BROKER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
    guard.unref();
    child.once('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('run.mjs prints one stderr hint naming the missing browser build and the fix; the report and evidence carry none of it', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'testlane-feature-launch-hint-'));
  const outputDir = path.join(workDir, 'out');
  // An entirely empty PLAYWRIGHT_BROWSERS_PATH makes chromium.launch() fail in
  // its own executable lookup on every OS, so no platform fixture is needed.
  const browsersDir = path.join(workDir, 'empty-browsers');
  await mkdir(outputDir, { recursive: true });
  await mkdir(browsersDir, { recursive: true });
  const setup = await setupCase();
  t.after(async () => {
    await setup.app.close();
    await rm(workDir, { recursive: true, force: true });
  });
  const manifestPath = path.join(workDir, 'workflow.json');
  const receiptPath = path.join(workDir, 'receipt.json');
  const configPath = path.join(workDir, 'broker-config.json');
  await writeFile(manifestPath, JSON.stringify(setup.manifest));
  await writeFile(receiptPath, JSON.stringify(setup.receipt));
  await writeFile(configPath, JSON.stringify(setup.ipcConfig));
  const brokerPath = await writeFixtureBroker(workDir);

  const result = await runTemplate({ manifestPath, receiptPath, brokerPath, outputDir, browsersDir, configPath });

  assert.equal(result.signal, null, `stderr: ${result.stderr}`);
  assert.equal(result.code, 1, `stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const writerIdentity = report.steps.find((step) => step.id === 'writer-identity');
  assert.equal(writerIdentity?.status, 'failed');
  assert.equal(writerIdentity?.reasonCode, 'launch-failed');
  assert.equal(report.verdict, 'failed');

  const hintLines = result.stderr.split(/\r?\n/u).filter((line) => line.startsWith('feature acceptance hint: '));
  assert.equal(hintLines.length, 1, `expected exactly one hint line, stderr: ${result.stderr}`);
  const [hint] = hintLines;
  assert.ok(hint.includes('Chromium is not installed'), hint);
  assert.ok(hint.includes(`expected executable: ${browsersDir}`) || hint.includes(path.basename(browsersDir)), `hint must carry the path from the error: ${hint}`);
  assert.ok(hint.includes('"npx playwright install chromium"'), hint);
  assert.ok(hint.includes('"npx playwright install --with-deps chromium"'), hint);
  assert.ok(hint.includes(`inside ${templateDir} `), `hint must name the template folder: ${hint}`);

  const stem = `feature-acceptance-${report.runId}`;
  for (const text of [result.stdout, ...(await Promise.all(['.log', '.exit', '.report.json'].map((ext) => readFile(path.join(outputDir, `${stem}${ext}`), 'utf8'))))]) {
    assert.equal(text.includes(path.basename(browsersDir)), false, 'the expected executable path must stay out of the report and evidence');
    assert.equal(text.includes("Executable doesn't exist"), false);
    assert.equal(text.includes('npx playwright'), false);
  }
});
