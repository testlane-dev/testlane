/** Actual CLI completion source with controlled Node-only proof doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

async function actualMain() {
  const source = await readFile(new URL('../browser-proof.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('async function main(){'), end = source.indexOf('\nfunction entry()', begin);
  const tail = source.split('\n').filter(line => line.startsWith('if(entry())main().catch('));
  assert.ok(begin > 0 && end > begin); assert.equal(tail.length, 1);
  return source.slice(begin, end) + '\n' + tail[0].replace('if(entry())', '');
}

test('actual CLI commits success only after completion, uncancelled signal and unchanged provisional status', async () => {
  const code = await actualMain();
  for (const mode of ['success', 'SIGINT', 'SIGTERM', 'entry-failure', 'proof-zero', 'proof-failure', 'throw']) {
    const proc = new EventEmitter(), stdout = [], stderr = []; let invoked = 0;
    proc.argv = ['node', 'proof.mjs', '--tools-root', path.resolve('tools'), '--output-dir', path.resolve('output')];
    if (mode === 'entry-failure') proc.exitCode = 7;
    const result = { schemaVersion: 1, passed: true, cleanupVerified: true };
    const context = { process: proc, AbortController, Error, JSON,
      console: { log: value => stdout.push(value), error: value => stderr.push(value) },
      runSupabaseBrowserProof: async ({ signal }) => {
        invoked++; assert.equal(proc.exitCode, 1); assert.equal(signal.aborted, false);
        if (mode === 'SIGINT' || mode === 'SIGTERM') queueMicrotask(() => proc.emit(mode));
        if (mode === 'proof-zero') proc.exitCode = 0;
        if (mode === 'proof-failure') proc.exitCode = 7;
        if (mode === 'throw') throw Error('CONTROLLED_PROOF_FAILURE');
        return result;
      } };
    await vm.runInNewContext(code, context);
    assert.equal(proc.listenerCount('SIGINT'), 0); assert.equal(proc.listenerCount('SIGTERM'), 0);
    assert.equal(invoked, mode === 'entry-failure' ? 0 : 1);
    if (mode === 'success') {
      assert.equal(proc.exitCode, 0); assert.deepEqual(stdout, [JSON.stringify(result)]); assert.deepEqual(stderr, []);
    } else {
      assert.equal(proc.exitCode, mode === 'entry-failure' || mode === 'proof-failure' ? 7 : 1);
      assert.deepEqual(stdout, []);
      assert.deepEqual(stderr, ['SUPABASE_BROWSER_PROOF_FAILED: inspect private fixed-code recovery evidence']);
    }
  }
});

test('actual CLI naturally exits nonzero when its only unresolved proof promise has no referenced work', async () => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'testlane-browser-main-'));
  try {
    const code = await actualMain(), entry = path.join(root, 'pending.mjs');
    await writeFile(entry, 'const runSupabaseBrowserProof = () => new Promise(() => {});\n' + code + '\n');
    const observed = await new Promise(resolve => {
      execFile(process.execPath, [entry, '--tools-root', path.join(root, 'tools'), '--output-dir', path.join(root, 'output')],
        { cwd: root, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 16 * 1024 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.ok(observed.error, 'the unresolved proof cannot naturally exit successfully');
    assert.equal(observed.error.code, 1); assert.equal(observed.error.killed, false); assert.equal(observed.error.signal, null);
    assert.equal(observed.stdout, ''); assert.equal(observed.stderr, '');
  } finally {
    assert.equal(path.dirname(await realpath(root)), parent); assert.ok(path.basename(root).startsWith('testlane-browser-main-'));
    await rm(root, { recursive: true, force: false });
  }
});
