import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeEvidence } from '../runtime.mjs';

test('evidence collision refuses overwrite before finalizing a report', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'testlane-evidence-'));
  const runId = 'evidence-collision';
  const log = path.join(directory, `workflow-smoke-${runId}.log`);
  const report = path.join(directory, `workflow-smoke-${runId}.report.json`);
  try {
    await writeFile(log, 'existing\n', { encoding: 'utf8', flag: 'wx' });
    await assert.rejects(() => writeEvidence(directory, { runId, verdict: 'passed', steps: [] }));
    assert.equal(await readFile(log, 'utf8'), 'existing\n');
    assert.equal((await readdir(directory)).includes(path.basename(report)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
