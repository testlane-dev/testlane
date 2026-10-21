/** Private fixed-stage synchronization only; contains no credentials or account authority. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';
const stages = ['records-absent', 'accounts-revoked'];
const valid = (nonce, stage) => typeof nonce === 'string' && /^[a-f0-9]{48}$/.test(nonce) && stages.includes(stage);
export async function writeBrowserGate(directory, nonce, stage) {
  assert.ok(valid(nonce, stage));
  assert.ok(path.isAbsolute(directory) && await realpath(directory) === directory && !(await lstat(directory)).isSymbolicLink());
  await writeFile(path.join(directory, stage + '.json'), JSON.stringify({ schemaVersion: 1, nonce, stage }) + '\n', { flag: 'wx', mode: 0o600 });
}
export async function readBrowserGate(directory, nonce, stage) {
  assert.ok(valid(nonce, stage));
  try { if (!path.isAbsolute(directory) || await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw Error(); }
  catch { throw Error('BROWSER_GATE_REFUSED'); }
  const file = path.join(directory, stage + '.json');
  let before;
  try { before = await lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return false; throw Error('BROWSER_GATE_REFUSED'); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n) throw Error('BROWSER_GATE_REFUSED');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error('BROWSER_GATE_REFUSED');
    const bytes = Buffer.alloc(Number(opened.size) + 1), read = await handle.read(bytes, 0, bytes.length, null);
    if (read.bytesRead !== Number(opened.size)) throw Error('BROWSER_GATE_REFUSED');
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      !bytes.subarray(0, read.bytesRead).equals(Buffer.from(JSON.stringify({ schemaVersion: 1, nonce, stage }) + '\n'))) throw Error('BROWSER_GATE_REFUSED');
    return true;
  } catch { throw Error('BROWSER_GATE_REFUSED'); } finally { await handle.close(); }
}

const flags = ['creationStarted', 'responseObserved', 'testTimeoutObserved'];
const optionalFlags = ['responseCreated', 'bodyDecoded', 'idValid', 'journalWritten', 'captureFulfilled', 'clickFulfilled'];
const optionalTimes = ['rolesOpenedMs', 'creationStartedMs', 'responseMs', 'decodeMs', 'journalMs', 'clickMs'];
const diagnosticKeys = [...flags, ...optionalFlags, ...optionalTimes, 'elapsedMs'];
function fixedDiagnostic(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error('BROWSER_DIAGNOSTIC_REFUSED');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== diagnosticKeys.length || keys.some(key => typeof key !== 'string' || !diagnosticKeys.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw Error('BROWSER_DIAGNOSTIC_REFUSED');
  const copy = Object.fromEntries(diagnosticKeys.map(key => [key, descriptors[key].value]));
  if (flags.some(key => typeof copy[key] !== 'boolean') || optionalFlags.some(key => copy[key] !== null && typeof copy[key] !== 'boolean') ||
      !Number.isSafeInteger(copy.elapsedMs) || copy.elapsedMs < 0 || copy.elapsedMs > 180000 ||
      optionalTimes.some(key => copy[key] !== null && (!Number.isSafeInteger(copy[key]) || copy[key] < 0 || copy[key] > copy.elapsedMs))) throw Error('BROWSER_DIAGNOSTIC_REFUSED');
  return copy;
}
async function diagnosticDirectory(directory) {
  try { if (!path.isAbsolute(directory) || await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw Error(); }
  catch { throw Error('BROWSER_DIAGNOSTIC_REFUSED'); }
}
/** One optional fixed snapshot, written only after both creation promises settle. */
export async function writeBrowserDiagnostic(directory, nonce, facts) {
  if (!valid(nonce, 'records-absent')) throw Error('BROWSER_DIAGNOSTIC_REFUSED');
  const fixed = fixedDiagnostic(facts); await diagnosticDirectory(directory);
  await writeFile(path.join(directory, 'creation-diagnostic.json'), JSON.stringify({ schemaVersion: 1, nonce,
    caseId: 'provisioned-browser-lifecycle', facts: fixed }) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => { throw Error('BROWSER_DIAGNOSTIC_REFUSED'); });
}
/** Missing evidence is unavailable; malformed evidence is refused, never authority. */
export async function readBrowserDiagnostic(directory, nonce) {
  if (!valid(nonce, 'records-absent')) throw Error('BROWSER_DIAGNOSTIC_REFUSED');
  await diagnosticDirectory(directory);
  const file = path.join(directory, 'creation-diagnostic.json'); let before;
  try { before = await lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('BROWSER_DIAGNOSTIC_REFUSED'); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4096n) throw Error('BROWSER_DIAGNOSTIC_REFUSED');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw Error('BROWSER_DIAGNOSTIC_REFUSED'); });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error();
    const bytes = Buffer.alloc(Number(opened.size) + 1), read = await handle.read(bytes, 0, bytes.length, null);
    if (read.bytesRead !== Number(opened.size)) throw Error();
    const value = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
    const fixed = fixedDiagnostic(value.facts), expected = JSON.stringify({ schemaVersion: 1, nonce, caseId: 'provisioned-browser-lifecycle', facts: fixed }) + '\n';
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || !bytes.subarray(0, read.bytesRead).equals(Buffer.from(expected))) throw Error();
    return fixed;
  } catch { throw Error('BROWSER_DIAGNOSTIC_REFUSED'); } finally {
    await handle.close().catch(() => { throw Error('BROWSER_DIAGNOSTIC_REFUSED'); });
  }
}
