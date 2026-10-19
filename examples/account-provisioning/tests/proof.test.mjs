import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installedTreeHash, runProvisioningProof } from '../proof.mjs';

test('pre-aborted proof refuses before creating output or starting broker setup', async () => {
  const controller = new AbortController(); controller.abort();
  const stages = [];
  await assert.rejects(runProvisioningProof({ outputDir: 'not-an-absolute-path', signal: controller.signal,
    onStage: stage => stages.push(stage) }), { name: 'AbortError' });
  assert.deepEqual(stages, []);
});

test('installed-tree binding separates filenames and arbitrary file bytes unambiguously', async () => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'testlane-provision-hash-'));
  try {
    const single = path.join(directory, 'single'), split = path.join(directory, 'split');
    await mkdir(single); await mkdir(split);
    // These distinct trees collide under filename + NUL + raw bytes concatenation.
    await writeFile(path.join(single, 'a'), Buffer.from('xb\0y'));
    await writeFile(path.join(split, 'a'), 'x'); await writeFile(path.join(split, 'b'), 'y');
    assert.equal(Buffer.concat([Buffer.from('a\0'), Buffer.from('xb\0y')]).toString('hex'),
      Buffer.concat([Buffer.from('a\0x'), Buffer.from('b\0y')]).toString('hex'));
    assert.notEqual(await installedTreeHash(single), await installedTreeHash(split));
    const sha = value => createHash('sha256').update(value).digest('hex');
    assert.equal(await installedTreeHash(split), sha(JSON.stringify([['a', sha('x')], ['b', sha('y')]])));
  } finally {
    assert.equal(path.dirname(await realpath(directory)), parent);
    assert.ok(path.basename(directory).startsWith('testlane-provision-hash-'));
    await rm(directory, { recursive: true, force: true });
  }
});
