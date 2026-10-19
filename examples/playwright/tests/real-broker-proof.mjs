/** Real packed CLI, native scratch store and two roles; never a live user vault. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { consumerProject, assertNoLeaks, publicArtifacts } from './consumer.mjs';
import { realBrokerSupport, createRealBrokerHarness, referenceProfiles } from '../../workflows/test-support/real-broker.mjs';
import { startReferenceApp, REFERENCE_HEADING } from '../../workflows/test-support/reference-app.mjs';

const support = realBrokerSupport();
if (!support.supported) {
  console.error('BLOCKED: this proof requires Windows DPAPI or Linux with TESTLANE_REAL_KEYCHAIN=1 inside an isolated D-Bus/keyring session; never macOS.');
  process.exitCode = 2;
} else {
  let consumer;
  let app;
  let harness;
  try {
    consumer = await consumerProject();
    const namespace = 'playwright-' + randomBytes(8).toString('hex');
    const writer = { email: 'writer@example.test', role: 'Writer', password: randomBytes(32).toString('base64url') };
    const reader = { email: 'reader@example.test', role: 'Reader', password: randomBytes(32).toString('base64url') };
    app = await startReferenceApp({
      accounts: [writer, reader], buildId: namespace, environment: 'testing', runId: namespace, dataScope: namespace,
    });
    const registry = referenceProfiles({ namespace, origin: app.origin, writer, reader });
    harness = await createRealBrokerHarness({ brokerCli: consumer.brokerCli, registry, support });
    await harness.seed(namespace + ':local:writer', writer.password);
    await harness.seed(namespace + ':local:reader', reader.password);
    await consumer.config({ cliPath: consumer.brokerCli, baseURL: app.origin, roles: {
      writer: [namespace + ':local:writer'], reader: [namespace + ':local:reader'],
    } });
    await consumer.spec('packed', `
      import { readFileSync } from 'node:fs';
      import { createTestlaneTest, expect } from './fixtures.mjs';
      const test = createTestlaneTest(JSON.parse(readFileSync(new URL('../fixture-config.json',import.meta.url),'utf8')));
      for (const name of ['first run','repeat run']) test(name, async ({testlane,browser}) => {
        for (const role of ['writer','reader']) {
          const session = await testlane.open(role);
          session.assertFresh();
          const response = await session.context.request.get('/api/me',{maxRedirects:0});
          expect(response.status()).toBe(200);
          const identity = await response.json();
          expect(identity.email === session.account.email).toBe(true);
          expect(identity.role === session.account.role).toBe(true);
          await session.page.goto('/workspace');
          await expect(session.page.getByRole('heading',{name:${JSON.stringify(REFERENCE_HEADING)},exact:true})).toBeVisible();
          expect(session.remainingMs() > 0).toBe(true);
          const anonymous = await browser.newContext();
          try { expect((await anonymous.request.get(${JSON.stringify(app.origin + '/api/me')},{maxRedirects:0})).status()).toBe(401); }
          finally { await anonymous.close(); }
        }
      });
    `);
    const result = await consumer.run(['--workers=1'], harness.env);
    const audit = await harness.auditText();
    assertNoLeaks(result.stdout + result.stderr + audit + await publicArtifacts(consumer.root), [writer.password, reader.password, ...app.issuedSessionTokens()]);
    const sessions = audit.trim().split('\n').map(JSON.parse).filter(row => row.event === 'session' && row.ok);
    const leftovers = (await readdir(consumer.sessionTemp)).filter(name => name.startsWith('testlane-playwright-'));
    const checks = {
      runnerPassed: result.code === 0,
      fourFreshSessions: sessions.length === 4 && app.stats().logins === 4,
      bothRoles: new Set(sessions.map(row => row.profile)).size === 2,
      privateFilesRemoved: leftovers.length === 0,
      noCredentialLeak: true,
    };
    console.log(JSON.stringify({ passed: Object.values(checks).every(Boolean), nativeStore: support.store, checks }));
    assert.ok(Object.values(checks).every(Boolean), 'packed consumer proof checks pass');
  } catch {
    console.error('FAIL packed Playwright fixture proof; inspect the fixed checks above and verify local prerequisites');
    process.exitCode = 1;
  } finally {
    try { await harness?.dispose(); } catch { process.exitCode = 1; console.error('FAIL scratch store cleanup'); }
    try { await app?.close(); } catch { process.exitCode = 1; console.error('FAIL reference app cleanup'); }
    try { await consumer?.dispose(); } catch { process.exitCode = 1; console.error('FAIL consumer cleanup'); }
  }
}
