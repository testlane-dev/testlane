/** Small shipped native-store/child helper. It never prints captured child output. */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, realpath, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Chromium appends its own profile paths; keep this root out of deep worktrees. */
export async function createDemoTemporaryDirectory() {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'tld-demo-'));
  if (process.platform !== 'win32') await chmod(root, 0o700);
  return Object.freeze({ root, parent });
}
/** Remove only this known empty directory. Unknown files require manual inspection. */
export async function removeDemoTemporaryDirectory({ root, parent }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(parent) || path.dirname(root) !== parent ||
      !/^tld-demo-[a-zA-Z0-9]+$/.test(path.basename(root)) || (await lstat(root)).isSymbolicLink() ||
      await realpath(root) !== root || (await readdir(root)).length !== 0) throw new Error('DEMO_TEMP_CLEANUP_INCOMPLETE');
  await rmdir(root);
}

export function demoStorePolicy({ platform = process.platform, allowUserKeychain = false } = {}) {
  if (platform === 'win32') return { store: 'dpapi', usesUserKeychain: false };
  if (['linux', 'darwin'].includes(platform) && allowUserKeychain === true) {
    return { store: platform === 'darwin' ? 'keychain-macos' : 'secret-service', usesUserKeychain: true };
  }
  throw new Error(['linux', 'darwin'].includes(platform) ? 'DEMO_USER_KEYCHAIN_ACKNOWLEDGEMENT_REQUIRED' : 'DEMO_PLATFORM_UNSUPPORTED');
}
async function stopTree(child) {
  if (!child.pid) return false;
  let closed = false;
  const observe = () => { closed = true; };
  child.once('close', observe);
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  } else {
    const system = process.env.SystemRoot ?? process.env.windir;
    if (!system || !path.isAbsolute(system)) child.kill('SIGKILL');
    else await new Promise(resolve => {
      const killer = spawn(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, shell: false, stdio: 'ignore',
      });
      let finished = false;
      const done = code => {
        if (finished) return; finished = true; clearTimeout(timer);
        if (code !== 0 && !closed) child.kill('SIGKILL');
        resolve();
      };
      const timer = setTimeout(() => { killer.kill(); done(null); }, 5000);
      killer.once('error', () => done(null)); killer.once('close', done);
    });
  }
  if (closed) return true;
  const confirmed = await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.off('close', done); resolve(true); };
    const timer = setTimeout(() => { child.off('close', done); resolve(false); }, 5000);
    child.once('close', done);
    if (closed) done();
  });
  child.off('close', observe);
  if (!confirmed) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  return confirmed;
}

/** Secrets may be supplied only as input; argv and env must contain no generated credentials. */
export async function runDemoChild({ entry, args = [], cwd, env = process.env, input, timeoutMs = 35_000, signal }) {
  if (!path.isAbsolute(entry) || !path.isAbsolute(cwd) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 220_000) {
    throw new Error('DEMO_CHILD_INPUT_INVALID');
  }
  if (signal?.aborted) throw new Error('DEMO_CANCELLED');
  return new Promise((resolve, reject) => {
    let child, stdout = '', stderr = '', settled = false, stopping = false, timer;
    const fail = code => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error(code)); } };
    const stop = code => {
      if (stopping || settled) return;
      stopping = true;
      void stopTree(child).then(confirmed => fail(confirmed ? code : 'DEMO_CHILD_TERMINATION_UNCONFIRMED'),
        () => fail('DEMO_CHILD_TERMINATION_UNCONFIRMED'));
    };
    const abort = () => stop('DEMO_CANCELLED');
    try {
      child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, shell: false,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      for (const [name, append] of [['stdout', value => { stdout += value; }], ['stderr', value => { stderr += value; }]]) {
        child[name].on('data', bytes => {
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.length > 256 * 1024) stop('DEMO_CHILD_OUTPUT_LIMIT');
          else append(bytes.toString('utf8'));
        });
      }
      child.stdin.on('error', () => {});
      child.once('error', () => fail('DEMO_CHILD_START_FAILED'));
      child.once('close', code => {
        if (settled || stopping) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        resolve({ code, stdout, stderr });
      });
      timer = setTimeout(() => stop('DEMO_CHILD_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(input === undefined ? undefined : input + '\n');
    } catch { fail('DEMO_CHILD_START_FAILED'); }
  });
}
