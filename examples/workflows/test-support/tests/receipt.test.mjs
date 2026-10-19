import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { issueReceipt } from '../receipt.mjs';

test('issueReceipt writes the exact documented keys, no secrets, with expiresAt = issuedAt + ttlMs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'testlane-receipt-'));
  try {
    const now = new Date('2026-09-25T00:00:00.000Z');
    const { path: filePath, receipt } = await issueReceipt({
      directory,
      workflowId: 'records-two-role',
      runId: 'run-abc123',
      environment: 'testing',
      origin: 'http://127.0.0.1:4310',
      buildId: 'ref-build-1',
      dataScope: 'scope-abc',
      ttlMs: 900_000,
      now,
    });
    assert.deepEqual(Object.keys(receipt).sort(), [
      'buildId',
      'dataScope',
      'environment',
      'expiresAt',
      'isolation',
      'issuedAt',
      'kind',
      'origin',
      'runId',
      'schemaVersion',
      'workflowId',
    ]);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'test-environment-receipt');
    assert.equal(receipt.runId, 'run-abc123');
    assert.equal(receipt.workflowId, 'records-two-role');
    assert.equal(receipt.environment, 'testing');
    assert.equal(receipt.origin, 'http://127.0.0.1:4310');
    assert.equal(receipt.buildId, 'ref-build-1');
    assert.equal(receipt.dataScope, 'scope-abc');
    assert.equal(receipt.isolation, 'dedicated-per-run');
    assert.equal(receipt.issuedAt, '2026-09-25T00:00:00.000Z');
    assert.equal(receipt.expiresAt, '2026-09-25T00:15:00.000Z');

    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(onDisk, receipt);
    assert.equal(path.basename(filePath), 'test-environment-run-abc123.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('issueReceipt is create-only: a second issue for the same runId is rejected and the first file is preserved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'testlane-receipt-collision-'));
  try {
    const first = await issueReceipt({
      directory,
      workflowId: 'records-two-role',
      runId: 'collide-run',
      environment: 'testing',
      origin: 'http://127.0.0.1:4310',
      buildId: 'build-first',
      dataScope: 'scope-first',
    });

    await assert.rejects(() =>
      issueReceipt({
        directory,
        workflowId: 'records-two-role',
        runId: 'collide-run',
        environment: 'testing',
        origin: 'http://127.0.0.1:4310',
        buildId: 'build-second',
        dataScope: 'scope-second',
      }),
    );

    const stillOnDisk = JSON.parse(await readFile(first.path, 'utf8'));
    assert.equal(stillOnDisk.buildId, 'build-first');
    assert.equal(stillOnDisk.dataScope, 'scope-first');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
