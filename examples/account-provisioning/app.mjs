/** Fixed synthetic loopback auth. Local controller methods never become HTTP routes. */
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { canonical, fail, ROLES, validOwner } from './contracts.mjs';

const instances = new WeakSet(), COOKIE = 'tlp_session';
const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHash = (password, salt) => scryptSync(password, salt, 32).toString('hex');
const equal = (a, b) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
export const isSyntheticApp = app => instances.has(app);
export async function startProvisioningApp({ now = Date.now, beforeCreate } = {}) {
  if (typeof now !== 'function' || (beforeCreate !== undefined && typeof beforeCreate !== 'function')) throw fail('PROVISION_INPUT_REFUSED');
  const targetId = randomUUID(), accounts = new Map(), operations = new Map(), sessions = new Map(), issued = new Set();
  let origin, closed = false, createFault = false, deleteFault = false, lastTime = 0, coordinator = null;
  const attempts = [];
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < lastTime) return null; lastTime = value; return value; };
  const live = () => { if (closed) throw fail('PROVISION_APP_CLOSED'); };
  const checkOwner = owner => { live(); if (!validOwner(owner) || owner.targetId !== targetId) throw fail('PROVISION_OWNERSHIP_REFUSED'); };
  function operation(owner) {
    const entry = operations.get(owner.operationId);
    if (entry && canonical(entry.owner) !== canonical(owner)) throw fail('PROVISION_OWNERSHIP_REFUSED');
    return entry;
  }
  function insert({ email, password, role, owner = null, expiresAt }) {
    if (typeof email !== 'string' || typeof password !== 'string' || password.length < 32 || password.length > 256 || !ROLES.includes(role)) throw fail('PROVISION_INPUT_REFUSED');
    if ([...accounts.values()].some(item => item.email.toLowerCase() === email.toLowerCase())) throw fail('PROVISION_ACCOUNT_COLLISION');
    const salt = randomBytes(32).toString('hex'), id = randomUUID();
    accounts.set(id, { id, email, role, owner: owner && structuredClone(owner), expiresAt, salt, passwordHash: passwordHash(password, salt) }); return id;
  }
  async function body(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new Error();
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 4096) throw new Error(); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value;
  }
  function send(response, status, value, headers = {}) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(JSON.stringify(value)); }
  function userFor(request) {
    const current = time(); if (current === null) return null;
    const token = (request.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const session = token && sessions.get(hash(token)), user = session && accounts.get(session.accountId);
    return user && user.expiresAt > current && session.expiresAt > current ? user : null;
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) send(response, 400, { error: 'REQUEST_INVALID' }); else response.destroy(); }); });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
  async function handle(request, response) {
    if (closed || request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(response, 403, { error: 'ORIGIN_REFUSED' });
    const url = new URL(request.url, origin);
    if (url.search || url.hash) return send(response, 400, { error: 'REQUEST_INVALID' });
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const value = await body(request);
      if (Object.keys(value).sort().join(',') !== 'email,password' || typeof value.email !== 'string' || typeof value.password !== 'string' || value.password.length > 256) return send(response, 400, { error: 'REQUEST_INVALID' });
      const current = time();
      const user = current !== null && [...accounts.values()].find(item => item.email === value.email && item.expiresAt > current && equal(item.passwordHash, passwordHash(value.password, item.salt)));
      if (!user) return send(response, 401, { error: 'SIGN_IN_REFUSED' });
      const token = randomBytes(32).toString('base64url'); issued.add(token);
      sessions.set(hash(token), { accountId: user.id, expiresAt: Math.min(user.expiresAt, current + 10 * 60_000) });
      return send(response, 200, { ok: true }, { 'Set-Cookie': COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict' });
    }
    // Exact route table: even an authenticated caller has no account/controller endpoint.
    if (!['/api/me', '/api/editor-only', '/api/reviewer-only'].includes(url.pathname)) return send(response, 404, { error: 'NOT_FOUND' });
    const user = userFor(request);
    if (!user) return send(response, 401, { error: 'AUTHENTICATION_REQUIRED' });
    if (request.method !== 'GET') return send(response, 405, { error: 'METHOD_REFUSED' });
    if (url.pathname === '/api/me') return send(response, 200, { email: user.email, role: user.role });
    const allowed = url.pathname === '/api/editor-only' ? 'Editor' : 'Reviewer';
    return send(response, user.role === allowed ? 200 : 403, user.role === allowed ? { ok: true } : { error: 'ROLE_REFUSED' });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const app = Object.freeze({
    target: Object.freeze({ kind: 'synthetic-local', targetId, origin }), origin,
    coordinatorBinding() { live(); return coordinator && structuredClone(coordinator); },
    bindCoordinator(binding) {
      live();
      if (!binding || typeof binding.root !== 'string' || !/^[a-f0-9]{64}$/.test(binding.policyHash ?? '') || !/^[a-f0-9]{64}$/.test(binding.nonce ?? '')) throw fail('PROVISION_STATE_INVALID');
      if (coordinator && canonical(coordinator) !== canonical(binding)) throw fail('PROVISION_STATE_INVALID');
      coordinator = structuredClone(binding);
    },
    async createOwned(owner, password) {
      checkOwner(owner);
      if (!coordinator || owner.policyHash !== coordinator.policyHash) throw fail('PROVISION_POLICY_REFUSED');
      if (operation(owner) || [...operations.values()].some(entry => entry.owner.runId === owner.runId && entry.owner.role === owner.role)) throw fail('PROVISION_REPLAY_REFUSED');
      const current = time(); if (current === null) throw fail('PROVISION_CLOCK_REFUSED');
      if (owner.expiresAt <= current || owner.expiresAt > current + 10 * 60_000) throw fail('PROVISION_EXPIRED');
      if ([...operations.values()].filter(entry => !entry.revoked).length >= 4 || attempts.filter(time => time > current - 60 * 60_000).length >= 10) throw fail('PROVISION_QUOTA_REFUSED');
      attempts.push(current);
      operations.set(owner.operationId, { owner: structuredClone(owner), id: null, revoked: false, deliveryPending: false });
      if (beforeCreate) await beforeCreate(); checkOwner(owner);
      if (operation(owner).revoked) throw fail('PROVISION_REPLAY_REFUSED');
      const committed = time(); if (committed === null) throw fail('PROVISION_CLOCK_REFUSED');
      if (owner.expiresAt <= committed) throw fail('PROVISION_EXPIRED');
      const id = insert({ ...owner, owner, password });
      operations.set(owner.operationId, { owner: structuredClone(owner), id, revoked: false, deliveryPending: false });
      if (createFault) { createFault = false; throw fail('PROVISION_CREATE_UNKNOWN'); } return { id };
    },
    inspectOwned(owner) {
      checkOwner(owner); const entry = operation(owner), user = entry?.id && accounts.get(entry.id);
      if (user && canonical(user.owner) !== canonical(owner)) throw fail('PROVISION_OWNERSHIP_REFUSED');
      return { present: Boolean(user), id: entry?.id ?? null, revoked: entry?.revoked === true, deliveryPending: entry?.deliveryPending === true };
    },
    beginCredentialDelivery(owner) { checkOwner(owner); const entry = operation(owner);
      if (!entry || entry.revoked || entry.deliveryPending || !accounts.has(entry.id)) throw fail('PROVISION_RUN_REFUSED'); entry.deliveryPending = true; },
    endCredentialDelivery(owner) { checkOwner(owner); const entry = operation(owner);
      if (!entry || !entry.deliveryPending) throw fail('PROVISION_RUN_REFUSED'); entry.deliveryPending = false; },
    revokeDeleteOwned(owner) {
      checkOwner(owner); const entry = operation(owner);
      if (!coordinator || owner.policyHash !== coordinator.policyHash) throw fail('PROVISION_POLICY_REFUSED');
      if (deleteFault) throw fail('PROVISION_CLEANUP_INCOMPLETE');
      const user = entry?.id && accounts.get(entry.id);
      if (user && canonical(user.owner) !== canonical(owner)) throw fail('PROVISION_OWNERSHIP_REFUSED');
      // A tombstone also fences a create that has not committed yet.
      operations.set(owner.operationId, { owner: structuredClone(owner), id: entry?.id ?? null, revoked: true, deliveryPending: entry?.deliveryPending === true });
      if (entry?.id) { accounts.delete(entry.id); for (const [token, session] of sessions) if (session.accountId === entry.id) sessions.delete(token); }
    },
    snapshot() { return [...accounts.values()].map(({ id, email, role, owner, expiresAt }) => structuredClone({ id, email, role, owner, expiresAt })); },
    issuedSessionTokens() { return [...issued]; },
    seedForeign({ email, password, role }) { live(); const current = time(); if (current === null) throw fail('PROVISION_CLOCK_REFUSED'); return insert({ email, password, role, expiresAt: current + 60 * 60_000 }); },
    failNextCreateAfterCommit() { createFault = true; }, setDeleteFailure(value) { deleteFault = value === true; },
    async close() { if (closed) return; closed = true; await new Promise((resolve, reject) => { server.close(error => error ? reject(fail('PROVISION_CLEANUP_INCOMPLETE')) : resolve()); server.closeAllConnections(); }); accounts.clear(); sessions.clear(); issued.clear(); },
  });
  instances.add(app); return app;
}
