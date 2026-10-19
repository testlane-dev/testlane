/**
 * Copy into your app's tools/testlane/ directory; install Playwright in that app.
 * Usage: node tools/testlane/verify.mjs tools/testlane/verify.json <storage-state-file>
 * The caller owns and removes the session file. Review GET routes for side effects.
 * This example is not an assessment runner or an application sandbox.
 */
import { readFile } from 'node:fs/promises';

let stage = 'configuration';
let browser;
let authenticated;
let anonymous;
let passed = false;
let assertNavigation = () => {};

try {
  const [configFile, stateFile, ...extra] = process.argv.slice(2);
  if (!configFile || !stateFile || extra.length) throw new Error();
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const fields = ['baseUrl', 'identityPath', 'protectedPath', 'heading', 'expectedEmail', 'expectedRole'];
  if (!fields.every((key) => typeof config[key] === 'string' && config[key].length > 0)) throw new Error();
  const base = new URL(config.baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error();
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new Error();
  const appUrl = (path) => {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error();
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.search || url.hash) throw new Error();
    return url.href;
  };
  const identityUrl = appUrl(config.identityPath);
  const protectedUrl = appUrl(config.protectedPath);

  stage = 'browser setup (install Playwright and Chromium in the consuming app)';
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  authenticated = await browser.newContext({ storageState: stateFile, serviceWorkers: 'block' });
  authenticated.setDefaultTimeout(15_000);

  stage = 'authenticated identity (check the route, account and session lifetime)';
  const identity = await authenticated.request.get(identityUrl, { maxRedirects: 0, timeout: 15_000 });
  if (identity.status() !== 200) throw new Error();
  const user = await identity.json();
  if (user.email !== config.expectedEmail || user.role !== config.expectedRole) throw new Error();
  console.log('PASS authenticated API identity');

  stage = 'protected page (check the path, heading and cookie-based authentication)';
  // Routing misses some server-redirect hops, so also validate the final page
  // and complete redirect chain. This rejects an escape after contact; it is
  // not network isolation. Other resources are ordinary browser traffic.
  await authenticated.route('**/*', (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && new URL(request.url()).origin !== base.origin) return route.abort();
    return route.continue();
  });
  let escaped = false;
  const checkRequest = (request) => {
    try {
      if (!request.isNavigationRequest()) return;
      for (let current = request; current; current = current.redirectedFrom()) {
        if (new URL(current.url()).origin !== base.origin) escaped = true;
      }
    } catch { escaped = true; }
  };
  authenticated.on('request', checkRequest);
  authenticated.on('response', (response) => checkRequest(response.request()));
  const page = await authenticated.newPage();
  assertNavigation = () => { if (escaped || new URL(page.url()).origin !== base.origin) throw new Error(); };
  const response = await page.goto(protectedUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  if (response) checkRequest(response.request());
  if (escaped || !response?.ok() || new URL(response.url()).origin !== base.origin || new URL(page.url()).origin !== base.origin || new URL(page.url()).pathname !== new URL(protectedUrl).pathname) throw new Error();
  await page.getByRole('heading', { name: config.heading, exact: true }).waitFor({ state: 'visible' });
  if (escaped || new URL(page.url()).origin !== base.origin) throw new Error();
  console.log('PASS protected page heading');

  stage = 'anonymous denial (the identity route must refuse a fresh unsigned context)';
  anonymous = await browser.newContext({ serviceWorkers: 'block' });
  const denial = await anonymous.request.get(identityUrl, { maxRedirects: 0, timeout: 15_000 });
  if (![401, 403].includes(denial.status())) throw new Error();
  console.log('PASS anonymous API denial');
  passed = true;
} catch {
  // App responses and browser errors can contain session values. Keep diagnostics fixed.
  console.error('FAIL ' + stage);
  process.exitCode = 1;
} finally {
  for (const resource of [anonymous, authenticated, browser]) {
    try { await resource?.close(); }
    catch { passed = false; process.exitCode = 1; console.error('FAIL browser cleanup'); }
  }
  // Anonymous checks and close() can deliver a late navigation event. Decide
  // success only after all resources have closed and the sticky guard passes.
  try { assertNavigation(); }
  catch { passed = false; process.exitCode = 1; console.error('FAIL protected page navigation'); }
}

if (passed) console.log('PASS existing-app checks; browser closed');
