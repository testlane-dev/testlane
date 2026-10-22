import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { iosListenerQuery, queryIosListeners, validateIosListenerSnapshot } from '../device.mjs';

const ports = [8511, 8512, 8513];
const snapshot = addresses => ({ code: 0, stdout: addresses.map((address, index) => 'p' + (2000 + index) + '\nn' + address + '\n').join(''), stderr: '' });
const local = port => '127.0.0.1:' + port;

test('one fresh fixed lsof query covers all three exact ports without hiding wildcard or foreign binds', async () => {
  const expected = ['-nP', '-a', '-iTCP:8511,8512,8513', '-sTCP:LISTEN', '-Fpn'];
  assert.deepEqual(iosListenerQuery(ports), expected);
  assert.equal(expected.filter(arg => arg.startsWith('-i')).length, 1,
    'one original search argument groups optional port derivations in Apple lsof exit-status handling');
  const calls = [];
  const run = async (...args) => { calls.push(args); return snapshot(ports.map(local)); };
  await queryIosListeners(run, ports); await queryIosListeners(run, ports);
  assert.equal(calls.length, 2, 'each check takes a new snapshot, never caches an earlier result');
  for (const call of calls) assert.deepEqual(call, ['/usr/sbin/lsof', expected, { ignoreSignal: false }]);
});

test('Appium remains mandatory while WDA and MJPEG may be absent before a session', () => {
  for (const visible of [[ports[0]], ports.slice(0, 2), [ports[0], ports[2]], ports]) {
    assert.equal(validateIosListenerSnapshot(snapshot(visible.map(local)), ports), true);
  }
  assert.throws(() => validateIosListenerSnapshot(snapshot(ports.slice(1).map(local)), ports), { message: 'IOS_APPIUM_STOPPED' });
  assert.throws(() => validateIosListenerSnapshot({ code: 1, stdout: '', stderr: '' }, ports), { message: 'IOS_APPIUM_STOPPED' });
});

test('all selected ports must be absent during cleanup and failed/ambiguous queries cannot prove absence', async () => {
  const calls = [];
  assert.equal(await queryIosListeners(async (...args) => { calls.push(args); return { code: 1, stdout: '', stderr: '' }; }, ports, { absent: true }), true);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][2], { ignoreSignal: true });
  for (const result of [snapshot([local(ports[0])]), snapshot([local(ports[1])]), snapshot([local(ports[2])]),
    { code: 0, stdout: '', stderr: '' }, { code: 2, stdout: '', stderr: '' }, { code: 1, stdout: 'p2000\n', stderr: '' }]) {
    assert.throws(() => validateIosListenerSnapshot(result, ports, { absent: true }), { message: 'IOS_LISTENER_STOP_UNCONFIRMED' });
  }
});

test('wildcard, IPv6, foreign or extra addresses are refused rather than filtered away', () => {
  const secret = randomBytes(32).toString('base64url');
  for (const address of ['*:' + ports[0], '0.0.0.0:' + ports[1], '[::1]:' + ports[2], '[::]:' + ports[0],
    '127.0.0.2:' + ports[0], '127.0.0.1:9999', 'localhost:' + ports[0], secret]) {
    assert.throws(() => validateIosListenerSnapshot(snapshot([local(ports[0]), address]), ports), error =>
      error.message === 'IOS_LISTENER_BINDING_REFUSED' && !error.message.includes(secret));
  }
  for (const result of [{ code: 0, stdout: 'p2000\n', stderr: '' }, { code: 1, stdout: 'n' + local(ports[0]), stderr: '' }, { code: 2, stdout: secret, stderr: '' }]) {
    assert.throws(() => validateIosListenerSnapshot(result, ports), { message: 'IOS_LISTENER_BINDING_REFUSED' });
  }
});

test('stderr or malformed command output cannot establish live binding or cleanup absence', () => {
  const secret = randomBytes(32).toString('base64url');
  for (const stderr of [secret, ' ', '\n']) {
    const absent = { code: 1, stdout: '', stderr };
    assert.throws(() => validateIosListenerSnapshot(absent, ports, { absent: true }),
      { message: 'IOS_LISTENER_STOP_UNCONFIRMED' });
    assert.throws(() => validateIosListenerSnapshot(absent, ports), { message: 'IOS_LISTENER_BINDING_REFUSED' });
    assert.throws(() => validateIosListenerSnapshot({ ...snapshot([local(ports[0])]), stderr }, ports),
      error => error.message === 'IOS_LISTENER_BINDING_REFUSED' && !error.message.includes(secret));
  }
  for (const result of [{ code: 1, stdout: '' }, { code: 1, stdout: '', stderr: null },
    { code: 1, stdout: null, stderr: '' }]) {
    assert.throws(() => validateIosListenerSnapshot(result, ports, { absent: true }),
      { message: 'IOS_LISTENER_STOP_UNCONFIRMED' });
  }
});

test('malformed port selections refuse before starting any command', async () => {
  let calls = 0;
  for (const selected of [[], [8511, 8512], [8511, 8511, 8512], [8511, '8512', 8513], [8511, 0, 8513], [8511, 65536, 8513]]) {
    await assert.rejects(queryIosListeners(async () => { calls++; }, selected), { message: 'IOS_LISTENER_BINDING_REFUSED' });
  }
  assert.equal(calls, 0);
});
