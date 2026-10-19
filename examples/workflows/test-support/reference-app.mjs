/**
 * In-process reference sandbox app used by the example workflow fixtures and
 * their tests. Dependency-free (`node:http` only), binds `127.0.0.1` on an
 * ephemeral port, and never writes a request, a body, a password or a
 * session token anywhere (no console output, no files). Generated passwords
 * and session tokens live only in the process's memory for the lifetime of
 * the server.
 *
 * This is a fixture, not a demo app: it exists so the workflow runners (the
 * authenticated-smoke and feature-acceptance examples) and their real-broker
 * proofs have a small, deterministic, two-role sandbox to sign into, plus a
 * `faults` knob so tests can force each failure mode the runners are meant
 * to catch.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const REFERENCE_PATHS = Object.freeze({
  login: '/login',
  ready: '/ready',
  me: '/api/me',
  workspace: '/workspace',
  data: '/api/data',
  environment: '/api/test-environment',
  records: '/api/records',
  newRecord: '/records/new',
  createRecord: '/records',
});

export const REFERENCE_HEADING = 'Reference workspace';
export const REFERENCE_FORM = Object.freeze({
  idLabel: 'Record ID',
  titleLabel: 'Title',
  submitLabel: 'Create record',
  createdText: 'Record created',
});
export const REFERENCE_ROLES = Object.freeze({ writer: 'Writer', reader: 'Reader' });
export const RECORD_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

const MAX_BODY_BYTES = 16 * 1024;
const HEADERS_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_COOKIE = 'ref_session';
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function isValidTitle(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && !CONTROL_CHAR_RE.test(value);
}

/** Reject with a null body when the declared or actual size exceeds MAX_BODY_BYTES. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('body too large'), { tooLarge: true }));
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true;
          req.removeListener('data', onData);
          req.removeListener('end', onEnd);
          req.removeListener('error', onError);
          reject(Object.assign(new Error('body too large'), { tooLarge: true }));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

export async function startReferenceApp({ accounts, buildId, environment, runId, dataScope, faults = {} }) {
  /** email (as given) -> account record, including the in-memory-only password. */
  const accountsByEmail = new Map();
  for (const account of accounts) accountsByEmail.set(account.email, { ...account });

  /** session token -> account email. Tokens are 64 lowercase hex characters. */
  const sessions = new Map();
  /** Every token this instance has ever issued (login or mintSession), for leak checks. */
  const issuedTokens = new Set();
  /** record id -> record. */
  const records = new Map();

  let currentFaults = { ...faults };
  const stats = {
    requests: 0,
    logins: 0,
    failedLogins: 0,
    creates: 0,
    mutations: 0,
    deniedMutations: 0,
    deletes: 0,
    byPath: {},
  };

  function issueToken(email) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, email);
    issuedTokens.add(token);
    return token;
  }

  function accountFor(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token === undefined) return null;
    const email = sessions.get(token);
    if (email === undefined) return null;
    return accountsByEmail.get(email) ?? null;
  }

  function foreignScope() {
    return `${dataScope}-foreign`;
  }

  function send(res, status, body, headers = {}) {
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const contentType = typeof body === 'string' ? (headers['content-type'] ?? 'text/html; charset=utf-8') : 'application/json';
    res.writeHead(status, { ...headers, 'content-type': contentType });
    res.end(text);
  }

  function pageShell(title, bodyHtml) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${bodyHtml}</body></html>`;
  }

  function originMismatch(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return false;
    return origin !== appOrigin;
  }

  function recordView(record) {
    return { id: record.id, title: record.title, scope: record.scope, createdBy: record.createdBy, version: record.version };
  }

  function bump(counter) {
    stats[counter] += 1;
  }

  // -------------------------------------------------------------------------
  // Route handlers
  // -------------------------------------------------------------------------

  async function handleLogin(req, res) {
    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch {
      send(res, 413);
      return;
    }
    const form = new URLSearchParams(bodyText);
    const email = form.get('email') ?? '';
    const password = form.get('password') ?? '';
    const account = accountsByEmail.get(email);
    if (account !== undefined && account.password === password) {
      const token = issueToken(email);
      stats.logins += 1;
      send(res, 303, undefined, {
        location: REFERENCE_PATHS.workspace,
        'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return;
    }
    stats.failedLogins += 1;
    send(res, 401);
  }

  function handleReady(res) {
    const status = currentFaults.readinessStatus ?? 200;
    const headerValue = Object.hasOwn(currentFaults, 'buildHeader') ? currentFaults.buildHeader : buildId;
    const headers = headerValue === null || headerValue === undefined ? {} : { 'x-build-id': headerValue };
    send(res, status, undefined, headers);
  }

  function handleMe(res, account) {
    if (account === null) {
      send(res, 401);
      return;
    }
    const role = currentFaults.identityRoleOverride?.[account.email] ?? account.role;
    send(res, 200, { email: account.email, role });
  }

  function handleWorkspace(res, account) {
    if (account === null) {
      send(res, 302, undefined, { location: REFERENCE_PATHS.login });
      return;
    }
    send(res, 200, pageShell(REFERENCE_HEADING, `<h1>${escapeHtml(REFERENCE_HEADING)}</h1>`));
  }

  function handleData(res, account) {
    if (account === null) {
      send(res, 401);
      return;
    }
    send(res, 200, { ok: true });
  }

  function handleEnvironment(res) {
    const override = currentFaults.environmentOverride ?? {};
    send(res, 200, {
      runId: override.runId ?? runId,
      dataScope: override.dataScope ?? dataScope,
      environment: override.environment ?? environment,
      buildId: override.buildId ?? buildId,
    });
  }

  function handleNewRecordForm(res, account) {
    if (account === null) {
      send(res, 302, undefined, { location: REFERENCE_PATHS.login });
      return;
    }
    if (account.role !== REFERENCE_ROLES.writer) {
      send(res, 403);
      return;
    }
    const html = pageShell(
      REFERENCE_FORM.submitLabel,
      `<form method="post" action="${REFERENCE_PATHS.createRecord}">` +
        `<label for="record-id">${escapeHtml(REFERENCE_FORM.idLabel)}</label>` +
        `<input id="record-id" name="id">` +
        `<label for="record-title">${escapeHtml(REFERENCE_FORM.titleLabel)}</label>` +
        `<input id="record-title" name="title">` +
        `<button type="submit">${escapeHtml(REFERENCE_FORM.submitLabel)}</button>` +
        `</form>`,
    );
    send(res, 200, html);
  }

  async function handleCreateRecord(req, res, account) {
    if (originMismatch(req)) {
      send(res, 403);
      return;
    }
    if (account === null) {
      send(res, 401);
      return;
    }
    if (account.role !== REFERENCE_ROLES.writer) {
      send(res, 403);
      return;
    }
    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch {
      send(res, 413);
      return;
    }
    const form = new URLSearchParams(bodyText);
    const id = form.get('id') ?? '';
    const title = form.get('title') ?? '';
    if (!RECORD_ID_RE.test(id) || !isValidTitle(title)) {
      send(res, 400);
      return;
    }
    if (records.has(id)) {
      send(res, 409);
      return;
    }
    if (currentFaults.createNoop !== true) {
      const scope = currentFaults.createScope ?? dataScope;
      records.set(id, { id, title, scope, createdBy: account.email, version: 1 });
      bump('creates');
    }
    send(res, 303, undefined, { location: `/records/${id}/created` });
  }

  function handleCreatedPage(res, account, id) {
    if (account === null) {
      send(res, 302, undefined, { location: REFERENCE_PATHS.login });
      return;
    }
    send(res, 200, pageShell(REFERENCE_FORM.createdText, `<p role="status">${escapeHtml(REFERENCE_FORM.createdText)}</p><p>${escapeHtml(id)}</p>`));
  }

  function handleGetApiRecord(res, account, id) {
    if (account === null) {
      send(res, 401);
      return;
    }
    const record = records.get(id);
    if (record === undefined) {
      if (currentFaults.phantomRecords === true) {
        send(res, 200, { id, title: '(phantom)', scope: foreignScope(), createdBy: 'phantom@example.test', version: 1 });
        return;
      }
      send(res, 404);
      return;
    }
    send(res, 200, recordView(record));
  }

  async function handlePutApiRecord(req, res, account, id) {
    if (originMismatch(req)) {
      send(res, 403);
      return;
    }
    if (account === null) {
      send(res, 401);
      return;
    }
    const record = records.get(id);
    if (record === undefined) {
      send(res, 404);
      return;
    }
    const mutation = currentFaults.readerMutation ?? 'deny';
    const isWriter = account.role === REFERENCE_ROLES.writer;
    const isReader = account.role === REFERENCE_ROLES.reader;
    const allow = isWriter || (isReader && mutation === 'allow');
    const applyAnyway = isReader && mutation === 'deny-but-mutate';
    if (!isWriter && !isReader) {
      send(res, 403);
      return;
    }
    if (!allow && !applyAnyway) {
      bump('deniedMutations');
      send(res, 403);
      return;
    }
    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch {
      send(res, 413);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      send(res, 400);
      return;
    }
    if (!isValidTitle(parsed?.title)) {
      send(res, 400);
      return;
    }
    record.title = parsed.title;
    record.version += 1;
    bump('mutations');
    if (!allow && applyAnyway) {
      bump('deniedMutations');
      send(res, 403);
      return;
    }
    send(res, 200, recordView(record));
  }

  function handleDeleteApiRecord(req, res, account, id) {
    if (originMismatch(req)) {
      send(res, 403);
      return;
    }
    if (account === null) {
      send(res, 401);
      return;
    }
    const record = records.get(id);
    if (record === undefined) {
      send(res, 404);
      return;
    }
    if (account.role !== REFERENCE_ROLES.writer) {
      bump('deniedMutations');
      send(res, 403);
      return;
    }
    if (record.scope !== dataScope) {
      bump('deniedMutations');
      send(res, 403);
      return;
    }
    const mode = currentFaults.deleteMode ?? 'normal';
    if (mode === 'error') {
      send(res, 500);
      return;
    }
    if (mode === 'ignore') {
      send(res, 204);
      return;
    }
    records.delete(id);
    bump('deletes');
    send(res, 204);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async function dispatch(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', appOrigin).pathname;
    } catch {
      send(res, 400);
      return;
    }
    stats.requests += 1;
    stats.byPath[pathname] = (stats.byPath[pathname] ?? 0) + 1;

    const delayMs = currentFaults.delayMs ?? 0;
    const delayPaths = currentFaults.delayPaths;
    if (delayMs > 0 && (delayPaths === null || delayPaths === undefined || delayPaths.some((prefix) => pathname.startsWith(prefix)))) {
      await sleep(delayMs);
    }

    const account = accountFor(req);
    const method = req.method ?? 'GET';

    if (method === 'POST' && pathname === REFERENCE_PATHS.login) return handleLogin(req, res);
    if (method === 'GET' && pathname === REFERENCE_PATHS.ready) return handleReady(res);
    if (method === 'GET' && pathname === REFERENCE_PATHS.me) return handleMe(res, account);
    if (method === 'GET' && pathname === REFERENCE_PATHS.workspace) return handleWorkspace(res, account);
    if (method === 'GET' && pathname === REFERENCE_PATHS.data) return handleData(res, account);
    if (method === 'GET' && pathname === REFERENCE_PATHS.environment) return handleEnvironment(res);
    if (method === 'GET' && pathname === REFERENCE_PATHS.newRecord) return handleNewRecordForm(res, account);
    if (method === 'POST' && pathname === REFERENCE_PATHS.createRecord) return handleCreateRecord(req, res, account);

    const createdMatch = /^\/records\/([^/]+)\/created$/u.exec(pathname);
    if (method === 'GET' && createdMatch) return handleCreatedPage(res, account, createdMatch[1]);

    if (pathname.startsWith(`${REFERENCE_PATHS.records}/`)) {
      const id = pathname.slice(REFERENCE_PATHS.records.length + 1);
      if (id !== '' && !id.includes('/')) {
        if (method === 'GET') return handleGetApiRecord(res, account, id);
        if (method === 'PUT') return handlePutApiRecord(req, res, account, id);
        if (method === 'DELETE') return handleDeleteApiRecord(req, res, account, id);
      }
    }

    send(res, 404);
  }

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch(() => {
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const appOrigin = `http://127.0.0.1:${port}`;

  function close() {
    return new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  return {
    origin: appOrigin,
    port,
    close,
    mintSession(email) {
      if (!accountsByEmail.has(email)) throw new Error('unknown account email');
      return issueToken(email);
    },
    issuedSessionTokens() {
      return [...issuedTokens];
    },
    seedRecord({ id, title, scope, createdBy, version = 1 }) {
      records.set(id, { id, title, scope, createdBy, version });
    },
    records() {
      return [...records.values()].map(recordView);
    },
    stats() {
      return { ...stats, byPath: { ...stats.byPath } };
    },
    setFaults(partial) {
      currentFaults = { ...currentFaults, ...partial };
    },
  };
}
