/** Experimental native contracts. Independent of Playwright reports. */
export const NATIVE_RUNNER = 'android-uiautomator2';
export const IOS_NATIVE_RUNNER = 'ios-xcuitest';
export const NATIVE_CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NATIVE_DRIVER_FAILURE_CODES = Object.freeze([
  'NATIVE_DRIVER_CONFIGURATION_INVALID', 'NATIVE_DRIVER_OWNERSHIP_REFUSED', 'NATIVE_DRIVER_CONTEXT_REFUSED',
  'NATIVE_DRIVER_TIMEOUT', 'NATIVE_DRIVER_COMMAND_FAILED', 'NATIVE_DRIVER_SESSION_INVALID', 'NATIVE_DRIVER_RESPONSE_INVALID',
  'NATIVE_DRIVER_SESSION_TIMEOUT', 'NATIVE_DRIVER_CONTEXT_TIMEOUT', 'NATIVE_DRIVER_READINESS_TIMEOUT',
  'NATIVE_DRIVER_ELEMENT_INVALID', 'NATIVE_DRIVER_ELEMENT_TIMEOUT', 'NATIVE_DRIVER_INPUT_INVALID',
]);
export const NATIVE_LIMITS = Object.freeze([
  'Experimental local Android execution; no general Expo, device or coding-agent certification is claimed.',
  'Plans, callbacks, app code and the supplied context are trusted executable code, not a security sandbox.',
  'Checks count strict deep-equality observations; counts do not establish business-oracle quality or coverage.',
  'Cleanup completion requires a settled callback and a successful observed cleanup check; application semantics remain authored code.',
  'Unsettled callbacks stop later cases and leave cleanup unknown. The process owner must enforce an outer worker budget, including code that blocks the event loop.',
  'Reports omit callback returns, expected/actual values, descriptions, exception messages, stacks, native view contents and driver payloads.',
]);
const IOS_LIMITS = Object.freeze([
  'Experimental iOS Simulator execution on an explicitly opted-in ephemeral GitHub-hosted Mac; no general Expo, real-device or coding-agent certification is claimed.',
  'Device scope is ephemeral-hosted-standard-device-set: one nonce-bound Simulator is created and deleted by exact UUID, with unchanged foreign inventory required for cleanup completion.',
  ...NATIVE_LIMITS.slice(1),
]);
export const nativeLimits = plan => plan?.runner === IOS_NATIVE_RUNNER ? IOS_LIMITS : NATIVE_LIMITS;
export class NativeVerificationError extends Error {
  constructor(code) { super(code); this.name = 'NativeVerificationError'; this.code = code; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function loopbackOrigin(value) {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new NativeVerificationError('NATIVE_TARGET_INVALID'); }
}
export function validateNativePlan(value) {
  if (!keys(value, ['schemaVersion', 'runner', 'status', 'title', 'target', 'app', 'cases']) ||
    value.schemaVersion !== 1 || ![NATIVE_RUNNER, IOS_NATIVE_RUNNER].includes(value.runner) || !['draft', 'reviewed'].includes(value.status) || !text(value.title, 160) ||
    !keys(value.target, ['baseUrl', 'environment']) || !['local', 'sandbox', 'testing', 'preview'].includes(value.target.environment) ||
    !Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > 50) throw new NativeVerificationError('NATIVE_PLAN_INVALID');
  const ios = value.runner === IOS_NATIVE_RUNNER, appId = ios ? 'bundleId' : 'package', appHash = ios ? 'buildSha256' : 'apkSha256';
  if (!keys(value.app, [appId, appHash]) || typeof value.app[appId] !== 'string' || value.app[appId].length > 160 ||
    !(ios ? /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/ : /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/).test(value.app[appId]) ||
    typeof value.app[appHash] !== 'string' || !/^[a-f0-9]{64}$/.test(value.app[appHash])) throw new NativeVerificationError('NATIVE_PLAN_INVALID');
  const baseUrl = loopbackOrigin(value.target.baseUrl);
  const ids = new Set();
  for (const item of value.cases) {
    if (!keys(item, ['id', 'title', 'expected', 'cleanup']) || typeof item.id !== 'string' || !NATIVE_CASE_ID.test(item.id) || ids.has(item.id) ||
      !text(item.title, 160) || !Array.isArray(item.expected) || item.expected.length === 0 || item.expected.length > 30 || !item.expected.every(value => text(value)) ||
      !keys(item.cleanup, ['required', 'description']) || typeof item.cleanup.required !== 'boolean' || !text(item.cleanup.description)) {
      throw new NativeVerificationError('NATIVE_PLAN_INVALID');
    }
    ids.add(item.id);
  }
  // Copy the data contract so callbacks cannot mutate the checked plan through aliases.
  return structuredClone({ ...value, target: { baseUrl, environment: value.target.environment } });
}

const diagnoses = {
  NATIVE_PLAN_INVALID: ['setup', 'The native plan is invalid.', 'Review the native runner, exact app package/APK hash, loopback target and case contract.'],
  NATIVE_PLAN_NOT_REVIEWED: ['setup', 'The native plan is still a draft.', 'Review the expected behavior and owned cleanup before marking the plan reviewed.'],
  NATIVE_CONFIGURATION_INVALID: ['setup', 'A native execution budget or input is invalid.', 'Use bounded positive execution, settlement and cleanup budgets and the documented callback API.'],
  NATIVE_CASE_MAPPING_INVALID: ['setup', 'Authored cases do not exactly match the plan.', 'Supply each planned case exactly once, with no unknown IDs, skip/retry flags or missing callbacks.'],
  NATIVE_CASE_NOT_RUN: ['execution', 'This planned native case did not run.', 'Resolve the earlier setup, cancellation or unsettled-callback diagnosis before a fresh run.'],
  NATIVE_ASSERTION_FAILED: ['body', 'A native body check failed, even if its exception was caught.', 'Inspect the authored business assertion against the bound case source; observed values are not retained.'],
  NATIVE_BODY_FAILED: ['body', 'The native case body failed.', 'Inspect native actions, API operations and the authored body. No exception text or native view content is retained.'],
  NATIVE_UI_SETTLEMENT_TIMEOUT: ['body', 'The expected native UI value was not observed before polling ended.', 'Review the bound app state and authored expected value. UI text is omitted and actions are never replayed.'],
  NATIVE_NO_BODY_CHECKS: ['body', 'No native body check was observed.', 'Add concrete check(actual, expected) assertions for the planned business behavior.'],
  NATIVE_BODY_TIMEOUT: ['body', 'The native body exceeded its budget.', 'Review awaited native/API operations and inspect owned records before retrying.'],
  NATIVE_BODY_UNSETTLED: ['body', 'The aborted body did not settle; cleanup is unknown.', 'Stop the owned worker and inspect owned records. No cleanup callback or later case was started concurrently with this body.'],
  NATIVE_CLEANUP_REQUIRED: ['cleanup', 'The plan requires a cleanup callback.', 'Provide scoped deletion and at least one check proving the owned application state is absent.'],
  NATIVE_CLEANUP_FAILED: ['cleanup', 'The authored native cleanup failed or one of its checks failed.', 'Inspect the separate owned-record journal and verify scoped recovery before retrying.'],
  NATIVE_NO_CLEANUP_CHECKS: ['cleanup', 'Cleanup returned without an observed check.', 'Assert that this run\'s owned state is absent; callback completion alone cannot verify cleanup.'],
  NATIVE_CLEANUP_TIMEOUT: ['cleanup', 'The native cleanup exceeded its budget.', 'Inspect the owned-record journal and verify deletion independently before retrying.'],
  NATIVE_CLEANUP_UNSETTLED: ['cleanup', 'The aborted cleanup did not settle.', 'Stop the owned worker and inspect retained state; no later case was started.'],
  NATIVE_RUN_CANCELLED: ['execution', 'The native run was cancelled.', 'Review cleanup outcomes and owned state before starting a fresh run.'],
  NATIVE_DRIVER_FAILED: ['setup', 'The owned native driver could not complete setup or execution.', 'Inspect the owned emulator and Appium lifecycle using private diagnostics; no driver payload is retained.'],
  NATIVE_DRIVER_CONFIGURATION_INVALID: ['setup', 'The native driver configuration was refused.', 'Review the loopback Appium origin, exact Android device/package and required native privacy capabilities.'],
  NATIVE_DRIVER_OWNERSHIP_REFUSED: ['setup', 'The native driver could not confirm device ownership within its budget.', 'Check the private parent ownership operation, retained process handles and guest identity before retrying.'],
  NATIVE_DRIVER_CONTEXT_REFUSED: ['setup', 'The driver did not observe the required NATIVE_APP context.', 'Use UiAutomator2 for the owned native app; WebViews and browser contexts are not accepted by this proof.'],
  NATIVE_DRIVER_TIMEOUT: ['execution', 'A native driver request exceeded its fixed budget.', 'Inspect the owned Appium/emulator lifecycle and command timing privately; no response body is retained.'],
  NATIVE_DRIVER_SESSION_TIMEOUT: ['setup', 'Native session creation exceeded its 120-second setup budget.', 'Inspect the owned cold Appium installation and instrumentation startup privately before retrying. Business-case budgets remain separate.'],
  NATIVE_DRIVER_CONTEXT_TIMEOUT: ['setup', 'The native context check exceeded its five-second request budget.', 'Inspect the owned Appium session privately. The runner must observe NATIVE_APP before accepting native actions.'],
  NATIVE_DRIVER_READINESS_TIMEOUT: ['setup', 'The initial native readiness element did not become available within its budget.', 'Inspect the bound app startup and accessibility ID privately. No business action or case is retried by this readiness check.'],
  NATIVE_DRIVER_COMMAND_FAILED: ['execution', 'The owned native driver command failed.', 'Inspect the private Appium/device command outcome; HTTP errors and transport errors are not copied into reports.'],
  NATIVE_DRIVER_CANCELLED: ['execution', 'The native driver operation was cancelled.', 'Review the phase cancellation and owned cleanup outcome before a fresh run. No driver payload is retained.'],
  NATIVE_DRIVER_SESSION_INVALID: ['setup', 'The native driver did not obtain a valid owned session.', 'Check Appium session creation and the exact owned app/device capabilities privately.'],
  NATIVE_DRIVER_RESPONSE_INVALID: ['execution', 'The native driver response did not satisfy its bounded contract.', 'Inspect the private Appium response shape and size; arbitrary response values are not retained.'],
  NATIVE_DRIVER_ELEMENT_INVALID: ['execution', 'A native action used an invalid accessibility identifier or closed session.', 'Use the stable app-owned accessibility IDs and keep actions within the owned driver lifetime.'],
  NATIVE_DRIVER_ELEMENT_TIMEOUT: ['execution', 'The native accessibility target was not found or made visible in time.', 'Review the bound native UI identifiers, view state and fixed scrolling limits privately.'],
  NATIVE_DRIVER_INPUT_INVALID: ['execution', 'A native text input was refused.', 'Use bounded string inputs in the trusted native case; input values are not copied into reports.'],
  NATIVE_DRIVER_CLEANUP_FAILED: ['cleanup', 'The owned native driver session did not close successfully.', 'Stop the owned Appium/emulator processes and inspect cleanup before accepting the run.'],
  NATIVE_WORKER_FAILED: ['execution', 'The native worker failed before a complete result was accepted.', 'Inspect owned worker and device state; incomplete execution cannot verify cleanup.'],
  NATIVE_WORKER_TIMEOUT: ['execution', 'The outer native worker budget expired.', 'The owned worker was stopped. Inspect owned records and stop the owned device processes; cleanup remains unknown.'],
  NATIVE_WORKER_PROTOCOL_INVALID: ['execution', 'The native worker IPC contract was refused.', 'Preserve private recovery state and inspect the worker source/protocol. No offending payload is copied into this report.'],
  NATIVE_WORKER_OUTPUT_LIMIT: ['execution', 'The native worker exceeded its private output budget.', 'Inspect private diagnostics and owned state; no truncated output is evidence of a passing run.'],
  NATIVE_WORKER_TERMINATION_UNCONFIRMED: ['execution', 'Owned native worker termination could not be confirmed.', 'Stop the owned process tree and device processes manually before recovery or another run.'],
  NATIVE_WORKER_RPC_UNSETTLED: ['cleanup', 'A parent-owned native operation did not settle.', 'Do not start another run. Stop the owned device processes and inspect retained recovery state before continuing.'],
};
const iosDiagnoses = {
  NATIVE_PLAN_INVALID: ['setup', 'The native plan is invalid.', 'Review the iOS runner, exact bundle ID/build hash, loopback target and case contract.'],
  NATIVE_DRIVER_FAILED: ['setup', 'The owned native driver could not complete setup or execution.', 'Inspect the owned Simulator and Appium lifecycle privately; no driver payload is retained.'],
  NATIVE_DRIVER_CONFIGURATION_INVALID: ['setup', 'The native driver configuration was refused.', 'Review the loopback Appium origin, exact Simulator UDID/bundle, owned device-set/build paths and required privacy capabilities.'],
  NATIVE_DRIVER_CONTEXT_REFUSED: ['setup', 'The driver did not observe the required NATIVE_APP context.', 'Use XCUITest for the owned Simulator app; WebViews and browser contexts are not accepted by this proof.'],
  NATIVE_DRIVER_SESSION_TIMEOUT: ['setup', 'Native session creation exceeded its 240-second setup budget.', 'Inspect the owned cold WebDriverAgent build and Simulator startup privately before retrying. Business-case budgets remain separate.'],
  NATIVE_DRIVER_CLEANUP_FAILED: ['cleanup', 'The owned native driver session did not close successfully.', 'Stop the owned Appium/Simulator processes and inspect cleanup before accepting the run.'],
};
export function nativeDiagnostic(code, runner = NATIVE_RUNNER) {
  if (!Object.hasOwn(diagnoses, code)) throw new NativeVerificationError('NATIVE_CONFIGURATION_INVALID');
  const [phase, summary, remedy] = runner === IOS_NATIVE_RUNNER && Object.hasOwn(iosDiagnoses, code) ? iosDiagnoses[code] : diagnoses[code];
  return { code, phase, summary, remedy };
}
export function nativeFailureReport(inputPlan, code) {
  const plan = validateNativePlan(inputPlan);
  return { schemaVersion: 1, runner: plan.runner, verdict: code === 'NATIVE_RUN_CANCELLED' ? 'cancelled' : 'blocked',
    reasonCodes: [code], diagnostics: [nativeDiagnostic(code, plan.runner)], limits: [...nativeLimits(plan)],
    cases: plan.cases.map(item => ({ id: item.id, status: 'blocked', reason: 'NATIVE_CASE_NOT_RUN', attempts: 0,
      assertionsObserved: 0, bodyAssertionsObserved: 0, cleanupAssertionsObserved: 0,
      cleanup: { required: item.cleanup.required, status: 'unknown' }, diagnostics: [nativeDiagnostic('NATIVE_CASE_NOT_RUN', plan.runner)] })) };
}
export function appendNativeRunFailure(input, code) {
  const report = structuredClone(input);
  report.reasonCodes = [...new Set([...report.reasonCodes, code])]; report.diagnostics = report.reasonCodes.map(value => nativeDiagnostic(value, report.runner));
  report.verdict = report.cases.some(row => row.status === 'cancelled') || report.reasonCodes.includes('NATIVE_RUN_CANCELLED') ? 'cancelled' :
    report.cases.some(row => row.status === 'failed') ? 'failed' : 'blocked';
  return report;
}

/** Accept only the fixed native report shape before recording worker IPC output. */
export function sanitizeNativeReport(value, inputPlan) {
  const refuse = () => { throw new NativeVerificationError('NATIVE_REPORT_INVALID'); };
  let plan;
  try { plan = validateNativePlan(inputPlan); } catch { return refuse(); }
  const validDiagnostic = item => {
    if (!keys(item, ['code', 'phase', 'summary', 'remedy']) || Object.keys(item).length !== 4 ||
      typeof item.code !== 'string' || !Object.hasOwn(diagnoses, item.code)) return false;
    const expected = nativeDiagnostic(item.code, plan.runner);
    return ['phase', 'summary', 'remedy'].every(key => item[key] === expected[key]);
  };
  const count = (number, max = 1_000_000) => Number.isSafeInteger(number) && number >= 0 && number <= max;
  const statuses = ['passed', 'failed', 'blocked', 'cancelled'];
  if (!keys(value, ['schemaVersion', 'runner', 'verdict', 'reasonCodes', 'diagnostics', 'cases', 'limits']) ||
    value.schemaVersion !== 1 || value.runner !== plan.runner || !statuses.includes(value.verdict) ||
    !Array.isArray(value.reasonCodes) || value.reasonCodes.some(code => typeof code !== 'string' || !Object.hasOwn(diagnoses, code)) ||
    new Set(value.reasonCodes).size !== value.reasonCodes.length || !Array.isArray(value.diagnostics) ||
    value.diagnostics.length !== value.reasonCodes.length || value.diagnostics.some((item, index) => !validDiagnostic(item) || item.code !== value.reasonCodes[index]) ||
    !Array.isArray(value.cases) || value.cases.length !== plan.cases.length ||
    JSON.stringify(value.limits) !== JSON.stringify(nativeLimits(plan))) return refuse();
  const rows = [];
  for (let index = 0; index < plan.cases.length; index++) {
    const row = value.cases[index], planned = plan.cases[index];
    if (!keys(row, ['id', 'status', 'reason', 'attempts', 'assertionsObserved', 'bodyAssertionsObserved', 'cleanupAssertionsObserved', 'cleanup', 'diagnostics']) ||
      row.id !== planned.id || !statuses.includes(row.status) || ![0, 1].includes(row.attempts) ||
      !count(row.bodyAssertionsObserved) || !count(row.cleanupAssertionsObserved) || !count(row.assertionsObserved, 2_000_000) ||
      row.assertionsObserved !== row.bodyAssertionsObserved + row.cleanupAssertionsObserved ||
      !keys(row.cleanup, ['required', 'status']) || Object.keys(row.cleanup).length !== 2 || row.cleanup.required !== planned.cleanup.required ||
      !['completed', 'failed', 'not-required', 'unknown'].includes(row.cleanup.status) ||
      !Array.isArray(row.diagnostics) || row.diagnostics.some(item => !validDiagnostic(item)) ||
      new Set(row.diagnostics.map(item => item.code)).size !== row.diagnostics.length ||
      (row.cleanup.status === 'completed' && row.cleanupAssertionsObserved < 1) ||
      (row.cleanup.status === 'not-required' && (row.cleanup.required || row.cleanupAssertionsObserved !== 0))) return refuse();
    if (row.status === 'passed') {
      if (row.reason !== 'NATIVE_CASE_PASSED' || row.attempts !== 1 || row.bodyAssertionsObserved < 1 || row.diagnostics.length ||
        !['completed', 'not-required'].includes(row.cleanup.status)) return refuse();
    } else if (!row.diagnostics.length || row.reason !== row.diagnostics[0].code) return refuse();
    if (row.attempts === 0 && (row.assertionsObserved !== 0 || row.cleanup.status !== 'unknown')) return refuse();
    if (row.diagnostics.some(item => ['NATIVE_BODY_UNSETTLED', 'NATIVE_CLEANUP_UNSETTLED'].includes(item.code)) &&
      (row.status !== 'blocked' || row.cleanup.status !== 'unknown')) return refuse();
    rows.push({ id: planned.id, status: row.status, reason: row.reason, attempts: row.attempts,
      assertionsObserved: row.assertionsObserved, bodyAssertionsObserved: row.bodyAssertionsObserved,
      cleanupAssertionsObserved: row.cleanupAssertionsObserved,
      cleanup: { required: planned.cleanup.required, status: row.cleanup.status }, diagnostics: row.diagnostics.map(item => nativeDiagnostic(item.code, plan.runner)) });
  }
  const expectedVerdict = rows.some(row => row.status === 'cancelled') || value.reasonCodes.includes('NATIVE_RUN_CANCELLED') ? 'cancelled' :
    rows.some(row => row.status === 'failed') ? 'failed' : rows.some(row => row.status !== 'passed') || value.reasonCodes.length ? 'blocked' : 'passed';
  if (value.verdict !== expectedVerdict || (value.verdict === 'passed' && plan.status !== 'reviewed')) return refuse();
  return { schemaVersion: 1, runner: plan.runner, verdict: value.verdict, reasonCodes: [...value.reasonCodes],
    diagnostics: value.reasonCodes.map(code => nativeDiagnostic(code, plan.runner)), cases: rows, limits: [...nativeLimits(plan)] };
}

const string = { type: 'string', minLength: 1 };
export const NATIVE_PLAN_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'runner', 'status', 'title', 'target', 'app', 'cases'],
  properties: {
    schemaVersion: { const: 1 }, runner: { enum: [NATIVE_RUNNER, IOS_NATIVE_RUNNER] }, status: { enum: ['draft', 'reviewed'] }, title: { ...string, maxLength: 160 },
    target: { type: 'object', additionalProperties: false, required: ['baseUrl', 'environment'], properties: {
      baseUrl: { ...string, format: 'uri' }, environment: { enum: ['local', 'sandbox', 'testing', 'preview'] },
    } },
    app: { type: 'object' },
    cases: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false,
      required: ['id', 'title', 'expected', 'cleanup'], properties: {
        id: { ...string, pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }, title: { ...string, maxLength: 160 },
        expected: { type: 'array', minItems: 1, maxItems: 30, items: { ...string, maxLength: 1000 } },
        cleanup: { type: 'object', additionalProperties: false, required: ['required', 'description'], properties: {
          required: { type: 'boolean' }, description: { ...string, maxLength: 1000 },
        } },
      },
    } },
  },
  oneOf: [
    { properties: { runner: { const: NATIVE_RUNNER }, app: { type: 'object', additionalProperties: false, required: ['package', 'apkSha256'], properties: {
      package: { ...string, maxLength: 160, pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$' }, apkSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } } } },
    { properties: { runner: { const: IOS_NATIVE_RUNNER }, app: { type: 'object', additionalProperties: false, required: ['bundleId', 'buildSha256'], properties: {
      bundleId: { ...string, maxLength: 160, pattern: '^[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+$' }, buildSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } } } },
  ],
});
