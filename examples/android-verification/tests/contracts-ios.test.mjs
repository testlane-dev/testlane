import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { runNativeCases } from '../runner.mjs';
import { IOS_NATIVE_RUNNER, NATIVE_RUNNER, NATIVE_LIMITS, NATIVE_PLAN_SCHEMA, nativeLimits, nativeDiagnostic,
  validateNativePlan, nativeFailureReport, appendNativeRunFailure, sanitizeNativeReport } from '../contracts.mjs';
import { runNativeWorker } from '../worker-host.mjs';
import { IOS_DEVICE_SCOPE } from '../../ios-verification/device-scope.mjs';

const binding = () => ({ schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome: '/Users/runner',
  deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
  udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) });

const plan = () => ({ schemaVersion: 1, runner: IOS_NATIVE_RUNNER, status: 'reviewed', title: 'Synthetic native approval',
  target: { baseUrl: 'http://127.0.0.1:4555', environment: 'testing' }, app: { bundleId: 'dev.testlane.iosproof', buildSha256: 'b'.repeat(64) },
  cases: [{ id: 'native-total', title: 'Exact saved total', expected: ['The saved total is correct'], cleanup: { required: true, description: 'Remove the owned record' } }] });
const passing = () => ({ id: 'native-total', run: ({ check }) => check(4200, 4200), cleanup: ({ check }) => check([], []) });

test('iOS plans have real bundle/build fields and cannot mix Android app fields or runners', () => {
  assert.deepEqual(validateNativePlan(plan()), plan());
  for (const mutate of [p => { p.app.package = 'dev.testlane.iosproof'; }, p => { p.app.apkSha256 = p.app.buildSha256; },
    p => { p.app = { package: 'dev.testlane.iosproof', apkSha256: 'b'.repeat(64) }; }, p => { p.runner = 'maestro'; },
    p => { p.app.bundleId = '../private'; }, p => { p.app.bundleId = 'device'; }, p => { p.app.buildSha256 = 'unknown'; },
    p => { p.target.environment = 'production'; }, p => { p.target.baseUrl = 'https://example.test'; }]) {
    const value = plan(); mutate(value); assert.throws(() => validateNativePlan(value), /^NativeVerificationError: NATIVE_/);
  }
  assert.equal(NATIVE_PLAN_SCHEMA.oneOf.length, 2);
  const android = plan(); android.runner = NATIVE_RUNNER; android.app = { package: 'dev.testlane.androidproof', apkSha256: 'a'.repeat(64) };
  assert.deepEqual(nativeLimits(android), NATIVE_LIMITS);
  assert.equal(nativeDiagnostic('NATIVE_DRIVER_SESSION_TIMEOUT').summary, 'Native session creation exceeded its 120-second setup budget.');
  assert.equal(nativeDiagnostic('NATIVE_DRIVER_SESSION_TIMEOUT', IOS_NATIVE_RUNNER).summary, 'Native session creation exceeded its 240-second setup budget.');
});

test('one shared runner and report sanitizer bind outcomes, limits and diagnoses to the reviewed platform', async () => {
  const input = plan(), report = await runNativeCases({ plan: input, cases: [passing()] });
  assert.equal(report.runner, IOS_NATIVE_RUNNER); assert.equal(report.verdict, 'passed');
  assert.ok(report.limits[0].includes('iOS Simulator')); assert.equal(report.limits[0].includes('Android'), false);
  assert.deepEqual(sanitizeNativeReport(report, input), report);
  for (const mutate of [r => { r.runner = NATIVE_RUNNER; }, r => { r.limits = [...NATIVE_LIMITS]; },
    r => { r.error = 'private'; }, r => { r.cases[0].cleanup.status = 'unknown'; }]) {
    const value = structuredClone(report); mutate(value); assert.throws(() => sanitizeNativeReport(value, input), { code: 'NATIVE_REPORT_INVALID' });
  }
  const failed = appendNativeRunFailure(report, 'NATIVE_DRIVER_SESSION_TIMEOUT');
  assert.equal(failed.verdict, 'blocked'); assert.ok(failed.diagnostics[0].summary.includes('240-second'));
  assert.deepEqual(sanitizeNativeReport(failed, input), failed);
  assert.deepEqual(sanitizeNativeReport(nativeFailureReport(input, 'NATIVE_DRIVER_CONFIGURATION_INVALID'), input).runner, IOS_NATIVE_RUNNER);
});

test('iOS retains caught-assertion, required-cleanup, exact-mapping and cancellation failures without raw payloads', async () => {
  const input = plan(), secret = randomBytes(32).toString('base64url');
  input.title = secret;
  const report = await runNativeCases({ plan: input, context: { secret }, cases: [{ id: 'native-total',
    run: ({ check }) => { try { check(secret, 'different'); } catch {} }, cleanup: ({ check }) => check([], []) }] });
  assert.equal(report.verdict, 'failed'); assert.equal(report.cases[0].reason, 'NATIVE_ASSERTION_FAILED');
  assert.equal(report.cases[0].cleanup.status, 'completed'); assert.deepEqual(sanitizeNativeReport(report, input), report);
  for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(JSON.stringify(report).includes(value), false);
  const missing = await runNativeCases({ plan: input, cases: [{ id: 'native-total', run: () => {} }] });
  assert.equal(missing.runner, IOS_NATIVE_RUNNER); assert.deepEqual(missing.reasonCodes, ['NATIVE_CLEANUP_REQUIRED']);
  const mismatch = await runNativeCases({ plan: input, cases: [{ ...passing(), skip: true }] });
  assert.deepEqual(mismatch.reasonCodes, ['NATIVE_CASE_MAPPING_INVALID']);
  const controller = new AbortController(); controller.abort();
  const cancelled = await runNativeCases({ plan: input, cases: [passing()], signal: controller.signal });
  assert.equal(cancelled.verdict, 'cancelled'); assert.equal(cancelled.runner, IOS_NATIVE_RUNNER);
  assert.deepEqual(sanitizeNativeReport(cancelled, input), cancelled);
});

test('fixed shared worker chooses iOS driver and refuses configuration before parent/device operations', async () => {
  const input = plan(), secret = randomBytes(32).toString('base64url'); let calls = 0;
  const result = await runNativeWorker({ plan: input, origin: input.target.baseUrl,
    driverOptions: { url: 'http://127.0.0.1:4723', capabilities: { 'appium:bundleId': input.app.bundleId } },
    identities: { editor: { email: 'editor@example.test', role: 'Editor' }, reviewer: { email: 'reviewer@example.test', role: 'Reviewer' } },
    cookies: { editor: 'owned=' + secret, reviewer: 'owned=other-generated-value' }, onRequest: async () => { calls++; return true; }, timeoutMs: 10_000 });
  assert.equal(calls, 0); assert.equal(result.captured, ''); assert.equal(result.report.runner, IOS_NATIVE_RUNNER);
  assert.deepEqual(result.report.reasonCodes, ['NATIVE_CONFIGURATION_INVALID']);
  assert.equal(JSON.stringify(result.report).includes(secret), false);
  assert.deepEqual(sanitizeNativeReport(result.report, input), result.report);
});

test('shared worker preserves explicit parent ownership ACKs and recognizes only the chosen iOS driver error class', async () => {
  const input = plan(), secret = randomBytes(32).toString('base64url'); let http = 0, parent = 0;
  const server = createServer((request, response) => { http++; response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ value: { error: 'unknown error', message: secret } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const capabilities = { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': 'FA001122-3344-5566-7788-9900AABBCCDD',
    'appium:bundleId': input.app.bundleId, 'appium:simulatorDevicesSetPath': binding().deviceSetPath,
    'appium:derivedDataPath': '/private/tmp/tld-ios-abc123/derived-data', 'appium:wdaLocalPort': 8211, 'appium:wdaRemotePort': 8211, 'appium:mjpegServerPort': 8212,
    'appium:wdaBindingIP': '127.0.0.1', 'appium:wdaBaseUrl': 'http://127.0.0.1', 'appium:skipLogCapture': true,
    'appium:showIOSLog': false, 'appium:showXcodeLog': false, 'appium:printPageSourceOnFindFailure': false,
    'appium:disableAutomaticScreenshots': true, 'appium:shutdownOtherSimulators': false, 'appium:resetLocationService': false, 'appium:noReset': true };
  const options = { plan: input, origin: input.target.baseUrl, driverOptions: { url: 'http://127.0.0.1:' + server.address().port, deviceBinding: binding(), capabilities },
    identities: { editor: { email: 'editor@example.test', role: 'Editor' }, reviewer: { email: 'reviewer@example.test', role: 'Reviewer' } },
    cookies: { editor: 'owned=' + secret, reviewer: 'owned=other-generated-value' }, timeoutMs: 10_000 };
  try {
    const result = await runNativeWorker({ ...options, onRequest: async request => { parent++; assert.deepEqual(request, { type: 'assert-owned' }); return true; } });
    assert.equal(parent, 1); assert.equal(http, 1); assert.deepEqual(result.report.reasonCodes, ['NATIVE_DRIVER_COMMAND_FAILED']);
    assert.equal(result.report.runner, IOS_NATIVE_RUNNER); assert.equal(result.captured, '');
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(JSON.stringify(result.report).includes(value), false);
    const refused = await runNativeWorker({ ...options, onRequest: async () => false });
    assert.deepEqual(refused.report.reasonCodes, ['NATIVE_DRIVER_OWNERSHIP_REFUSED']); assert.equal(http, 1);
    const mismatched = await runNativeWorker({ ...options, driverOptions: { ...options.driverOptions, capabilities: { ...capabilities, 'appium:bundleId': 'dev.testlane.other' } },
      onRequest: async () => { assert.fail('mismatched plan must be refused before ownership or network'); } });
    assert.deepEqual(mismatched.report.reasonCodes, ['NATIVE_DRIVER_CONFIGURATION_INVALID']); assert.equal(http, 1);
    const unbound = await runNativeWorker({ ...options, driverOptions: { ...options.driverOptions, deviceBinding: { ...binding(), nonce: 'bad' } },
      onRequest: async () => { assert.fail('invalid binding is refused before spawning/contact'); } });
    assert.deepEqual(unbound.report.reasonCodes, ['NATIVE_CONFIGURATION_INVALID']); assert.equal(http, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
