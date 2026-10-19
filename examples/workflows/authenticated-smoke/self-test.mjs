import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseWorkflow } from './manifest.mjs';
import { runAuthenticatedChecks, createDeadline } from './runtime.mjs';

function appServer({ cookie, email, role, wrongRole = false, readinessFail = false, offOriginRedirect = false, denyAuthenticated = false, delayMs = 0, delayPath = null, buildId = null }) {
  const requests = { count: 0 };
  // A delayed handler (see below) simulates a slow endpoint for the duration
  // of one self-test run; it must never outlive that run. Two things are
  // tracked so `server.close()` (called from self-test's `finally`, see
  // below) can end the run immediately instead of waiting out `delayMs`:
  // the pending setTimeout itself (cleared, so it never fires and writes to
  // a response the test has stopped observing) and the open socket carrying
  // the still-pending request (destroyed, so Node's http server doesn't wait
  // for that connection to end before closing). Each timer is also unref'd
  // as a second line of defence, so it can't keep the process alive on its
  // own even if `close()` is somehow never reached.
  const pendingTimers = new Set();
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    requests.count += 1;
    if (delayMs > 0 && (delayPath === null || request.url === delayPath)) {
      const timer = setTimeout(() => { pendingTimers.delete(timer); handle(request, response); }, delayMs);
      timer.unref();
      pendingTimers.add(timer);
      return;
    }
    handle(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const socket of sockets) socket.destroy();
    return originalClose(callback);
  };
  function handle(request, response) {
    const authenticated = !denyAuthenticated && (request.headers.cookie ?? '').includes(`smoke_session=${cookie}`);
    if (request.url === '/ready') { response.writeHead(readinessFail ? 503 : 200, buildId === null ? {} : { 'x-build-id': buildId }); response.end(); return; }
    if (request.url === '/identity') {
      if (!authenticated) { response.writeHead(401); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ email, role: wrongRole ? 'wrong-role' : role })); return;
    }
    if (request.url === '/api/data') {
      if (!authenticated) { response.writeHead(401); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); return;
    }
    if (request.url === '/protected') {
      if (!authenticated) { response.writeHead(302, { location: '/login' }); response.end(); return; }
      if (offOriginRedirect) { response.writeHead(302, { location: 'https://outside.invalid/' }); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><h1>Protected workspace</h1>'); return;
    }
    response.writeHead(404); response.end();
  }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

/** Run against a generated loopback app and IPC broker double; no browser artifacts are retained. */
export async function runSelfTest({ caseName = 'happy' } = {}) {
  const cookie = randomBytes(24).toString('hex');
  const email = `smoke-${randomBytes(4).toString('hex')}@example.test`;
  const role = 'Sales';
  const appBuildId = ['build-id', 'unexpected-header'].includes(caseName) ? (caseName === 'build-id' ? 'synthetic-build' : 'unobserved-canary') : null;
  // The loopback app server has to exist before anything below it can run, but
  // parseWorkflow() (right after it) throws when the built contracts are
  // unavailable -- e.g. this template was copied away from its sibling
  // ../../../dist. Everything from here on is inside try/finally so the
  // server is closed on every exit path; otherwise it keeps listening and the
  // process never exits, even after the caller has already reported failure.
  // `identity-timeout` and `api-timeout` need one specific step -- `identity`
  // or `api` -- to be the one that times out, regardless of how long the
  // unrelated steps ahead of it take on a loaded runner: the broker calls
  // (each one a child process), the readiness fetch and the session file,
  // and for `api` also the real Chromium launch inside the `identity` step,
  // identity and the protected page. A shared 1000ms run budget left no
  // headroom for that earlier work, so under load one of those steps -- not
  // the intended one -- would hit the deadline first (for `identity-timeout`
  // that was `broker-check` or `session`; the same class of wall-clock race
  // fixed for feature-acceptance in PR #9). Giving these cases their own
  // generous budget (10s) and a delay well past it (20s) makes the intended
  // step the deterministic timeout regardless of machine speed. `timeout`
  // doesn't need this: it delays every path, and only one broker call
  // (profile-policy) runs ahead of readiness, the first request to the app,
  // which therefore always times out first.
  const isLateTimeoutCase = ['identity-timeout', 'api-timeout'].includes(caseName);
  const isReadinessTimeoutCase = caseName === 'timeout';
  const app = await appServer({ cookie, email, role, wrongRole: caseName === 'wrong-role', readinessFail: caseName === 'readiness-fail', offOriginRedirect: caseName === 'off-origin', denyAuthenticated: caseName === 'auth-denied', delayMs: isLateTimeoutCase ? 20000 : isReadinessTimeoutCase ? 2000 : 0, delayPath: caseName === 'identity-timeout' ? '/identity' : caseName === 'api-timeout' ? '/api/data' : null, buildId: appBuildId });
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const workflow = parseWorkflow({ schemaVersion: 1, kind: 'authenticated-smoke', id: 'synthetic-smoke', profile: 'synthetic:local:smoke', target: { origin, environment: 'testing', ...(caseName === 'build-id' ? { buildId: appBuildId } : {}) }, identity: { email, role }, checks: { readinessPath: '/ready', identityPath: '/identity', protectedPath: '/protected', protectedHeading: 'Protected workspace', apiPath: '/api/data' }, timeoutMs: isLateTimeoutCase ? 10000 : isReadinessTimeoutCase ? 1000 : 30000 });
    const fakeBroker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-broker.mjs');
    const steps = [];
    let cleanup = { status: 'complete' };
    let deadline;
    let actualBuild = null;
    try {
      deadline = createDeadline(workflow.timeoutMs);
      if (caseName === 'cancelled') deadline.cancel();
      const profiles = ['production-metadata', 'unrelated-production'].includes(caseName)
        ? [{ name: workflow.profile, email, role, environment: 'testing', baseUrl: origin, strategy: 'nextauth-credentials' }, { name: 'other:local:prod', email, role, environment: 'production', baseUrl: caseName === 'production-metadata' ? 'http://127.0.0.1:9' : 'https://production.example.test', strategy: 'form-post' }]
        : undefined;
      ({ actualBuild } = await runAuthenticatedChecks({ workflow, brokerCli: fakeBroker, deadline, ipcConfig: { origin, cookie, profiles, profile: { name: workflow.profile, email, role, environment: 'testing', baseUrl: origin, strategy: 'nextauth-credentials' } }, onStep: (id, status, code, durationMs) => { steps.push({ id, status, code, durationMs }); if (caseName === 'cancel-after-session' && id === 'session' && status === 'passed') deadline.cancel(); }, cleanupHook: caseName === 'cleanup-failure' ? () => { throw new Error('synthetic cleanup failure'); } : undefined }));
      return { workflow, steps, expectedFailure: false, exitCode: 0, cleanup, actualBuild, requests: app.requests.count };
    } catch (error) {
      if (error.code === 'CLEANUP_FAILED') cleanup = { status: 'failed' };
      return { workflow, steps, expectedFailure: true, exitCode: 1, code: error.code ?? 'SELF_TEST_FAILED', hint: error.hint, cleanup, actualBuild, requests: app.requests.count };
    } finally {
      deadline?.dispose?.();
    }
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}
