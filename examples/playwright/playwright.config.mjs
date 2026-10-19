// Merge these settings into the consuming app's existing Playwright configuration.
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'app.spec.mjs',
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { trace: 'off', video: 'off', screenshot: 'off' },
});
