/** Private fixed-stage synchronization only; contains no credentials or account authority. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
