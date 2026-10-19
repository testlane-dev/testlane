import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startDemoApp } from '../app.mjs';

function accounts() { return { editor: { email: 'editor@example.test', password: randomBytes(32).toString('base64url') },
  reviewer: { email: 'reviewer@example.test', password: randomBytes(32).toString('base64url') } }; }
async function login(app, account) {
  const response = await fetch(app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account) });
  assert.equal(response.status, 200);
  const header = response.headers.get('set-cookie');
  assert.ok(header.includes('HttpOnly') && header.includes('SameSite=Strict') && !header.includes('Domain='));
  return header.split(';')[0];
}
async function request(app, cookie, route, { method = 'GET', body } = {}) {
  return fetch(app.origin + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('local app enforces both roles, preserves full state on denial/conflict, and allows owned cleanup', async () => {
  const users = accounts(), app = await startDemoApp({ accounts: users });
  try {
    assert.equal(new URL(app.origin).hostname, '127.0.0.1'); assert.ok(Number(new URL(app.origin).port) > 0);
    const editor = await login(app, users.editor), reviewer = await login(app, users.reviewer);
    const me = await request(app, editor, '/api/me'); assert.deepEqual(await me.json(), { email: users.editor.email, role: 'Editor' });
    assert.equal((await request(app, undefined, '/api/requests')).status, 401);
    assert.equal((await request(app, reviewer, '/api/requests', { method: 'POST', body: { marker: 'owned-demo', quantity: 3, unitPriceCents: 1400 } })).status, 403);
    const created = await request(app, editor, '/api/requests', { method: 'POST', body: { marker: 'owned-demo', quantity: 3, unitPriceCents: 1400 } });
    assert.equal(created.status, 201); const before = await created.json();
    assert.deepEqual(Object.keys(before).sort(), ['approverEmail', 'id', 'marker', 'ownerEmail', 'quantity', 'status', 'totalCents', 'unitPriceCents', 'version']);
    assert.equal(before.totalCents, 4200); assert.equal(before.ownerEmail, users.editor.email);
    const route = '/api/requests/' + before.id;
    assert.equal((await request(app, editor, route + '/approve', { method: 'POST' })).status, 403);
    assert.deepEqual(await (await request(app, editor, route)).json(), before);
    assert.equal((await request(app, reviewer, route + '/approve', { method: 'POST' })).status, 200);
    const approved = { ...before, status: 'approved', approverEmail: users.reviewer.email, version: 2 };
    assert.deepEqual(await (await request(app, editor, route)).json(), approved);
    assert.equal((await request(app, reviewer, route + '/approve', { method: 'POST' })).status, 409);
    assert.deepEqual(await (await request(app, reviewer, route)).json(), approved);
    assert.equal((await request(app, reviewer, route, { method: 'DELETE' })).status, 403);
    const exposed = app.records(); exposed[0].totalCents = -1; assert.equal(app.records()[0].totalCents, 4200);
    assert.equal((await request(app, editor, route, { method: 'DELETE' })).status, 204);
    assert.equal((await request(app, editor, route)).status, 404); assert.equal(app.records().length, 0);
    assert.equal(app.issuedSessionTokens().length, 2);
  } finally { await app.close(); }
  assert.equal(app.records().length, 0); assert.equal(app.issuedSessionTokens().length, 0);
});

test('controller changes only newly calculated totals and exposes no HTTP defect/admin route', async () => {
  const users = accounts(), app = await startDemoApp({ accounts: users });
  try {
    const editor = await login(app, users.editor);
    for (const [index, defect] of [false, true, false].entries()) {
      app.setDefect(defect);
      const response = await request(app, editor, '/api/requests', { method: 'POST', body: { marker: 'owned-' + index, quantity: 3, unitPriceCents: 1400 } });
      const row = await response.json(); assert.equal(row.totalCents, defect ? 4199 : 4200);
      assert.equal((await request(app, editor, '/api/requests/' + row.id, { method: 'DELETE' })).status, 204);
      assert.equal(app.records().length, 0);
    }
    for (const route of ['/api/admin', '/api/defect', '/api/reset']) assert.equal((await request(app, editor, route, { method: 'POST' })).status, 404);
    const escaped = await fetch(app.origin + '/api/me', { headers: { Cookie: editor, Origin: 'https://outside.example.test' } });
    assert.equal(escaped.status, 403);
    const invalid = await request(app, editor, '/api/requests', { method: 'POST', body: { marker: 'invalid', quantity: -1, unitPriceCents: 1400 } });
    assert.equal(invalid.status, 400); assert.equal(app.records().length, 0);
  } finally { await app.close(); }
});

test('invalid account configuration is refused without binding a server', async () => {
  const shared = randomBytes(32).toString('base64url');
  await assert.rejects(startDemoApp({ accounts: { editor: { email: 'same@example.test', password: shared }, reviewer: { email: 'same@example.test', password: shared } } }), /DEMO_ACCOUNTS_INVALID/);
});
