/** Actual private-path setup only. Never invokes a broker store or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareProvisioningProofDirectories } from '../proof.mjs';
import { assertPrivateRuntimeDirectory } from '../supabase/tools/private-directory.mjs';

const keys = ['TMP', 'TEMP', 'TMPDIR', 'NODE_DISABLE_COMPILE_CACHE'];
const environment = () => keys.map(key => [key, Object.hasOwn(process.env, key), process.env[key]]);
// Test fixture only: atomically create ONE new empty parent with a descriptor.
// Production continues to use the existing provider permission implementation.
import { fixture } from './private-proof-fixture.mjs';

test('verified private output/session/scratch precede temporary lease and empty-only disposal', async () => {
  const before = environment(), f = await fixture(); let storage;
  try {
    storage = await prepareProvisioningProofDirectories(path.join(f.parent, 'proof'));
    for (const directory of [storage.output, storage.sessionRoot, storage.scratchRoot]) {
      assert.equal(await assertPrivateRuntimeDirectory(directory), directory);
    }
    assert.equal(await realpath(os.tmpdir()), storage.scratchRoot);
    for (const key of ['TMP','TEMP','TMPDIR']) assert.equal(process.env[key], storage.scratchRoot);
    assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1');
    const canary = randomBytes(32).toString('base64url'), session = path.join(storage.sessionRoot, 'unit-cookie.json');
    await writeFile(session, canary, { flag: 'wx', mode: 0o600 });
    await assert.rejects(storage.removeEmpty());
    assert.equal(await readFile(session, 'utf8'), canary, 'uncertain session data is not recursively erased');
    assert.equal(await realpath(storage.scratchRoot), storage.scratchRoot, 'preflight verifies both directories before removing either');
    await unlink(session); await storage.removeEmpty();
    await assert.rejects(lstat(storage.sessionRoot), { code: 'ENOENT' });
    await assert.rejects(lstat(storage.scratchRoot), { code: 'ENOENT' });
  } finally { storage?.restore(); storage?.restore(); assert.deepEqual(environment(), before); await f.close(); }
});

test('pre-cancelled private setup leaves no directory or environment lease', async () => {
  const before = environment(), f = await fixture(), controller = new AbortController(); controller.abort();
  try {
    const output = path.join(f.parent, 'absent');
    await assert.rejects(prepareProvisioningProofDirectories(output, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(lstat(output), { code: 'ENOENT' }); assert.deepEqual(environment(), before);
  } finally { await f.close(); }
});

test('unsafe parent is refused before output creation or temporary environment changes', async () => {
  const before = environment(), f = await fixture({ unsafe: true });
  try {
    const output = path.join(f.parent, 'absent');
    await assert.rejects(prepareProvisioningProofDirectories(output), { code: 'SUPABASE_PRIVATE_DIRECTORY_REFUSED' });
    await assert.rejects(lstat(output), { code: 'ENOENT' }); assert.deepEqual(environment(), before);
  } finally { await f.close(); }
});
