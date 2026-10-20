/** Fixed failure projection only. Never read child logs or recovery metadata. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';

const STAGES = new Set(['host-validation', 'private-runtime', 'bus-start', 'keyring-start', 'keyring-canary', 'proof', 'cleanup']);
const CODES = new Set(['HOST_REFUSED', 'PATH_REFUSED', 'OWNERSHIP_REFUSED', 'PREREQUISITE_REFUSED', 'ABORTED',
  'START_FAILED', 'START_TIMEOUT', 'COMMAND_FAILED', 'COMMAND_TIMEOUT', 'OUTPUT_LIMIT', 'PROCESS_UNCONFIRMED',
  'CANARY_FAILED', 'PROOF_FAILED', 'PROOF_RECEIPT_REFUSED', 'LISTENER_UNCONFIRMED', 'STORAGE_UNCONFIRMED', 'LEAK_DETECTED', 'FAILED']);
const KEYS = ['schemaVersion', 'purpose', 'stage', 'code', 'proofExitCode', 'recoveryRetained'];
const MAX_BYTES = 8192;
const invalid = () => new Error('ANDROID_HOSTED_RUNTIME_DIAGNOSTIC_INVALID');
const SCOPES = new Set(['captured', 'proof-output', 'private-runtime', 'combined-boundary']);
const INCOMPLETE_CODES = new Set(['OUTPUT_LIMIT', 'STORAGE_UNCONFIRMED', 'OWNERSHIP_REFUSED', 'LEAK_DETECTED', 'FAILED']);

function ownData(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export function validateHostedRuntimeScanFact(value) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    const match = descriptor.value === 'match', data = ownData(value, ['scope', 'kind', 'code', ...(match ? ['secret', 'encoding'] : [])]);
    if (!SCOPES.has(data.scope)) throw invalid();
    if (match) {
      if (data.code !== 'LEAK_DETECTED' || !['unlock','canary'].includes(data.secret) || !['raw','uri','base64','base64url'].includes(data.encoding)) throw invalid();
    } else if (data.kind !== 'incomplete' || data.scope === 'combined-boundary' || !INCOMPLETE_CODES.has(data.code)) throw invalid();
    return Object.freeze(data);
  } catch { throw invalid(); }
}

export function validateHostedAndroidRuntimeFailure(value) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value)) throw invalid();
    const withFact = Object.hasOwn(value, 'scanFact'), data = ownData(value, [...KEYS, ...(withFact ? ['scanFact'] : [])]);
    if (data.schemaVersion !== 1 || data.purpose !== 'fixed-hosted-runtime-failure' ||
        !STAGES.has(data.stage) || !CODES.has(data.code) || typeof data.recoveryRetained !== 'boolean' ||
        !(data.proofExitCode === null || Number.isSafeInteger(data.proofExitCode) && data.proofExitCode >= 0 && data.proofExitCode <= 255)) throw invalid();
    return Object.freeze({ schemaVersion: 1, purpose: 'fixed-hosted-runtime-failure', stage: data.stage,
      code: data.code, proofExitCode: data.proofExitCode, recoveryRetained: data.recoveryRetained,
      ...(withFact ? { scanFact: validateHostedRuntimeScanFact(data.scanFact) } : {}) });
  } catch { throw invalid(); }
}

export async function readHostedAndroidRuntimeFailure(file) {
  let handle;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || await realpath(file) !== file) throw invalid();
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_BYTES) throw invalid();
    // A replaced FIFO must not turn failure projection into an unbounded wait.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat(), current = await lstat(file);
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino ||
        await realpath(file) !== file) throw invalid();
    return validateHostedAndroidRuntimeFailure(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } catch { throw invalid(); }
  finally { try { await handle?.close(); } catch { throw invalid(); } }
}
