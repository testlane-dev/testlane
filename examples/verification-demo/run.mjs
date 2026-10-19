#!/usr/bin/env node
/** Run only the bundled disposable demo, never a caller-selected app or account. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoApp } from './app.mjs';
import { prepareDemoSuite } from './suite.mjs';
import { createDemoTemporaryDirectory, demoStorePolicy, removeDemoTemporaryDirectory, runDemoChild } from './native.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
function registry({ namespace, origin, accounts }) {
  return { version: 1, profiles: Object.fromEntries(['editor', 'reviewer'].map(name => [namespace + ':testing:' + name, {
    app: 'testlane-verification-demo', environment: 'testing', baseUrl: origin, strategy: 'form-post',
    account: { email: accounts[name].email, role: name === 'editor' ? 'Editor' : 'Reviewer' }, session: { ttlMinutes: 10 },
    options: { loginPath: '/api/login', bodyFormat: 'json', fields: '{"email":"{{email}}","password":"{{secret}}"}',
      sessionCookieName: 'tldemo_session', mePath: '/api/me', emailField: 'email', roleField: 'role' },
  }])) };
}
async function scanText(root, values) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('DEMO_OUTPUT_PATH_INVALID');
    if (entry.isDirectory()) await scanText(file, values);
    else if (entry.isFile()) {
      const bytes = await readFile(file);
      if (values.some(value => bytes.includes(Buffer.from(value)))) throw new Error('DEMO_SECRET_OUTPUT_BLOCKED');
    }
  }
}

/** Uses only newly generated credentials and uniquely named native entries, removed in finally. */
export async function runDemo({ projectRoot = process.env.TESTLANE_VERIFICATION_TEST_PROJECT ?? process.cwd(), allowUserKeychain = false, signal } = {}) {
  const policy = demoStorePolicy({ allowUserKeychain }); // Refuse before creating files or writing a store.
  let project = await realpath(projectRoot);
  const packageRoot = await realpath(path.resolve(HERE, '../..'));
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const sourceCheckout = (await lstat(path.join(packageRoot, 'src', 'cli.ts')).catch(() => null))?.isFile() === true;
  let require = createRequire(path.join(project, 'package.json'));
  try { require.resolve('@playwright/test/cli'); }
  catch {
    if (process.env.TESTLANE_VERIFICATION_TEST_PROJECT || !sourceCheckout || project !== packageRoot) throw new Error('DEMO_PLAYWRIGHT_UNAVAILABLE');
    // Source-only convenience: use the existing locked example dependencies. Never
    // install anything or use checkout-only dependencies for an installed consumer.
    project = await realpath(path.join(packageRoot, 'examples', 'playwright'));
    await lstat(path.join(project, 'package.json'));
    require = createRequire(path.join(project, 'package.json')); require.resolve('@playwright/test/cli');
  }
  if (!sourceCheckout && !process.env.TESTLANE_VERIFICATION_TEST_PROJECT && await realpath(path.dirname(require.resolve('@testlane/cli/package.json'))) !== packageRoot) {
    throw new Error('DEMO_INSTALLATION_MISMATCH');
  }
  const cli = path.join(packageRoot, 'dist', 'cli.js'); await lstat(cli);
  const runId = randomUUID(), namespace = 'verification-demo-' + runId;
  const output = path.join(project, 'output', 'testlane-demo', 'run-' + runId);
  await mkdir(path.dirname(output), { recursive: true });
  if (await realpath(path.dirname(output)) !== path.dirname(output)) throw new Error('DEMO_OUTPUT_PATH_INVALID');
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  const appProject = path.join(output, 'app'), home = path.join(output, '.broker'), profilesFile = path.join(output, 'testlane.profiles.json');
  await mkdir(appProject, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(appProject, 'package.json'), '{"name":"testlane-disposable-demo","private":true,"type":"module"}\n', { flag: 'wx', mode: 0o600 });
  const temporary = await createDemoTemporaryDirectory();
  const accounts = Object.fromEntries(['editor', 'reviewer'].map(name => [name, { email: name + '-' + runId + '@example.test', password: randomBytes(32).toString('base64url') }]));
  const profiles = ['editor', 'reviewer'].map(name => namespace + ':testing:' + name);
  const env = { ...process.env, TESTLANE_HOME: home, AGENT_AUTH_HOME: home, TESTLANE_PROFILES: profilesFile,
    TESTLANE_STORE: policy.store, TESTLANE_REQUESTER: 'verification-demo', AGENT_AUTH_PROFILES: '', AGENT_AUTH_STORE: '', AGENT_AUTH_REQUESTER: '', DEBUG: '', PWDEBUG: '', NODE_DEBUG: '',
    TMP: temporary.root, TEMP: temporary.root, TMPDIR: temporary.root, PWTEST_CACHE_DIR: path.join(output, '.playwright-cache') };
  delete env.NODE_OPTIONS; delete env.FORCE_COLOR;
  let app, failure, cleanupFailed = false; const attempted = new Set(), outputs = [], runs = [];
  const execute = async (args, options = {}) => {
    const result = await runDemoChild({ entry: cli, args, cwd: appProject, env, signal, ...options });
    outputs.push(result.stdout, result.stderr); return result;
  };
  let receipt;
  try {
    app = await startDemoApp({ accounts });
    await writeFile(profilesFile, JSON.stringify(registry({ namespace, origin: app.origin, accounts }), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (const name of ['editor', 'reviewer']) {
      const profile = namespace + ':testing:' + name; attempted.add(profile);
      const seeded = await execute(['store', 'set', profile], { input: accounts[name].password });
      if (seeded.code !== 0) throw new Error('DEMO_NATIVE_STORE_SETUP_FAILED');
    }
    const { planFile, specFile } = await prepareDemoSuite({ projectRoot: appProject, packageRoot, origin: app.origin,
      editorProfile: profiles[0], reviewerProfile: profiles[1], editor: accounts.editor, reviewer: accounts.reviewer });
    const planSHA256 = hash(await readFile(planFile)), specSHA256 = hash(await readFile(specFile));
    for (const [label, defect] of [['passing', false], ['injected-defect', true], ['corrected', false]]) {
      app.setDefect(defect);
      const reportRoot = path.join(output, label);
      const result = await execute(['verify', 'run', '--plan', planFile, '--output-dir', reportRoot, '--json'], { timeoutMs: 210_000 });
      let report; try { report = JSON.parse(result.stdout); } catch { throw new Error('DEMO_REPORT_INVALID'); }
      const expectedFailures = defect ? ['editor-browser-total', 'reviewer-approves'] : [];
      const actualFailures = report.cases?.filter(item => item.status === 'failed').map(item => item.id).sort();
      if (report.verdict !== (defect ? 'failed' : 'passed') || result.code !== (defect ? 1 : 0) || report.reasonCodes?.length ||
          report.cases?.length !== 5 || JSON.stringify(actualFailures) !== JSON.stringify([...expectedFailures].sort()) ||
          report.cases.some(item => item.attempts !== 1 || item.assertionsObserved < 1 ||
            item.cleanup.status !== (item.cleanup.required ? 'completed' : 'not-required')) || app.records().length !== 0 ||
          hash(await readFile(planFile)) !== planSHA256 || hash(await readFile(specFile)) !== specSHA256 ||
          !/^run-[a-f0-9-]{36}\/report\.json$/.test(report.reportPath ?? '')) throw new Error('DEMO_VERIFICATION_UNEXPECTED');
      const reportFile = path.join(reportRoot, report.reportPath);
      const rendered = await execute(['verify', 'report', '--report', reportFile, '--plan', planFile, '--json']);
      if (rendered.code !== 0) throw new Error('DEMO_SUMMARY_FAILED');
      runs.push({ label, verdict: report.verdict, cases: report.cases.map(({ id, status, cleanup }) => ({ id, status, cleanup: cleanup.status })),
        recordCountAfterRun: app.records().length, report: path.relative(output, reportFile).split(path.sep).join('/') });
    }
    receipt = { schemaVersion: 1, demonstration: 'Built-in local request approval example; not independent coding-agent acceptance',
      packageVersion: metadata.version, planSHA256, specSHA256, runs, screenshots: 'off', cleanup: 'pending' };
  } catch (error) { failure = error; if (error.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') cleanupFailed = true; }
  finally {
    // An attempted seed can partially succeed before the CLI reports failure. Delete
    // every attempted unique entry, not just entries whose setup returned success.
    for (const profile of attempted) {
      try {
        const removed = await runDemoChild({ entry: cli, args: ['store', 'delete', profile], cwd: appProject, env });
        outputs.push(removed.stdout, removed.stderr);
        if (removed.code !== 0) cleanupFailed = true;
        const absent = await runDemoChild({ entry: cli, args: ['check', profile], cwd: appProject, env });
        outputs.push(absent.stdout, absent.stderr);
        if (absent.code !== 4) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    const credentials = [...Object.values(accounts).map(account => account.password), ...(app?.issuedSessionTokens() ?? [])];
    const variants = credentials.flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]);
    if (outputs.some(output => variants.some(value => output.includes(value)))) failure = new Error('DEMO_SECRET_OUTPUT_BLOCKED');
    try { await scanText(output, variants); await scanText(temporary.root, variants); }
    catch { failure = new Error('DEMO_SECRET_OUTPUT_BLOCKED'); }
    // A child whose exit was not confirmed can still hold a live session or use
    // its broker home. Preserve recovery metadata even if deletion checks passed.
    const terminationUnconfirmed = failure?.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED';
    if (terminationUnconfirmed || app?.records().length) cleanupFailed = true;
    try { await app?.close(); } catch { cleanupFailed = true; }
    if (!terminationUnconfirmed) {
      try { await removeDemoTemporaryDirectory(temporary); } catch { cleanupFailed = true; }
    }
    if (!cleanupFailed) {
      try {
        if (!within(output, home) || (await lstat(home)).isSymbolicLink() || await realpath(home) !== home) throw new Error('DEMO_OUTPUT_PATH_INVALID');
        await rm(home, { recursive: true });
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      await writeFile(path.join(output, 'recovery.json'), JSON.stringify({ status: 'manual-inspection-required',
        profiles, home: '.broker', registry: 'testlane.profiles.json', temporaryDirectory: temporary.root, journalDirectory: 'app/output/testlane-demo-recovery' }) + '\n', { flag: 'wx', mode: 0o600 });
      const error = new Error('DEMO_CLEANUP_INCOMPLETE'); error.recoveryDirectory = output; throw error;
    }
  }
  if (failure) { const error = new Error(/^DEMO_[A-Z_]+$/.test(failure.message) ? failure.message : 'DEMO_FAILED'); error.recoveryDirectory = output; throw error; }
  receipt.cleanup = 'completed';
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...receipt, outputDirectory: output };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--json', '--allow-user-keychain'].includes(arg)) || new Set(args).size !== args.length) throw new Error('DEMO_ARGUMENTS_INVALID');
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runDemo({ allowUserKeychain: args.includes('--allow-user-keychain'), signal: controller.signal });
    process.stdout.write(args.includes('--json') ? JSON.stringify(result, null, 2) + '\n' :
      'Demo: 5 passed → 2 expected failures → 5 passed, with unchanged tests.\nRecords after every run: 0. Native entries removed.\nPrivate reports: ' + result.outputDirectory + '\n');
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
function isEntryPoint() {
  try {
    const entry = realpathSync(process.argv[1]), self = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
  } catch { return false; }
}
if (isEntryPoint()) main().catch(error => {
  process.stderr.write('Testlane verification demo: ' + (/^DEMO_[A-Z_]+$/.test(error.message) ? error.message : 'DEMO_FAILED') + '\n');
  if (error.recoveryDirectory) process.stderr.write('Inspect the owned demo directory before retrying: ' + error.recoveryDirectory + '\n');
  process.exitCode = 1;
});
