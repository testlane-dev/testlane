#!/usr/bin/env node
/** Private, static local view of an existing report. Never executes tests or app code. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_VERSION, validatePlan } from './contracts.mjs';
import { LIMITS } from './runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CASE_REASONS = {
  passed: ['CASE_PASSED'],
  failed: ['CASE_FAILED', 'CASE_TIMED_OUT', 'CLEANUP_FAILED'],
  blocked: ['CASE_NOT_RUN', 'RETRY_OR_DUPLICATE_CASE', 'CASE_SKIPPED', 'EXPECTED_FAILURE_NOT_ACCEPTED',
    'AUTHORING_HELPER_REQUIRED', 'CLEANUP_NOT_CONFIRMED', 'UNAPPROVED_ATTACHMENT', 'NO_ASSERTIONS_OBSERVED'],
  cancelled: ['FORCED_STOP', 'RUN_CANCELLED'],
};
const RUN_REASONS = ['GLOBAL_TEST_ERROR', 'CASE_MAPPING_INVALID', 'RUN_CONFIGURATION_INVALID', 'REPORTER_INVALID',
  'NO_TESTS_DISCOVERED', 'FORCED_STOP', 'RUN_CANCELLED', 'TEST_RUN_FAILED', 'PLAN_NOT_REVIEWED',
  'PLAN_CHANGED_DURING_RUN', 'SPEC_CHANGED_DURING_RUN', 'UNAPPROVED_ARTIFACT', 'ARTIFACT_MISSING',
  'PLAN_INVALID', 'PROJECT_INVALID', 'SPEC_INVALID', 'PLAYWRIGHT_UNAVAILABLE', 'RUNNER_BLOCKED'];
const CLEANUP = ['completed', 'failed', 'not-required', 'unknown'];
function digest(value) { return typeof value === 'string' && SHA.test(value); }
function fail(code) { throw new Error(code); }
function keys(value, allowed) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}
function integer(value, max = 1000000) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function escape(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
async function input(file, max) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail('INPUT_INVALID');
  const bytes = await readFile(file);
  if (bytes.length > max) fail('INPUT_INVALID');
  return bytes;
}
function validateReport(report, plan) {
  if (!keys(report, ['schemaVersion', 'runId', 'harness', 'helper', 'plan', 'specs', 'reportPath', 'verdict',
    'reasonCodes', 'cases', 'artifacts', 'limits', 'execution']) || report.schemaVersion !== 1 ||
    typeof report.runId !== 'string' || !UUID.test(report.runId) ||
    !keys(report.harness, ['version', 'sha256']) || report.harness.version !== HARNESS_VERSION ||
    (report.harness.sha256 !== undefined && !digest(report.harness.sha256)) ||
    !keys(report.plan, ['sha256']) || !digest(report.plan.sha256) ||
    !Object.hasOwn(CASE_REASONS, report.verdict) || report.reportPath !== 'run-' + report.runId + '/report.json' ||
    !Array.isArray(report.reasonCodes) || report.reasonCodes.some(reason => !RUN_REASONS.includes(reason)) ||
    new Set(report.reasonCodes).size !== report.reasonCodes.length ||
    !Array.isArray(report.cases) || report.cases.length !== plan.cases.length ||
    !Array.isArray(report.specs) || !Array.isArray(report.artifacts) || report.artifacts.length > plan.cases.length * 5 ||
    !Array.isArray(report.limits) || JSON.stringify(report.limits) !== JSON.stringify(LIMITS)) fail('REPORT_INVALID');
  if (report.helper !== undefined && (!keys(report.helper, ['version', 'sha256']) || report.helper.version !== '1' || !digest(report.helper.sha256))) fail('REPORT_INVALID');
  if (report.execution !== undefined && (!keys(report.execution, ['exitCode', 'cancelled', 'forced']) ||
    !(report.execution.exitCode === null || integer(report.execution.exitCode, 255)) ||
    typeof report.execution.cancelled !== 'boolean' || typeof report.execution.forced !== 'boolean' ||
    (report.execution.forced && !report.execution.cancelled))) fail('REPORT_INVALID');
  const specs = new Map();
  const plannedSpecs = new Set(plan.cases.map(item => hash(item.spec)));
  for (const spec of report.specs) {
    if (!keys(spec, ['id', 'sha256']) || !digest(spec.id) || !digest(spec.sha256) || specs.has(spec.id) || !plannedSpecs.has(spec.id)) fail('REPORT_INVALID');
    specs.set(spec.id, spec);
  }
  const ids = new Set();
  for (const item of report.cases) {
    const planned = plan.cases.find(value => value.id === item?.id);
    if (!planned || ids.has(item.id) || !keys(item, ['id', 'status', 'reason', 'cleanup', 'attempts', 'assertionsObserved', 'specId']) ||
      !Object.hasOwn(CASE_REASONS, item.status) || !CASE_REASONS[item.status].includes(item.reason) ||
      !keys(item.cleanup, ['required', 'status']) || item.cleanup.required !== planned.cleanup.required || !CLEANUP.includes(item.cleanup.status) ||
      !integer(item.attempts, 300) || (item.assertionsObserved !== undefined && !integer(item.assertionsObserved)) ||
      (item.assertionsObserved === undefined && item.attempts !== 0) ||
      (item.specId !== undefined && (item.specId !== hash(planned.spec) || !specs.has(item.specId)))) fail('REPORT_INVALID');
    ids.add(item.id);
    if ((item.status === 'passed' && (item.attempts !== 1 || item.assertionsObserved < 1 || !item.specId ||
      (item.cleanup.status !== 'completed' && (planned.cleanup.required || item.cleanup.status !== 'not-required')))) ||
      (item.status === 'failed' && item.attempts !== 1) ||
      (item.reason === 'CLEANUP_FAILED' && item.cleanup.status !== 'failed') ||
      (item.reason === 'CASE_NOT_RUN' && item.attempts !== 0) ||
      (item.reason === 'NO_ASSERTIONS_OBSERVED' && item.assertionsObserved !== 0) ||
      (item.reason === 'FORCED_STOP' && item.cleanup.status !== 'unknown')) fail('REPORT_INVALID');
  }
  if (report.verdict === 'passed' && (plan.status !== 'reviewed' || report.reasonCodes.length ||
    report.cases.some(item => item.status !== 'passed') || !report.helper || !report.harness.sha256 ||
    specs.size !== plannedSpecs.size || !report.execution || report.execution.exitCode !== 0 ||
    report.execution.cancelled || report.execution.forced)) fail('REPORT_INVALID');
  if (report.verdict === 'failed' && !report.cases.some(item => item.status === 'failed')) fail('REPORT_INVALID');
  return report;
}
async function validateArtifacts(report, plan, directory) {
  const seen = new Set();
  const counts = new Map();
  for (const artifact of report.artifacts) {
    if (!keys(artifact, ['kind', 'path', 'caseId', 'size', 'sha256', 'private', 'review']) ||
      artifact.kind !== 'screenshot' || artifact.private !== true || artifact.review !== 'unreviewed' ||
      plan.evidence.screenshots !== 'manual' || !plan.cases.some(item => item.id === artifact.caseId) ||
      typeof artifact.path !== 'string' || !/^artifacts\/screenshot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/.test(artifact.path) ||
      !integer(artifact.size, 5 * 1024 * 1024) || artifact.size < 8 || !digest(artifact.sha256) || seen.has(artifact.path)) fail('ARTIFACT_INVALID');
    seen.add(artifact.path);
    counts.set(artifact.caseId, (counts.get(artifact.caseId) ?? 0) + 1);
    if (counts.get(artifact.caseId) > 5) fail('ARTIFACT_INVALID');
    const parent = path.join(directory, 'artifacts');
    const file = path.join(directory, ...artifact.path.split('/'));
    const parentInfo = await lstat(parent), info = await lstat(file);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size !== artifact.size) fail('ARTIFACT_INVALID');
    const resolved = await realpath(file);
    const relative = path.relative(directory, resolved).split(path.sep).join('/');
    if (relative !== artifact.path) fail('ARTIFACT_INVALID');
    const bytes = await readFile(file);
    if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('ARTIFACT_INVALID');
  }
}
function html(report, plan) {
  const details = report.cases.map(item => {
    const planned = plan.cases.find(value => value.id === item.id);
    const links = report.artifacts.filter(artifact => artifact.caseId === item.id).map(artifact =>
      '<li><a download href="' + escape(artifact.path) + '">' + escape(path.posix.basename(artifact.path)) + '</a> · ' + artifact.size + ' bytes · private, unreviewed<br><code>' + artifact.sha256 + '</code></li>').join('');
    return '<section class="case"><div class="case-head"><h2>' + escape(planned.title) + '</h2><strong class="status ' + item.status + '">' + item.status + '</strong></div>' +
      '<p class="meta">Case <code>' + item.id + '</code> · ' + (item.assertionsObserved ?? 0) + ' observed assertions · ' + item.attempts + ' attempt(s)</p>' +
      '<p>Reason: <code>' + item.reason + '</code></p><h3>Expected behavior</h3><ul>' + planned.expected.map(value => '<li>' + escape(value) + '</li>').join('') +
      '</ul><h3>Cleanup: ' + item.cleanup.status + (planned.cleanup.required ? ' (required)' : ' (optional)') + '</h3><p>' + escape(planned.cleanup.description) + '</p>' +
      (links ? '<h3>Evidence</h3><p>Private app data. Contents are unreviewed; no binary redaction is claimed.</p><ul>' + links + '</ul>' : '<p class="meta">No screenshots retained for this case.</p>') + '</section>';
  }).join('');
  const specs = report.specs.map(spec => '<li>Spec ID <code>' + spec.id + '</code><br>SHA256 <code>' + spec.sha256 + '</code></li>').join('');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>Testlane verification summary</title><style>' +
    ':root{color-scheme:light;font-family:system-ui,sans-serif;color:#12233e;background:#edf2f8}*{box-sizing:border-box}body{margin:0}main{max-width:960px;margin:0 auto;padding:36px 24px}header{border-top:5px solid #2671db;padding:24px;background:#10223c;color:white;border-radius:8px}.eyebrow{font-size:.8rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#bcd7ff}h1{font-size:2rem;line-height:1.2;margin:8px 0 16px}h2{font-size:1.25rem;margin:0}h3{font-size:1rem;margin-bottom:8px}p,li{line-height:1.6}code{font-size:.85rem;overflow-wrap:anywhere}.case,.panel{background:white;border:1px solid #d4dfed;border-radius:8px;padding:22px;margin:20px 0}.case-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.status{display:inline-block;padding:4px 12px;border-radius:4px;text-transform:uppercase;font-size:.8rem;white-space:nowrap;background:#e4ebf5;color:#183453}.passed{background:#d8f1e7;color:#14553d}.failed{background:#fce1e0;color:#8b2523}.blocked,.cancelled{background:#fff0ce;color:#6d4c10}.meta{color:#4e627a;font-size:.9rem}a{color:#174f9d}li+li{margin-top:8px}header .meta{color:#cfddf0}@media(max-width:560px){main{padding:18px 12px}.case-head{display:block}.status{margin-top:12px}}@media print{:root{background:white}main{max-width:none;padding:0}header{color:#12233e;background:white;border:1px solid #d4dfed}header .meta,.eyebrow{color:#4e627a}.case,.panel{break-inside:avoid}a{color:inherit}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}' +
    '</style></head><body><main><header><div class="eyebrow">Testlane · private local report</div><h1>' + escape(plan.title) + '</h1><strong class="status ' + report.verdict + '">' + report.verdict + '</strong>' +
    '<p class="meta">Run <code>' + report.runId + '</code></p></header><section class="panel"><h2>What this report means</h2>' +
    '<p>This summary contains private application descriptions. Review it before sharing. Hashes bind these local inputs; this report is not signed and does not prove that arbitrary report data was left unedited.</p>' +
    '<p>Run reason codes: ' + (report.reasonCodes.length ? report.reasonCodes.map(value => '<code>' + value + '</code>').join(', ') : 'none') + '</p></section>' + details +
    '<section class="panel"><h2>Input hashes</h2><p>Plan SHA256 <code>' + report.plan.sha256 + '</code></p><p>Harness version ' + escape(report.harness.version) + ' · SHA256 <code>' + (report.harness.sha256 ?? 'not recorded') + '</code></p>' +
    '<p>Authoring helper SHA256 <code>' + (report.helper?.sha256 ?? 'not recorded') + '</code></p><ul>' + specs + '</ul></section>' +
    '<section class="panel"><h2>Limits</h2><ul>' + report.limits.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul></section></main></body></html>\n';
}

export async function renderVerificationReport({ reportFile, planFile }) {
  try {
    if (typeof reportFile !== 'string' || typeof planFile !== 'string') fail('INPUT_INVALID');
    const [reportBytes, planBytes] = await Promise.all([input(reportFile, 2 * 1024 * 1024), input(planFile, 256 * 1024)]);
    const report = JSON.parse(reportBytes.toString('utf8'));
    if (report?.plan?.sha256 !== hash(planBytes)) fail('PLAN_HASH_MISMATCH');
    const plan = validatePlan(JSON.parse(planBytes.toString('utf8')));
    validateReport(report, plan);
    const directory = await realpath(path.dirname(path.resolve(reportFile)));
    await validateArtifacts(report, plan, directory);
    await writeFile(path.join(directory, 'summary.html'), html(report, plan), { flag: 'wx', mode: 0o600 });
    return { status: 'rendered', filename: 'summary.html' };
  } catch (error) {
    const allowed = ['INPUT_INVALID', 'PLAN_INVALID', 'PLAN_HASH_MISMATCH', 'REPORT_INVALID', 'ARTIFACT_INVALID'];
    throw new Error(error?.code === 'EEXIST' ? 'SUMMARY_EXISTS' : allowed.includes(error?.message) ? error.message : 'REPORT_RENDER_BLOCKED');
  }
}

function isEntryPoint() {
  try {
    const entry = realpathSync(process.argv[1]), self = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
  } catch { return false; }
}
if (isEntryPoint()) {
  try {
    const args = process.argv.slice(2);
    let reportFile, planFile, json = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--json' && !json) json = true;
      else if (args[index] === '--report' && args[index + 1] && !reportFile) reportFile = args[++index];
      else if (args[index] === '--plan' && args[index + 1] && !planFile) planFile = args[++index];
      else fail('ARGUMENTS_INVALID');
    }
    if (!reportFile || !planFile) fail('ARGUMENTS_INVALID');
    const result = await renderVerificationReport({ reportFile, planFile });
    process.stdout.write(json ? JSON.stringify(result) + '\n' : 'Testlane verification: summary.html rendered (private).\n');
  } catch (error) {
    const codes = ['ARGUMENTS_INVALID', 'INPUT_INVALID', 'PLAN_INVALID', 'PLAN_HASH_MISMATCH', 'REPORT_INVALID', 'ARTIFACT_INVALID', 'SUMMARY_EXISTS', 'REPORT_RENDER_BLOCKED'];
    process.stderr.write('Testlane verification report: ' + (codes.includes(error.message) ? error.message : 'REPORT_RENDER_BLOCKED') + '\n');
    process.exitCode = 2;
  }
}
