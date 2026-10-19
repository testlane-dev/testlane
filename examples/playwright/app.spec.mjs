// Copy alongside fixtures.mjs; replace this public configuration as the human.
import { createTestlaneTest, expect } from './fixtures.mjs';

const test = createTestlaneTest({
  cliPath: '/absolute/path/to/testlane/dist/cli.js',
  baseURL: 'http://localhost:3000',
  roles: {
    qa: ['shop:testing:qa:worker-0'],
    admin: ['shop:testing:admin:worker-0'],
  },
});

test('each role reaches its own authenticated workspace', async ({ testlane }) => {
  for (const role of ['qa', 'admin']) {
    const session = await testlane.open(role);
    let stage = 'session expiry';
    try {
      session.assertFresh();
      stage = 'identity request';
      const response = await session.context.request.get('/api/me', { maxRedirects: 0 });
      expect(response.status(), 'authenticated identity status').toBe(200);
      stage = 'identity response';
      const identity = await response.json();
      // Compare booleans so a reflected cookie cannot appear in assertion output.
      expect(identity.email === session.account.email, 'expected account').toBe(true);
      expect(identity.role === session.account.role, 'expected role').toBe(true);
      stage = 'protected page';
      session.assertFresh();
      await session.page.goto('/dashboard');
      await expect(session.page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
      stage = 'session expiry';
      expect(session.remainingMs() > 0, 'session is still fresh').toBe(true);
    } catch {
      // Network/JSON/browser exceptions can quote cookies or response bodies.
      throw new Error('App verification failed: ' + stage);
    }
  }
});
