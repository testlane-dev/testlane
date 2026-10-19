/** Fixed-entry, bounded native worker host. All authentication travels over IPC. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativePlan, sanitizeNativeReport, nativeFailureReport, appendNativeRunFailure } from './contracts.mjs';

const ENTRY = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const MAX_IPC = 256 * 1024, MAX_OUTPUT = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));
export function validNativeWorkerRequest(value, plan) {
  if (!object(value) || typeof value.type !== 'string') return false;
  if (['assert-owned', 'bootstrap-consumed'].includes(value.type)) return exact(value, ['type']);
  if (value.type === 'load-role') return exact(value, ['type', 'role']) && ['editor', 'reviewer'].includes(value.role);
  if (!plan.cases.some(item => item.id === value.caseId && item.cleanup.required)) return false;
  if (value.type === 'remove') return exact(value, ['type', 'caseId']);
  if (typeof value.marker !== 'string' || !/^native-proof-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.marker)) return false;
  if (value.type === 'intent') return exact(value, ['type', 'caseId', 'marker']);
  return value.type === 'record' && exact(value, ['type', 'caseId', 'marker', 'id']) && typeof value.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id);
}
async function stopChild(child, closed) {
  if (!child || closed() || !child.pid) return true;
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot ?? process.env.windir;
    if (system && path.isAbsolute(system)) await new Promise(resolve => {
      const killer = spawn(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      let done = false;
      const finish = code => { if (done) return; done = true; clearTimeout(timer); if (code !== 0 && !closed()) child.kill('SIGKILL'); resolve(); };
      const timer = setTimeout(() => { killer.kill(); finish(null); }, 3000);
      killer.once('error', () => finish(null)); killer.once('close', finish);
    });
    else child.kill('SIGKILL');
  } else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  if (closed()) return true;
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(true); };
    const timer = setTimeout(() => { child.off('close', finish); resolve(false); }, 5000);
    child.once('close', finish); if (closed()) finish();
  });
}
export async function runNativeWorker({ plan: input, driverOptions, identities, origin, cookies, onRequest, signal, timeoutMs = 360_000 } = {}) {
  const plan = validateNativePlan(input);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || typeof onRequest !== 'function') {
    return { report: nativeFailureReport(plan, 'NATIVE_CONFIGURATION_INVALID'), captured: '' };
  }
  if (signal?.aborted) return { report: nativeFailureReport(plan, 'NATIVE_RUN_CANCELLED'), captured: '' };
  const payload = { plan, driverOptions, identities, origin, cookies };
  try { if (Buffer.byteLength(JSON.stringify(payload)) > MAX_IPC) throw new Error(); }
  catch { return { report: nativeFailureReport(plan, 'NATIVE_CONFIGURATION_INVALID'), captured: '' }; }
  return new Promise(resolve => {
    let child, captured = '', outputBytes = 0, closed = false, exitCode, finishing = false, done = false, budget, grace;
    const requestIds = new Set(), activeRequests = new Set();
    const complete = async (report, force = false) => {
      if (finishing || done) return; finishing = true; clearTimeout(budget); clearTimeout(grace); signal?.removeEventListener('abort', cancel);
      let stopped;
      try {
        if (!force && child && !closed) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(); };
          const timer = setTimeout(finish, 2000);
          child.once('close', finish); if (closed) finish();
        });
        // A returned report does not excuse a worker that hangs or exits badly.
        if (!force && child && (!closed || exitCode !== 0)) report = appendNativeRunFailure(report, 'NATIVE_WORKER_FAILED');
        stopped = await stopChild(child, () => closed);
      } catch { stopped = false; }
      if (!stopped) {
        report = appendNativeRunFailure(report, 'NATIVE_WORKER_TERMINATION_UNCONFIRMED');
        child?.stdout?.destroy(); child?.stderr?.destroy(); if (child?.connected) child.disconnect(); child?.unref();
      }
      // Await the actual parent callback, not just its RPC response timeout. A
      // callback may still be completing an owned ADB operation after cancellation.
      if (activeRequests.size) {
        let timer;
        const settled = await Promise.race([Promise.allSettled([...activeRequests]).then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 25_000); })]);
        clearTimeout(timer);
        if (!settled) report = appendNativeRunFailure(report, 'NATIVE_WORKER_RPC_UNSETTLED');
      }
      if (signal?.aborted && !report.reasonCodes.includes('NATIVE_RUN_CANCELLED')) report = appendNativeRunFailure(report, 'NATIVE_RUN_CANCELLED');
      let safe;
      try { safe = sanitizeNativeReport(report, plan); } catch { safe = nativeFailureReport(plan, 'NATIVE_WORKER_PROTOCOL_INVALID'); }
      done = true; resolve({ report: safe, captured });
    };
    const refuse = code => complete(nativeFailureReport(plan, code), true);
    const cancel = () => {
      if (finishing || done || grace) return;
      if (child?.connected) child.send({ type: 'cancel' }, () => {});
      grace = setTimeout(() => refuse('NATIVE_RUN_CANCELLED'), 30_000);
    };
    try {
      const env = { ...process.env, DEBUG: '', NODE_DEBUG: '', PWDEBUG: '' }; delete env.NODE_OPTIONS;
      child = spawn(process.execPath, [ENTRY], { cwd: path.dirname(ENTRY), env, windowsHide: true, shell: false,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', value => {
        outputBytes += value.length;
        if (outputBytes > MAX_OUTPUT) void refuse('NATIVE_WORKER_OUTPUT_LIMIT');
        else captured += value.toString('utf8');
      });
      child.on('message', message => {
        if (finishing || done) return;
        let size; try { size = Buffer.byteLength(JSON.stringify(message)); } catch { void refuse('NATIVE_WORKER_PROTOCOL_INVALID'); return; }
        if (size > MAX_IPC) { void refuse('NATIVE_WORKER_PROTOCOL_INVALID'); return; }
        if (exact(message, ['type', 'report']) && message.type === 'result') {
          let report;
          try { report = sanitizeNativeReport(message.report, plan); } catch { void refuse('NATIVE_WORKER_PROTOCOL_INVALID'); return; }
          if (activeRequests.size) { void refuse('NATIVE_WORKER_PROTOCOL_INVALID'); return; }
          const unsettled = report.cases.some(item => item.diagnostics.some(value => /_UNSETTLED$/.test(value.code)));
          void complete(report, unsettled); return;
        }
        if (!exact(message, ['type', 'id', 'request']) || message.type !== 'request' || typeof message.id !== 'string' ||
          !/^rpc-[0-9]{1,6}$/.test(message.id) || requestIds.has(message.id) || requestIds.size >= 2048 || !validNativeWorkerRequest(message.request, plan)) {
          void refuse('NATIVE_WORKER_PROTOCOL_INVALID'); return;
        }
        requestIds.add(message.id);
        const operation = Promise.resolve().then(() => onRequest(structuredClone(message.request)));
        activeRequests.add(operation);
        operation.then(() => activeRequests.delete(operation), () => activeRequests.delete(operation));
        void (async () => {
          let timer, ok = false;
          try { ok = (await Promise.race([operation,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 20_000); })])) === true; }
          catch {} finally { clearTimeout(timer); }
          if (!finishing && !done && child.connected) child.send({ type: 'response', id: message.id, ok }, () => {});
        })();
      });
      child.once('error', () => { void refuse('NATIVE_WORKER_FAILED'); });
      child.once('close', code => { closed = true; exitCode = code; if (!finishing) void refuse(signal?.aborted ? 'NATIVE_RUN_CANCELLED' : 'NATIVE_WORKER_FAILED'); });
      child.once('spawn', () => { child.send({ type: 'start', payload }, error => { if (error) void refuse('NATIVE_WORKER_FAILED'); }); });
      budget = setTimeout(() => refuse('NATIVE_WORKER_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    } catch { void refuse('NATIVE_WORKER_FAILED'); }
  });
}
