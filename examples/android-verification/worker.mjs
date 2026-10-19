/** Private IPC worker. Credentials and app payloads never cross stdout or report fields. */
import { runNativeCases } from './runner.mjs';
import { createApprovalCases } from './proof-cases.mjs';
import { NATIVE_PROOF_BUDGETS } from './budgets.mjs';
import { loopbackOrigin, validateNativePlan, nativeFailureReport, appendNativeRunFailure, NATIVE_DRIVER_FAILURE_CODES, IOS_NATIVE_RUNNER } from './contracts.mjs';

const controller = new AbortController(), pending = new Map();
let started = false, sequence = 0;
const fixed = () => new Error('NATIVE_WORKER_OPERATION_FAILED');
function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) { reject(fixed()); return; }
    process.send(message, error => error ? reject(fixed()) : resolve());
  });
}
function rpc(request) {
  return new Promise((resolve, reject) => {
    const id = 'rpc-' + (++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(fixed()); }, 20_000);
    pending.set(id, { finish: ok => { clearTimeout(timer); pending.delete(id); ok ? resolve() : reject(fixed()); } });
    send({ type: 'request', id, request }).catch(() => { pending.get(id)?.finish(false); });
  });
}
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(fixed()); };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
async function main(payload) {
  let driver, report, DriverError;
  const plan = validateNativePlan(payload.plan), origin = loopbackOrigin(payload.origin);
  if (origin !== plan.target.baseUrl || !payload.identities || !payload.cookies) throw fixed();
  for (const role of ['editor', 'reviewer']) {
    if (typeof payload.cookies[role] !== 'string' || !payload.cookies[role] || payload.cookies[role].length > 8192 || /[\r\n]/.test(payload.cookies[role]) ||
      typeof payload.identities[role]?.email !== 'string' || payload.identities[role].email.length > 254 ||
      payload.identities[role].role !== (role === 'editor' ? 'Editor' : 'Reviewer')) throw fixed();
  }
  try {
    // A reviewed enum chooses exactly one local implementation. Caller-supplied
    // module paths, code, driver names or remote sources are never imported.
    const implementation = plan.runner === IOS_NATIVE_RUNNER ? await import('../ios-verification/driver.mjs') : await import('./driver.mjs');
    const createNativeDriver = implementation.createNativeDriver; DriverError = implementation.NativeDriverError;
    const appCapability = plan.runner === IOS_NATIVE_RUNNER ? 'appium:bundleId' : 'appium:appPackage';
    const plannedApp = plan.runner === IOS_NATIVE_RUNNER ? plan.app.bundleId : plan.app.package;
    if (payload.driverOptions?.capabilities?.[appCapability] !== plannedApp) throw new DriverError('NATIVE_DRIVER_CONFIGURATION_INVALID');
    driver = await createNativeDriver({ ...payload.driverOptions, signal: controller.signal,
      assertOwned: async () => { await rpc({ type: 'assert-owned' }); return true; } });
    // Appium session creation precedes React Native's initial view mount. Wait
    // only for this app-owned readiness element; no test action is retried.
    await driver.waitFor('session-status');
    const waitText = async (id, expected, signal, timeoutMs = 10_000) => {
      const activeDriver = driver.withSignal(signal);
      const until = Date.now() + Math.max(1, Math.min(timeoutMs, 10_000));
      while (Date.now() < until) {
        if (signal?.aborted || controller.signal.aborted) throw fixed();
        const value = await activeDriver.text(id);
        if (value === expected) return value;
        await delay(Math.min(200, Math.max(1, until - Date.now())), signal);
      }
      throw fixed();
    };
    const api = async (role, method, route, body, signal) => {
      if (![null, 'editor', 'reviewer'].includes(role) || !['GET', 'POST', 'DELETE'].includes(method) ||
        typeof route !== 'string' || !/^\/api\/(?:me|requests(?:\/[a-f0-9-]{36}(?:\/approve)?)?)$/.test(route)) throw fixed();
      const timed = new AbortController(), timer = setTimeout(() => timed.abort(), 5000);
      try {
        const response = await fetch(origin + route, { method, redirect: 'error',
          // Cleanup has a fresh phase signal after body cancellation. It must be
          // able to inspect/delete owned records even when the run was cancelled.
          signal: AbortSignal.any([timed.signal, signal ?? controller.signal]),
          headers: { ...(role ? { Cookie: payload.cookies[role] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.status === 204) return { status: 204, body: null };
        const reader = response.body?.getReader(); if (!reader) throw fixed();
        let length = 0; const chunks = [];
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 64 * 1024) { await reader.cancel(); throw fixed(); }
          chunks.push(Buffer.from(value));
        }
        return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      } catch { throw fixed(); }
      finally { clearTimeout(timer); }
    };
    const context = {
      driver, identities: payload.identities, api, waitText,
      async loadRole(role, signal) {
        if (!['editor', 'reviewer'].includes(role) || signal?.aborted) throw fixed();
        const activeDriver = driver.withSignal(signal);
        await activeDriver.click('sign-out'); await waitText('session-status', 'signed-out', signal);
        await rpc({ type: 'load-role', role });
        await activeDriver.click('load-session'); await waitText('session-status', 'ready', signal);
        await waitText('identity-email', payload.identities[role].email, signal);
        await waitText('identity-role', payload.identities[role].role, signal);
        await rpc({ type: 'bootstrap-consumed' });
      },
      ownership: {
        intent: (caseId, marker) => rpc({ type: 'intent', caseId, marker }),
        record: (caseId, marker, id) => rpc({ type: 'record', caseId, marker, id }),
        remove: caseId => rpc({ type: 'remove', caseId }),
      },
    };
    report = await runNativeCases({ plan, cases: createApprovalCases(), context, signal: controller.signal,
      timeoutMs: NATIVE_PROOF_BUDGETS.bodyMs, cleanupTimeoutMs: NATIVE_PROOF_BUDGETS.cleanupMs, settleTimeoutMs: NATIVE_PROOF_BUDGETS.settleMs });
  } catch (error) {
    // Only this local driver's known class and allowlisted code select a static
    // diagnosis. Raw errors, messages, response bodies and RPC payloads never do.
    const code = controller.signal.aborted ? 'NATIVE_RUN_CANCELLED' :
      DriverError && error instanceof DriverError && NATIVE_DRIVER_FAILURE_CODES.includes(error.code) ? error.code : 'NATIVE_DRIVER_FAILED';
    report = nativeFailureReport(plan, code);
  } finally {
    const unsettled = report?.cases.some(item => item.diagnostics.some(value => ['NATIVE_BODY_UNSETTLED', 'NATIVE_CLEANUP_UNSETTLED'].includes(value.code)));
    // An unsettled callback cannot safely race session close. The host stops this
    // worker immediately; the parent owns Appium/emulator shutdown and recovery.
    if (driver && !unsettled) try { await driver.close(); }
    catch { report = appendNativeRunFailure(report, 'NATIVE_DRIVER_CLEANUP_FAILED'); }
  }
  await send({ type: 'result', report });
}

process.on('message', message => {
  if (message?.type === 'cancel') { controller.abort(); return; }
  if (message?.type === 'response' && typeof message.id === 'string' && typeof message.ok === 'boolean') {
    pending.get(message.id)?.finish(message.ok); return;
  }
  if (message?.type !== 'start' || started) { controller.abort(); return; }
  started = true;
  main(message.payload).catch(() => { process.exitCode = 1; }).finally(() => {
    for (const request of pending.values()) request.finish(false);
    if (process.connected) process.disconnect(); process.channel?.unref();
  });
});
process.on('disconnect', () => { controller.abort(); for (const request of pending.values()) request.finish(false); });
process.on('SIGINT', () => controller.abort()); process.on('SIGTERM', () => controller.abort());
