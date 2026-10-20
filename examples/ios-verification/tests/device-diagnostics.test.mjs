import test from 'node:test';
import assert from 'node:assert/strict';
import { iosPrewarmDiagnosticDue, verifyIosDiagnosticIdentity, iosPrewarmDiagnosticFailure, createIosDiagnosticPolicy } from '../device.mjs';

const state = () => ({ spawned: true, pid: 2345, child: { pid: 2345 }, exited: false, closed: false });
const info = () => ({ pid: 2345, ppid: 1234, pgid: 2345, zombie: false, started: 'Tue Oct 20 01:20:30 2026' });

test('sampler-only policy retains error-level Appium while standalone diagnostics preserves debug verbosity', () => {
  const normal = createIosDiagnosticPolicy(), sampler = createIosDiagnosticPolicy({ prewarmDiagnostics: true });
  assert.equal(normal.appiumLogLevel, 'error'); assert.equal(normal.beginPrewarm().canSample('owned-proof-app-prewarm'), false);
  assert.equal(sampler.appiumLogLevel, 'error'); assert.equal(sampler.beginPrewarm().canSample('owned-proof-app-prewarm'), true);
  assert.equal(iosPrewarmDiagnosticDue({ diagnostics: true, kind: 'owned-proof-app-prewarm', elapsedMs: 15000, state: state() }), true);
  for (const options of [{ diagnostics: true }, { diagnostics: true, prewarmDiagnostics: true }]) {
    const standalone = createIosDiagnosticPolicy(options);
    assert.equal(standalone.appiumLogLevel, 'debug'); assert.equal(standalone.beginPrewarm().canSample('owned-device-list'), true);
  }
  for (const value of ['true', null, 1, {}, []]) {
    assert.throws(() => createIosDiagnosticPolicy({ prewarmDiagnostics: value }), /IOS_DEVICE_INPUT_INVALID/);
    assert.throws(() => createIosDiagnosticPolicy({ diagnostics: value }), /IOS_DEVICE_INPUT_INVALID/);
  }
});

test('the prewarm diagnostic lease excludes concurrent use and stays consumed after every settlement outcome', async () => {
  for (const outcome of ['success', 'guard-failure', 'launch-failure', 'cancelled']) {
    const policy = createIosDiagnosticPolicy({ prewarmDiagnostics: true });
    const entered = Promise.withResolvers(), settle = Promise.withResolvers();
    let lease;
    const first = (async () => {
      lease = policy.beginPrewarm(); assert.equal(lease.canSample('owned-device-list'), true); entered.resolve();
      try {
        await settle.promise;
        if (outcome !== 'success') throw Error(outcome);
      } finally { policy.finishPrewarm(lease); }
    })();
    const result = outcome === 'success' ? first : assert.rejects(first, error => error.message === outcome);
    await entered.promise;
    const concurrent = policy.beginPrewarm();
    assert.equal(concurrent, undefined, 'a pending first prewarm cannot grant a second sampler');
    policy.finishPrewarm(concurrent);
    assert.equal(lease.canSample('owned-device-list'), true, 'a concurrent invocation cannot revoke the first lease');
    settle.resolve(); await result;
    assert.equal(policy.beginPrewarm(), undefined, 'success, refusal and cancellation never renew the permission');
    assert.equal(lease.claimSample('owned-device-list'), false, 'a retained token is revoked on every settlement path');
    assert.equal(lease.claimSample('owned-proof-app-prewarm'), false);
    policy.finishPrewarm(lease); assert.equal(policy.beginPrewarm(), undefined);
    assert.equal(policy.appiumLogLevel, 'error');
  }
});

test('only the first prewarm inventory and fixed launch can share one actual sample claim', async () => {
  for (const selected of ['owned-device-list', 'owned-proof-app-prewarm']) {
    const policy = createIosDiagnosticPolicy({ prewarmDiagnostics: true }), lease = policy.beginPrewarm();
    for (const kind of ['owned-device-list', 'owned-proof-app-prewarm']) {
      assert.equal(lease.canSample(kind), true, 'eligibility probes do not consume the actual sample claim');
    }
    for (const kind of ['runtime-list', 'owned-device-create', 'owned-device-boot', 'owned-app-install', 'loopback-listeners',
      'process-identity', 'owned-descendants', 'owned-process-group', 'owned-prewarm-stack-sample', 'other', undefined]) {
      assert.equal(lease.canSample(kind), false); assert.equal(lease.claimSample(kind), false);
    }
    const claims = await Promise.all([selected, selected === 'owned-device-list' ? 'owned-proof-app-prewarm' : 'owned-device-list']
      .map(kind => Promise.resolve().then(() => lease.claimSample(kind))));
    assert.deepEqual(claims, [true, false], 'inventory and launch cannot both cause actual sampling');
    assert.equal(lease.canSample('owned-device-list'), false); assert.equal(lease.canSample('owned-proof-app-prewarm'), false);
    assert.equal(lease.claimSample(selected), false, 'an unavailable/failed sample cannot be retried');
    policy.finishPrewarm(lease); assert.equal(policy.beginPrewarm(), undefined);
  }
});

test('sampling is due only for a still-live explicit pre-auth prewarm diagnostic after fifteen seconds', () => {
  const value = { diagnostics: true, kind: 'owned-proof-app-prewarm', elapsedMs: 15000, state: state() };
  assert.equal(iosPrewarmDiagnosticDue(value), true);
  assert.equal(iosPrewarmDiagnosticDue({ ...value, kind: 'owned-device-list' }), true);
  for (const change of [{ diagnostics: false }, { diagnostics: 'true' }, { kind: 'owned-device-boot' },
    { kind: 'owned-prewarm-stack-sample' }, { kind: 'other' }, { elapsedMs: 14999 }, { elapsedMs: NaN },
    { state: { ...state(), exited: true } }, { state: { ...state(), closed: true } },
    { state: { ...state(), spawned: false } }, { state: { ...state(), pid: 0 } }]) {
    assert.equal(iosPrewarmDiagnosticDue({ ...value, ...change }), false);
  }
});

test('the exact retained live command must match parent, group and start identity before it can be inspected', () => {
  const started = verifyIosDiagnosticIdentity(state(), info(), { ownerPid: 1234 });
  assert.equal(started, info().started);
  assert.equal(verifyIosDiagnosticIdentity(state(), info(), { ownerPid: 1234, started }), started);
  for (const change of [{ pid: 3456 }, { ppid: 9999 }, { pgid: 9999 }, { zombie: true },
    { started: 'Tue Oct 20 01:20:31 2026' }, { started: 'untrusted-native-text' }]) {
    assert.throws(() => verifyIosDiagnosticIdentity(state(), { ...info(), ...change }, { ownerPid: 1234, started }),
      error => error.message === 'IOS_PROCESS_OWNERSHIP_REFUSED' && !String(error.stack).includes('untrusted-native-text'));
  }
  for (const change of [{ child: { pid: 9999 } }, { exited: true }, { closed: true }, { spawned: false }]) {
    assert.throws(() => verifyIosDiagnosticIdentity({ ...state(), ...change }, info(), { ownerPid: 1234, started }), /IOS_PROCESS_OWNERSHIP_REFUSED/);
  }
});

test('unavailable diagnostic metadata contains only fixed codes and never raw native errors', () => {
  const privateText = 'untrusted-native-text';
  const error = Object.assign(Error(privateText), { raw: privateText, pid: 2345 });
  const result = iosPrewarmDiagnosticFailure(error);
  assert.deepEqual(result, { status: 'unavailable', code: 'IOS_PREAUTH_DIAGNOSTIC_FAILED' });
  assert.equal(JSON.stringify(result).includes(privateText), false); assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(iosPrewarmDiagnosticFailure(Error('IOS_PROCESS_STOP_UNCONFIRMED')), { status: 'unavailable', code: 'IOS_PROCESS_STOP_UNCONFIRMED' });
});
