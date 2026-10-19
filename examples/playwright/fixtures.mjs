/** Copy this file into the consuming app; install @playwright/test there. */
import { test as base, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const PROFILE = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$/;
const COOKIE_STRATEGIES = ['form-post', 'nextauth-credentials', 'app-handoff'];

class FixtureError extends Error {}
function fail(code) { return new FixtureError('Testlane fixture: ' + code); }
function recording(value) { return value !== undefined && value !== 'off' && value?.mode !== 'off'; }

// A routed initial request can still redirect without another route callback.
// Record observed navigation hops so an escape cannot pass after returning to
// the app. The target may already have been contacted; this is not a sandbox.
function observeNavigationOrigin(context, origin) {
  let escaped = false;
  const observe = (request) => {
    try {
      if (!request.isNavigationRequest()) return;
      for (let current = request; current; current = current.redirectedFrom()) {
        if (new URL(current.url()).origin !== origin) escaped = true;
      }
    } catch { escaped = true; }
  };
  context.on('request', observe);
  context.on('response', (response) => observe(response.request()));
  return () => {
    try {
      for (const page of context.pages()) {
        if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) escaped = true;
      }
    } catch { escaped = true; }
    if (escaped) throw fail('off-origin document navigation observed; stop this run');
  };
}

function configuration(options) {
  try {
    if (!path.isAbsolute(options.cliPath)) throw fail('configuration');
    const url = new URL(options.baseURL);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('configuration');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw fail('configuration');
    const roles = Object.fromEntries(Object.entries(options.roles).map(([role, profiles]) => {
      if (!Array.isArray(profiles) || profiles.length === 0 || !profiles.every((p) => typeof p === 'string' && PROFILE.test(p))) throw fail('configuration');
      return [role, [...profiles]];
    }));
    const names = Object.values(roles).flat();
    if (!names.length || new Set(names).size !== names.length) throw fail('configuration');
    return Object.freeze({ cliPath: options.cliPath, origin: url.origin, roles });
  } catch { throw fail('invalid configuration (absolute cliPath, app origin and distinct profile arrays required)'); }
}

/**
 * Each role maps parallelIndex -> human-seeded profile. No modulo/fallback sharing.
 * The broker path and registry/home environment are human-controlled configuration.
 * Errors intentionally omit captured broker/browser output and response bodies.
 */
export function createTestlaneTest(options) {
  const config = configuration(options);
  return base.extend({
    testlane: [async ({ browser, trace, video, screenshot }, use, testInfo) => {
      if (recording(trace) || recording(video) || recording(screenshot)) throw fail('disable trace, video and screenshot recording');
      if (['DEBUG', 'PWDEBUG', 'NODE_DEBUG'].some((name) => process.env[name])) throw fail('disable debug logging before issuing sessions');
      const controller = new AbortController();
      const brokerEnv = { ...process.env, NO_COLOR: '1' };
      // Playwright sets FORCE_COLOR for reporters; combining it with NO_COLOR makes
      // Node warn before the broker starts. Keep child output plain and warning-free.
      for (const key of Object.keys(brokerEnv)) if (key.toUpperCase() === 'FORCE_COLOR') delete brokerEnv[key];
      const contexts = new Set();
      const navigationGuards = new Set();
      const pending = new Set();
      const activeRoles = new Set();
      let closed = false;

      async function broker(args) {
        if (closed) throw fail('fixture already closed');
        try {
          const result = await execute(process.execPath, [config.cliPath, ...args], {
            cwd: testInfo.config.rootDir, env: brokerEnv, shell: false, windowsHide: true,
            timeout: 20_000, maxBuffer: 64 * 1024, signal: controller.signal,
            // No input or credential values are passed. The CLI uses its normal approved registry/home.
          });
          if (result.stderr.trim()) throw fail('broker warning');
          return result.stdout;
        } catch (error) {
          const exit = Number.isInteger(error.code) ? ' (exit ' + error.code + ')' : '';
          throw fail('broker refused, warned or unavailable' + exit + '; check the approved profile in a normal terminal');
        }
      }

      async function open(role) {
        if (closed) throw fail('fixture already closed');
        if (!Object.hasOwn(config.roles, role)) throw fail('unknown role');
        if (activeRoles.has(role)) throw fail('role already opened in this test; reuse its context');
        const profile = config.roles[role][testInfo.parallelIndex];
        if (!profile) throw fail('no profile for this parallel worker; seed another account or reduce workers');
        activeRoles.add(role);
        let directory;
        let state;
        let stage = 'profile discovery';
        try {
          const listing = JSON.parse(await broker(['--json', 'profiles']));
          const selected = Object.values(config.roles).flat().map((name) => listing.profiles.find((p) => p.name === name));
          if (selected.some((p) => !p || p.environment === 'production' || new URL(p.baseUrl).origin !== config.origin || !COOKIE_STRATEGIES.includes(p.strategy) || !p.email)) throw fail('profile mismatch');
          if (new Set(selected.map((p) => p.email.toLowerCase())).size !== selected.length) throw fail('accounts must differ');
          const summary = selected.find((p) => p.name === profile);
          stage = 'session issuance';
          const parent = await realpath(os.tmpdir());
          directory = await mkdtemp(path.join(parent, 'testlane-playwright-'));
          if (process.platform !== 'win32') await chmod(directory, 0o700);
          state = path.join(directory, 'storage.json');
          const confirmation = await broker(['session', profile, '--format', 'storage-state', '--out', state]);
          // Testlane 0.5 --out confirmation carries the expiry of THIS session.
          // Never issue a separate check to guess its lifetime.
          const match = / \(expires (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\)\r?\n?$/.exec(confirmation);
          const expiresAt = match?.[1];
          const expiry = Date.parse(expiresAt ?? '');
          if (!Number.isFinite(expiry)) throw fail('missing expiry');
          let assertNavigation = () => {};
          const assertFresh = () => {
            assertNavigation();
            if (closed || Date.now() >= expiry) throw fail('session expired or fixture closed; stop this test and start a new run');
          };
          assertFresh();
          stage = 'browser context setup';
          const context = await browser.newContext({
            baseURL: config.origin, storageState: state,
            serviceWorkers: 'block', acceptDownloads: false,
          });
          contexts.add(context);
          assertNavigation = observeNavigationOrigin(context, config.origin);
          navigationGuards.add(assertNavigation);
          if (closed) { await context.close(); throw fail('fixture closed'); }
          // Abort routed off-origin documents; the observer also rejects redirect
          // hops that routing misses. Ordinary app resources are not sandboxed.
          await context.route('**/*', (route) => {
            if (route.request().isNavigationRequest() && new URL(route.request().url()).origin !== config.origin) return route.abort();
            return route.continue();
          });
          const page = await context.newPage();
          assertFresh();
          return Object.freeze({
            profile, page, context, expiresAt,
            account: Object.freeze({ email: summary.email, role: summary.role }),
            remainingMs: () => closed ? 0 : Math.max(0, expiry - Date.now()), assertFresh,
          });
        } catch (error) {
          if (error instanceof FixtureError) throw error;
          throw fail(stage + ' failed; response bodies and browser errors are not printed');
        } finally {
          // Only remove our known file and empty directory; never recursively delete a caller path.
          try {
            if (state) await unlink(state).catch((e) => { if (e.code !== 'ENOENT') throw e; });
            if (directory) await rmdir(directory);
          } catch { throw fail('session file cleanup failed; inspect the private temp directory'); }
        }
      }

      const fixture = Object.freeze({
        open(role) {
          const operation = open(role);
          pending.add(operation);
          operation.then(() => pending.delete(operation), () => pending.delete(operation));
          return operation;
        },
      });
      try { await use(fixture); }
      finally {
        const unfinished = pending.size > 0;
        closed = true;
        controller.abort();
        await Promise.allSettled([...pending]);
        let navigationFailed = false;
        for (const guard of navigationGuards) { try { guard(); } catch { navigationFailed = true; } }
        let cleanupFailed = false;
        for (const context of contexts) {
          try { await context.close(); } catch { cleanupFailed = true; }
        }
        for (const guard of navigationGuards) { try { guard(); } catch { navigationFailed = true; } }
        if (cleanupFailed) throw fail('browser context cleanup failed');
        if (navigationFailed) throw fail('off-origin document navigation observed; stop this run');
        if (unfinished) throw fail('session request still running at teardown; await every open()');
      }
    }, { timeout: 60_000 }],
  });
}

export { expect };
