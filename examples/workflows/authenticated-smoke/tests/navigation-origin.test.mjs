import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWorkflow } from '../manifest.mjs';
import { deriveReport } from '../report.mjs';
import { createDeadline, runAuthenticatedChecks } from '../runtime.mjs';

// Real pinned app-local Playwright + Chromium. The second loopback server
// deliberately serves the same path/heading, or redirects back to the app.
// Neither a final-origin-only check nor heading-only check is sufficient.
test('smoke rejects external navigation chains and preserves same-origin redirects', { timeout: 120_000 }, async (t) => {
  const cookie = randomBytes(24).toString('hex');
  const email = 'redirect-smoke@example.test';
  const role = 'QA';
  let mode;
  let origin;
  let externalOrigin;
  const external = http.createServer((req, res) => {
    if (mode === 'returning-redirect') {
      res.writeHead(302, { location: origin + '/protected?complete=1' }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><h1>Protected workspace</h1>');
  });
  const app = http.createServer((req, res) => {
    const authenticated = req.headers.cookie === 'smoke_session=' + cookie;
    if (req.url === '/ready') { res.end(); return; }
    if (req.url === '/identity' || req.url === '/api/data') {
      res.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/identity' ? { email, role } : { ok: authenticated })); return;
    }
    if ((mode === 'identity-redirect' && req.url === '/') ||
        (mode === 'anonymous-redirect' && req.url === '/' && !authenticated)) {
      res.writeHead(302, { location: externalOrigin + '/' }); res.end(); return;
    }
    if (req.url === '/protected' && !['identity-redirect', 'anonymous-redirect'].includes(mode)) {
      res.writeHead(302, { location: mode === 'same-origin-redirect' ? '/protected?complete=1' : externalOrigin + '/protected' });
      res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><h1>Protected workspace</h1>');
  });
  for (const server of [app, external]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  }
  origin = 'http://127.0.0.1:' + app.address().port;
  externalOrigin = 'http://127.0.0.1:' + external.address().port;
  const workflow = parseWorkflow({ schemaVersion: 1, kind: 'authenticated-smoke', id: 'redirect-smoke',
    profile: 'redirect:local:smoke', target: { origin, environment: 'testing' }, identity: { email, role },
    checks: { readinessPath: '/ready', identityPath: '/identity', protectedPath: '/protected', protectedHeading: 'Protected workspace', apiPath: '/api/data' }, timeoutMs: 20000 });
  for (const nextMode of ['same-origin-redirect', 'external-redirect', 'returning-redirect', 'identity-redirect', 'anonymous-redirect']) {
    await t.test(nextMode, async () => {
      mode = nextMode;
      const steps = [];
      const deadline = createDeadline(workflow.timeoutMs);
      let failure;
      try {
        await runAuthenticatedChecks({ workflow, deadline,
          brokerCli: fileURLToPath(new URL('../fake-broker.mjs', import.meta.url)),
          ipcConfig: { origin, cookie, profile: { name: workflow.profile, email, role, environment: 'testing', baseUrl: origin, strategy: 'nextauth-credentials' } },
          onStep: (id, status, code) => steps.push({ id, status, code }),
        });
      } catch (error) { failure = error; }
      finally { deadline.dispose(); }
      assert.equal(JSON.stringify(steps).includes(cookie), false);
      if (mode === 'same-origin-redirect') {
        assert.equal(failure, undefined);
        assert.equal(steps.every((step) => step.status === 'passed'), true);
        assert.equal(steps.length, 8);
      } else {
        assert.equal(failure?.code, 'ASSERTION_FAILED');
        const id = mode === 'identity-redirect' ? 'identity' : mode === 'anonymous-redirect' ? 'anonymous-denied' : 'protected-page';
        assert.deepEqual(steps.find((step) => step.id === id), { id, status: 'failed', code: 'ASSERTION_FAILED' });
      }
    });
  }
  for (const at of ['context-close', 'browser-close']) {
    await t.test(`late observed navigation during ${at} fails finalized cleanup`, async () => {
      mode = 'same-origin-redirect';
      const steps = [];
      let authenticated;
      let observed = false;
      const escape = () => {
        observed = true;
        authenticated.emit('request', { isNavigationRequest: () => true, url: () => externalOrigin + '/late', redirectedFrom: () => null });
      };
      const loadBrowser = async () => {
        const real = await import('playwright');
        return { chromium: { launch: async (options) => {
          const browser = await real.chromium.launch(options);
          const newContext = browser.newContext.bind(browser);
          browser.newContext = async (options) => {
            const context = await newContext(options);
            if (options?.storageState) {
              authenticated = context;
              if (at === 'context-close') {
                const close = context.close.bind(context);
                context.close = async (...args) => { escape(); return close(...args); };
              }
            }
            return context;
          };
          if (at === 'browser-close') {
            const close = browser.close.bind(browser);
            browser.close = async (...args) => { escape(); return close(...args); };
          }
          return browser;
        } } };
      };
      const deadline = createDeadline(workflow.timeoutMs);
      let failure;
      try {
        await runAuthenticatedChecks({ workflow, deadline, loadBrowser,
          brokerCli: fileURLToPath(new URL('../fake-broker.mjs', import.meta.url)),
          ipcConfig: { origin, cookie, profile: { name: workflow.profile, email, role, environment: 'testing', baseUrl: origin, strategy: 'nextauth-credentials' } },
          onStep: (id, status, code, durationMs) => steps.push({ id, status, reasonCode: status === 'passed' ? 'ok' : 'assertion-failed', durationMs, attempt: 1 }),
        });
      } catch (error) { failure = error; }
      finally { deadline.dispose(); }
      assert.equal(observed, true);
      assert.equal(failure?.code, 'CLEANUP_FAILED');
      assert.equal(steps.length, 8);
      assert.equal(steps.every((step) => step.status === 'passed'), true);
      const report = deriveReport({ schemaVersion: 1, kind: 'authenticated-smoke-report', workflowId: workflow.id,
        runId: 'late-navigation-' + at, startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z',
        sourceTree: null, target: { origin, environment: 'testing', actualBuild: null }, profile: workflow.profile,
        steps, cleanup: { status: 'failed', reasonCode: 'cleanup-failed' } });
      assert.equal(report.verdict, 'failed');
      assert.equal(JSON.stringify(report).includes(cookie), false);
    });
  }

});
