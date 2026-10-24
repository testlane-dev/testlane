/** Exact parent-owned Playwright BrowserServer; no arbitrary endpoint or process inputs. */
import { createRequire } from 'node:module';
import path from 'node:path';
const fail = () => Object.assign(Error('BROWSER_SERVER_CLEANUP_UNCONFIRMED'), { preserveConsumer: true });
function outcome(promise) {
  const result = { settled: false, ok: false };
  result.promise = Promise.resolve(promise).then(() => { result.settled = true; result.ok = true; }, () => { result.settled = true; });
  return result;
}
async function bounded(task, milliseconds) {
  let timer;
  try { await Promise.race([task.promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
  return task.settled && task.ok;
}
/** Private helper is extracted verbatim into VM tests; no exported execution-injection API. */
function retainBrowserServer(server) {
  const child = server.process(); let closed = false, closeTask;
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw fail();
  child.once('close', () => { closed = true; });
  const endpoint = server.wsEndpoint();
  return Object.freeze({ endpoint,
    close() {
      if (!closeTask) closeTask = (async () => {
        let graceful;
        try { graceful = outcome(server.close()); } catch { graceful = outcome(Promise.reject(Error())); }
        const ok = await bounded(graceful, 10_000);
        if (!ok) {
          let killed;
          try { killed = outcome(server.kill()); } catch { throw fail(); }
          if (!await bounded(killed, 10_000)) throw fail();
          // A late graceful task still has to settle; native close is not an
          // excuse to erase an unknown local operation or claim a passing run.
          await bounded(graceful, 1000);
          if (!graceful.settled || !closed) throw fail();
          throw fail(); // A failed/forced graceful close is never acceptance.
        }
        if (!closed) {
          const observed = outcome(new Promise(resolve => child.once('close', resolve)));
          await bounded(observed, 1000);
        }
        if (!closed) throw fail();
        // Playwright may internally use a forceful fallback during close().
        // This acknowledges only its settled close plus the retained process.
        return { browserProcessClosed: true, closeAcknowledged: true };
      })();
      return closeTask;
    },
  });
}
export async function startOwnedBrowserServer({ consumerRoot, temporaryRoot, signal }) {
  signal?.throwIfAborted();
  const require = createRequire(path.join(consumerRoot, 'package.json'));
  if (require('@playwright/test/package.json').version !== '1.64.0' || require('playwright/package.json').version !== '1.64.0') throw Error('BROWSER_TOOL_VERSION_REFUSED');
  const env = { HOME: temporaryRoot, USERPROFILE: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot, TMPDIR: temporaryRoot,
    XDG_CACHE_HOME: path.join(temporaryRoot, 'cache'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PATH: process.platform === 'win32' ? path.dirname(process.execPath) : '/usr/bin:/bin' };
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot;
    if (!system || !path.isAbsolute(system)) throw Error('BROWSER_OS_ENV_REFUSED');
    env.SystemRoot = system; env.windir = system; env.ComSpec = path.join(system, 'System32', 'cmd.exe');
    env.PATH += path.delimiter + path.join(system, 'System32');
    env.APPDATA = path.join(temporaryRoot, 'roaming'); env.LOCALAPPDATA = path.join(temporaryRoot, 'local');
  }
  let owned, server;
  try {
    server = await require('playwright').chromium.launchServer({ host: '127.0.0.1', port: 0, headless: true,
      timeout: 30_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, env });
    owned = retainBrowserServer(server);
    let validEndpoint = false;
    try { const url = new URL(owned.endpoint);
      validEndpoint = url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash && /^\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname);
    } catch { /* A malformed endpoint must never escape as a raw URL error. */ }
    if (!validEndpoint) {
      await owned.close(); throw Error('BROWSER_ENDPOINT_REFUSED');
    }
    if (signal?.aborted) { await owned.close(); signal.throwIfAborted(); }
    return owned;
  } catch (error) {
    if (owned) {
      try { await owned.close(); } catch { throw fail(); }
      throw Error(signal?.aborted ? 'BROWSER_CANCELLED' : 'BROWSER_SERVER_START_FAILED');
    }
    // A returned server is still exact authority even if retaining/validating
    // its metadata failed. Stop only that handle; never claim verified cleanup.
    if (server) { const killed = outcome(Promise.resolve().then(() => server.kill())); await bounded(killed, 10_000); }
    throw Object.assign(Error('BROWSER_SERVER_START_UNCONFIRMED'), { preserveConsumer: true });
  }
}
