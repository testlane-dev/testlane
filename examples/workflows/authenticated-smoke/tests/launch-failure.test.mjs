/**
 * Regression coverage for a chromium.launch() (or newContext()/newPage())
 * failure during the `identity` step: before the fix, that browser bring-up
 * ran *between* mark() calls, so a launch failure threw past every mark()
 * with no onStep() call at all -- the step set was just missing 4 steps and
 * the report surfaced as "blocked" with no reason pointing at the browser.
 * A binary that starts but never becomes ready was worse: the run's own
 * deadline still fired and evidence still got written, but the orphaned
 * browser child kept the event loop (and the whole `node run.mjs` process)
 * alive forever.
 *
 * Both cases are driven through the real `run.mjs` CLI entry point (a real
 * child process, not an in-process call into runtime.mjs) because the
 * process-exit/orphan-process behaviour under test only exists at that
 * entry point. The broker is a tiny plain-spawn double (config delivered via
 * a temp JSON file named by an env var, never argv or a real secret) since
 * `fake-broker.mjs`/`self-test.mjs` are IPC(fork)-only and `run.mjs` never
 * passes an `ipcConfig`. The app under test only ever needs to answer
 * `/ready`: every case here fails before any authenticated page is reached.
 *
 * The report only ever says `launch-failed`; so that a newcomer whose browser
 * is not installed is not left with just that, the runner also prints ONE
 * stderr hint line (the expected executable path and the exact fix for a
 * missing browser, the first line of the error for anything else). The cases
 * below cover both, and that none of that text reaches the report/evidence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow } from '../manifest.mjs';
import { createDeadline, launchFailure, launchHintLine, runAuthenticatedChecks, SmokeError } from '../runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runMjs = path.join(here, '..', 'run.mjs');
const fakeBrokerPath = path.join(here, '..', 'fake-broker.mjs');

/**
 * The chromium and chromium-headless-shell revisions the installed
 * playwright-core looks for (its browsers.json, read through the template's
 * own `playwright` dependency), so the fixture install below follows a
 * playwright upgrade instead of pinning one revision. If Playwright ever stops
 * finding the fixture anyway (a new directory layout, say), it reports a
 * missing install instead: the exiting-binary test below then gets the
 * "Chromium is not installed" hint and fails on its hint assertion. The hang
 * test alone would not notice, because it accepts launch-failed.
 */
function bundledChromiumRevisions() {
  const playwrightPackage = createRequire(import.meta.url).resolve('playwright/package.json');
  const corePackage = createRequire(playwrightPackage).resolve('playwright-core/package.json');
  const { browsers } = JSON.parse(readFileSync(path.join(path.dirname(corePackage), 'browsers.json'), 'utf8'));
  const revision = (name) => {
    const entry = browsers.find((browser) => browser.name === name);
    if (!entry?.revision) throw new Error(`playwright-core's browsers.json lists no ${name} revision`);
    return entry.revision;
  };
  return { chromium: revision('chromium'), headlessShell: revision('chromium-headless-shell') };
}

// What the `behavior: 'exit'` fixture binary prints on its own stderr. Only
// the FIRST line of Playwright's launch error may reach the runner's hint, and
// Playwright puts this text further down (under "Browser logs:"), so it must
// never show up there.
const FIXTURE_REFUSAL = 'fixture browser refused to start';

function startReadyOnlyApp() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url === '/ready') {
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** A plain-spawn (no IPC) broker double. Config comes from a temp file named by an env var, never argv/a real secret. */
async function writeFixtureBroker(dir) {
  const brokerPath = path.join(dir, 'fixture-broker.mjs');
  await writeFile(
    brokerPath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const config = JSON.parse(readFileSync(process.env.LAUNCH_FAILURE_BROKER_CONFIG, 'utf8'));",
      'const args = process.argv.slice(2);',
      "const command = args.find((arg) => !arg.startsWith('-'));",
      "if (command === 'profiles') { process.stdout.write(JSON.stringify({ profiles: [config.profile] })); process.exit(0); }",
      "if (command === 'check') { process.stdout.write(JSON.stringify({ ok: true, email: config.profile.email, role: config.profile.role })); process.exit(0); }",
      "if (command === 'session') {",
      "  const outIndex = args.indexOf('--out');",
      '  const out = args[outIndex + 1];',
      "  writeFileSync(out, JSON.stringify({ cookies: [{ name: 'smoke_session', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));",
      '  process.stdout.write(JSON.stringify({ path: out }));',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  return brokerPath;
}

async function buildWorkflowManifest(dir, { origin, timeoutMs }) {
  const email = `launch-failure-${randomBytes(4).toString('hex')}@example.test`;
  const profile = { name: 'launch-failure:local:smoke', email, role: 'Sales', environment: 'testing', baseUrl: origin, strategy: 'nextauth-credentials' };
  const workflow = {
    schemaVersion: 1,
    kind: 'authenticated-smoke',
    id: 'launch-failure-smoke',
    profile: profile.name,
    target: { origin, environment: 'testing' },
    identity: { email, role: profile.role },
    checks: { readinessPath: '/ready', identityPath: '/identity', protectedPath: '/protected', protectedHeading: 'Protected workspace', apiPath: '/api/data' },
    timeoutMs,
  };
  const manifestPath = path.join(dir, 'workflow.json');
  await writeFile(manifestPath, JSON.stringify(workflow));
  const configPath = path.join(dir, 'broker-config.json');
  await writeFile(configPath, JSON.stringify({ profile }));
  return { manifestPath, configPath };
}

/**
 * Spawns `run.mjs` for real. `guardMs` is a last-resort safety kill (SIGKILL)
 * so this test can never itself hang forever while demonstrating the
 * pre-fix bug (a launch that never settles) -- `guardTripped: true` on the
 * result IS the failure signal for that case, not a thing this helper hides.
 */
function runTemplate({ manifestPath, brokerPath, outputDir, browsersDir, configPath, guardMs = 20_000 }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [runMjs, '--manifest', manifestPath, '--broker-cli', brokerPath, '--output-dir', outputDir, '--json'],
      { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir, LAUNCH_FAILURE_BROKER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const startedAtMs = Date.now();
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, signal: null, stdout, stderr, elapsedMs: Date.now() - startedAtMs, guardTripped: true });
    }, guardMs);
    guard.unref();
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAtMs, guardTripped: false });
    });
  });
}

/** SIGKILLs every process whose command line contains `marker`. Used both as an assertion (via assertNoProcessMatching) and as unconditional teardown so a run this test intentionally drove into a hang never leaks a real process into the rest of the sandbox. */
function killAllMatching(marker) {
  let output;
  try {
    output = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' });
  } catch {
    return; // pgrep exits 1 with nothing to report when no process matches
  }
  for (const line of output.split('\n')) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** Polls briefly (the OS needs a moment to reap an asynchronously-killed process) then asserts nothing matches `marker` any more. */
async function assertNoProcessMatching(marker) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    let output;
    try {
      output = execFileSync('pgrep', ['-fa', marker], { encoding: 'utf8' });
    } catch {
      return; // no match: exactly what we want
    }
    if (output.trim() === '') return;
    if (attempt === 14) assert.fail(`orphan process(es) still running after the run exited:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * A fixture "chromium" install (matching playwright-core's bundled revision
 * and Linux directory layout: chromium-<rev>/chrome-linux64/chrome,
 * chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell,
 * plus an INSTALLATION_COMPLETE marker -- confirmed against a real local
 * Chromium install) whose "binary" is a single long-lived Node process that
 * never prints the DevTools-listening line Playwright's launch() waits for
 * on stderr, simulating a binary that starts but never becomes ready (e.g. a
 * stuck first-run AV scan). A single process with no further exec'd child,
 * so killing this one PID leaves nothing behind to orphan.
 *
 * Only implemented for linux: this suite only ever runs in a Linux CI
 * container/sandbox, and darwin/win32 each need a real platform-native
 * fixture binary (a .app bundle's actual Mach-O executable / a spawnable
 * .exe) that has not been built or verified anywhere in this repo. Rather
 * than guess at an unverified shape, other platforms get an explicit
 * `{ supported: false, reason }` so the caller can skip loudly instead of
 * silently passing nothing.
 *
 * `behavior: 'exit'` swaps the binary for one that prints a line on stderr
 * and exits 1 straight away, i.e. a launch that fails for a reason other
 * than a missing install.
 */
async function buildFixtureBrowsersDir(root, { behavior = 'hang' } = {}) {
  if (process.platform === 'linux') {
    const revisions = bundledChromiumRevisions();
    const chromeRoot = path.join(root, `chromium-${revisions.chromium}`);
    const shellRoot = path.join(root, `chromium_headless_shell-${revisions.headlessShell}`);
    const chromeDir = path.join(chromeRoot, 'chrome-linux64');
    const shellDir = path.join(shellRoot, 'chrome-headless-shell-linux64');
    await mkdir(chromeDir, { recursive: true });
    await mkdir(shellDir, { recursive: true });
    const script = (behavior === 'exit'
      ? [
        '#!/usr/bin/env node',
        '// Simulates a Chromium binary that cannot start: it complains and exits.',
        `process.stderr.write('${FIXTURE_REFUSAL}\\n');`,
        'process.exit(1);',
        '',
      ]
      : [
        '#!/usr/bin/env node',
        '// Simulates a Chromium binary that starts but never signals readiness',
        "// (never prints the DevTools-listening line on stderr). A single Node",
        '// process with no further exec’d child, so killing this PID orphans',
        '// nothing.',
        'setInterval(() => {}, 0x7fffffff);',
        '',
      ]).join('\n');
    const chromeBin = path.join(chromeDir, 'chrome');
    const shellBin = path.join(shellDir, 'chrome-headless-shell');
    await writeFile(chromeBin, script);
    await writeFile(shellBin, script);
    await chmod(chromeBin, 0o755);
    await chmod(shellBin, 0o755);
    await writeFile(path.join(chromeRoot, 'INSTALLATION_COMPLETE'), '');
    await writeFile(path.join(shellRoot, 'INSTALLATION_COMPLETE'), '');
    await writeFile(path.join(shellRoot, 'DEPENDENCIES_VALIDATED'), '');
    return { supported: true };
  }
  if (process.platform === 'darwin') {
    return {
      supported: false,
      reason:
        'macOS needs a real chrome-mac*/*.app bundle fixture Playwright will actually spawn; not built or verified anywhere in this repo (this suite only ever runs on the Linux CI container)',
    };
  }
  return {
    supported: false,
    reason:
      'Windows needs a spawnable .exe fixture under chrome-win64\\; a POSIX/node-shebang script is not enough, and none was built or verified here (this suite only ever runs on the Linux CI container)',
  };
}

test('a chromium.launch() that fails fast (no installed browser) fails identity with launch-failed, not a silently missing step', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'testlane-launch-failure-'));
  const outputDir = path.join(workDir, 'out');
  // An entirely empty PLAYWRIGHT_BROWSERS_PATH is portable across every OS
  // Playwright supports: chromium.launch() fails during its own executable
  // lookup (before it would ever try to spawn anything platform-specific),
  // so this case needs no OS-specific fixture at all.
  const browsersDir = path.join(workDir, 'empty-browsers');
  await mkdir(outputDir, { recursive: true });
  await mkdir(browsersDir, { recursive: true });
  const app = await startReadyOnlyApp();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  });
  const brokerPath = await writeFixtureBroker(workDir);
  const { manifestPath, configPath } = await buildWorkflowManifest(workDir, { origin: `http://127.0.0.1:${app.port}`, timeoutMs: 10_000 });

  const result = await runTemplate({ manifestPath, brokerPath, outputDir, browsersDir, configPath });

  assert.equal(result.guardTripped, false, 'must exit on its own well within the guard window');
  assert.equal(result.signal, null, `must not be signalled (stderr: ${result.stderr})`);
  assert.equal(result.code, 1);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${result.stdout}`);
  }
  for (const id of ['profile-policy', 'readiness', 'broker-check', 'session']) {
    assert.equal(report.steps.find((step) => step.id === id)?.status, 'passed', `${id} should have passed`);
  }
  const identity = report.steps.find((step) => step.id === 'identity');
  assert.ok(identity, 'identity step must be present in the report, not silently missing');
  assert.equal(identity.status, 'failed');
  assert.equal(identity.reasonCode, 'launch-failed');
  assert.equal(report.verdict, 'failed');
  assert.notEqual(report.verdict, 'blocked');
  assert.deepEqual([...report.missingRequiredSteps].sort(), ['anonymous-denied', 'api', 'protected-page']);
  assert.equal(report.cleanup.status, 'complete');

  // Evidence was written even though the browser never came up.
  const stem = `workflow-smoke-${report.runId}`;
  const { readFile } = await import('node:fs/promises');
  const exitCode = (await readFile(path.join(outputDir, `${stem}.exit`), 'utf8')).trim();
  assert.equal(exitCode, '1');

  // A newcomer sees WHY on stderr: one line naming the executable Playwright
  // expected (taken from its error) and the exact fix -- and none of that
  // text reaches the report or the evidence files.
  const hintLines = result.stderr.split(/\r?\n/u).filter((line) => line.startsWith('workflow smoke hint: '));
  assert.equal(hintLines.length, 1, `expected exactly one hint line, stderr: ${result.stderr}`);
  const [hint] = hintLines;
  assert.ok(hint.includes('Chromium is not installed'), hint);
  assert.ok(hint.includes(`expected executable: ${browsersDir}`) || hint.includes(path.basename(browsersDir)), `hint must carry the path from the error: ${hint}`);
  assert.ok(hint.includes('"npx playwright install chromium"'), hint);
  assert.ok(hint.includes('"npx playwright install --with-deps chromium"'), hint);
  assert.ok(hint.includes(`inside ${path.dirname(runMjs)} `), `hint must name the template folder: ${hint}`);
  for (const text of [result.stdout, ...(await Promise.all(['.log', '.exit', '.report.json'].map((ext) => readFile(path.join(outputDir, `${stem}${ext}`), 'utf8'))))]) {
    assert.equal(text.includes(path.basename(browsersDir)), false, 'the expected executable path must stay out of the report and evidence');
    assert.equal(text.includes("Executable doesn't exist"), false);
    assert.equal(text.includes('npx playwright'), false);
  }
});

test('a launch that fails for any other reason prints a generic one-line hint: the first line of the error only, never the browser logs', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'testlane-launch-refused-'));
  const outputDir = path.join(workDir, 'out');
  const browsersDir = path.join(workDir, 'refusing-browsers');
  await mkdir(outputDir, { recursive: true });
  await mkdir(browsersDir, { recursive: true });
  const fixture = await buildFixtureBrowsersDir(browsersDir, { behavior: 'exit' });
  t.after(async () => {
    killAllMatching(browsersDir);
    await rm(workDir, { recursive: true, force: true });
  });
  if (!fixture.supported) {
    t.skip(`no portable exiting-binary fixture for ${process.platform}: ${fixture.reason}`);
    return;
  }
  const app = await startReadyOnlyApp();
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); });
  const brokerPath = await writeFixtureBroker(workDir);
  const { manifestPath, configPath } = await buildWorkflowManifest(workDir, { origin: `http://127.0.0.1:${app.port}`, timeoutMs: 10_000 });

  const result = await runTemplate({ manifestPath, brokerPath, outputDir, browsersDir, configPath });

  assert.equal(result.guardTripped, false, 'must exit on its own well within the guard window');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const identity = report.steps.find((step) => step.id === 'identity');
  assert.equal(identity?.status, 'failed');
  assert.equal(identity?.reasonCode, 'launch-failed');

  const hintLines = result.stderr.split(/\r?\n/u).filter((line) => line.startsWith('workflow smoke hint: '));
  assert.equal(hintLines.length, 1, `expected exactly one hint line, stderr: ${result.stderr}`);
  const [hint] = hintLines;
  assert.match(hint, /^workflow smoke hint: the browser could not be started \(browserType\.launch: [^\n]{1,200}\)\.$/u);
  assert.equal(hint.includes('Chromium is not installed'), false, 'not a missing-install failure');
  // Everything after the first line of Playwright's error (the browser's own
  // stderr, its launch command line and profile directory) stays out.
  for (const text of [result.stderr, result.stdout]) {
    assert.equal(text.includes(FIXTURE_REFUSAL), false, 'browser stderr must not be echoed');
    assert.equal(text.includes('--user-data-dir'), false, 'the launch command line must not be echoed');
    assert.equal(text.includes('Browser logs'), false);
  }
});

test('launchFailure()/launchHintLine(): the hint names the missing executable (path kept whole, spaces and CRLF included) and the exact fix', () => {
  const unix = new Error([
    "browserType.launch: Executable doesn't exist at /home/dev user/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell",
    '╔════════════════════════════════════════════════════════════╗',
    '║ Looks like Playwright was just installed or updated.       ║',
    '║ Please run the following command to download new browsers: ║',
    '║     npx playwright install                                 ║',
    '╚════════════════════════════════════════════════════════════╝',
  ].join('\n'));
  const failure = launchFailure(unix, { detail: true });
  assert.ok(failure instanceof SmokeError);
  assert.equal(failure.code, 'LAUNCH_FAILED');
  assert.equal(
    launchHintLine(failure, '/work/authenticated-smoke'),
    'Chromium is not installed (expected executable: /home/dev user/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell). Fix: run "npx playwright install chromium" inside /work/authenticated-smoke (Ubuntu: "npx playwright install --with-deps chromium"), then retry.',
  );

  const windows = new Error("browserType.launch: Executable doesn't exist at C:\\Users\\Dev User\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243\\chrome-win\\headless_shell.exe\r\nPlease run the following command to download new browsers:\r\n    npx playwright install\r\n");
  const windowsLine = launchHintLine(launchFailure(windows, { detail: true }), 'C:\\work\\authenticated-smoke');
  assert.ok(windowsLine.includes('(expected executable: C:\\Users\\Dev User\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243\\chrome-win\\headless_shell.exe)'), windowsLine);
  assert.equal(/[\r\n]/u.test(windowsLine), false, 'a single line');
});

test('launchFailure()/launchHintLine(): any other launch error gives a short generic hint -- first line only, control characters stripped, capped', () => {
  const canary = 'ERROR-BODY-CANARY';
  const multiline = launchFailure(new Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launching> /x/chrome --user-data-dir=/tmp/profile\n[pid=1][err] ${canary}`), { detail: true });
  assert.equal(launchHintLine(multiline, '/work'), 'the browser could not be started (browserType.launch: Target page, context or browser has been closed).');

  const noisy = launchFailure(new Error(`\u001b[31mred\u0007 \u0000bell\u009b\u202e${'x'.repeat(500)}\nsecond line ${canary}`), { detail: true });
  const noisyLine = launchHintLine(noisy, '/work');
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202e]/u.test(noisyLine), false, 'control characters are stripped');
  assert.equal(noisyLine.includes(canary), false, 'only the first line');
  // ESC, BEL, NUL, the C1 control and the bidi override are dropped (the
  // "[31m" remainder of the colour code is plain text), then 200 characters
  // are kept and "..." marks the cut.
  assert.equal(noisyLine, `the browser could not be started ([31mred bell${'x'.repeat(188)}...).`);

  assert.equal(launchHintLine(launchFailure(new Error(''), { detail: true }), '/work'), 'the browser could not be started (no error message).');
  assert.equal(launchHintLine(launchFailure('not an Error', { detail: true }), '/work'), 'the browser could not be started (no error message).');
});

test('launchFailure()/launchHintLine(): a newContext()/newPage() failure and anything that is not a raw launch error never put error text in the hint', () => {
  // newContext({ storageState }) reads the session file; its errors (and
  // newPage()'s) may quote it, so by default no text is carried at all.
  const canary = 'STORAGE-STATE-CANARY';
  const failure = launchFailure(new Error(`browserContext.newContext: ${canary}`));
  assert.equal(failure.code, 'LAUNCH_FAILED');
  assert.deepEqual(failure.hint, {});
  const line = launchHintLine(failure, '/work');
  assert.equal(line.includes(canary), false);
  assert.equal(line, 'the browser started but could not open a context or page; its error text is not printed.');

  // A SmokeError (TIMEOUT/CANCELLED from the deadline) passes through untouched and gets no hint.
  const timeout = new SmokeError('TIMEOUT');
  assert.equal(launchFailure(timeout, { detail: true }), timeout);
  assert.equal(launchHintLine(timeout, '/work'), null);
  assert.equal(launchHintLine(undefined, '/work'), null);
  assert.equal(launchHintLine(new SmokeError('PLAYWRIGHT_UNAVAILABLE'), '/work'), null);
});

/**
 * Regression coverage for a raw `context.newPage()` failure during
 * `identity`: before the fix, `safeError()` mapped anything that wasn't
 * already a SmokeError to the generic PROCESS_ERROR code (-> a misleading
 * "assertion-failed"), same class of bug as the launch()/newContext() cases
 * above. Unlike those two (driven through a real `run.mjs` child process
 * with a fixture Chromium binary, since fully faking a CDP-level newPage
 * failure would need a real protocol implementation), this one is driven
 * in-process against `runAuthenticatedChecks` directly -- exactly how
 * `self-test.mjs` already does for the happy path -- using the `loadBrowser`
 * test-only injection seam added alongside this fix (mirrors the seam
 * feature-acceptance's runtime.mjs already had; see
 * ../../feature-acceptance/tests/launch-failure.test.mjs for its
 * newPage() case).
 */
test('a raw context.newPage() failure in identity is LAUNCH_FAILED, not PROCESS_ERROR (in-process via the loadBrowser test seam)', async (t) => {
  const cookie = randomBytes(24).toString('hex');
  const email = `newpage-failure-${randomBytes(4).toString('hex')}@example.test`;
  const role = 'Sales';
  const app = await startReadyOnlyApp();
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.port}`;

  const workflow = parseWorkflow({
    schemaVersion: 1,
    kind: 'authenticated-smoke',
    id: 'newpage-failure-smoke',
    profile: 'newpage-failure:local:smoke',
    target: { origin, environment: 'testing' },
    identity: { email, role },
    checks: { readinessPath: '/ready', identityPath: '/identity', protectedPath: '/protected', protectedHeading: 'Protected workspace', apiPath: '/api/data' },
    timeoutMs: 15_000,
  });

  const deadline = createDeadline(workflow.timeoutMs);
  const steps = [];
  let caught = null;
  try {
    await runAuthenticatedChecks({
      workflow,
      brokerCli: fakeBrokerPath,
      deadline,
      ipcConfig: { origin, cookie, profile: { name: workflow.profile, email, role, environment: 'testing', baseUrl: origin, strategy: 'nextauth-credentials' } },
      onStep: (id, status, code, durationMs) => steps.push({ id, status, code, durationMs }),
      // A fake `playwright` module: chromium.launch() and browser.newContext()
      // both succeed (so this exercises the NEW newPage() wrapping, not the
      // already-covered launch()/newContext() ones), but context.newPage()
      // throws a raw (non-SmokeError) error, simulating browser tooling that
      // came up far enough to open a context but failed to open a page.
      loadBrowser: async () => ({
        chromium: {
          launch: async () => ({
            newContext: async () => ({
              on: () => {},
              route: async () => {},
              newPage: async () => { throw new Error('mock: browser context could not open a page'); },
              close: async () => {},
            }),
            close: async () => {},
          }),
        },
      }),
    });
  } catch (error) {
    caught = error;
  } finally {
    deadline.dispose?.();
  }

  assert.ok(caught, 'expected runAuthenticatedChecks to reject');
  for (const id of ['profile-policy', 'readiness', 'broker-check', 'session']) {
    assert.equal(steps.find((step) => step.id === id)?.status, 'passed', `${id} should have passed`);
  }
  const identity = steps.find((step) => step.id === 'identity');
  assert.ok(identity, 'identity step must be recorded, not silently missing');
  assert.equal(identity.status, 'failed');
  assert.equal(identity.code, 'LAUNCH_FAILED');
  assert.notEqual(identity.code, 'PROCESS_ERROR');
  assert.equal(caught.code, 'LAUNCH_FAILED');
  // The page-open failure comes after the session file exists, so none of its
  // error text may reach the stderr hint.
  const line = launchHintLine(caught, '/work');
  assert.equal(line.includes('mock: browser context could not open a page'), false);
  assert.equal(line, 'the browser started but could not open a context or page; its error text is not printed.');
});

test(
  'a chromium binary that starts but never becomes ready is bounded by the run deadline, exits on its own, and leaves no orphan process',
  { timeout: 30_000 },
  async (t) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'testlane-launch-hang-'));
    const outputDir = path.join(workDir, 'out');
    const browsersDir = path.join(workDir, 'hang-browsers');
    await mkdir(outputDir, { recursive: true });
    await mkdir(browsersDir, { recursive: true });

    const fixture = await buildFixtureBrowsersDir(browsersDir);
    t.after(async () => {
      killAllMatching(browsersDir);
      await rm(workDir, { recursive: true, force: true });
    });
    if (!fixture.supported) {
      t.skip(`no portable hanging-binary fixture for ${process.platform}: ${fixture.reason}`);
      return;
    }

    const app = await startReadyOnlyApp();
    t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); });
    const brokerPath = await writeFixtureBroker(workDir);
    const timeoutMs = 4_000;
    const { manifestPath, configPath } = await buildWorkflowManifest(workDir, { origin: `http://127.0.0.1:${app.port}`, timeoutMs });

    const result = await runTemplate({ manifestPath, brokerPath, outputDir, browsersDir, configPath, guardMs: 20_000 });

    assert.equal(
      result.guardTripped,
      false,
      `the process must exit on its own, bounded by the run's own deadline -- it did not, and had to be force-killed by this test's safety guard (a hang) (stdout: ${result.stdout}, stderr: ${result.stderr})`,
    );
    assert.equal(result.signal, null, `must not be signalled (stderr: ${result.stderr})`);
    // Bounded by the run's own deadline (timeoutMs) plus, at most, the fixed
    // force-exit grace period -- generous headroom added for CI scheduling,
    // not for an external kill.
    assert.ok(result.elapsedMs < timeoutMs + 10_000, `took ${result.elapsedMs}ms, expected roughly ${timeoutMs}ms (+ grace)`);
    assert.equal(result.code, 1);

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      assert.fail(`stdout was not valid JSON: ${result.stdout}`);
    }
    const identity = report.steps.find((step) => step.id === 'identity');
    assert.ok(identity, 'identity step must be present in the report, not silently missing');
    assert.equal(identity.status, 'failed');
    // Playwright's own launch `timeout` and the run's outer deadline target
    // the same wall-clock end time; whichever settles first wins the race
    // deterministically (the outer deadline's timer is armed strictly
    // earlier), so this consistently lands on 'timeout' rather than
    // 'launch-failed' -- both are acceptable evidence that the browser
    // bring-up is now inside the identity step and bounded by the deadline.
    assert.ok(['timeout', 'launch-failed'].includes(identity.reasonCode), `unexpected reasonCode ${identity.reasonCode}`);
    assert.equal(report.verdict, 'failed');

    // No orphan browser process left running once run.mjs has exited.
    await assertNoProcessMatching(browsersDir);
  },
);
