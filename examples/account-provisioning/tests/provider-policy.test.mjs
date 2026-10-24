import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewedSupabasePolicy, validatePolicy } from '../contracts.mjs';
import { createProvisioner } from '../controller.mjs';

const target = () => ({ kind: 'supabase-local', targetId: randomUUID(), origin: 'http://127.0.0.1:54321' });
test('reviewed local Supabase policy preserves fixed roles, quotas, deadlines and disabled effects', () => {
  const descriptor = target(), policy = reviewedSupabasePolicy(descriptor, 'a'.repeat(64));
  assert.deepEqual(validatePolicy(policy, descriptor), policy);
  assert.deepEqual(policy.roles, ['Editor', 'Reviewer']);
  assert.equal(policy.ttlMs, 600_000); assert.equal(policy.maxAccountsPerRun, 2);
  assert.equal(policy.maxActiveAccounts, 4); assert.equal(policy.maxCreateAttemptsPerHour, 10);
  assert.deepEqual(policy.effects, { email: false, sms: false, billing: false, webhooks: false });
});
test('provider policy rejects hosted targets, authority expansion, extra metadata and target replacement', () => {
  const descriptor = target(), policy = reviewedSupabasePolicy(descriptor, 'a'.repeat(64));
  for (const change of [
    { environment: 'production' }, { roles: ['Admin'] }, { maxActiveAccounts: 5 }, { ttlMs: 600_001 },
    { effects: { ...policy.effects, webhooks: true } }, { adminKey: 'not-an-authority-input' },
  ]) assert.throws(() => validatePolicy({ ...policy, ...change }, descriptor));
  for (const replacement of [
    { ...descriptor, origin: 'https://project.supabase.co' },
    { ...descriptor, origin: 'http://localhost:54321' },
    { ...descriptor, origin: 'http://127.0.0.1:54321/auth/v1' },
    { ...descriptor, origin: 'http://127.0.0.1' },
    { ...descriptor, kind: 'supabase-hosted' },
  ]) assert.throws(() => validatePolicy({ ...policy, target: replacement }, replacement));
  assert.throws(() => validatePolicy(policy, { ...descriptor, targetId: randomUUID() }));
  assert.throws(() => reviewedSupabasePolicy({ ...descriptor, kind: 'synthetic-local' }, 'a'.repeat(64)));
});
test('a supabase-local label cannot register arbitrary adapter code or create coordinator state', async () => {
  const descriptor = target(), policy = reviewedSupabasePolicy(descriptor, 'a'.repeat(64));
  const root = path.join(os.tmpdir(), 'testlane-forged-provider-' + randomUUID());
  let called = false;
  const forged = { target: descriptor, async coordinatorBinding() { called = true; throw new Error('not a registered factory'); } };
  await assert.rejects(createProvisioner({ app: forged, root, policy }), { message: 'PROVISION_TARGET_REFUSED' });
  assert.equal(called, false);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});
