/** Case-contract unit tests with a synthetic driver, not Android acceptance evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalCases } from '../proof-cases.mjs';
import { NativeVerificationError } from '../contracts.mjs';
import { NativeDriverError } from '../driver.mjs';

function context({ brokenTotal = false, mutateDenial = false } = {}) {
  const identities = { editor: { email: 'editor@example.test', role: 'Editor' }, reviewer: { email: 'reviewer@example.test', role: 'Reviewer' } };
  const rows = new Map(), journals = new Map(), clicks = [], scopes = [], values = new Map(), inputs = new Map();
  let role, pending, reads = 0, keyboardHides = 0;
  const api = async (account, method, route, body) => {
    if (!account) return { status: 401 };
    if (route === '/api/me') return { status: 200, body: { ...identities[account] } };
    if (route === '/api/requests' && method === 'GET') return { status: 200, body: [...rows.values()].map(row => ({ ...row })) };
    if (route === '/api/requests' && method === 'POST') {
      const row = { id: '01234567-0123-4123-8123-012345678901', marker: body.marker, ownerEmail: identities.editor.email,
        quantity: body.quantity, unitPriceCents: body.unitPriceCents, totalCents: brokenTotal ? 4199 : 4200,
        status: 'draft', approverEmail: null, version: 1 };
      rows.set(row.id, row); return { status: 201, body: { ...row } };
    }
    const id = route.split('/')[3], row = rows.get(id);
    if (!row) return { status: 404 };
    if (method === 'GET') return { status: 200, body: { ...row } };
    if (method === 'DELETE') { rows.delete(id); return { status: 204 }; }
    if (route.endsWith('/approve')) {
      if (account === 'editor') { if (mutateDenial) row.ownerEmail = 'unexpected-owner@example.test'; return { status: 403 }; }
      if (row.status === 'approved') return { status: 409 };
      row.status = 'approved'; row.approverEmail = identities.reviewer.email; row.version = 2;
      return { status: 200, body: { ...row } };
    }
    throw Error('UNIT_ROUTE_UNEXPECTED');
  };
  const display = row => {
    if (!row) return;
    for (const [key, value] of Object.entries({ id: row.id, total: row.totalCents, status: row.status })) values.set('request-' + key, String(value));
  };
  const settle = async () => {
    if (!pending || reads++ === 0) return;
    const operation = pending; pending = null;
    await operation();
  };
  const ctx = {
    identities, signal: new AbortController().signal, check: (actual, expected) => assert.deepEqual(actual, expected), api,
    async loadRole(selected) { role = selected; values.clear(); values.set('session-status', 'ready'); values.set('identity-email', identities[role].email); values.set('identity-role', identities[role].role); values.set('operation-status', 'SESSION_READY'); },
    ownership: {
      async intent(id, marker) { journals.set(id, { marker }); },
      async record(id, marker, recordId) { journals.set(id, { marker, id: recordId }); },
      async remove(id) { journals.delete(id); },
    },
    driver: {
      withSignal(signal) { assert.ok(signal instanceof AbortSignal); scopes.push(signal); return this; },
      async type(id, value) { inputs.set(id, value); },
      async hideKeyboard() { keyboardHides++; },
      async text(id) { await settle(); return values.get(id) ?? '-'; },
      async click(id) {
        clicks.push(id); reads = 0; values.set('operation-status', 'WORKING');
        pending = async () => {
          let result;
          if (id === 'create-request') result = await api(role, 'POST', '/api/requests', { marker: inputs.get('run-marker'), quantity: Number(inputs.get('quantity')), unitPriceCents: Number(inputs.get('unit-price')) });
          else if (id === 'load-request') result = await api(role, 'GET', '/api/requests/' + inputs.get('selected-id'));
          else if (id === 'approve-request') result = await api(role, 'POST', '/api/requests/' + inputs.get('selected-id') + '/approve');
          else if (id === 'anonymous-check') result = await api(null, 'GET', '/api/requests');
          else throw Error('UNIT_ACTION_UNEXPECTED');
          values.set('api-status', String(result.status)); values.set('operation-status', (id === 'anonymous-check' ? 'ANONYMOUS_HTTP_' : 'HTTP_') + result.status);
          display(result.body);
        };
      },
    },
  };
  return { ctx, rows, journals, clicks, scopes, keyboardHides: () => keyboardHides };
}

test('native total oracle catches 4199 only after UI settlement and owned-ID capture, then cleans up', async () => {
  const fixture = context({ brokenTotal: true }), item = createApprovalCases().find(value => value.id === 'editor-native-total');
  await assert.rejects(item.run(fixture.ctx), error => error.code === 'ERR_ASSERTION');
  assert.equal(fixture.journals.get(item.id)?.id, '01234567-0123-4123-8123-012345678901');
  assert.deepEqual(fixture.clicks, ['create-request']); assert.equal(fixture.keyboardHides(), 1);
  assert.equal(fixture.rows.size, 1);
  await item.cleanup(fixture.ctx); assert.equal(fixture.rows.size, 0); assert.equal(fixture.journals.size, 0);
});

test('denial checks compare ownership too, rather than accepting an unchanged amount alone', async () => {
  const fixture = context({ mutateDenial: true }), item = createApprovalCases().find(value => value.id === 'editor-cannot-approve');
  await assert.rejects(item.run(fixture.ctx), error => error.code === 'ERR_ASSERTION');
  assert.deepEqual(fixture.clicks, ['load-request', 'approve-request']); assert.equal(fixture.keyboardHides(), 1);
  await item.cleanup(fixture.ctx); assert.equal(fixture.rows.size, 0); assert.equal(fixture.journals.size, 0);
});

test('reviewer and duplicate cases wait for their exact results without replaying approval actions', async () => {
  for (const id of ['reviewer-native-approval', 'duplicate-approval-unchanged']) {
    const fixture = context(), item = createApprovalCases().find(value => value.id === id);
    await item.run(fixture.ctx);
    assert.equal(fixture.clicks.filter(value => value === 'approve-request').length, id === 'reviewer-native-approval' ? 1 : 2);
    await item.cleanup(fixture.ctx); assert.equal(fixture.rows.size, 0); assert.equal(fixture.journals.size, 0);
  }
});

test('anonymous case works from fresh UI state and does not create app data', async () => {
  const fixture = context(), item = createApprovalCases().find(value => value.id === 'anonymous-denied');
  await item.run(fixture.ctx);
  assert.deepEqual(fixture.clicks, ['anonymous-check']); assert.equal(fixture.rows.size, 0); assert.equal(fixture.journals.size, 0);
  assert.deepEqual(fixture.scopes, [fixture.ctx.signal]);
});

test('body and cleanup scope the shared driver to their distinct phase signals exactly once', async () => {
  const fixture = context(), item = createApprovalCases().find(value => value.id === 'editor-native-total');
  const body = new AbortController(), cleanup = new AbortController();
  await item.run({ ...fixture.ctx, signal: body.signal });
  body.abort();
  await item.cleanup({ ...fixture.ctx, signal: cleanup.signal });
  assert.deepEqual(fixture.scopes, [body.signal, cleanup.signal]);
  assert.equal(fixture.rows.size, 0); assert.equal(fixture.journals.size, 0);
});

test('UI polling propagates ownership, transport and cancellation failures after one read without replaying an action', async () => {
  for (const code of ['NATIVE_DRIVER_OWNERSHIP_REFUSED', 'NATIVE_DRIVER_COMMAND_FAILED', 'NATIVE_DRIVER_CANCELLED']) {
    const fixture = context(), item = createApprovalCases().find(value => value.id === 'anonymous-denied');
    const read = fixture.ctx.driver.text, error = new NativeDriverError(code); let reads = 0;
    fixture.ctx.driver.text = async id => {
      if (id === 'operation-status') { reads++; throw error; }
      return read(id);
    };
    await assert.rejects(item.run(fixture.ctx), actual => actual === error);
    assert.equal(reads, 1); assert.deepEqual(fixture.clicks, ['anonymous-check']);
    assert.equal(fixture.rows.size, 0); assert.equal(fixture.journals.size, 0);
  }
});

test('a value that never settles yields the fixed platform-neutral cause after the unchanged eight-second observation budget', async t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const fixture = context(), item = createApprovalCases().find(value => value.id === 'anonymous-denied');
  const read = fixture.ctx.driver.text; let reads = 0;
  fixture.ctx.driver.text = async id => {
    if (id === 'operation-status') { reads++; now += 8001; return 'private-unsettled-native-value'; }
    return read(id);
  };
  await assert.rejects(item.run(fixture.ctx), error => {
    assert.equal(Object.getPrototypeOf(error), NativeVerificationError.prototype);
    assert.equal(error.code, 'NATIVE_UI_SETTLEMENT_TIMEOUT'); assert.equal(String(error.stack).includes('private-unsettled-native-value'), false);
    return true;
  });
  assert.equal(reads, 1); assert.deepEqual(fixture.clicks, ['anonymous-check']); assert.equal(fixture.rows.size, 0);
});
