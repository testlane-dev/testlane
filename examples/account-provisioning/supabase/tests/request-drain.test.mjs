import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequestDrain } from '../request-drain.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('closing the HTTP server does not finish shutdown until its in-flight handler has settled', async () => {
  const requests = createRequestDrain({ timeoutMs: 2000 }), started = gate(), finish = gate();
  const server = createServer((request, response) => {
    void requests.run(async () => { started.resolve(); await finish.promise; response.end('synthetic'); }).catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetching = fetch('http://127.0.0.1:' + server.address().port).catch(() => undefined);
  let closed = false;
  try {
    await started.promise;
    const stopping = requests.close(async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }).then(() => { closed = true; });
    await delay(25); assert.equal(closed, false);
    let laterAction = false;
    assert.throws(() => requests.run(() => { laterAction = true; }), { code: 'PROVISION_APP_CLOSED' });
    assert.equal(laterAction, false);
    finish.resolve(); await stopping; assert.equal(closed, true);
  } finally {
    finish.resolve(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fetching;
  }
});

test('an unsettled handler fails close with a fixed code and cannot reopen the request fence', async () => {
  const requests = createRequestDrain({ timeoutMs: 30 }), finish = gate();
  const pending = requests.run(() => finish.promise);
  let stops = 0;
  const stopping = requests.close(() => { stops++; });
  try {
    await assert.rejects(stopping, { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    assert.equal(requests.close(() => { stops++; }), stopping);
    assert.equal(stops, 1);
    assert.throws(() => requests.run(() => {}), { code: 'PROVISION_APP_CLOSED' });
  } finally { finish.resolve(); await pending; }
  await assert.rejects(stopping, { code: 'PROVISION_CLEANUP_INCOMPLETE' });
});

test('rejected requests settle without an unhandled cleanup task and do not expose their private failure', async () => {
  const requests = createRequestDrain(), finish = gate(), canary = randomBytes(32).toString('base64url');
  const pending = requests.run(async () => { await finish.promise; throw Error(canary); });
  const expectedFailure = pending.catch(() => undefined);
  const stopping = requests.close(() => {});
  finish.resolve(); await expectedFailure; await stopping;
});

test('stop failure is fixed and repeated close cannot repeat the stop mutation', async () => {
  const requests = createRequestDrain(), canary = randomBytes(32).toString('base64url');
  let stops = 0;
  const stopping = requests.close(() => { stops++; throw Error(canary); });
  await assert.rejects(stopping, error => error.code === 'PROVISION_CLEANUP_INCOMPLETE' && !String(error).includes(canary));
  assert.equal(requests.close(() => { stops++; }), stopping);
  assert.equal(stops, 1);
  assert.throws(() => requests.run(() => {}), { code: 'PROVISION_APP_CLOSED' });
});
