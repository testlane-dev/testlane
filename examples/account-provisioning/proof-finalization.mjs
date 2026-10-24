/** Final publication boundary for source-only proofs AFTER verified cleanup. */
import { lstat, open, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical } from './contracts.mjs';
import { assertPrivateRuntimeDirectory } from './supabase/tools/private-directory.mjs';

const prefixes = Object.freeze({ synthetic: 'PROVISION_PROOF', supabase: 'SUPABASE_PROOF' });
const fixed = code => Object.assign(new Error(code), { code });
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const cancelled = (signal, prefix) => { if (signal?.aborted) throw fixed(prefix + '_CANCELLED'); };
async function missing(file) {
  try { await lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

/**
 * onCheckpoint is a trusted test observer, never a provider/device operation.
 * The two callers invoke this only after all account/native/filesystem cleanup
 * and leak scans succeeded. Cancellation cannot turn that into publication.
 */
export async function finalizeProvisioningProof({ outputDir, receipt, kind, signal, onCheckpoint = () => {} }) {
  const prefix = typeof kind === 'string' && Object.hasOwn(prefixes, kind) ? prefixes[kind] : undefined;
  if (!prefix || !receipt || receipt.passed !== true || receipt.cleanupVerified !== true || receipt.credentialLeakScanPassed !== true ||
      typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw fixed('PROVISION_PROOF_FINALIZATION_REFUSED');
  const output = await assertPrivateRuntimeDirectory(path.resolve(outputDir));
  const file = path.join(output, 'receipt.json'), failureFile = path.join(output, 'failure.json');
  let handle, createdIdentity;
  try {
    cancelled(signal, prefix);
    await onCheckpoint('after-cleanup');
    cancelled(signal, prefix);
    handle = await open(file, 'wx', 0o600);
    createdIdentity = await handle.stat({ bigint: true });
    cancelled(signal, prefix);
    await onCheckpoint('before-write');
    cancelled(signal, prefix);
    await handle.writeFile(canonical(receipt) + '\n');
    await handle.close(); handle = undefined;
    await onCheckpoint('after-write');
    cancelled(signal, prefix);
    return receipt;
  } catch (error) {
    let receiptAbsent = false, recoveryDirectoryVerified = false;
    try {
      if (handle) { await handle.close(); handle = undefined; }
      await assertPrivateRuntimeDirectory(output);
      if (!samePath(await realpath(output), output)) throw Error();
      recoveryDirectoryVerified = true;
      if (createdIdentity) {
        const current = await lstat(file, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino) throw Error();
        await unlink(file);
      }
      receiptAbsent = await missing(file);
    } catch { /* Do not turn an unknown receipt outcome into passing evidence. */ }
    const wasCancelled = signal?.aborted === true;
    const code = prefix + (wasCancelled ? '_CANCELLED' : '_FINALIZATION_FAILED');
    if (!recoveryDirectoryVerified) throw fixed(prefix + '_FINALIZATION_EVIDENCE_INCOMPLETE');
    try {
      await writeFile(failureFile, canonical({ schemaVersion: 1, status: wasCancelled ? 'cancelled' : 'failed',
        stage: 'receipt-finalization', code, cleanupVerified: true, credentialLeakScanPassed: true, passingReceiptAbsent: receiptAbsent }) + '\n',
      { flag: 'wx', mode: 0o600 });
    } catch { throw fixed(prefix + '_FINALIZATION_EVIDENCE_INCOMPLETE'); }
    if (!receiptAbsent) throw fixed(prefix + '_FINALIZATION_EVIDENCE_INCOMPLETE');
    throw fixed(code);
  }
}
