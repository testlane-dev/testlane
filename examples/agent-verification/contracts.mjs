export const HARNESS_VERSION = '1';
export const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Diagnostic text is product copy, never an exception message or observed app value.
// Reports may omit these additive fields (schema v1); supplied fields must match
// this catalogue exactly so even a malformed report cannot render arbitrary text.
const diagnosticText = {
  ASSERTION_FAILED: [
    'A Playwright expect step failed, even if test code caught its exception.',
    'Compare the expected behavior with the bound spec. Use the first failed-expect coordinates when present; review imported assertion helpers when no coordinates are available.',
  ],
  CASE_BODY_FAILED: [
    'The runCase body threw before completing; no failed Playwright expect step was observed.',
    'Inspect actions and app-owned helper calls inside runCase.run, including navigation, requests and explicit throws. Review cleanup before repeating a mutation.',
  ],
  CASE_SETUP_OR_CONTRACT_FAILED: [
    'The test failed before a valid runCase body result was recorded.',
    'Check suite hooks, fixture initialization, role/profile configuration and the copied authoring helper. The report cannot distinguish a browser-launch failure from another setup or contract error.',
  ],
  CASE_AFTER_BODY_FAILED: [
    'The case body and declared cleanup completed, but Playwright reported another test failure.',
    'Inspect fixture teardown and test code after runCase. Completed application cleanup does not establish that browser or fixture teardown succeeded.',
  ],
  CASE_TIMED_OUT: [
    'Playwright reported that the test exceeded its time limit.',
    'Inspect awaited actions, selectors, requests and cleanup. The preview defaults to 30 seconds per test; inspect owned records before a fresh run.',
  ],
  CLEANUP_FAILED: [
    'The authored cleanup callback failed.',
    'Inspect the separate owned-record journal and remove only this run\'s records. Verify their absence before retrying; do not treat the feature as verified.',
  ],
  CLEANUP_UNCONFIRMED: [
    'The report could not confirm the cleanup outcome required by the plan.',
    'Check the runCase cleanup callback and ownership journal, then verify application state directly before repeating a mutation.',
  ],
  CASE_CONTRACT_INCOMPLETE: [
    'The case did not satisfy the plan, authoring or evidence contract.',
    'Review the case reason code, static case annotation, helper version, observed expect steps, and the no-skip/no-retry rules. Do not remove a required case to obtain a pass.',
  ],
  CASE_NOT_RUN: [
    'No execution result was recorded for this planned case.',
    'Resolve the run-level diagnostics and confirm that the planned spec and static case annotation match before starting a new run.',
  ],
  RUN_CANCELLED: [
    'Execution was interrupted or cancellation was requested.',
    'Review every cleanup outcome and the owned-record journal. Start a new run only after checking any retained application state.',
  ],
  FORCED_STOP: [
    'The runner forcibly stopped its child; cleanup is unknown.',
    'Inspect owned browser processes, temporary files and the separate ownership journal. Verify scoped application cleanup manually before reuse.',
  ],
  RUN_TIMED_OUT: [
    'Playwright reported that the whole verification run exceeded its time limit.',
    'The preview has a 175-second suite budget. Review slow cases and cleanup, then split the reviewed plan into smaller runs without dropping required coverage.',
  ],
  RUNNER_START_FAILED: [
    'The verification child process could not be started.',
    'Check the Node executable, app working directory, process permissions and installation. No browser or application failure is inferred from a startup error.',
  ],
  RUNNER_REPORT_UNAVAILABLE: [
    'The runner did not receive a complete valid Playwright journal.',
    'Check runtime installation and process permissions, then review whether the child exited or was stopped. Cleanup is unverified unless a case records a valid outcome.',
  ],
  GLOBAL_TEST_ERROR: [
    'Playwright reported a run-level error outside an individual case result.',
    'Review spec imports, suite hooks, configuration and fixture setup. Raw error text is not retained; a run-level error does not identify a specific browser or dependency problem.',
  ],
  PLAYWRIGHT_UNAVAILABLE: [
    'The app-local @playwright/test CLI could not be resolved.',
    'Install the reviewed Playwright Test dependency in the app repository and confirm that its CLI resolves there. Browser installation and launch are separate checks.',
  ],
  RUNNER_CONFIGURATION_BLOCKED: [
    'A required local input or configuration could not be validated.',
    'Review the run reason code, plan review status, project/spec paths and testlane doctor. Resolve the input or configuration before starting a new run.',
  ],
  RUNNER_EVIDENCE_INVALID: [
    'Execution evidence did not satisfy the verification contract.',
    'Review the run reason codes, case mapping, copied helper and retained artifacts. Preserve the original report; do not edit evidence into a passing result.',
  ],
  RUNNER_FAILED: [
    'The test process or overall Playwright run did not finish successfully.',
    'Review case and run diagnostics, including fixture teardown and cleanup, before retrying. Passing individual case bodies cannot override a failed run.',
  ],
};
export const CASE_FAILURE_DIAGNOSTICS = Object.freeze([
  'ASSERTION_FAILED', 'CASE_BODY_FAILED', 'CASE_SETUP_OR_CONTRACT_FAILED', 'CASE_AFTER_BODY_FAILED',
]);
export function diagnostic(code) {
  if (!Object.hasOwn(diagnosticText, code)) throw new Error('DIAGNOSTIC_INVALID');
  const [summary, remedy] = diagnosticText[code];
  return { code, summary, remedy };
}
export function validDiagnostic(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 3 && Object.keys(value).every(key => ['code', 'summary', 'remedy'].includes(key)) &&
    typeof value.code === 'string' && Object.hasOwn(diagnosticText, value.code) &&
    value.summary === diagnosticText[value.code][0] && value.remedy === diagnosticText[value.code][1];
}
export function caseDiagnosticCode(reason, observed) {
  if (reason === 'CASE_PASSED') return null;
  if (reason === 'CASE_FAILED') return CASE_FAILURE_DIAGNOSTICS.includes(observed) ? observed : 'RUNNER_FAILED';
  if (reason === 'AUTHORING_HELPER_REQUIRED' && ['CASE_SETUP_OR_CONTRACT_FAILED', 'CASE_TIMED_OUT'].includes(observed)) return observed;
  return ({ CASE_NOT_RUN: 'CASE_NOT_RUN', CASE_TIMED_OUT: 'CASE_TIMED_OUT', CLEANUP_FAILED: 'CLEANUP_FAILED',
    CLEANUP_NOT_CONFIRMED: 'CLEANUP_UNCONFIRMED', FORCED_STOP: 'FORCED_STOP', RUN_CANCELLED: 'RUN_CANCELLED' })[reason] ?? 'CASE_CONTRACT_INCOMPLETE';
}
export function runDiagnostics(reasonCodes) {
  const codes = reasonCodes.map(reason => ({
    GLOBAL_TEST_ERROR: 'GLOBAL_TEST_ERROR', RUNNER_START_FAILED: 'RUNNER_START_FAILED', RUN_TIMED_OUT: 'RUN_TIMED_OUT',
    RUN_CANCELLED: 'RUN_CANCELLED', FORCED_STOP: 'FORCED_STOP', PLAYWRIGHT_UNAVAILABLE: 'PLAYWRIGHT_UNAVAILABLE',
    REPORTER_INVALID: 'RUNNER_REPORT_UNAVAILABLE', TEST_RUN_FAILED: 'RUNNER_FAILED',
    PLAN_INVALID: 'RUNNER_CONFIGURATION_BLOCKED', PLAN_NOT_REVIEWED: 'RUNNER_CONFIGURATION_BLOCKED',
    PROJECT_INVALID: 'RUNNER_CONFIGURATION_BLOCKED', SPEC_INVALID: 'RUNNER_CONFIGURATION_BLOCKED', RUNNER_BLOCKED: 'RUNNER_FAILED',
  })[reason] ?? 'RUNNER_EVIDENCE_INVALID');
  return [...new Set(codes)].map(diagnostic);
}
const environments = ['local', 'sandbox', 'testing', 'preview'];
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function text(value, max = 1000) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
export function validatePlan(value) {
  if (!keys(value, ['schemaVersion', 'status', 'title', 'projectDir', 'target', 'cases', 'evidence']) ||
      value.schemaVersion !== 1 || !['draft', 'reviewed'].includes(value.status) || !text(value.title, 160) ||
      (value.projectDir !== undefined && !text(value.projectDir, 4096)) ||
      !keys(value.target, ['baseUrl', 'environment']) || !environments.includes(value.target.environment)) throw new Error('PLAN_INVALID');
  let url;
  try { url = new URL(value.target.baseUrl); } catch { throw new Error('PLAN_INVALID'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.hostname.toLowerCase().split('.').some(label => ['prod', 'production', 'live'].includes(label)) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('PLAN_INVALID');
  if (value.evidence !== undefined && (!keys(value.evidence, ['screenshots']) || !['off', 'manual'].includes(value.evidence.screenshots))) throw new Error('PLAN_INVALID');
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > 100) throw new Error('PLAN_INVALID');
  const ids = new Set();
  for (const item of value.cases) {
    if (!keys(item, ['id', 'title', 'spec', 'expected', 'cleanup']) || typeof item.id !== 'string' || !CASE_ID.test(item.id) || ids.has(item.id) ||
        !text(item.title, 160) || !text(item.spec, 4096) || !/\.spec\.(?:[cm]?[jt]s)$/.test(item.spec) ||
        !Array.isArray(item.expected) || item.expected.length === 0 || item.expected.length > 30 || !item.expected.every(x => text(x)) ||
        !keys(item.cleanup, ['required', 'description']) || typeof item.cleanup.required !== 'boolean' || !text(item.cleanup.description)) throw new Error('PLAN_INVALID');
    ids.add(item.id);
  }
  return { ...value, projectDir: value.projectDir ?? '.', target: { baseUrl: url.origin, environment: value.target.environment },
    evidence: value.evidence ?? { screenshots: 'off' } };
}
