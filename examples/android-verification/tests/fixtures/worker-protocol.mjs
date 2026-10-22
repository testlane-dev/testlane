// Deliberately malformed/failed workers for the fixed-entry host's lifecycle tests.
// Tests redirect spawn internally; callers cannot select a public worker entry.
import { nativeLimits, nativeFailureReport, nativeDiagnostic } from '../../contracts.mjs';
const mode = process.argv[2];
let payload;
const passed = plan => ({ schemaVersion: 1, runner: plan.runner, verdict: 'passed', reasonCodes: [], diagnostics: [], limits: [...nativeLimits(plan)],
  cases: plan.cases.map(item => ({ id: item.id, status: 'passed', reason: 'NATIVE_CASE_PASSED', attempts: 1,
    bodyAssertionsObserved: 1, cleanupAssertionsObserved: item.cleanup.required ? 1 : 0, assertionsObserved: item.cleanup.required ? 2 : 1,
    cleanup: { required: item.cleanup.required, status: item.cleanup.required ? 'completed' : 'not-required' }, diagnostics: [] })) });
function result(report, exit = 0) { process.send({ type: 'result', report }, () => { process.disconnect(); process.exitCode = exit; }); }
process.on('message', message => {
  if (message.type === 'cancel' && mode === 'honor-cancel') { result(nativeFailureReport(payload.plan, 'NATIVE_RUN_CANCELLED')); return; }
  if (message.type === 'response' && mode === 'rpc-clean') { result(message.ok ? passed(payload.plan) : nativeFailureReport(payload.plan, 'NATIVE_WORKER_FAILED')); return; }
  if (message.type !== 'start') return;
  payload = message.payload;
  if (mode === 'sync-block') {
    process.stdout.write('native-worker-entering-block\n', () => { for (;;) {} });
    return;
  }
  if (mode === 'timeout' || mode === 'honor-cancel') { setInterval(() => {}, 1000).unref(); return; }
  if (mode === 'malformed') { result({ ...passed(payload.plan), error: payload.cookies.editor }); return; }
  if (mode === 'bad-request') { process.send({ type: 'request', id: 'rpc-1', request: { type: 'assert-owned', error: payload.cookies.editor } }); return; }
  if (mode === 'output') { process.stdout.write('x'.repeat(300 * 1024)); return; }
  if (mode === 'rpc-then-pass' || mode === 'rpc-clean') {
    process.send({ type: 'request', id: 'rpc-1', request: { type: 'assert-owned' } });
    if (mode === 'rpc-clean') return;
  }
  if (mode === 'unsettled') {
    const report = nativeFailureReport(payload.plan, 'NATIVE_BODY_UNSETTLED');
    report.cases[0].attempts = 1; report.cases[0].reason = 'NATIVE_BODY_UNSETTLED';
    report.cases[0].diagnostics = [nativeDiagnostic('NATIVE_BODY_UNSETTLED')];
    process.send({ type: 'result', report }); return;
  }
  if (mode === 'hang-after-result') { process.send({ type: 'result', report: passed(payload.plan) }); return; }
  result(passed(payload.plan), mode === 'bad-exit' ? 2 : 0);
});
