/** Real next-auth v4 Node API fixture, not a Next.js/App Router deployment. */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, TTL_MS, UUID } from '../contracts.mjs';
import { createSupabaseAuthority, requireSupabaseTarget, supabaseIdentity } from './authority.mjs';

export const NEXTAUTH_VERSION = '4.24.15';
export const isNextAuthSupabaseApp = value => instances.has(value);
const instances = new WeakSet(), HERE = path.dirname(fileURLToPath(import.meta.url));
// The public v4 Node handler reads this origin from process.env per request.
// A single fixture lease prevents one local fixture from borrowing another's origin.
let originLease = false;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const SESSION_COOKIE = 'next-auth.session-token';

async function loadNextAuth(requested) {
  try {
    if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw fail();
    const root = path.resolve(requested);
    if (!same(await realpath(root), root) || (await lstat(root)).isSymbolicLink()) throw fail();
    const marker = JSON.parse(await readFile(path.join(root, 'supabase-tools.json'), 'utf8'));
    if (marker.schemaVersion !== 1 || marker.complete !== true) throw fail();
    for (const file of ['package.json', 'package-lock.json']) {
      const bytes = await readFile(path.join(root, file));
      if (hash(bytes) !== hash(await readFile(path.join(HERE, 'tools', file))) || marker.packageSha256?.[file] !== hash(bytes)) throw fail();
    }
    const packageFile = path.join(root, 'node_modules', 'next-auth', 'package.json');
    if (!same(await realpath(packageFile), packageFile) || JSON.parse(await readFile(packageFile, 'utf8')).version !== NEXTAUTH_VERSION) throw fail();
    const require = createRequire(path.join(root, 'package.json'));
    const entry = require.resolve('next-auth'), provider = require.resolve('next-auth/providers/credentials');
    for (const file of [entry, provider]) if (!same(await realpath(file), file) || !file.startsWith(path.join(root, 'node_modules', 'next-auth') + path.sep)) throw fail();
    const library = require('next-auth'), Credentials = require('next-auth/providers/credentials').default;
    if (typeof library.default !== 'function' || typeof library.getServerSession !== 'function' || typeof Credentials !== 'function') throw fail();
    return { NextAuth: library.default, getServerSession: library.getServerSession, Credentials };
  } catch { throw fail('PROVISION_TARGET_REFUSED'); }
}

/** Bounded plain Cookie parsing for the documented NextApi req.cookies surface. */
export function parseNextAuthCookies(header) {
  if (header === undefined) return Object.create(null);
  if (typeof header !== 'string' || header.length > 16_384 || /[\r\n\0]/.test(header)) throw fail('PROVISION_INPUT_REFUSED');
  const cookies = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('='), name = part.slice(0, index).trim();
    if (index < 1 || !/^[A-Za-z0-9_.-]{1,128}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(cookies, name)) throw fail('PROVISION_INPUT_REFUSED');
    let value;
    try { value = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { throw fail('PROVISION_INPUT_REFUSED'); }
    if (/[\r\n\0]/.test(value)) throw fail('PROVISION_INPUT_REFUSED');
    cookies[name] = value;
  }
  return cookies;
}

export function parseNextAuthForm(text, origin) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) throw fail('PROVISION_INPUT_REFUSED');
  const values = Object.create(null), allowed = ['csrfToken', 'email', 'password', 'json', 'callbackUrl'];
  for (const [key, value] of new URLSearchParams(text)) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw fail('PROVISION_INPUT_REFUSED');
    values[key] = value;
  }
  if (Object.keys(values).length !== allowed.length || !/^[a-f0-9]{64}$/.test(values.csrfToken ?? '') ||
    typeof values.email !== 'string' || values.email.length < 1 || values.email.length > 254 || /[\r\n\0]/.test(values.email) ||
    typeof values.password !== 'string' || values.password.length < 1 || values.password.length > 256 ||
    values.json !== 'true' || values.callbackUrl !== origin) throw fail('PROVISION_INPUT_REFUSED');
  return values;
}

async function body(request, origin) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw fail('PROVISION_INPUT_REFUSED');
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; if (length > 4096) throw fail('PROVISION_INPUT_REFUSED'); chunks.push(chunk); }
  return parseNextAuthForm(Buffer.concat(chunks).toString('utf8'), origin);
}
function send(response, status, value) {
  response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}
export function isSensitiveNextAuthCookie(name, value, origin) {
  // v4 also sets this public redirect destination. Every other cookie, including
  // an unexpected callback value, remains a canary rather than a broad exclusion.
  return !(name === 'next-auth.callback-url' && value === origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? ''));
}
function adaptResponse(response, issued, origin) {
  const setHeader = response.setHeader.bind(response);
  response.setHeader = (name, value) => {
    if (name.toLowerCase() === 'set-cookie') for (const cookie of Array.isArray(value) ? value : [value]) {
      const pair = String(cookie).split(';', 1)[0], index = pair.indexOf('=');
      if (index > 0 && pair.slice(index + 1)) {
        const name = pair.slice(0, index), decoded = decodeURIComponent(pair.slice(index + 1));
        if (isSensitiveNextAuthCookie(name, decoded, origin)) issued.add(decoded);
      }
    }
    return setHeader(name, value);
  };
  response.status = code => { response.statusCode = code; return response; };
  response.json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); return response; };
  response.send = value => {
    if (value === undefined) response.end();
    else if (typeof value === 'string' || Buffer.isBuffer(value)) response.end(value);
    else response.json(value);
    return response;
  };
}
async function settleWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('PROVISION_CLEANUP_INCOMPLETE')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function startNextAuthSupabaseApp({ runtime, releaseId, toolsRoot } = {}) {
  requireSupabaseTarget(runtime, releaseId);
  if (originLease) throw fail('PROVISION_STATE_LOCKED');
  originLease = true;
  const previousOrigin = process.env.NEXTAUTH_URL, hadOrigin = Object.hasOwn(process.env, 'NEXTAUTH_URL');
  let restored = false;
  const restoreOrigin = () => {
    if (restored) return; restored = true;
    if (hadOrigin) process.env.NEXTAUTH_URL = previousOrigin; else delete process.env.NEXTAUTH_URL;
    originLease = false;
  };
  let server;
  try {
    const { NextAuth, getServerSession, Credentials } = await loadNextAuth(toolsRoot);
    const secret = randomBytes(48).toString('base64url'), issued = new Set([secret]), active = new Set();
    let origin, closed = false, closePromise;
    const live = () => { if (closed) throw fail('PROVISION_APP_CLOSED'); };
    const authority = createSupabaseAuthority({ runtime, releaseId, assertLive: live });
    async function grantFor(id, email) {
      live(); if (!UUID.test(id ?? '') || typeof email !== 'string') return null;
      const grant = supabaseIdentity(await runtime.ledger('identity', id));
      return !closed && grant?.email === email ? grant : null;
    }
    const options = {
      secret, debug: false, useSecureCookies: false,
      session: { strategy: 'jwt', maxAge: TTL_MS / 1000 }, jwt: { maxAge: TTL_MS / 1000 },
      cookies: { sessionToken: { name: SESSION_COOKIE, options: { httpOnly: true, sameSite: 'strict', path: '/', secure: false } } },
      logger: { error() {}, warn() {}, debug() {} },
      providers: [Credentials({
        name: 'Local test account', credentials: { email: { type: 'text' }, password: { type: 'password' } },
        async authorize(credentials) {
          live();
          if (typeof credentials?.email !== 'string' || typeof credentials.password !== 'string') return null;
          const result = await runtime.signIn(credentials.email, credentials.password);
          if (result.status !== 200 || !UUID.test(result.user?.id ?? '') || result.user.email !== credentials.email) return null;
          const grant = await grantFor(result.user.id, result.user.email);
          // The provider JWT/refresh token never enters the framework user or cookie.
          return grant ? { id: grant.id, email: grant.email } : null;
        },
      })],
      callbacks: {
        async redirect() { return origin; },
        async jwt({ token, user }) {
          const id = user?.id ?? token.sub, email = user?.email ?? token.email;
          return UUID.test(id ?? '') && typeof email === 'string' ? { sub: id, email } : {};
        },
        async session({ token, session }) {
          const grant = await grantFor(token.sub, token.email);
          return grant ? { user: { id: grant.id, email: grant.email, role: grant.role }, expires: session.expires } : null;
        },
      },
    };
    async function handle(request, response) {
      adaptResponse(response, issued, origin); response.setHeader('Cache-Control', 'no-store');
      if (closed || process.env.NEXTAUTH_URL !== origin || request.headers.host !== new URL(origin).host ||
        request.headers.origin && request.headers.origin !== origin || Object.keys(request.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'))) return send(response, 403, { error: 'ORIGIN_REFUSED' });
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.search || url.hash) return send(response, 400, { error: 'REQUEST_INVALID' });
      request.cookies = parseNextAuthCookies(request.headers.cookie);
      const routes = { '/api/auth/csrf': ['GET', ['csrf']], '/api/auth/callback/credentials': ['POST', ['callback', 'credentials']], '/api/auth/session': ['GET', ['session']] };
      if (Object.hasOwn(routes, url.pathname)) {
        const [method, nextauth] = routes[url.pathname];
        if (request.method !== method) return send(response, 405, { error: 'METHOD_REFUSED' });
        request.query = { nextauth };
        if (method === 'POST') request.body = await body(request, origin);
        return NextAuth(request, response, options);
      }
      if (!['/api/me', '/api/editor-only', '/api/reviewer-only'].includes(url.pathname)) return send(response, 404, { error: 'NOT_FOUND' });
      if (request.method !== 'GET') return send(response, 405, { error: 'METHOD_REFUSED' });
      const session = await getServerSession(request, response, options);
      const grant = session?.user && await grantFor(session.user.id, session.user.email);
      if (!grant) return send(response, 401, { error: 'AUTHENTICATION_REQUIRED' });
      if (url.pathname === '/api/me') return send(response, 200, { email: grant.email, role: grant.role });
      const allowed = url.pathname === '/api/editor-only' ? 'Editor' : 'Reviewer';
      return send(response, grant.role === allowed ? 200 : 403, grant.role === allowed ? { ok: true } : { error: 'ROLE_REFUSED' });
    }
    server = createServer((request, response) => {
      const pending = handle(request, response).catch(() => {
        if (!response.headersSent) send(response, 400, { error: 'REQUEST_INVALID' }); else response.destroy();
      });
      active.add(pending); void pending.finally(() => active.delete(pending));
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port; process.env.NEXTAUTH_URL = origin;
    const app = Object.freeze({
      target: Object.freeze({ kind: 'supabase-local', targetId: runtime.targetId, origin }), origin,
      authentication: Object.freeze({ kind: 'nextauth-credentials', library: 'next-auth', version: NEXTAUTH_VERSION, scope: 'Node NextApi-compatible library fixture' }),
      ...authority,
      issuedSessionTokens() { return [...issued]; },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = settleWithin((async () => {
          await new Promise((resolve, reject) => { server.close(error => error ? reject(fail('PROVISION_CLEANUP_INCOMPLETE')) : resolve()); server.closeAllConnections(); });
          await Promise.allSettled([...active]);
          issued.clear(); restoreOrigin();
        })(), 20_000);
        return closePromise;
      },
    });
    instances.add(app); return app;
  } catch {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    restoreOrigin(); throw fail('PROVISION_TARGET_REFUSED');
  }
}
