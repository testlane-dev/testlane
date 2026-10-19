/**
 * The fixture's trusted setup adapter: issues a `test-environment-receipt`
 * file the way a real CI job's setup step would, for the feature-acceptance
 * runner (Job C) to read and verify against its manifest and the live
 * `/api/test-environment` endpoint. Contains no secrets.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function issueReceipt({
  directory,
  workflowId,
  runId,
  environment,
  origin,
  buildId,
  dataScope,
  ttlMs = 900_000,
  now = new Date(),
}) {
  const issuedAt = new Date(now.getTime());
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);
  const receipt = {
    schemaVersion: 1,
    kind: 'test-environment-receipt',
    runId,
    workflowId,
    environment,
    origin,
    buildId,
    dataScope,
    isolation: 'dedicated-per-run',
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `test-environment-${runId}.json`);
  await writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { path: filePath, receipt };
}
