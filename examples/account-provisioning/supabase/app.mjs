/** Synthetic app-owned HTTP sessions backed by the explicitly owned local Auth stack. */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exact, fail, TTL_MS, UUID } from '../contracts.mjs';
import { createSupabaseAuthority, requireSupabaseTarget, supabaseIdentity } from './authority.mjs';
import { isNextAuthSupabaseApp } from './nextauth-app.mjs';
import { createRequestDrain } from './request-drain.mjs';
import { browserAsset, browserRecordResponse } from './browser-fixture.mjs';

const instances = new WeakSet(), COOKIE = 'tlp_supabase_session';
const digest = value => createHash('sha256').update(value).digest('hex');
export const isSupabaseApp = app => instances.has(app) || isNextAuthSupabaseApp(app);

export async function startSupabaseProvisioningApp({ runtime, releaseId } = {}) {
  requireSupabaseTarget(runtime, releaseId);
  const sessions = new Map(), issued = new Set(), requests = createRequestDrain(); let origin, closed = false, quiescing = false, closePromise, drainPromise;
  const live = () => { if (closed) throw fail('PROVISION_APP_CLOSED'); };
  const authority = createSupabaseAuthority({ runtime, releaseId, assertLive: live });
  async function currentUser(request) {
    const cookie = (request.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const session = cookie && sessions.get(digest(cookie));
    if (!session || session.expiresAt <= Date.now()) return null;
    const user = await runtime.getUser(session.accessToken);
    if (user.status !== 200 || user.user?.id !== session.userId) return null;
    const grant = supabaseIdentity(await runtime.ledger('identity', session.userId));
    return grant && grant.email === user.user.email ? { grant, accessToken: session.accessToken } : null;
  }
  async function body(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw fail('PROVISION_INPUT_REFUSED');
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 4096) throw fail('PROVISION_INPUT_REFUSED'); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value;
  }
  function send(response, status, value, headers = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(JSON.stringify(value));
  }
  async function handle(request, response) {
    if (closed || quiescing || request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(response, 403, { error: 'ORIGIN_REFUSED' });
    const url = new URL(request.url, origin);
    if (url.search || url.hash) return send(response, 400, { error: 'REQUEST_INVALID' });
    const asset = browserAsset(url.pathname);
    if (asset && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(asset.body); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const credentials = await body(request);
      if (!exact(credentials, ['email', 'password']) || typeof credentials.email !== 'string' || credentials.email.length > 254 ||
        typeof credentials.password !== 'string' || credentials.password.length < 1 || credentials.password.length > 256) throw fail('PROVISION_INPUT_REFUSED');
      const result = await runtime.signIn(credentials.email, credentials.password);
      if (result.status !== 200 || typeof result.accessToken !== 'string' || !UUID.test(result.user?.id ?? '')) return send(response, 401, { error: 'SIGN_IN_REFUSED' });
      const grant = supabaseIdentity(await runtime.ledger('identity', result.user.id));
      if (!grant || grant.email !== credentials.email || grant.email !== result.user.email) return send(response, 401, { error: 'SIGN_IN_REFUSED' });
      const token = randomBytes(32).toString('base64url'); issued.add(token);
      sessions.set(digest(token), { userId: grant.id, accessToken: result.accessToken, expiresAt: Date.now() + TTL_MS });
      return send(response, 200, { ok: true }, { 'Set-Cookie': COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict' });
    }
    const recordRoute = url.pathname === '/api/records' || /^\/api\/records\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url.pathname);
    if (!recordRoute && !['/api/me', '/api/editor-only', '/api/reviewer-only'].includes(url.pathname)) return send(response, 404, { error: 'NOT_FOUND' });
    const session = await currentUser(request), user = session?.grant;
    if (!user) return send(response, 401, { error: 'AUTHENTICATION_REQUIRED' });
    if (recordRoute) {
      const result = await browserRecordResponse({ method: request.method, route: url.pathname, user, readBody: () => body(request),
        rest: (method, route, value) => runtime.rest(method, route, session.accessToken, value) });
      if (result.status === 204) { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return; }
      return send(response, result.status, result.body);
    }
    if (request.method !== 'GET') return send(response, 405, { error: 'METHOD_REFUSED' });
    if (url.pathname === '/api/me') return send(response, 200, { email: user.email, role: user.role });
    const allowed = url.pathname === '/api/editor-only' ? 'Editor' : 'Reviewer';
    return send(response, user.role === allowed ? 200 : 403, user.role === allowed ? { ok: true } : { error: 'ROLE_REFUSED' });
  }
  const server = createServer((request, response) => {
    if (closed || quiescing) return send(response, 403, { error: 'ORIGIN_REFUSED' });
    void requests.run(async () => {
      try { await handle(request, response); }
      catch { if (!response.headersSent) send(response, 400, { error: 'REQUEST_INVALID' }); else response.destroy(); }
    }).catch(() => response.destroy());
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const stopAndDrainRequests = () => {
    if (!drainPromise) {
      quiescing = true;
      drainPromise = requests.close(async () => {
        await new Promise((resolve, reject) => { server.close(error => error ? reject(fail('PROVISION_CLEANUP_INCOMPLETE')) : resolve()); server.closeAllConnections(); });
      });
    }
    return drainPromise;
  };
  const app = Object.freeze({
    target: Object.freeze({ kind: 'supabase-local', targetId: runtime.targetId, origin }), origin,
    authentication: Object.freeze({ kind: 'form-post' }),
    ...authority,
    issuedSessionTokens() { return [...issued]; },
    // Local teardown only: stop browser writers before owned fallback cleanup.
    // Authority remains live until close(); this never becomes an HTTP route.
    stopAndDrainRequests,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = stopAndDrainRequests().then(() => { sessions.clear(); issued.clear(); });
      return closePromise;
    },
  });
  instances.add(app); return app;
}
