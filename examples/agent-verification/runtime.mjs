import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, realpath, lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_VERSION, validatePlan } from './contracts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
const reasons = new Set(['GLOBAL_TEST_ERROR', 'CASE_MAPPING_INVALID', 'RUN_CONFIGURATION_INVALID', 'REPORTER_INVALID']);
export const LIMITS = [
  'The plan and test code are trusted app code, not a security sandbox.',
  'The runner cannot prove assertion quality, test completeness, the declared environment, or arbitrary app cleanup semantics.',
  'At least one Playwright expect step is required. Identity and cleanup assertions can contribute; the count does not establish business-oracle quality. Node assert-only specs are unsupported in this version.',
  'Cleanup completed means the authored cleanup callback finished; that callback must assert its own app state was removed.',
  'Forced termination can leave browser processes or app state behind; cleanup is then unknown and requires inspection.',
  'Manual screenshots are private app data and remain unreviewed. No raw output, error messages, response bodies or test titles are copied into this report.',
  'Plan descriptions and test source can contain private app data; hashes bind evidence but do not make that source public-safe.',
];
export function reconcile(plan, journal, execution) {
  const errors = [];
  const rawRows = Array.isArray(journal?.results) ? journal.results : [];
  const rows = rawRows.filter(row => row && typeof row === 'object');
  if (!journal || journal.schemaVersion !== 1 || !Number.isInteger(journal.discovered) ||
      !Array.isArray(journal.errors) || journal.errors.some(e => !reasons.has(e)) || rows.length > 300) errors.push('REPORTER_INVALID');
  else errors.push(...journal.errors);
  if (rows.length !== rawRows.length || rows.some(row =>
      !['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown'].includes(row.status) ||
      !['mapped', 'expectedPassed', 'helper', 'started', 'unexpectedAttachments'].every(key => typeof row[key] === 'boolean') ||
      !Number.isInteger(row.retry) || !['completed', 'failed', 'not-required', 'unknown'].includes(row.cleanup) ||
      !Number.isInteger(row.assertionsObserved) || row.assertionsObserved < 0 ||
      !Array.isArray(row.screenshots))) errors.push('REPORTER_INVALID');
  if (journal?.discovered === 0) errors.push('NO_TESTS_DISCOVERED');
  if (rows.some(r => !r.mapped || !plan.cases.some(c => c.id === r.id))) errors.push('CASE_MAPPING_INVALID');
  const cases = plan.cases.map(item => {
    const results = rows.filter(r => r.id === item.id);
    let status = 'blocked', reason = 'CASE_NOT_RUN', cleanup = 'unknown';
    if (results.length > 1 || results.some(r => r.retry !== 0)) reason = 'RETRY_OR_DUPLICATE_CASE';
    else if (results.length === 1) {
      const row = results[0];
      cleanup = ['completed', 'failed', 'not-required'].includes(row.cleanup) ? row.cleanup : 'unknown';
      if (execution.forced) { status = 'cancelled'; reason = 'FORCED_STOP'; cleanup = 'unknown'; }
      else if (row.status === 'interrupted') { status = 'cancelled'; reason = 'RUN_CANCELLED'; }
      else if (row.status === 'skipped') reason = 'CASE_SKIPPED';
      else if (!row.expectedPassed) reason = 'EXPECTED_FAILURE_NOT_ACCEPTED';
      else if (!row.helper || !row.started) reason = 'AUTHORING_HELPER_REQUIRED';
      else if (cleanup === 'failed') { status = 'failed'; reason = 'CLEANUP_FAILED'; }
      else if (row.status !== 'passed') { status = 'failed'; reason = row.status === 'timedOut' ? 'CASE_TIMED_OUT' : 'CASE_FAILED'; }
      else if (cleanup !== 'completed' && (item.cleanup.required || cleanup !== 'not-required')) reason = 'CLEANUP_NOT_CONFIRMED';
      else if (row.unexpectedAttachments) reason = 'UNAPPROVED_ATTACHMENT';
      else if (row.assertionsObserved < 1) reason = 'NO_ASSERTIONS_OBSERVED';
      else if (row.status === 'passed') { status = 'passed'; reason = 'CASE_PASSED'; }
    } else if (execution.cancelled) { status = 'cancelled'; reason = execution.forced ? 'FORCED_STOP' : 'RUN_CANCELLED'; }
    return { id: item.id, status, reason, cleanup: { required: item.cleanup.required, status: cleanup }, attempts: results.length,
      assertionsObserved: results.reduce((sum, row) => sum + (Number.isInteger(row.assertionsObserved) && row.assertionsObserved > 0 ? row.assertionsObserved : 0), 0) };
  });
  if (execution.cancelled) errors.push(execution.forced ? 'FORCED_STOP' : 'RUN_CANCELLED');
  if (journal?.outcome !== 'passed' && cases.every(c => c.status === 'passed')) errors.push('TEST_RUN_FAILED');
  if (execution.exitCode !== 0 && cases.every(c => c.status === 'passed')) errors.push('TEST_RUN_FAILED');
  let verdict = 'passed';
  if (execution.cancelled || cases.some(c => c.status === 'cancelled')) verdict = 'cancelled';
  else if (cases.some(c => c.status === 'failed')) verdict = 'failed';
  else if (errors.length || cases.length === 0 || cases.some(c => c.status !== 'passed')) verdict = 'blocked';
  return { verdict, reasonCodes: [...new Set(errors)], cases };
}
function expression(file) {
  return '^' + file.split(/[\\/]/).map(part => part.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')).join('[\\\\/]') + '$';
}
async function runChild(cli, config, env, signal) {
  return new Promise(resolve => {
    let child, timer, forceTimer, settled = false, cancelled = signal?.aborted === true, forced = false;
    const finish = exitCode => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (child?.connected) child.disconnect();
      resolve({ exitCode, cancelled, forced });
    };
    const cancel = () => {
      cancelled = true;
      if (child?.connected) child.send('testlane:verification:cancel:v1', () => {});
      if (!forceTimer) forceTimer = setTimeout(() => { forced = true; child?.kill('SIGKILL'); }, 5000);
    };
    try {
      child = spawn(process.execPath, [path.join(HERE, 'bootstrap.mjs'), cli, config], {
        env, cwd: path.dirname(config), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
      child.once('error', () => finish(null)); child.once('exit', code => finish(code));
      timer = setTimeout(cancel, 180000);
      signal?.addEventListener('abort', cancel, { once: true });
      if (cancelled) cancel();
    } catch { finish(null); }
  });
}
export async function runVerification({ planFile, outputDir, signal }) {
  const id = randomUUID();
  const root = path.resolve(outputDir ?? path.join(path.dirname(path.resolve(planFile)), 'output', 'agent-verification'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await realpath(root);
  const directory = path.join(parent, 'run-' + id);
  await mkdir(directory, { mode: 0o700 });
  const controlDir = path.join(directory, '.control');
  const artifactDir = path.join(directory, 'artifacts');
  await mkdir(controlDir, { mode: 0o700 }); await mkdir(artifactDir, { mode: 0o700 });
  const report = { schemaVersion: 1, runId: id, harness: { version: HARNESS_VERSION }, plan: { sha256: null }, specs: [],
    reportPath: 'run-' + id + '/report.json', verdict: 'blocked', reasonCodes: [], cases: [], artifacts: [], limits: LIMITS };
  let plan;
  try {
    const bytes = await readFile(planFile);
    if (bytes.length > 256 * 1024) throw new Error('PLAN_INVALID');
    report.plan.sha256 = sha256(bytes);
    plan = validatePlan(JSON.parse(bytes.toString('utf8')));
    report.cases = plan.cases.map(c => ({ id: c.id, status: 'blocked', reason: 'CASE_NOT_RUN', cleanup: { required: c.cleanup.required, status: 'unknown' }, attempts: 0 }));
    if (plan.status !== 'reviewed') report.reasonCodes = ['PLAN_NOT_REVIEWED'];
    else if (signal?.aborted) { report.verdict = 'cancelled'; report.reasonCodes = ['RUN_CANCELLED']; report.cases.forEach(c => { c.status = 'cancelled'; c.reason = 'RUN_CANCELLED'; }); }
    else {
      const project = await realpath(path.resolve(path.dirname(path.resolve(planFile)), plan.projectDir));
      const packageFile = path.join(project, 'package.json');
      if (!(await lstat(packageFile)).isFile()) throw new Error('PROJECT_INVALID');
      const specFiles = new Map();
      for (const item of plan.cases) {
        if (path.isAbsolute(item.spec)) throw new Error('SPEC_INVALID');
        const file = path.resolve(project, item.spec);
        if (!inside(project, file) || !(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error('SPEC_INVALID');
        const resolved = await realpath(file);
        if (!inside(project, resolved)) throw new Error('SPEC_INVALID');
        specFiles.set(item.spec, { file: resolved, hash: sha256(await readFile(resolved)) });
      }
      report.specs = [...specFiles].map(([spec, value]) => ({ id: sha256(spec), sha256: value.hash }));
      const helper = await readFile(path.join(HERE, 'authoring.mjs'));
      report.helper = { version: '1', sha256: sha256(helper) };
      const harnessFiles = await Promise.all(['runtime.mjs', 'contracts.mjs', 'reporter.mjs', 'bootstrap.mjs', 'run.mjs'].map(name => readFile(path.join(HERE, name))));
      report.harness.sha256 = sha256(Buffer.concat(harnessFiles));
      let cli;
      try { cli = createRequire(packageFile).resolve('@playwright/test/cli'); } catch { throw new Error('PLAYWRIGHT_UNAVAILABLE'); }
      const controlFile = path.join(controlDir, 'control.json');
      const journalFile = path.join(controlDir, 'journal.json');
      const configFile = path.join(controlDir, 'playwright.config.mjs');
      const control = { schemaVersion: 1, origin: plan.target.baseUrl, screenshots: plan.evidence.screenshots, artifactDir,
        helperVersion: report.helper.version, helperHash: report.helper.sha256,
        cases: plan.cases.map(c => ({ id: c.id, cleanupRequired: c.cleanup.required, spec: specFiles.get(c.spec).file })) };
      await writeFile(controlFile, JSON.stringify(control), { flag: 'wx', mode: 0o600 });
      const config = 'export default { testDir: ' + JSON.stringify(project) + ', testMatch: [' +
        [...specFiles.values()].map(v => 'new RegExp(' + JSON.stringify(expression(v.file)) + ', ' + JSON.stringify(process.platform === 'win32' ? 'i' : '') + ')').join(',') +
        '], workers: 1, retries: 0, repeatEach: 1, timeout: 30000, globalTimeout: 175000, forbidOnly: true, fullyParallel: false, ' +
        'outputDir: ' + JSON.stringify(path.join(directory, '.private-test-results')) + ', preserveOutput: "never", ' +
        'reporter: [[' + JSON.stringify(path.join(HERE, 'reporter.mjs')) + ', ' + JSON.stringify({ controlFile, journalFile }) + ']], ' +
        'use: { baseURL: ' + JSON.stringify(plan.target.baseUrl) + ', trace: "off", video: "off", screenshot: "off", acceptDownloads: false, serviceWorkers: "block" } };\n';
      await writeFile(configFile, config, { flag: 'wx', mode: 0o600 });
      const env = { ...process.env, TESTLANE_VERIFICATION_CONTROL: controlFile, DEBUG: '', PWDEBUG: '', NODE_DEBUG: '', FORCE_COLOR: '0', PLAYWRIGHT_NO_COPY_PROMPT: '1' };
      const execution = await runChild(cli, configFile, env, signal);
      let journal;
      try { const data = await readFile(journalFile); if (data.length <= 1024 * 1024) journal = JSON.parse(data.toString('utf8')); } catch {}
      Object.assign(report, reconcile(plan, journal, execution));
      report.cases.forEach(item => { const spec = plan.cases.find(c => c.id === item.id).spec; item.specId = sha256(spec); });
      report.execution = { exitCode: execution.exitCode, cancelled: execution.cancelled, forced: execution.forced };
      if (sha256(await readFile(planFile)) !== report.plan.sha256) { report.verdict = 'blocked'; report.reasonCodes.push('PLAN_CHANGED_DURING_RUN'); }
      for (const value of specFiles.values()) if (sha256(await readFile(value.file)) !== value.hash) { report.verdict = 'blocked'; report.reasonCodes.push('SPEC_CHANGED_DURING_RUN'); }
      const declared = new Map();
      for (const row of journal?.results ?? []) for (const value of row.screenshots ?? []) {
        const match = /^([a-z0-9][a-z0-9-]{0,63}):(screenshot-[a-f0-9-]{36}\.png)$/.exec(value);
        if (match && plan.cases.some(c => c.id === match[1])) declared.set(match[2], match[1]);
      }
      for (const file of await readdir(artifactDir)) {
        const location = path.join(artifactDir, file), info = await lstat(location);
        if (plan.evidence.screenshots !== 'manual' || !declared.has(file) || !info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) {
          report.verdict = 'blocked'; report.reasonCodes.push('UNAPPROVED_ARTIFACT'); continue;
        }
        report.artifacts.push({ kind: 'screenshot', path: 'artifacts/' + file, caseId: declared.get(file), size: info.size,
          sha256: sha256(await readFile(location)), private: true, review: 'unreviewed' });
      }
      if (declared.size !== report.artifacts.length) { report.verdict = 'blocked'; report.reasonCodes.push('ARTIFACT_MISSING'); }
      for (const file of [controlFile, journalFile, configFile]) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  } catch (error) {
    report.reasonCodes.push(['PLAN_INVALID', 'PROJECT_INVALID', 'SPEC_INVALID', 'PLAYWRIGHT_UNAVAILABLE'].includes(error.message) ? error.message : 'RUNNER_BLOCKED');
    report.verdict = signal?.aborted ? 'cancelled' : 'blocked';
  }
  report.reasonCodes = [...new Set(report.reasonCodes)];
  const filename = path.join(directory, 'report.json');
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { report, reportPath: filename, directory };
}
