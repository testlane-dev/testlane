import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runNativeWorker, validNativeWorkerRequest } from '../worker-host.mjs';
import { NATIVE_RUNNER, sanitizeNativeReport } from '../contracts.mjs';

const plan = () => ({ schemaVersion: 1, runner: NATIVE_RUNNER, status: 'reviewed', title: 'Disposable native workflow',
  target: { baseUrl: 'http://127.0.0.1:4555', environment: 'testing' }, app: { package: 'dev.testlane.androidproof', apkSha256: 'a'.repeat(64) },
  cases: [{ id: 'owned-request', title: 'Exact total', expected: ['Save the exact total'], cleanup: { required: true, description: 'Delete the owned record' } }] });
const fixture = fileURLToPath(new URL('./fixtures/worker-protocol.mjs', import.meta.url));
async function withWorker(mode, callback) {
  const original = childProcess.spawn; const children = [];
  childProcess.spawn = function (command, args, options) {
    const isWorker = args?.length === 1 && args[0].endsWith('android-verification' + (process.platform === 'win32' ? '\\' : '/') + 'worker.mjs');
    const child = original(command, isWorker ? [fixture, mode] : args, options);
    if (isWorker) children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  try { return await callback(children); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}
const input = () => {
  const secret = randomBytes(32).toString('base64url');
  return { plan: plan(), driverOptions: { url: 'http://127.0.0.1:4723', capabilities: {} }, origin: 'http://127.0.0.1:4555',
    identities: { editor: { email: secret + '@example.test', role: 'Editor' }, reviewer: { email: 'reviewer@example.test', role: 'Reviewer' } },
    cookies: { editor: 'owned=' + secret, reviewer: 'owned=other-generated-value' }, onRequest: async () => true, timeoutMs: 5000 };
};
const noSecrets = (report, value) => {
  const text = JSON.stringify(report), secret = value.cookies.editor;
  for (const canary of [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret), value.identities.editor.email]) assert.equal(text.includes(canary), false);
};

test('native worker request schemas allow only fixed operations and exact owned identifiers', () => {
  const p = plan(), marker = 'native-proof-' + randomUUID(), id = randomUUID();
  for (const request of [{ type: 'assert-owned' }, { type: 'bootstrap-consumed' }, { type: 'load-role', role: 'editor' },
    { type: 'intent', caseId: 'owned-request', marker }, { type: 'record', caseId: 'owned-request', marker, id }, { type: 'remove', caseId: 'owned-request' }]) assert.equal(validNativeWorkerRequest(request, p), true);
  for (const request of [{ type: 'assert-owned', raw: 'private' }, { type: 'load-role', role: 'administrator' },
    { type: 'intent', caseId: 'unknown', marker }, { type: 'record', caseId: 'owned-request', marker, id: '-'.repeat(36) },
    { type: 'intent', caseId: 'owned-request', marker: 'native-proof-' + '-'.repeat(36) }, { type: 'shell', command: 'private' }]) assert.equal(validNativeWorkerRequest(request, p), false);
  p.cases[0].cleanup.required = false;
  assert.equal(validNativeWorkerRequest({ type: 'remove', caseId: 'owned-request' }, p), false);
});

test('pre-cancelled workers do not spawn and normal fixed results require a clean worker exit', async () => {
  await withWorker('pass', async children => {
    const value = input(), controller = new AbortController(); controller.abort();
    const cancelled = await runNativeWorker({ ...value, signal: controller.signal });
    assert.equal(cancelled.report.verdict, 'cancelled'); assert.equal(children.length, 0);
    const result = await runNativeWorker(value);
    assert.equal(result.report.verdict, 'passed'); assert.equal(result.captured, ''); assert.equal(children.length, 1);
    assert.equal(children[0].exitCode, 0); assert.deepEqual(sanitizeNativeReport(result.report, value.plan), result.report); noSecrets(result.report, value);
  });
});

test('the real fixed-entry worker refuses invalid driver setup without exposing IPC credentials', async () => {
  const value = input(); let requests = 0;
  const result = await runNativeWorker({ ...value, onRequest: async () => { requests++; return true; } });
  assert.equal(result.report.verdict, 'blocked'); assert.deepEqual(result.report.reasonCodes, ['NATIVE_DRIVER_CONFIGURATION_INVALID']);
  assert.equal(requests, 0); assert.equal(result.captured, ''); noSecrets(result.report, value);
  assert.deepEqual(sanitizeNativeReport(result.report, value.plan), result.report);
});

test('a refused parent ownership check produces only its allowlisted static driver diagnosis', async () => {
  const value = input(); let requests = 0;
  value.driverOptions.capabilities = { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': 'emulator-5556',
    'appium:appPackage': 'dev.testlane.androidproof', 'appium:remoteAdbHost': '127.0.0.1', 'appium:adbPort': 5039, 'appium:systemPort': 8211,
    'appium:skipLogcatCapture': true, 'appium:suppressKillServer': true, 'appium:printPageSourceOnFindFailure': false };
  const result = await runNativeWorker({ ...value, onRequest: async request => {
    requests++; assert.deepEqual(request, { type: 'assert-owned' }); throw new Error(value.cookies.editor);
  } });
  assert.equal(requests, 1); assert.equal(result.report.verdict, 'blocked');
  assert.deepEqual(result.report.reasonCodes, ['NATIVE_DRIVER_OWNERSHIP_REFUSED']);
  assert.equal(result.report.diagnostics[0].summary, 'The native driver could not confirm device ownership within its budget.');
  assert.equal(result.captured, ''); noSecrets(result.report, value);
  assert.deepEqual(sanitizeNativeReport(result.report, value.plan), result.report);
});

test('a nonzero exit or a hanging worker cannot turn its claimed passing result into acceptance', async () => {
  for (const mode of ['bad-exit', 'hang-after-result']) await withWorker(mode, async children => {
    const value = input(), before = Date.now(), result = await runNativeWorker(value);
    assert.notEqual(result.report.verdict, 'passed'); assert.ok(result.report.reasonCodes.includes('NATIVE_WORKER_FAILED'));
    assert.ok(Date.now() - before < 10_000); assert.equal(children[0].exitCode === null && children[0].signalCode === null, false); noSecrets(result.report, value);
  });
});

test('malformed reports and unknown IPC fields are refused without copying private payloads', async () => {
  for (const mode of ['malformed', 'bad-request']) await withWorker(mode, async () => {
    const value = input(); let calls = 0;
    const result = await runNativeWorker({ ...value, onRequest: async () => { calls++; return true; } });
    assert.equal(result.report.verdict, 'blocked'); assert.ok(result.report.reasonCodes.includes('NATIVE_WORKER_PROTOCOL_INVALID'));
    assert.equal(calls, 0); noSecrets(result.report, value); assert.equal(result.captured, '');
  });
});

test('parent RPC calls require explicit acknowledgement and finish before a result is accepted', async () => {
  await withWorker('rpc-clean', async () => {
    const value = input(); let ended = false;
    const result = await runNativeWorker({ ...value, onRequest: async request => { assert.deepEqual(request, { type: 'assert-owned' }); await delay(40); ended = true; return true; } });
    assert.equal(ended, true); assert.equal(result.report.verdict, 'passed');
    const refused = await runNativeWorker({ ...value, onRequest: async () => undefined });
    assert.notEqual(refused.report.verdict, 'passed');
  });
  await withWorker('rpc-then-pass', async () => {
    const value = input(); let ended = false;
    const result = await runNativeWorker({ ...value, onRequest: async () => { await delay(100); ended = true; return true; } });
    assert.equal(ended, true); assert.ok(result.report.reasonCodes.includes('NATIVE_WORKER_PROTOCOL_INVALID')); noSecrets(result.report, value);
  });
});

test('outer timeout and an unsettled body stop the owned worker with unknown cleanup', async () => {
  for (const mode of ['timeout', 'unsettled']) await withWorker(mode, async children => {
    // Only the timeout fixture exercises a short outer budget. The unsettled
    // fixture must first start and send its result, including on loaded runners.
    const value = input(), result = await runNativeWorker({ ...value, timeoutMs: mode === 'timeout' ? 300 : 5000 });
    assert.equal(result.report.verdict, 'blocked'); assert.equal(result.report.cases[0].cleanup.status, 'unknown');
    assert.ok(result.report.reasonCodes.includes(mode === 'timeout' ? 'NATIVE_WORKER_TIMEOUT' : 'NATIVE_BODY_UNSETTLED'));
    assert.equal(children[0].exitCode === null && children[0].signalCode === null, false); noSecrets(result.report, value);
  });
});

test('the external budget stops a worker whose synchronous code blocks its event loop', async () => {
  await withWorker('sync-block', async children => {
    const value = input(), before = Date.now(), result = await runNativeWorker({ ...value, timeoutMs: 1500 });
    assert.equal(result.captured, 'native-worker-entering-block\n');
    assert.ok(Date.now() - before < 10_000);
    assert.equal(result.report.verdict, 'blocked'); assert.deepEqual(result.report.reasonCodes, ['NATIVE_WORKER_TIMEOUT']);
    assert.equal(result.report.cases[0].cleanup.status, 'unknown');
    assert.equal(children[0].exitCode === null && children[0].signalCode === null, false); noSecrets(result.report, value);
  });
});

test('mid-run cancellation and output overflow remain fixed failures and stop the worker', async () => {
  await withWorker('honor-cancel', async children => {
    const value = input(), controller = new AbortController();
    const pending = runNativeWorker({ ...value, signal: controller.signal });
    await delay(100); controller.abort(); const result = await pending;
    assert.equal(result.report.verdict, 'cancelled'); assert.equal(children[0].exitCode, 0); noSecrets(result.report, value);
  });
  await withWorker('output', async () => {
    const value = input(), result = await runNativeWorker(value);
    assert.equal(result.report.verdict, 'blocked'); assert.ok(result.report.reasonCodes.includes('NATIVE_WORKER_OUTPUT_LIMIT'));
    assert.ok(Buffer.byteLength(result.captured) <= 256 * 1024); noSecrets(result.report, value);
  });
});
