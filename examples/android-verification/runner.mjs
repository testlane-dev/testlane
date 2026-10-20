/** Bounded cooperative native cases. An external owner must bound the worker process. */
import { isDeepStrictEqual, types } from 'node:util';
import { NATIVE_RUNNER, IOS_NATIVE_RUNNER, NATIVE_DRIVER_FAILURE_CODES, nativeLimits, NativeVerificationError, validateNativePlan, nativeDiagnostic } from './contracts.mjs';
import { NativeDriverError as AndroidDriverError } from './driver.mjs';
import { NativeDriverError as IosDriverError } from '../ios-verification/driver.mjs';

const DRIVER_CAUSES = new Set([...NATIVE_DRIVER_FAILURE_CODES, 'NATIVE_DRIVER_CANCELLED']);
function failureCause(error, runner) {
  // Proxy checks are intrinsic and run before any property/prototype operation.
  // Never invoke callback-owned getters, inspect messages/stacks, or stringify
  // the thrown value. Only our exact classes and own primitive codes qualify.
  if (error === null || typeof error !== 'object' || types.isProxy(error) || !types.isNativeError(error)) return;
  try {
    const prototype = Object.getPrototypeOf(error), descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return;
    if (prototype === NativeVerificationError.prototype && descriptor.value === 'NATIVE_UI_SETTLEMENT_TIMEOUT') return descriptor.value;
    if (prototype === (runner === IOS_NATIVE_RUNNER ? IosDriverError.prototype : AndroidDriverError.prototype) && DRIVER_CAUSES.has(descriptor.value)) return descriptor.value;
  } catch { /* An unrecognized thrown value contributes no public metadata. */ }
}

function wait(promise, milliseconds, signal) {
  return new Promise(resolve => {
    let done = false, timer;
    const finish = outcome => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(outcome);
    };
    const cancel = () => finish({ kind: 'cancelled' });
    promise.then(value => finish({ kind: 'settled', ok: value.ok, ...(value.cause ? { cause: value.cause } : {}) }), () => finish({ kind: 'settled', ok: false }));
    timer = setTimeout(() => finish({ kind: 'timeout' }), milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
function counter() { return { observed: 0, failed: false, open: true }; }
function checking(state) {
  return (actual, expected) => {
    if (!state.open) throw new NativeVerificationError('NATIVE_CHECK_OUTSIDE_PHASE');
    state.observed++;
    let equal = false;
    try { equal = state.observed <= 1_000_000 && isDeepStrictEqual(actual, expected); } catch {}
    if (!equal) { state.failed = true; throw new NativeVerificationError('NATIVE_ASSERTION_FAILED'); }
  };
}
async function phase(callback, context, state, timeoutMs, settleTimeoutMs, signal, runner) {
  if (signal?.aborted) { state.open = false; return { kind: 'cancelled', unsettled: false }; }
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending = Promise.resolve().then(() => callback(Object.freeze({ ...context, check: checking(state), signal: combined })))
    .then(() => ({ ok: true }), error => {
      const cause = failureCause(error, runner);
      return { ok: false, ...(cause ? { cause } : {}) };
    }); // Never retain the thrown value or callback return.
  const outcome = await wait(pending, timeoutMs, signal);
  if (outcome.kind === 'settled') { state.open = false; return { ...outcome, unsettled: false }; }
  controller.abort();
  const settled = await wait(pending, settleTimeoutMs);
  state.open = false;
  return { ...outcome, unsettled: settled.kind !== 'settled' };
}
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
function rowFor(item, runner) {
  return { id: item.id, status: 'blocked', reason: 'NATIVE_CASE_NOT_RUN', attempts: 0,
    assertionsObserved: 0, bodyAssertionsObserved: 0, cleanupAssertionsObserved: 0,
    cleanup: { required: item.cleanup.required, status: 'unknown' }, diagnostics: [nativeDiagnostic('NATIVE_CASE_NOT_RUN', runner)] };
}
function failedReport(code, rows = [], plan) {
  return { schemaVersion: 1, runner: plan?.runner ?? NATIVE_RUNNER, verdict: 'blocked', reasonCodes: [code],
    diagnostics: [nativeDiagnostic(code, plan?.runner)], cases: rows, limits: [...nativeLimits(plan)] };
}
export async function runNativeCases({ plan: input, cases, context = {}, signal, timeoutMs = 30_000,
  cleanupTimeoutMs = 5000, settleTimeoutMs = 5000 } = {}) {
  let plan;
  try { plan = validateNativePlan(input); } catch { return failedReport('NATIVE_PLAN_INVALID'); }
  const rows = plan.cases.map(item => rowFor(item, plan.runner)), diagnosis = code => nativeDiagnostic(code, plan.runner);
  if (!bounded(timeoutMs, 180_000) || !bounded(cleanupTimeoutMs, 30_000) || !bounded(settleTimeoutMs, 10_000)) return failedReport('NATIVE_CONFIGURATION_INVALID', rows, plan);
  if (plan.status !== 'reviewed') return failedReport('NATIVE_PLAN_NOT_REVIEWED', rows, plan);
  const ids = new Set(plan.cases.map(item => item.id));
  if (!Array.isArray(cases) || cases.length !== ids.size || new Set(cases.map(item => item?.id)).size !== ids.size ||
    cases.some(item => !item || typeof item !== 'object' || Object.keys(item).some(key => !['id', 'run', 'cleanup'].includes(key)) ||
      !ids.has(item.id) || typeof item.run !== 'function' || (item.cleanup !== undefined && typeof item.cleanup !== 'function'))) {
    return failedReport('NATIVE_CASE_MAPPING_INVALID', rows, plan);
  }
  const authoredById = new Map(cases.map(item => [item.id, { run: item.run, cleanup: item.cleanup }]));
  const missingCleanup = plan.cases.findIndex(item => item.cleanup.required && !authoredById.get(item.id).cleanup);
  if (missingCleanup !== -1) {
    rows[missingCleanup].reason = 'NATIVE_CLEANUP_REQUIRED';
    rows[missingCleanup].diagnostics = [diagnosis('NATIVE_CLEANUP_REQUIRED')];
    return failedReport('NATIVE_CLEANUP_REQUIRED', rows, plan);
  }
  const report = { schemaVersion: 1, runner: plan.runner, verdict: 'passed', reasonCodes: [], diagnostics: [], cases: rows, limits: [...nativeLimits(plan)] };
  let stop = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], item = plan.cases[index], authored = authoredById.get(item.id);
    if (stop) continue;
    if (signal?.aborted) {
      stop = true; report.reasonCodes.push('NATIVE_RUN_CANCELLED');
      row.status = 'cancelled'; row.reason = 'NATIVE_RUN_CANCELLED'; row.diagnostics = [diagnosis(row.reason)];
      continue;
    }
    row.attempts = 1;
    const body = counter(), cleanup = counter();
    const bodyResult = await phase(authored.run, context, body, timeoutMs, settleTimeoutMs, signal, plan.runner);
    const failures = [];
    if (bodyResult.unsettled) { failures.push('NATIVE_BODY_UNSETTLED'); stop = true; row.status = 'blocked'; }
    else if (bodyResult.kind === 'cancelled') { failures.push('NATIVE_RUN_CANCELLED'); row.status = 'cancelled'; stop = true; }
    else if (bodyResult.kind === 'timeout') { failures.push('NATIVE_BODY_TIMEOUT'); row.status = 'failed'; }
    else if (body.failed) { failures.push('NATIVE_ASSERTION_FAILED'); row.status = 'failed'; }
    else if (!bodyResult.ok) { failures.push('NATIVE_BODY_FAILED'); if (bodyResult.cause) failures.push(bodyResult.cause); row.status = 'failed'; }
    else if (body.observed === 0) { failures.push('NATIVE_NO_BODY_CHECKS'); row.status = 'blocked'; }
    else row.status = 'passed';
    if (bodyResult.unsettled) row.cleanup.status = 'unknown';
    else if (authored.cleanup) {
      // Cleanup gets its own fresh cooperative signal, even after run cancellation.
      const cleaned = await phase(authored.cleanup, context, cleanup, cleanupTimeoutMs, settleTimeoutMs, undefined, plan.runner);
      let cleanupFailure;
      if (cleaned.unsettled) { cleanupFailure = 'NATIVE_CLEANUP_UNSETTLED'; row.cleanup.status = 'unknown'; stop = true; row.status = 'blocked'; }
      else if (cleaned.kind === 'timeout') cleanupFailure = 'NATIVE_CLEANUP_TIMEOUT';
      else if (!cleaned.ok || cleanup.failed) cleanupFailure = 'NATIVE_CLEANUP_FAILED';
      else if (cleanup.observed === 0) cleanupFailure = 'NATIVE_NO_CLEANUP_CHECKS';
      if (cleanupFailure) {
        failures.push(cleanupFailure);
        if (cleanupFailure === 'NATIVE_CLEANUP_FAILED' && !cleanup.failed && cleaned.cause) failures.push(cleaned.cause);
        if (row.cleanup.status !== 'unknown' || !cleaned.unsettled) row.cleanup.status = 'failed';
        if (!['blocked', 'cancelled'].includes(row.status)) row.status = 'failed';
      } else row.cleanup.status = 'completed';
    } else row.cleanup.status = 'not-required';
    row.bodyAssertionsObserved = body.observed; row.cleanupAssertionsObserved = cleanup.observed;
    row.assertionsObserved = body.observed + cleanup.observed;
    row.reason = failures[0] ?? 'NATIVE_CASE_PASSED';
    row.diagnostics = [...new Set(failures)].map(diagnosis);
    if (failures.includes('NATIVE_RUN_CANCELLED')) report.reasonCodes.push('NATIVE_RUN_CANCELLED');
    if (bodyResult.unsettled || failures.includes('NATIVE_CLEANUP_UNSETTLED')) report.reasonCodes.push('NATIVE_BODY_UNSETTLED' === row.reason ? row.reason : 'NATIVE_CLEANUP_UNSETTLED');
  }
  if (signal?.aborted) report.reasonCodes.push('NATIVE_RUN_CANCELLED');
  report.reasonCodes = [...new Set(report.reasonCodes)];
  report.diagnostics = report.reasonCodes.map(diagnosis);
  if (rows.some(row => row.status === 'cancelled') || report.reasonCodes.includes('NATIVE_RUN_CANCELLED')) report.verdict = 'cancelled';
  else if (rows.some(row => row.status === 'failed')) report.verdict = 'failed';
  else if (rows.some(row => row.status !== 'passed')) report.verdict = 'blocked';
  return report;
}
