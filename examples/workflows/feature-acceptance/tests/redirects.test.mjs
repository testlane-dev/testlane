import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { cleanupReceiptDirs, reportFor, runCase, setupCase, stepFor } from './helpers.mjs';

after(cleanupReceiptDirs);

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function redirectCase(t, { at, roundtrip }) {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  let proxyOrigin;
  let externalHits = 0;
  const identity = at === 'reader-identity' ? setup.reader : setup.writer;
  const foreignOrigin = await listen(t, (req, res) => {
    externalHits += 1;
    if (roundtrip) { res.writeHead(302, { location: proxyOrigin + req.url }); res.end(); return; }
    if (req.url === setup.workflow.checks.identityPath) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ email: identity.email, role: identity.role }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Matching external page</title><p>Record created</p>');
  });
  let rootVisits = 0;
  let redirected = false;
  proxyOrigin = await listen(t, (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') rootVisits += 1;
    const redirectNavigation = !redirected && req.method === 'GET' && (
      (at === 'writer-identity' && pathname === '/' && rootVisits === 1) ||
      (at === 'reader-identity' && pathname === '/' && rootVisits === 2) ||
      (at === 'create-page' && pathname === setup.workflow.record.createPagePath)
    );
    if (redirectNavigation) {
      redirected = true;
      res.writeHead(302, { location: foreignOrigin + req.url }); res.end(); return;
    }
    const headers = { ...req.headers };
    // The proxy is part of this test app. Keep its upstream form-origin check.
    if (headers.origin === proxyOrigin) headers.origin = setup.app.origin;
    const upstream = http.request(new URL(req.url, setup.app.origin), { method: req.method, headers }, (response) => {
      const responseHeaders = { ...response.headers };
      if (at === 'submit' && req.method === 'POST' && pathname === '/records' && response.statusCode === 303) {
        redirected = true;
        responseHeaders.location = foreignOrigin + response.headers.location;
      }
      res.writeHead(response.statusCode, responseHeaders);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  setup.workflow = { ...setup.workflow, target: { ...setup.workflow.target, origin: proxyOrigin } };
  setup.receipt = { ...setup.receipt, origin: proxyOrigin };
  setup.ipcConfig = { ...setup.ipcConfig, origin: proxyOrigin, profiles: setup.profiles.map((profile) => ({ ...profile, baseUrl: proxyOrigin })) };
  const run = await runCase(setup);
  assert.equal(redirected, true, 'fixture must emit the server redirect');
  assert.ok(externalHits > 0, 'server redirects bypass the route callback; this is validation, not network containment');
  const step = at === 'create-page' || at === 'submit' ? 'browser-create' : at;
  assert.equal(stepFor(run.steps, step)?.status, 'failed');
  assert.equal(stepFor(run.steps, step)?.code, 'ASSERTION_FAILED');
  assert.equal(stepFor(run.steps, 'api-readback'), undefined);
  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'failed');
  assert.equal(report.cleanup.status, 'complete');
  assert.equal(report.cleanup.record, at === 'submit' ? 'deleted-verified' : at === 'create-page' ? 'absent-verified' : 'none');
  assert.equal(setup.app.records().length, 0);
  assert.equal(setup.app.stats().creates, at === 'submit' ? 1 : 0);
  assert.equal(setup.app.stats().deletes, at === 'submit' ? 1 : 0);
  const text = JSON.stringify(report);
  assert.equal([setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()].some((secret) => text.includes(secret)), false);
}

for (const at of ['writer-identity', 'reader-identity', 'create-page', 'submit']) {
  for (const roundtrip of [false, true]) {
    test(`${at}: rejects a server redirect ${roundtrip ? 'through another origin back to the app' : 'to another origin with matching content'}`, async (t) => {
      await redirectCase(t, { at, roundtrip });
    });
  }
}

for (const at of ['writer-context-close', 'reader-context-close', 'browser-close']) {
  test(`late observed navigation during ${at} fails the report after record cleanup`, async (t) => {
    const setup = await setupCase();
    t.after(() => setup.app.close());
    const contexts = [];
    let observed = false;
    const escape = (context) => {
      observed = true;
      context.emit('request', { isNavigationRequest: () => true, url: () => 'http://127.0.0.1:1/late', redirectedFrom: () => null });
    };
    const run = await runCase(setup, { loadBrowser: async () => {
      const real = await import('playwright');
      return { chromium: { launch: async (options) => {
        const browser = await real.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (options) => {
          const context = await newContext(options);
          const index = contexts.push(context) - 1;
          if ((at === 'writer-context-close' && index === 0) || (at === 'reader-context-close' && index === 1)) {
            const close = context.close.bind(context);
            context.close = async (...args) => { escape(context); return close(...args); };
          }
          return context;
        };
        if (at === 'browser-close') {
          const close = browser.close.bind(browser);
          browser.close = async (...args) => { escape(contexts[0]); return close(...args); };
        }
        return browser;
      } } };
    } });
    assert.equal(observed, true);
    assert.equal(run.error?.code, 'CLEANUP_FAILED');
    assert.equal(run.steps.length, 13);
    assert.equal(run.steps.every((step) => step.status === 'passed'), true);
    assert.deepEqual(run.error.cleanup, { status: 'failed', record: 'deleted-verified' });
    assert.equal(setup.app.records().length, 0);
    assert.equal(setup.app.stats().deletes, 1);
    const report = reportFor(setup, run);
    assert.equal(report.verdict, 'failed');
    assert.equal(report.cleanup.status, 'failed');
    const text = JSON.stringify(report);
    assert.equal([setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()].some((secret) => text.includes(secret)), false);
  });
}
