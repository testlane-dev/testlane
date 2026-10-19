import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REFERENCE_FORM,
  REFERENCE_HEADING,
  REFERENCE_PATHS,
  REFERENCE_ROLES,
  RECORD_ID_RE,
  startReferenceApp,
} from '../reference-app.mjs';

const referenceAppUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../reference-app.mjs')).href;

function accounts() {
  return {
    writer: { email: 'writer@example.test', role: REFERENCE_ROLES.writer, password: 'writer-secret-1' },
    reader: { email: 'reader@example.test', role: REFERENCE_ROLES.reader, password: 'reader-secret-1' },
  };
}

async function withApp(overrides, fn) {
  const { writer, reader } = accounts();
  const app = await startReferenceApp({
    accounts: [writer, reader],
    buildId: 'build-1',
    environment: 'testing',
    runId: 'run-1',
    dataScope: 'scope-1',
    faults: {},
    ...overrides,
  });
  try {
    await fn(app, { writer, reader });
  } finally {
    await app.close();
  }
}

async function login(app, account) {
  const res = await fetch(app.origin + REFERENCE_PATHS.login, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: account.email, password: account.password }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303, 'expected login to succeed for this helper');
  const setCookie = res.headers.get('set-cookie');
  return setCookie.split(';')[0];
}

// ---------------------------------------------------------------------------
// Login and cookie flags
// ---------------------------------------------------------------------------

test('login: correct credentials issue a 303 with a well-formed session cookie', async () => {
  await withApp({}, async (app, { writer }) => {
    const res = await fetch(app.origin + REFERENCE_PATHS.login, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: writer.email, password: writer.password }),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), REFERENCE_PATHS.workspace);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^ref_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax$/);
  });
});

test('login: wrong password or unknown email is refused with 401 and no cookie', async () => {
  await withApp({}, async (app, { writer }) => {
    const wrong = await fetch(app.origin + REFERENCE_PATHS.login, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: writer.email, password: 'not-the-password' }),
      redirect: 'manual',
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const unknown = await fetch(app.origin + REFERENCE_PATHS.login, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'nobody@example.test', password: 'x' }),
      redirect: 'manual',
    });
    assert.equal(unknown.status, 401);

    assert.equal(app.stats().failedLogins, 2);
    assert.equal(app.stats().logins, 0);
  });
});

// ---------------------------------------------------------------------------
// Anonymous access
// ---------------------------------------------------------------------------

test('anonymous requests: JSON endpoints 401, HTML pages redirect 302 to /login', async () => {
  await withApp({}, async (app) => {
    const me = await fetch(app.origin + REFERENCE_PATHS.me);
    assert.equal(me.status, 401);

    const data = await fetch(app.origin + REFERENCE_PATHS.data);
    assert.equal(data.status, 401);

    const workspace = await fetch(app.origin + REFERENCE_PATHS.workspace, { redirect: 'manual' });
    assert.equal(workspace.status, 302);
    assert.equal(workspace.headers.get('location'), REFERENCE_PATHS.login);

    const newRecord = await fetch(app.origin + REFERENCE_PATHS.newRecord, { redirect: 'manual' });
    assert.equal(newRecord.status, 302);

    const record = await fetch(`${app.origin}${REFERENCE_PATHS.records}/some-record-id`);
    assert.equal(record.status, 401);

    const create = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: 'anon-record-id', title: 'x' }),
      redirect: 'manual',
    });
    assert.equal(create.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Role authorization for create / PUT / DELETE
// ---------------------------------------------------------------------------

test('role authorization: reader cannot create records, writer can', async () => {
  await withApp({}, async (app, { writer, reader }) => {
    const writerCookie = await login(app, writer);
    const readerCookie = await login(app, reader);

    const readerForm = await fetch(app.origin + REFERENCE_PATHS.newRecord, { headers: { cookie: readerCookie } });
    assert.equal(readerForm.status, 403);

    const readerCreate = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: readerCookie },
      body: new URLSearchParams({ id: 'reader-record-id', title: 'nope' }),
      redirect: 'manual',
    });
    assert.equal(readerCreate.status, 403);

    const writerForm = await fetch(app.origin + REFERENCE_PATHS.newRecord, { headers: { cookie: writerCookie } });
    assert.equal(writerForm.status, 200);
    const formHtml = await writerForm.text();
    assert.ok(formHtml.includes(REFERENCE_FORM.idLabel));
    assert.ok(formHtml.includes(REFERENCE_FORM.titleLabel));
    assert.ok(formHtml.includes(`>${REFERENCE_FORM.submitLabel}<`));
    assert.ok(formHtml.includes(`action="${REFERENCE_PATHS.createRecord}"`));

    const writerCreate = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: writerCookie },
      body: new URLSearchParams({ id: 'writer-record-id', title: 'ok' }),
      redirect: 'manual',
    });
    assert.equal(writerCreate.status, 303);
    assert.equal(writerCreate.headers.get('location'), '/records/writer-record-id/created');

    const createdPage = await fetch(`${app.origin}/records/writer-record-id/created`, { headers: { cookie: readerCookie } });
    assert.equal(createdPage.status, 200);
    const createdHtml = await createdPage.text();
    assert.ok(createdHtml.includes(REFERENCE_FORM.createdText));
  });
});

test('role authorization: PUT and DELETE default to writer-only, reader is refused without mutating', async () => {
  await withApp({}, async (app, { writer, reader }) => {
    const writerCookie = await login(app, writer);
    const readerCookie = await login(app, reader);
    app.seedRecord({ id: 'seeded-record-a', title: 'Original', scope: 'scope-1', createdBy: writer.email });

    const deniedPut = await fetch(`${app.origin}${REFERENCE_PATHS.records}/seeded-record-a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: readerCookie },
      body: JSON.stringify({ title: 'Reader tried' }),
    });
    assert.equal(deniedPut.status, 403);

    const afterDeniedPut = await fetch(`${app.origin}${REFERENCE_PATHS.records}/seeded-record-a`, { headers: { cookie: writerCookie } });
    const unchanged = await afterDeniedPut.json();
    assert.equal(unchanged.title, 'Original');
    assert.equal(unchanged.version, 1);

    const deniedDelete = await fetch(`${app.origin}${REFERENCE_PATHS.records}/seeded-record-a`, {
      method: 'DELETE',
      headers: { cookie: readerCookie },
    });
    assert.equal(deniedDelete.status, 403);

    const writerPut = await fetch(`${app.origin}${REFERENCE_PATHS.records}/seeded-record-a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: writerCookie },
      body: JSON.stringify({ title: 'Writer updated' }),
    });
    assert.equal(writerPut.status, 200);
    const updated = await writerPut.json();
    assert.equal(updated.title, 'Writer updated');
    assert.equal(updated.version, 2);

    const writerDelete = await fetch(`${app.origin}${REFERENCE_PATHS.records}/seeded-record-a`, {
      method: 'DELETE',
      headers: { cookie: writerCookie },
    });
    assert.equal(writerDelete.status, 204);

    const goneNow = await fetch(`${app.origin}${REFERENCE_PATHS.records}/seeded-record-a`, { headers: { cookie: writerCookie } });
    assert.equal(goneNow.status, 404);
  });
});

test('DELETE refuses a record whose scope does not match the app dataScope, without deleting it', async () => {
  await withApp({}, async (app, { writer }) => {
    const writerCookie = await login(app, writer);
    app.seedRecord({ id: 'foreign-record-a', title: 'Foreign', scope: 'other-scope', createdBy: writer.email });

    const res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/foreign-record-a`, {
      method: 'DELETE',
      headers: { cookie: writerCookie },
    });
    assert.equal(res.status, 403);

    const stillThere = await fetch(`${app.origin}${REFERENCE_PATHS.records}/foreign-record-a`, { headers: { cookie: writerCookie } });
    assert.equal(stillThere.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Origin-mismatch refusal on mutating requests
// ---------------------------------------------------------------------------

test('Origin-mismatch: a mutating request with a foreign Origin header is refused with 403', async () => {
  await withApp({}, async (app, { writer }) => {
    const writerCookie = await login(app, writer);
    const foreignOrigin = 'https://attacker.example.test';

    const create = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: writerCookie, origin: foreignOrigin },
      body: new URLSearchParams({ id: 'origin-mismatch-id', title: 'x' }),
      redirect: 'manual',
    });
    assert.equal(create.status, 403);

    app.seedRecord({ id: 'origin-mismatch-put', title: 'Original', scope: 'scope-1', createdBy: writer.email });
    const put = await fetch(`${app.origin}${REFERENCE_PATHS.records}/origin-mismatch-put`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: writerCookie, origin: foreignOrigin },
      body: JSON.stringify({ title: 'nope' }),
    });
    assert.equal(put.status, 403);

    app.seedRecord({ id: 'origin-mismatch-delete', title: 'Original', scope: 'scope-1', createdBy: writer.email });
    const del = await fetch(`${app.origin}${REFERENCE_PATHS.records}/origin-mismatch-delete`, {
      method: 'DELETE',
      headers: { cookie: writerCookie, origin: foreignOrigin },
    });
    assert.equal(del.status, 403);
    assert.equal(
      app.records().some((r) => r.id === 'origin-mismatch-delete'),
      true,
      'a foreign-Origin DELETE must be refused without deleting the record',
    );

    // A matching Origin (or none at all) is unaffected.
    const ok = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: writerCookie, origin: app.origin },
      body: new URLSearchParams({ id: 'origin-match-id', title: 'x' }),
      redirect: 'manual',
    });
    assert.equal(ok.status, 303);

    const sameOriginDelete = await fetch(`${app.origin}${REFERENCE_PATHS.records}/origin-mismatch-delete`, {
      method: 'DELETE',
      headers: { cookie: writerCookie, origin: app.origin },
    });
    assert.equal(sameOriginDelete.status, 204);

    app.seedRecord({ id: 'origin-absent-delete', title: 'Original', scope: 'scope-1', createdBy: writer.email });
    const absentOriginDelete = await fetch(`${app.origin}${REFERENCE_PATHS.records}/origin-absent-delete`, {
      method: 'DELETE',
      headers: { cookie: writerCookie },
    });
    assert.equal(absentOriginDelete.status, 204);
  });
});

// ---------------------------------------------------------------------------
// id / title validation, 409 conflict, version increments
// ---------------------------------------------------------------------------

test('record id must match RECORD_ID_RE and title must be 1..200 chars with no control characters', async () => {
  assert.equal(RECORD_ID_RE.test('ab-c'), false, 'too short to be a realistic fixture (sanity check on the regex itself)');
  await withApp({}, async (app, { writer }) => {
    const cookie = await login(app, writer);

    const badId = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'NOT-LOWERCASE', title: 'ok title' }),
      redirect: 'manual',
    });
    assert.equal(badId.status, 400);

    const emptyTitle = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'valid-record-id', title: '' }),
      redirect: 'manual',
    });
    assert.equal(emptyTitle.status, 400);

    const controlCharTitle = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'valid-record-id-2', title: 'bad\u0007title' }),
      redirect: 'manual',
    });
    assert.equal(controlCharTitle.status, 400);

    const tooLongTitle = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'valid-record-id-3', title: 'x'.repeat(201) }),
      redirect: 'manual',
    });
    assert.equal(tooLongTitle.status, 400);

    assert.equal(app.stats().creates, 0);
  });
});

test('creating a record with an id already in use returns 409 and does not overwrite it', async () => {
  await withApp({}, async (app, { writer }) => {
    const cookie = await login(app, writer);
    const create = (title) =>
      fetch(app.origin + REFERENCE_PATHS.createRecord, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ id: 'duplicate-record-id', title }),
        redirect: 'manual',
      });

    const first = await create('First');
    assert.equal(first.status, 303);
    const second = await create('Second');
    assert.equal(second.status, 409);

    const stored = await fetch(`${app.origin}${REFERENCE_PATHS.records}/duplicate-record-id`, { headers: { cookie } });
    assert.equal((await stored.json()).title, 'First');
  });
});

test('version increments by exactly one on each successful PUT', async () => {
  await withApp({}, async (app, { writer }) => {
    const cookie = await login(app, writer);
    app.seedRecord({ id: 'versioned-record', title: 'v1', scope: 'scope-1', createdBy: writer.email });

    let last = 1;
    for (const title of ['v2', 'v3', 'v4']) {
      const res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/versioned-record`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.version, last + 1);
      assert.equal(body.title, title);
      last = body.version;
    }
  });
});

test('PUT on a missing record is 404; invalid JSON or title on an existing record is 400', async () => {
  await withApp({}, async (app, { writer }) => {
    const cookie = await login(app, writer);
    const missing = await fetch(`${app.origin}${REFERENCE_PATHS.records}/does-not-exist`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(missing.status, 404);

    app.seedRecord({ id: 'invalid-body-record', title: 'orig', scope: 'scope-1', createdBy: writer.email });
    const badJson = await fetch(`${app.origin}${REFERENCE_PATHS.records}/invalid-body-record`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);

    const badTitle = await fetch(`${app.origin}${REFERENCE_PATHS.records}/invalid-body-record`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(badTitle.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Environment endpoint
// ---------------------------------------------------------------------------

test('GET /api/test-environment is anonymous and reflects the configured run', async () => {
  await withApp({}, async (app) => {
    const res = await fetch(app.origin + REFERENCE_PATHS.environment);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      runId: 'run-1',
      dataScope: 'scope-1',
      environment: 'testing',
      buildId: 'build-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Fault toggles
// ---------------------------------------------------------------------------

test('fault identityRoleOverride only changes what /api/me reports, not real authorization', async () => {
  await withApp({}, async (app, { writer }) => {
    const cookie = await login(app, writer);
    app.setFaults({ identityRoleOverride: { [writer.email]: 'Reader' } });

    const me = await fetch(app.origin + REFERENCE_PATHS.me, { headers: { cookie } });
    assert.equal((await me.json()).role, 'Reader');

    // Real authorization still uses the account's true role (Writer): record creation still works.
    const create = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'still-writer-record', title: 'x' }),
      redirect: 'manual',
    });
    assert.equal(create.status, 303);
  });
});

test('fault readinessStatus and buildHeader override /ready', async () => {
  await withApp({}, async (app) => {
    app.setFaults({ readinessStatus: 503 });
    let res = await fetch(app.origin + REFERENCE_PATHS.ready);
    assert.equal(res.status, 503);

    app.setFaults({ readinessStatus: 200, buildHeader: 'overridden-build' });
    res = await fetch(app.origin + REFERENCE_PATHS.ready);
    assert.equal(res.headers.get('x-build-id'), 'overridden-build');

    app.setFaults({ buildHeader: null });
    res = await fetch(app.origin + REFERENCE_PATHS.ready);
    assert.equal(res.headers.has('x-build-id'), false);

    assert.equal(res.status, 200, 'readiness never redirects');
  });
});

test('fault environmentOverride replaces individual fields of /api/test-environment', async () => {
  await withApp({}, async (app) => {
    app.setFaults({ environmentOverride: { runId: 'lying-run-id' } });
    const res = await fetch(app.origin + REFERENCE_PATHS.environment);
    const body = await res.json();
    assert.equal(body.runId, 'lying-run-id');
    assert.equal(body.dataScope, 'scope-1');
    assert.equal(body.environment, 'testing');
    assert.equal(body.buildId, 'build-1');
  });
});

test('fault phantomRecords returns a 200 foreign-scope record for an unknown id and stores nothing', async () => {
  await withApp({ faults: { phantomRecords: true } }, async (app, { writer }) => {
    const cookie = await login(app, writer);
    const res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/never-created`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.scope, 'scope-1');
    assert.equal(app.records().some((r) => r.id === 'never-created'), false);
  });
});

test('fault createNoop redirects to the created page but stores nothing', async () => {
  await withApp({ faults: { createNoop: true } }, async (app, { writer }) => {
    const cookie = await login(app, writer);
    const res = await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'noop-record-id', title: 'x' }),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.equal(app.records().some((r) => r.id === 'noop-record-id'), false);
    assert.equal(app.stats().creates, 0);
  });
});

test('fault createScope stores newly created records under a different scope', async () => {
  await withApp({ faults: { createScope: 'other-scope' } }, async (app, { writer }) => {
    const cookie = await login(app, writer);
    await fetch(app.origin + REFERENCE_PATHS.createRecord, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ id: 'scoped-record-id', title: 'x' }),
      redirect: 'manual',
    });
    const record = app.records().find((r) => r.id === 'scoped-record-id');
    assert.equal(record.scope, 'other-scope');
  });
});

test('fault readerMutation allow/deny-but-mutate change reader PUT outcomes', async () => {
  await withApp({}, async (app, { writer, reader }) => {
    const writerCookie = await login(app, writer);
    const readerCookie = await login(app, reader);

    app.seedRecord({ id: 'rm-allow', title: 'orig', scope: 'scope-1', createdBy: writer.email });
    app.setFaults({ readerMutation: 'allow' });
    let res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/rm-allow`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: readerCookie },
      body: JSON.stringify({ title: 'reader wrote this' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, 2);

    app.seedRecord({ id: 'rm-deny-but-mutate', title: 'orig', scope: 'scope-1', createdBy: writer.email });
    app.setFaults({ readerMutation: 'deny-but-mutate' });
    res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/rm-deny-but-mutate`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: readerCookie },
      body: JSON.stringify({ title: 'sneaky' }),
    });
    assert.equal(res.status, 403);
    const after = await fetch(`${app.origin}${REFERENCE_PATHS.records}/rm-deny-but-mutate`, { headers: { cookie: writerCookie } });
    const afterBody = await after.json();
    assert.equal(afterBody.title, 'sneaky', 'the fault claims denial but still mutates the record underneath');
    assert.equal(afterBody.version, 2);
  });
});

test('fault deleteMode error/ignore change DELETE outcomes without a normal deletion', async () => {
  await withApp({}, async (app, { writer }) => {
    const cookie = await login(app, writer);

    app.seedRecord({ id: 'dm-error', title: 'x', scope: 'scope-1', createdBy: writer.email });
    app.setFaults({ deleteMode: 'error' });
    let res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/dm-error`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 500);
    assert.equal(app.records().some((r) => r.id === 'dm-error'), true);

    app.seedRecord({ id: 'dm-ignore', title: 'x', scope: 'scope-1', createdBy: writer.email });
    app.setFaults({ deleteMode: 'ignore' });
    res = await fetch(`${app.origin}${REFERENCE_PATHS.records}/dm-ignore`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 204);
    assert.equal(app.records().some((r) => r.id === 'dm-ignore'), true, 'ignore mode keeps the record despite a 204');
  });
});

test('fault delayMs/delayPaths delays only matching paths', async () => {
  await withApp({ faults: { delayMs: 40, delayPaths: [REFERENCE_PATHS.data] } }, async (app, { writer }) => {
    const cookie = await login(app, writer);

    const fastStart = Date.now();
    await fetch(app.origin + REFERENCE_PATHS.me, { headers: { cookie } });
    const fastElapsed = Date.now() - fastStart;

    const slowStart = Date.now();
    await fetch(app.origin + REFERENCE_PATHS.data, { headers: { cookie } });
    const slowElapsed = Date.now() - slowStart;

    assert.ok(slowElapsed >= 35, `expected the delayed path to take at least ~40ms, took ${slowElapsed}ms`);
    assert.ok(slowElapsed > fastElapsed, `expected the delayed path (${slowElapsed}ms) to be slower than the non-delayed one (${fastElapsed}ms)`);
  });
});

// ---------------------------------------------------------------------------
// mintSession / issuedSessionTokens / stats
// ---------------------------------------------------------------------------

test('mintSession issues a working cookie and is tracked by issuedSessionTokens', async () => {
  await withApp({}, async (app, { reader }) => {
    const token = app.mintSession(reader.email);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(app.issuedSessionTokens().includes(token));

    const res = await fetch(app.origin + REFERENCE_PATHS.me, { headers: { cookie: `ref_session=${token}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).email, reader.email);
  });
});

test('mintSession refuses an unknown account email', async () => {
  await withApp({}, async (app) => {
    assert.throws(() => app.mintSession('nobody@example.test'));
  });
});

// ---------------------------------------------------------------------------
// Leak safety: the app never writes to stdout/stderr
// ---------------------------------------------------------------------------

test('the reference app never writes to stdout or stderr, across a broad mix of requests', async () => {
  // Run in a dedicated child process (fork, silent:true) rather than
  // monkey-patching process.stdout/stderr in this test process: node's own
  // test runner interleaves its TAP reporting on those same streams between
  // awaited ticks, which would produce false positives. A forked child's
  // stdio is redirected to pipes nothing else writes to, so any byte on
  // either pipe can only have come from the app itself.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'testlane-leak-safety-'));
  const scriptPath = path.join(tmpDir, 'exercise.mjs');
  const script = `
    import { REFERENCE_PATHS, REFERENCE_ROLES, startReferenceApp } from ${JSON.stringify(referenceAppUrl)};
    const writer = { email: 'writer@example.test', role: REFERENCE_ROLES.writer, password: 'writer-secret-1' };
    const reader = { email: 'reader@example.test', role: REFERENCE_ROLES.reader, password: 'reader-secret-1' };
    const app = await startReferenceApp({ accounts: [writer, reader], buildId: 'build-1', environment: 'testing', runId: 'run-1', dataScope: 'scope-1' });
    async function login(account) {
      const res = await fetch(app.origin + REFERENCE_PATHS.login, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: account.email, password: account.password }), redirect: 'manual' });
      return res.headers.get('set-cookie').split(';')[0];
    }
    const cookie = await login(writer);
    const readerCookie = await login(reader);
    await fetch(app.origin + REFERENCE_PATHS.login, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: writer.email, password: 'definitely-wrong' }), redirect: 'manual' });
    await fetch(app.origin + REFERENCE_PATHS.ready);
    await fetch(app.origin + REFERENCE_PATHS.me, { headers: { cookie } });
    await fetch(app.origin + REFERENCE_PATHS.workspace, { headers: { cookie } });
    await fetch(app.origin + REFERENCE_PATHS.environment);
    await fetch(app.origin + REFERENCE_PATHS.createRecord, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ id: 'leak-check-record', title: 'x' }), redirect: 'manual' });
    await fetch(\`\${app.origin}\${REFERENCE_PATHS.records}/leak-check-record\`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: readerCookie }, body: JSON.stringify({ title: 'nope' }) });
    await fetch(\`\${app.origin}\${REFERENCE_PATHS.records}/leak-check-record\`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: 'not json at all' });
    await fetch(\`\${app.origin}\${REFERENCE_PATHS.records}/does-not-exist\`, { headers: { cookie } });
    await fetch(app.origin + REFERENCE_PATHS.createRecord, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ id: 'oversized-record', title: 'x'.repeat(20000) }), redirect: 'manual' }).catch(() => {});
    await fetch(\`\${app.origin}/nonexistent-path\`);
    await app.close();
    process.exitCode = 0;
  `;
  await writeFile(scriptPath, script, 'utf8');
  try {
    const result = await new Promise((resolve, reject) => {
      const child = fork(scriptPath, [], { silent: true, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.once('close', (code) => resolve({ code, stdout, stderr }));
      child.once('error', reject);
    });
    assert.equal(result.stdout, '', 'the reference app must never write to stdout');
    assert.equal(result.stderr, '', 'the reference app must never write to stderr');
    assert.equal(result.code, 0, 'the exercising child process should exit cleanly');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('close() stops accepting connections', async () => {
  const { writer } = accounts();
  const app = await startReferenceApp({ accounts: [writer], buildId: 'b', environment: 'testing', runId: 'r', dataScope: 's' });
  const origin = app.origin;
  await app.close();
  await assert.rejects(() => fetch(origin + REFERENCE_PATHS.ready, { signal: AbortSignal.timeout(2000) }));
});
