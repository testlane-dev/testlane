import test from 'node:test';
import assert from 'node:assert/strict';
import { iosPrewarmDiagnosticDue, verifyIosDiagnosticIdentity, iosPrewarmDiagnosticFailure } from '../device.mjs';

const state = () => ({ spawned: true, pid: 2345, child: { pid: 2345 }, exited: false, closed: false });
const info = () => ({ pid: 2345, ppid: 1234, pgid: 2345, zombie: false, started: 'Tue Oct 20 01:20:30 2026' });

test('sampling is due only for a still-live explicit pre-auth prewarm diagnostic after fifteen seconds', () => {
  const value = { diagnostics: true, kind: 'owned-proof-app-prewarm', elapsedMs: 15000, state: state() };
  assert.equal(iosPrewarmDiagnosticDue(value), true);
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
