/** One fixed source-only lifecycle case, copied into the installed consumer. */
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import path from 'node:path';
import { createTestlaneTest, expect } from './fixtures.mjs';
import { runCase } from './testlane-authoring.mjs';
import { readBrowserGate, writeBrowserGate } from './browser-gate.mjs';
const config = JSON.parse(await readFile(new URL('./browser-config.json', import.meta.url), 'utf8'));
const test = createTestlaneTest(config.fixture);
test.use({ connectOptions: { wsEndpoint: config.privateBrowserEndpoint, timeout: 10_000 } });
const fixed = run => run().catch(() => { throw Error('BROWSER_LIFECYCLE_CASE_FAILED'); });
async function action(page, name, status) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#operation-status')).toHaveText('HTTP_' + status);
}
test('Created sandbox accounts use browser roles and are revoked in the same live app', {
  annotation: { type: 'testlane-case', description: 'provisioned-browser-lifecycle' },
}, async ({ testlane, browser }, info) => {
  let editor, reviewer, recordId, creation;
  const originalCookies = new Map();
  const journal = path.join(config.gateDirectory, 'record.json');
  await runCase(info, 'provisioned-browser-lifecycle', { run: async () => {
    await fixed(async () => {
    editor = await testlane.open('editor'); reviewer = await testlane.open('reviewer');
    for (const [session, role, email] of [[editor, 'Editor', config.editorEmail], [reviewer, 'Reviewer', config.reviewerEmail]]) {
      session.assertFresh(); await session.page.goto('/workspace');
      const cookies = (await session.context.cookies()).filter(value => value.name === 'tlp_supabase_session');
      expect(cookies.length === 1 && cookies[0].httpOnly, 'one opaque HttpOnly app cookie reaches each context').toBe(true);
      originalCookies.set(session, cookies[0].value);
      await expect(session.page.locator('#session-status')).toHaveText('AUTHENTICATED');
      await expect(session.page.locator('#identity-role')).toHaveText(role);
      expect(await session.page.locator('#identity-email').textContent() === email, 'live browser identity matches the created account').toBe(true);
      await action(session.page, 'Check editor access', role === 'Editor' ? 200 : 403);
      await action(session.page, 'Check reviewer access', role === 'Reviewer' ? 200 : 403);
    }
    const anonymous = await browser.newContext({ baseURL: config.fixture.baseURL, serviceWorkers: 'block', acceptDownloads: false });
    try { expect((await anonymous.request.get('/api/me', { maxRedirects: 0 })).status() === 401, 'anonymous identity is refused').toBe(true); }
    finally { await anonymous.close(); }
    await action(reviewer.page, 'Create record', 403);
    expect((await reviewer.context.request.get('/api/records', { maxRedirects: 0 })).status() === 200, 'Reviewer can read only its own empty scope').toBe(true);
    creation = editor.page.waitForResponse(response => response.url() === config.fixture.baseURL + '/api/records' && response.request().method() === 'POST')
      .then(async response => {
        const value = await response.json();
        if (typeof value.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)) {
          recordId = value.id;
          await writeFile(journal, JSON.stringify({ schemaVersion: 1, id: recordId }) + '\n', { flag: 'wx', mode: 0o600 });
        }
        expect(response.status() === 201 && Boolean(recordId), 'Editor creates a journaled owned record').toBe(true);
      });
    const outcomes = await Promise.allSettled([creation, editor.page.getByRole('button', { name: 'Create record', exact: true }).click()]);
    expect(outcomes.every(value => value.status === 'fulfilled'), 'creation response and browser action both settle').toBe(true);
    await expect(editor.page.locator('#records li')).toHaveCount(1);
    await expect(editor.page.locator('#records li')).toHaveText('synthetic');
    const saved = await editor.context.request.get('/api/records', { maxRedirects: 0 }), rows = await saved.json();
    expect(saved.status() === 200 && rows.length === 1 && rows[0].id === recordId && rows[0].note === 'synthetic', 'fresh persisted state matches the browser-created record').toBe(true);
    expect((await reviewer.context.request.get('/api/records', { maxRedirects: 0 }).then(value => value.json())).length === 0, 'Reviewer cannot read the Editor record').toBe(true);
    });
    // Preserve this safe, deliberately injected assertion and its exact source
    // location rather than wrapping it as an arbitrary browser exception.
    expect(config.injectBodyFailure === false, 'controlled assertion failure occurs only after persistence').toBe(true);
  }, cleanup: () => fixed(async () => {
    // A failed click/assertion cannot outrun its already-started ownership capture.
    if (creation) await Promise.allSettled([creation]);
    if (recordId) {
      expect((await editor.context.request.delete('/api/records/' + recordId, { maxRedirects: 0 })).status() === 204, 'delete only the exact owned record').toBe(true);
      const remaining = await editor.context.request.get('/api/records', { maxRedirects: 0 });
      expect(remaining.status() === 200 && (await remaining.json()).length === 0, 'owned record is absent before revocation').toBe(true);
      await unlink(journal);
    }
    if (!editor || !reviewer || !recordId) throw Error('BROWSER_LIFECYCLE_CASE_FAILED');
    await writeBrowserGate(config.gateDirectory, config.nonce, 'records-absent');
    const deadline = performance.now() + 15_000;
    while (!await readBrowserGate(config.gateDirectory, config.nonce, 'accounts-revoked')) {
      if (performance.now() >= deadline) throw Error('BROWSER_LIFECYCLE_CASE_FAILED');
      await pause(25);
    }
    for (const session of [editor, reviewer]) {
      session.assertFresh();
      expect((await session.context.cookies()).find(value => value.name === 'tlp_supabase_session')?.value === originalCookies.get(session), 'the original app cookie is still present before rejection').toBe(true);
      expect((await session.context.request.get('/api/me', { maxRedirects: 0 })).status() === 401, 'the original browser context is refused while the app remains live').toBe(true);
      await action(session.page, 'Refresh identity', 401);
      await expect(session.page.locator('#session-status')).toHaveText('AUTHENTICATION_REQUIRED');
      await expect(session.page.locator('#identity-email')).toHaveText('');
      await expect(session.page.locator('#identity-role')).toHaveText('');
      await expect(session.page.locator('#records li')).toHaveCount(0);
      expect((await session.context.request.get('/api/records', { maxRedirects: 0 })).status() === 401, 'revoked record access is refused').toBe(true);
      expect((await session.context.cookies()).find(value => value.name === 'tlp_supabase_session')?.value === originalCookies.get(session), 'rejection did not clear or replace the original app cookie').toBe(true);
    }
  }) });
});
