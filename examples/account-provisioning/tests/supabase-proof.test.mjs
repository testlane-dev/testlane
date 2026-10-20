import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startSupabaseProvisioningApp } from '../supabase/app.mjs';
import { runSupabaseProvisioningProof } from '../supabase/proof.mjs';

test('a forged provider handle is refused before inspecting its properties or opening an app server', async () => {
  const secret = randomBytes(32).toString('base64url'); let inspected = false;
  const forged = new Proxy({}, { get() { inspected = true; throw Error(secret); } });
  await assert.rejects(startSupabaseProvisioningApp({ runtime: forged, releaseId: 'a'.repeat(64) }), { code: 'PROVISION_TARGET_REFUSED' });
  assert.equal(inspected, false);
});

test('pre-cancelled provider acceptance creates no output, broker store or Docker resources', async t => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tlp-provider-abort-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent); assert.equal(await realpath(root), root); assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const outputDir = path.join(root, 'not-created'), controller = new AbortController(); controller.abort();
  await assert.rejects(runSupabaseProvisioningProof({ toolsRoot: path.join(root, 'not-installed'), outputDir, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(lstat(outputDir), { code: 'ENOENT' });
});
