import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startProvisioningApp } from '../app.mjs';
import { createProvisioner } from '../controller.mjs';
import { emailFor, reviewedSyntheticPolicy, TTL_MS } from '../contracts.mjs';

async function fixture(options = {}) {
  let current = 1_000_000;
  const now = () => current, parent = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(parent, 'testlane-provision-unit-'));
  const app = await startProvisioningApp({ now, ...options });
  const foreign = { email: 'foreign@example.test', password: randomBytes(32).toString('base64url'), role: 'Editor' };
  app.seedForeign(foreign); const baseline = app.snapshot(), policy = reviewedSyntheticPolicy(app.target, 'a'.repeat(64));
  const root = path.join(directory, 'state'), manager = await createProvisioner({ app, root, policy, now });
  const credentials = new Map(), sink = credential => { credentials.set(credential.role, credential); };
  return { app, directory, root, manager, policy, credentials, sink, now, baseline, foreign,
    advance(value) { current = value; }, async run() { return manager.beginRun({ runId: randomUUID(), releaseId: policy.releaseId }); },
    async close() { await app.close(); const resolved = await realpath(directory); assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith('testlane-provision-unit-')); await rm(resolved, { recursive: true, force: true }); } };
}
async function login(app, credential) {
  const result = await fetch(app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credential.email, password: credential.password }) });
  return { status: result.status, cookie: result.headers.get('set-cookie')?.split(';')[0] };
}
const request = (app, cookie, route) => fetch(app.origin + route, { headers: cookie ? { Cookie: cookie } : {} });
const unchanged = f => assert.deepEqual(f.app.snapshot().filter(item => item.owner === null), f.baseline);

test('creates dedicated live roles, denies the inverse permission, and invalidates old sessions before server close', async () => {
  const f = await fixture();
  try {
    const run = await f.run(), cookies = [];
    for (const role of ['Editor', 'Reviewer']) {
      const result = await f.manager.createAccount(run, role, f.sink);
      assert.equal(result.role, role); assert.equal(result.password, undefined);
      const signed = await login(f.app, f.credentials.get(role)); assert.equal(signed.status, 200); cookies.push(signed.cookie);
      assert.deepEqual(await (await request(f.app, signed.cookie, '/api/me')).json(), { email: emailFor(run.runId, role), role });
      assert.equal((await request(f.app, signed.cookie, '/api/editor-only')).status, role === 'Editor' ? 200 : 403);
      assert.equal((await request(f.app, signed.cookie, '/api/reviewer-only')).status, role === 'Reviewer' ? 200 : 403);
    }
    const foreign = await login(f.app, f.foreign); assert.equal(foreign.status, 200);
    assert.equal((await f.manager.cleanupRun(run)).cleanup, 'completed');
    for (const cookie of cookies) assert.equal((await request(f.app, cookie, '/api/me')).status, 401);
    for (const credential of f.credentials.values()) assert.equal((await login(f.app, credential)).status, 401);
    assert.equal((await request(f.app, foreign.cookie, '/api/me')).status, 200); unchanged(f);
    assert.deepEqual((await f.manager.snapshot()).operations.map(item => item.status), ['deleted', 'deleted']);
  } finally { await f.close(); }
});

test('strict policy refuses production, external targets, roles, delivery effects and unregistered adapters before directory creation', async () => {
  const f = await fixture();
  try {
    const mutations = [p => { p.enabled = false; }, p => { p.environment = 'production'; }, p => { p.roles.push('Admin'); },
      p => { p.effects.email = true; }, p => { p.effects.sms = true; }, p => { p.effects.billing = true; },
      p => { p.target.origin = 'https://production.example.test'; }, p => { p.providerKey = 'private'; }, p => { p.maxActiveAccounts = 1000; }];
    for (const [index, mutate] of mutations.entries()) {
      const policy = structuredClone(f.policy), root = path.join(f.directory, 'invalid-' + index); mutate(policy);
      await assert.rejects(createProvisioner({ app: f.app, root, policy, now: f.now }), /^ProvisionError: PROVISION_/);
      await assert.rejects(lstat(root), { code: 'ENOENT' });
    }
    await assert.rejects(createProvisioner({ app: { ...f.app }, root: path.join(f.directory, 'fake'), policy: f.policy }), { code: 'PROVISION_TARGET_REFUSED' });
    unchanged(f);
  } finally { await f.close(); }
});

test('public HTTP routes cannot create, enumerate, mutate roles, revoke or reset accounts', async () => {
  const f = await fixture();
  try {
    const run = await f.run(); await f.manager.createAccount(run, 'Editor', f.sink);
    const signed = await login(f.app, f.credentials.get('Editor'));
    for (const route of ['/api/accounts', '/api/users', '/api/create', '/api/admin', '/api/reset', '/api/revoke', '/api/auth/agent-handoff']) {
      for (const cookie of [undefined, signed.cookie]) {
        const result = await fetch(f.app.origin + route, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'Admin', email: 'attacker@example.test' }) }); assert.equal(result.status, 404);
      }
    }
    const extra = await fetch(f.app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f.credentials.get('Editor'), role: 'Admin' }) });
    assert.equal(extra.status, 400);
    const large = await fetch(f.app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(5000) }); assert.equal(large.status, 400);
    const escaped = await fetch(f.app.origin + '/api/me', { headers: { Cookie: signed.cookie, Origin: 'https://outside.example.test' } }); assert.equal(escaped.status, 403);
    assert.equal(f.app.snapshot().filter(item => item.owner !== null).length, 1); unchanged(f);
  } finally { await f.close(); }
});

test('replay, escalation, supplied ownership fields and different release/run handles never increase authority', async () => {
  const f = await fixture();
  try {
    const run = await f.run(); await f.manager.createAccount(run, 'Editor', f.sink);
    await assert.rejects(f.manager.createAccount(run, 'Editor', f.sink), { code: 'PROVISION_REPLAY_REFUSED' });
    for (const role of ['Admin', 'admin', { role: 'Editor', admin: true }]) await assert.rejects(f.manager.createAccount(run, role, f.sink), { code: 'PROVISION_ROLE_REFUSED' });
    for (const handle of [{ ...run, releaseId: 'b'.repeat(64) }, { ...run, targetId: randomUUID() }, { ...run, accountId: f.baseline[0].id }, { ...run, expiresAt: run.expiresAt + 1 }]) {
      await assert.rejects(f.manager.createAccount(handle, 'Reviewer', f.sink), { code: 'PROVISION_RUN_REFUSED' });
    }
    await f.manager.cleanupRun(run);
    await assert.rejects(f.manager.beginRun({ runId: run.runId, releaseId: f.policy.releaseId }), { code: 'PROVISION_REPLAY_REFUSED' });
    assert.equal(f.app.snapshot().length, 1); unchanged(f);
  } finally { await f.close(); }
});

test('target-wide active quota survives new run IDs, fresh coordinator directories and concurrent requests', async () => {
  const f = await fixture();
  try {
    const runs = [await f.run(), await f.run(), await f.run()];
    const results = await Promise.allSettled(runs.flatMap(run => ['Editor', 'Reviewer'].map(role => f.manager.createAccount(run, role, () => {}))));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 4);
    assert.ok(results.filter(item => item.status === 'rejected').every(item => item.reason.code === 'PROVISION_QUOTA_REFUSED'));
    assert.equal(f.app.snapshot().filter(item => item.owner !== null).length, 4);
    const other = path.join(f.directory, 'new-state');
    await assert.rejects(createProvisioner({ app: f.app, root: other, policy: f.policy, now: f.now }), { code: 'PROVISION_STATE_INVALID' });
    await assert.rejects(lstat(other), { code: 'ENOENT' });
    for (const run of runs) await f.manager.cleanupRun(run); unchanged(f);
  } finally { await f.close(); }
});

test('create-delete churn cannot reset the target rate limit; the adapter also refuses bypass attempts', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      const run = await f.run(); for (const role of ['Editor', 'Reviewer']) await f.manager.createAccount(run, role, () => {}); await f.manager.cleanupRun(run);
    }
    const run = await f.run(); await assert.rejects(f.manager.createAccount(run, 'Editor', () => {}), { code: 'PROVISION_QUOTA_REFUSED' });
    const prior = (await f.manager.snapshot()).operations[0].owner, runId = randomUUID();
    await assert.rejects(f.app.createOwned({ ...prior, runId, operationId: randomUUID(), email: emailFor(runId, 'Editor') }, randomBytes(32).toString('base64url')), { code: 'PROVISION_QUOTA_REFUSED' });
    assert.equal((await f.manager.snapshot()).operations.length, 10); unchanged(f);
  } finally { await f.close(); }
});

test('expiry and clock rollback deny both sign-in and existing sessions while preserving narrow cleanup', async () => {
  const f = await fixture();
  try {
    const run = await f.run(); await f.manager.createAccount(run, 'Editor', f.sink); const signed = await login(f.app, f.credentials.get('Editor'));
    f.advance(run.expiresAt); assert.equal((await request(f.app, signed.cookie, '/api/me')).status, 401);
    assert.equal((await login(f.app, f.credentials.get('Editor'))).status, 401);
    await assert.rejects(f.manager.createAccount(run, 'Reviewer', f.sink), { code: 'PROVISION_EXPIRED' });
    f.advance(run.expiresAt - 1); await assert.rejects(f.manager.createAccount(run, 'Reviewer', f.sink), { code: 'PROVISION_CLOCK_REFUSED' });
    assert.equal((await request(f.app, signed.cookie, '/api/me')).status, 401);
    await f.manager.cleanupRun(run); assert.equal(f.app.snapshot().filter(item => item.owner !== null).length, 0); unchanged(f);
    assert.ok(run.expiresAt - TTL_MS === 1_000_000);
  } finally { await f.close(); }
});

test('lost create response persists intent, blocks new runs and recovers without duplicate creation', async () => {
  const f = await fixture();
  try {
    const run = await f.run(); let sink = 0; f.app.failNextCreateAfterCommit();
    await assert.rejects(f.manager.createAccount(run, 'Editor', () => { sink++; }), { code: 'PROVISION_CREATE_UNKNOWN' });
    assert.equal(sink, 0); assert.equal(f.app.snapshot().filter(item => item.owner !== null).length, 1);
    const state = await f.manager.snapshot(); assert.equal(state.operations[0].status, 'create-unknown'); assert.equal(state.operations[0].accountId, null);
    await assert.rejects(f.run(), { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    const recovered = await createProvisioner({ app: f.app, root: f.root, policy: f.policy, now: f.now });
    const handle = await recovered.recoverRun(run.runId); await recovered.cleanupRun(handle);
    assert.equal(f.app.snapshot().length, 1); assert.equal((await recovered.snapshot()).operations.length, 1); unchanged(f);
  } finally { await f.close(); }
});

test('seeding exceptions and failed revocation remain blocked and retain secret-free recovery state', async () => {
  const f = await fixture(); let secret;
  try {
    const run = await f.run();
    await assert.rejects(f.manager.createAccount(run, 'Editor', value => { secret = value.password; throw new Error(secret); }), error => {
      assert.equal(error.code, 'PROVISION_SEED_UNKNOWN'); assert.equal(String(error.stack).includes(secret), false); return true;
    });
    f.app.setDeleteFailure(true); await assert.rejects(f.manager.cleanupRun(run), { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    await assert.rejects(f.run(), { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    const text = await readFile(path.join(f.root, 'ledger.json'), 'utf8');
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) assert.equal(text.includes(value), false);
    f.app.setDeleteFailure(false); await f.manager.cleanupRun(run); unchanged(f);
  } finally { await f.close(); }
});

test('cleanup fences an outstanding create instead of allowing it to commit after reported absence', async () => {
  let release, started; const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ beforeCreate: async () => { started(); await gate; } });
  try {
    const run = await f.run(); let sink = 0;
    const creation = f.manager.createAccount(run, 'Editor', () => { sink++; }); const rejected = assert.rejects(creation, /^ProvisionError: PROVISION_/);
    await entered; await f.manager.cleanupRun(run); release(); await rejected;
    assert.equal(sink, 0); assert.equal(f.app.snapshot().length, 1);
    assert.equal((await f.manager.snapshot()).operations[0].status, 'deleted'); unchanged(f);
  } finally { release(); await f.close(); }
});

test('pending credential delivery prevents cleanup completion and a new run until the sink actually settles', async () => {
  const f = await fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  try {
    const run = await f.run(); let delivered = false;
    const creation = f.manager.createAccount(run, 'Editor', async () => { entered(); await gate; delivered = true; });
    const rejected = assert.rejects(creation, { code: 'PROVISION_RUN_REFUSED' });
    await started;
    await assert.rejects(f.manager.cleanupRun(run), { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    assert.equal(delivered, false); assert.equal(f.app.snapshot().filter(item => item.owner !== null).length, 0);
    await assert.rejects(f.run(), { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    const recovered = await createProvisioner({ app: f.app, root: f.root, policy: f.policy, now: f.now });
    await assert.rejects(recovered.cleanupRun(await recovered.recoverRun(run.runId)), { code: 'PROVISION_CLEANUP_INCOMPLETE' });
    release(); await rejected; assert.equal(delivered, true);
    await recovered.cleanupRun(await recovered.recoverRun(run.runId));
    assert.equal((await recovered.snapshot()).runs[0].status, 'released'); await f.run(); unchanged(f);
  } finally { release(); await f.close(); }
});

test('foreign-ID journal tampering, corrupt state, missing bound ledger and path aliases never widen deletion', async () => {
  for (const mode of ['foreign-id', 'corrupt', 'missing', 'symlink']) {
    const f = await fixture();
    try {
      const run = await f.run(); await f.manager.createAccount(run, 'Editor', f.sink);
      const ledger = path.join(f.root, 'ledger.json');
      if (mode === 'foreign-id') { const value = JSON.parse(await readFile(ledger, 'utf8')); value.operations[0].accountId = f.baseline[0].id; await writeFile(ledger, JSON.stringify(value));
        await assert.rejects(f.manager.cleanupRun(run), { code: 'PROVISION_CLEANUP_INCOMPLETE' }); }
      if (mode === 'corrupt') { await writeFile(ledger, '{private-corrupt-input'); await assert.rejects(f.manager.snapshot(), { code: 'PROVISION_STATE_INVALID' }); }
      if (mode === 'missing') { await unlink(ledger); await assert.rejects(createProvisioner({ app: f.app, root: f.root, policy: f.policy, now: f.now }), { code: 'PROVISION_STATE_INVALID' }); }
      if (mode === 'symlink') {
        const other = path.join(f.directory, 'foreign-state'), control = path.join(other, 'control.txt');
        await mkdir(other); await writeFile(control, 'private-control'); await unlink(ledger);
        // Directory junctions need no symlink privilege on Windows CI. Both
        // aliases must be refused before a ledger read or mutation is attempted.
        await symlink(other, ledger, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(f.manager.snapshot(), { code: 'PROVISION_STATE_INVALID' }); assert.equal(await readFile(control, 'utf8'), 'private-control');
      }
      unchanged(f);
    } finally { await f.close(); }
  }
});
