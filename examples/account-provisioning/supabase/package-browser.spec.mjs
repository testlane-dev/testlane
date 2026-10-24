/** Installed-package proof. All accounts, provider state and records are synthetic. */
import { readFile } from 'node:fs/promises';
import { createTestlaneTest, expect } from './fixtures.mjs';
import { runCase } from './testlane-authoring.mjs';
import { loadBrowserWorkerBinding, requestBrowserRunRevocation } from './installed-worker.mjs';

const config = JSON.parse(await readFile(new URL('./package-browser-config.json', import.meta.url), 'utf8'));
const binding = await loadBrowserWorkerBinding();
const test = createTestlaneTest(binding.fixture);
test.use({ connectOptions: { wsEndpoint: config.privateBrowserEndpoint, timeout: 10000 } });
const safe = task => task().catch(() => { throw Error('PACKAGE_BROWSER_CASE_FAILED'); });
async function action(page, label, status) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('#operation-status')).toHaveText('HTTP_' + status);
}

test('Automatically created accounts verify behavior and reject their original sessions', {
  annotation: { type: 'testlane-case', description: 'automatic-account-browser-lifecycle' },
}, async ({ testlane, browser }, info) => {
  test.setTimeout(90000);
  let editor, reviewer, recordId, capture, click;
  const cookies = new Map();
  await runCase(info, 'automatic-account-browser-lifecycle', {
    run: async () => {
      await safe(async () => {
        editor = await testlane.open('editor'); reviewer = await testlane.open('reviewer');
        for (const [session, role] of [[editor, 'Editor'], [reviewer, 'Reviewer']]) {
          session.assertFresh(); await session.page.goto('/workspace');
          const original = (await session.context.cookies()).filter(cookie => cookie.name === 'tlp_supabase_session');
          expect(original.length === 1 && original[0].httpOnly, 'one HttpOnly app cookie reaches the browser').toBe(true);
          cookies.set(session, original[0].value);
          await expect(session.page.locator('#session-status')).toHaveText('AUTHENTICATED');
          await expect(session.page.locator('#identity-role')).toHaveText(role);
          expect(await session.page.locator('#identity-email').textContent() === session.account.email, 'browser identity matches the automatically created profile').toBe(true);
          await action(session.page, 'Check editor access', role === 'Editor' ? 200 : 403);
          await action(session.page, 'Check reviewer access', role === 'Reviewer' ? 200 : 403);
        }
        const anonymous = await browser.newContext({ baseURL: binding.fixture.baseURL, serviceWorkers: 'block', acceptDownloads: false });
        try { expect((await anonymous.request.get('/api/me', { maxRedirects: 0 })).status() === 401, 'anonymous access is refused').toBe(true); }
        finally { await anonymous.close(); }
        await action(reviewer.page, 'Create record', 403);
        capture = editor.page.waitForResponse(response => response.url() === binding.fixture.baseURL + '/api/records' && response.request().method() === 'POST')
          .then(async response => {
            const value = await response.json();
            if (typeof value?.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)) recordId = value.id;
            expect(response.status() === 201 && Boolean(recordId), 'capture the owned ID before refreshing the page').toBe(true);
          });
        click = editor.page.getByRole('button', { name: 'Create record', exact: true }).click();
        expect((await Promise.allSettled([capture, click])).every(result => result.status === 'fulfilled'), 'creation response and click both settle').toBe(true);
        await expect(editor.page.locator('#records li')).toHaveText('synthetic');
        const saved = await editor.context.request.get('/api/records', { maxRedirects: 0 }), rows = await saved.json();
        expect(saved.status() === 200 && rows.length === 1 && rows[0].id === recordId && rows[0].note === 'synthetic', 'a fresh request verifies persisted browser output').toBe(true);
        const denied = await reviewer.context.request.get('/api/records', { maxRedirects: 0 });
        expect(denied.status() === 200 && (await denied.json()).length === 0, 'Reviewer cannot read the Editor record').toBe(true);
      });
      expect(config.injectBodyFailure === false, 'intentional failure is injected only after persistence').toBe(true);
    },
    cleanup: () => safe(async () => {
      await Promise.allSettled([capture, click].filter(Boolean));
      if (!editor || !reviewer || !recordId) throw Error('PACKAGE_BROWSER_CASE_FAILED');
      expect((await editor.context.request.delete('/api/records/' + recordId, { maxRedirects: 0 })).status() === 204, 'delete the exact owned record').toBe(true);
      const remaining = await editor.context.request.get('/api/records', { maxRedirects: 0 });
      expect(remaining.status() === 200 && (await remaining.json()).length === 0, 'owned records are absent before account revocation').toBe(true);
      await requestBrowserRunRevocation(binding);
      for (const session of [editor, reviewer]) {
        session.assertFresh();
        expect((await session.context.cookies()).find(cookie => cookie.name === 'tlp_supabase_session')?.value === cookies.get(session), 'the original cookie remains present').toBe(true);
        expect((await session.context.request.get('/api/me', { maxRedirects: 0 })).status() === 401, 'the original context is refused while the app is live').toBe(true);
        await action(session.page, 'Refresh identity', 401);
        await expect(session.page.locator('#session-status')).toHaveText('AUTHENTICATION_REQUIRED');
        await expect(session.page.locator('#identity-email')).toHaveText('');
        await expect(session.page.locator('#identity-role')).toHaveText('');
        await expect(session.page.locator('#records li')).toHaveCount(0);
        expect((await session.context.request.get('/api/records', { maxRedirects: 0 })).status() === 401, 'revoked record access is refused').toBe(true);
        expect((await session.context.cookies()).find(cookie => cookie.name === 'tlp_supabase_session')?.value === cookies.get(session), 'the rejected cookie was neither cleared nor replaced').toBe(true);
      }
    }),
  });
});
