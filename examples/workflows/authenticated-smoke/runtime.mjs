import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fork, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { URL, pathToFileURL } from 'node:url';
import { allowedStrategy } from './manifest.mjs';

const MAX_OUTPUT = 64 * 1024;
// Floor for cleanupRace's per-operation ceiling: the minimum bounded chance a
// single cleanup op (context.close(), browser.close(), ...) gets even when
// the run deadline has already expired (or is nearly there) by the time
// cleanup starts.
const CLEANUP_OP_FLOOR_MS = 2000;

export class SmokeError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

export function runId() { return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(6).toString('hex')}`; }

function originOf(value) { return new URL(value).origin; }
function loopback(value) { const host = new URL(value).hostname; return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'; }
function productionHost(value) { try { return new URL(value).hostname.toLowerCase().replace(/\.$/u, '').split('.').some((label) => ['prod', 'production', 'live'].includes(label)); } catch { return true; } }
function hostname(value) { try { return new URL(value).hostname.toLowerCase().replace(/\.$/u, ''); } catch { return ''; } }
function boundedText(value) { return typeof value === 'string' ? value.slice(0, MAX_OUTPUT) : ''; }

function safeError(error) {
  if (error instanceof SmokeError) return error;
  const code = error?.name === 'AbortError' ? 'TIMEOUT' : error?.code === 'ENOENT' ? 'BROKER_UNAVAILABLE' : 'PROCESS_ERROR';
  return new SmokeError(code);
}

// A `chromium.launch()`/`newContext()`/`newPage()` failure is neither a
// broker/process problem nor an app assertion: it means the browser tooling
// itself did not come up (missing/corrupt install, first-run AV scan still
// holding the binary, a crashed startup, ...). `deadline.race()` already
// turns a launch that runs past the deadline into a SmokeError('TIMEOUT') or
// ('CANCELLED') -- those are left untouched -- so only a *raw* error here
// (anything not already a SmokeError) is startup tooling failing on its own,
// and gets the dedicated `LAUNCH_FAILED` code instead of falling into the
// generic PROCESS_ERROR bucket (-> a misleading "assertion-failed").
//
// The report stays free of error text (it only ever gets the `launch-failed`
// reason), so the raw error never reaches it. A newcomer whose browser is not
// installed would otherwise see just "identity failed launch-failed", so the
// failure also carries a private `hint` for the runner's one stderr line (see
// `launchHintLine`): `{ missingExecutable }` or `{ detail }` (bounded,
// control-character-free text taken from the error: the expected executable
// path, or the error's FIRST line only -- never the browser logs or the launch
// command line Playwright appends), or `{}` when no error text is to be shown.
//
// `detail: true` is passed ONLY for a `chromium.launch()` rejection. That
// call receives `{ headless, timeout }` and nothing derived from the session:
// the session step has already written the storage-state file by then, but
// only `newContext({ storageState })` reads it, and `newContext()`/
// `newPage()` errors may quote state or page content -- so those never
// contribute any error text to the hint.
const HINT_LINE_MAX = 200;
const HINT_PATH_MAX = 300;

function printable(text, max) {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function launchHint(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  // The match Playwright's own tooling uses on its missing-browser error
  // ("browserType.launch: Executable doesn't exist at <path>\n..."); the path
  // is the rest of that line and may contain spaces.
  const missing = /Executable doesn't exist at ([^\r\n]+)/u.exec(message);
  const executable = missing ? printable(missing[1], HINT_PATH_MAX) : '';
  if (executable !== '') return { missingExecutable: executable };
  const detail = printable(message.split(/\r?\n/u, 1)[0], HINT_LINE_MAX);
  return { detail: detail === '' ? 'no error message' : detail };
}

export function launchFailure(error, { detail = false } = {}) {
  if (error instanceof SmokeError) return error;
  const failure = new SmokeError('LAUNCH_FAILED');
  failure.hint = detail ? launchHint(error) : {};
  return failure;
}

/**
 * The one human-readable stderr line for a LAUNCH_FAILED failure (never part
 * of the report), or null for any other failure. `templateDir` is the
 * template folder that holds its own `package.json`/`node_modules`: the
 * folder `npx playwright install chromium` has to run in to fetch the build
 * its pinned Playwright expects.
 */
export function launchHintLine(failure, templateDir) {
  if (failure?.code !== 'LAUNCH_FAILED') return null;
  const hint = failure.hint ?? {};
  if (hint.missingExecutable !== undefined) {
    return `Chromium is not installed (expected executable: ${hint.missingExecutable}). Fix: run "npx playwright install chromium" inside ${templateDir} (Ubuntu: "npx playwright install --with-deps chromium"), then retry.`;
  }
  if (hint.detail !== undefined) return `the browser could not be started (${hint.detail}).`;
  return 'the browser started but could not open a context or page; its error text is not printed.';
}

/** Spawn the broker with an executable path and an argv array; shell expansion is never used. */
export async function brokerCall({ brokerCli, args, deadline, ipcConfig }) {
  if (!existsSync(brokerCli)) throw new SmokeError('BROKER_UNAVAILABLE');
  const child = ipcConfig === undefined
    ? spawn(process.execPath, [brokerCli, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : fork(brokerCli, args, { silent: true, windowsHide: true });
  let stdout = ''; let stderr = '';
  const onData = (part, chunk) => { if (part.length < MAX_OUTPUT) part += chunk.toString('utf8').slice(0, MAX_OUTPUT - part.length); return part; };
  child.stdout?.on('data', (chunk) => { stdout = onData(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = onData(stderr, chunk); });
  if (ipcConfig !== undefined) child.send({ type: 'config', config: ipcConfig });
  const processResult = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let result;
  try { result = await deadline.race(processResult, () => { child.kill(); }); }
  catch (error) { child.kill(); throw error; }
  if (result.error) throw safeError(result.error);
  if (result.code !== 0) throw new SmokeError('BROKER_COMMAND_FAILED');
  return { stdout: boundedText(stdout), stderr: boundedText(stderr) };
}

export function createDeadline(timeoutMs) {
  const end = Date.now() + timeoutMs;
  let cancelled = false;
  let timedOut = false;
  let cancelResolve;
  // Resolve-only: nothing here ever rejects `cancelledPromise` (`cancel()`
  // only calls `cancelResolve()`), so it carries no unhandled-rejection
  // hazard even when never consumed -- unlike `timeoutPromise` below.
  const cancelledPromise = new Promise((resolve) => { cancelResolve = resolve; });
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
  // `timeoutPromise` only gets a consumer -- and therefore a rejection
  // handler -- when `race()` is called (Promise.race there subscribes to
  // it). A caller that only ever uses `cleanupRace()` (its own, unrelated
  // per-op timeout) or nothing at all never touches this promise, so once
  // the timer below fires, `timeoutReject(...)` rejects it with no handler
  // attached and Node terminates the process on the unhandled rejection --
  // even though nothing here actually needed that rejection observed. This
  // no-op `.catch` guarantees a handler always exists; `race()`'s own
  // `Promise.race([...]).catch(...)` still separately observes and rethrows
  // the same rejection when it *is* the caller, so `race()`'s semantics
  // (including its TIMEOUT/CANCELLED classification) are unchanged.
  timeoutPromise.catch(() => {});
  const timer = setTimeout(() => { timedOut = true; timeoutReject(new SmokeError('TIMEOUT')); }, Math.max(1, timeoutMs));
  return {
    remaining: () => Math.max(1, end - Date.now()),
    expired: () => cancelled || timedOut,
    isCancelled: () => cancelled,
    cancelled: () => cancelledPromise,
    race: (promise, onTimeout = () => {}) => Promise.race([promise, timeoutPromise, cancelledPromise.then(() => { throw new SmokeError('CANCELLED'); })]).catch((error) => { if (error?.code === 'TIMEOUT') onTimeout(); throw error; }),
    // Per-cleanup-op ceiling: Math.max(CLEANUP_OP_FLOOR_MS, remaining on THIS
    // deadline), not a flat 2000ms regardless of the deadline. Previously a
    // slow-but-still-within-budget browser close (e.g. under CPU load) was
    // cut off at a hardcoded 2000ms even while most of the caller's
    // configured cleanup budget (8-10s for feature-acceptance) remained. The
    // floor preserves today's behaviour when the deadline has already
    // expired (or is nearly there): cleanup still gets a bounded chance
    // instead of ~0ms. The per-op timer is always cleared once the race
    // settles, so it never dangles and keeps the event loop alive.
    //
    // `reserveMs` (optional, defaults to 0) carves out budget for a LATER
    // cleanup op that this one must not be allowed to starve -- e.g. a
    // hung browser-context close must not be able to consume the whole
    // cleanup budget and leave no time for the safety-critical record
    // GET/DELETE/verify that runs after it. The cap still never drops
    // below CLEANUP_OP_FLOOR_MS even when reserveMs would otherwise push it
    // lower.
    cleanupRace: (promise, { reserveMs = 0 } = {}) => {
      const capMs = Math.max(CLEANUP_OP_FLOOR_MS, end - Date.now() - reserveMs);
      let opTimer;
      const opTimeout = new Promise((_, reject) => { opTimer = setTimeout(() => reject(new SmokeError('CLEANUP_FAILED')), capMs); });
      return Promise.race([promise, opTimeout]).finally(() => clearTimeout(opTimer));
    },
    cancel: () => { if (!cancelled) { cancelled = true; cancelResolve(); } },
    dispose: () => clearTimeout(timer),
  };
}

export async function fetchStatus(url, deadline, expectedBuildId) {
  let response;
  const controller = new AbortController();
  try {
    response = await deadline.race(fetch(url, { redirect: 'manual', signal: controller.signal }), () => controller.abort());
  } catch { throw new SmokeError(deadline.isCancelled?.() ? 'CANCELLED' : deadline.expired() ? 'TIMEOUT' : 'READINESS_UNAVAILABLE'); }
  if (response.status >= 300 && response.status < 400) throw new SmokeError('READINESS_REDIRECT');
  if (!response.ok) throw new SmokeError('READINESS_HTTP');
  const observedBuild = expectedBuildId === undefined ? null : response.headers.get('x-build-id');
  if (expectedBuildId !== undefined && observedBuild !== expectedBuildId) throw new SmokeError('BUILD_MISMATCH');
  if (response.body) await response.body.cancel().catch(() => {});
  return { status: response.status, actualBuild: expectedBuildId === undefined ? null : expectedBuildId };
}

function assertProfilePolicy(workflow, profiles) {
  if (!Array.isArray(profiles)) throw new SmokeError('PROFILE_METADATA_INVALID');
  const profile = profiles.find((candidate) => candidate && candidate.name === workflow.profile);
  if (!profile) throw new SmokeError('PROFILE_NOT_FOUND');
  if (profile.environment === 'production' || workflow.target.environment === 'production') throw new SmokeError('PRODUCTION_REFUSED');
  const targetHost = hostname(workflow.target.origin);
  const productionHosts = profiles.filter((candidate) => candidate?.environment === 'production').map((candidate) => hostname(candidate.baseUrl)).filter(Boolean);
  if (productionHosts.includes(targetHost) || productionHost(profile.baseUrl)) throw new SmokeError('PRODUCTION_REFUSED');
  if (profile.environment !== workflow.target.environment) throw new SmokeError('ENVIRONMENT_MISMATCH');
  if (!allowedStrategy(profile.strategy)) throw new SmokeError('STRATEGY_UNSUPPORTED');
  if (originOf(profile.baseUrl) !== workflow.target.origin) throw new SmokeError('ORIGIN_MISMATCH');
  if (!loopback(workflow.target.origin)) throw new SmokeError('NON_LOOPBACK_TARGET');
  if (profile.email !== workflow.identity.email || profile.role !== workflow.identity.role) throw new SmokeError('PROFILE_IDENTITY_MISMATCH');
  return profile;
}

function jsonOutput(text) {
  try { return JSON.parse(text); } catch { throw new SmokeError('BROKER_OUTPUT_INVALID'); }
}

function sameOriginUrl(origin, pathname) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin) throw new SmokeError('OFF_ORIGIN_PATH');
  return url.href;
}

// Routing is best effort: Playwright does not route every server-redirect hop.
// Validate the completed navigation as well, including a hop that returns to the
// expected origin. Fixed errors keep URLs and browser response values private.
function navigationRequestMatches(request, origin) {
  for (let current = request; current; current = current.redirectedFrom()) {
    if (new URL(current.url()).origin !== origin) return false;
  }
  return true;
}

export function assertNavigationOrigin(page, response, origin) {
  try {
    if (new URL(page.url()).origin !== origin) throw new Error();
    if (response && (new URL(response.url()).origin !== origin || !navigationRequestMatches(response.request(), origin))) throw new Error();
  } catch { throw new SmokeError('ASSERTION_FAILED'); }
}

export function observeNavigationOrigin(context, origin) {
  let escaped = false;
  const observe = (request) => {
    try { if (request.isNavigationRequest() && !navigationRequestMatches(request, origin)) escaped = true; }
    catch { escaped = true; }
  };
  context.on('request', observe);
  context.on('response', (response) => {
    observe(response.request());
    try { if (response.request().isNavigationRequest() && new URL(response.url()).origin !== origin) escaped = true; }
    catch { escaped = true; }
  });
  return Object.freeze({ assert() { if (escaped) throw new SmokeError('ASSERTION_FAILED'); } });
}

// `loadBrowser` is an optional test-only injection seam (mirrors
// feature-acceptance's runtime.mjs): defaults to app-installed Playwright,
// so production behaviour is unchanged; tests can pass a fake module to
// simulate a browser-tooling failure without a real Chromium install.
function projectBrowserEntry() {
  const projectRequire = createRequire(path.join(process.cwd(), 'package.json'));
  for (const name of ['playwright', '@playwright/test']) {
    try { return projectRequire.resolve(name); }
    catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  return null;
}

/** App-installed Playwright takes precedence; direct source/template runs retain their own dependency. */
export async function loadProjectBrowser() {
  const entry = projectBrowserEntry();
  const loaded = await (entry === null ? import('playwright') : import(pathToFileURL(entry).href));
  // createRequire resolves CJS entry points; their named exports can live under default.
  const browser = loaded.chromium ? loaded : loaded.default;
  if (!browser?.chromium) throw new SmokeError('PLAYWRIGHT_UNAVAILABLE');
  return browser;
}

export function browserInstallDirectory(templateDir) {
  try { return projectBrowserEntry() === null ? templateDir : process.cwd(); } catch { return process.cwd(); }
}

async function browserModule(loadBrowser) {
  try { return await (loadBrowser ? loadBrowser() : loadProjectBrowser()); } catch { throw new SmokeError('PLAYWRIGHT_UNAVAILABLE'); }
}

async function withDeadline(promise, deadline) {
  return deadline.race(promise);
}

async function pageFetch(page, pathname, deadline, expected) {
  const payload = await withDeadline(page.evaluate(async ({ pathname }) => {
    const response = await fetch(pathname, { redirect: 'manual', credentials: 'same-origin' });
    let body = null;
    try { body = await response.json(); } catch { /* body intentionally not surfaced */ }
    return { status: response.status, redirected: response.redirected, body };
  }, { pathname }), deadline);
  if (deadline.expired()) throw new SmokeError(deadline.isCancelled?.() ? 'CANCELLED' : 'TIMEOUT');
  if (payload.redirected || !expected(payload)) throw new SmokeError('ASSERTION_FAILED');
  return payload;
}

export async function runAuthenticatedChecks({ workflow, brokerCli, deadline, ipcConfig, onStep, cleanupHook, loadBrowser }) {
  const origin = workflow.target.origin;
  const navigationGuards = [];
  let stepFailed = false;
  const mark = async (id, action) => {
    const started = Date.now();
    try { await action(); for (const guard of navigationGuards) guard.assert(); onStep(id, 'passed', 'OK', Date.now() - started); }
    catch (error) {
      stepFailed = true;
      const failure = safeError(error);
      const status = failure.code === 'CANCELLED' ? 'cancelled' : ['PLAYWRIGHT_UNAVAILABLE', 'BROKER_UNAVAILABLE', 'READINESS_UNAVAILABLE', 'READINESS_HTTP'].includes(failure.code) ? 'blocked' : 'failed';
      onStep(id, status, failure.code, Date.now() - started);
      throw failure;
    }
  };
  let profile;
  let actualBuild = null;
  await mark('profile-policy', async () => {
    const result = await brokerCall({ brokerCli, args: ['--json', 'profiles'], deadline, ipcConfig });
    profile = assertProfilePolicy(workflow, jsonOutput(result.stdout).profiles);
  });
  await mark('readiness', async () => { const result = await fetchStatus(sameOriginUrl(origin, workflow.checks.readinessPath), deadline, workflow.target.buildId); actualBuild = result.actualBuild; });
  let sessionFile;
  let browser;
  let context;
  let page;
  let popupSeen = false;
  try {
    await mark('broker-check', async () => {
      const result = await brokerCall({ brokerCli, args: ['--json', 'check', workflow.profile], deadline, ipcConfig });
      const check = jsonOutput(result.stdout);
      if (check.ok !== true || check.email !== workflow.identity.email || check.role !== workflow.identity.role) throw new SmokeError('BROKER_IDENTITY_MISMATCH');
    });
    await mark('session', async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'testlane-smoke-'));
      await chmod(tempRoot, 0o700).catch(() => {});
      sessionFile = path.join(tempRoot, 'session.json');
      await brokerCall({ brokerCli, args: ['session', workflow.profile, '--format', 'storage-state', '--out', sessionFile], deadline, ipcConfig });
      const state = JSON.parse(await readFile(sessionFile, 'utf8'));
      if (!Array.isArray(state.cookies) || state.cookies.length === 0 || state.origins === undefined) throw new SmokeError('SESSION_INVALID');
    });
    if (deadline.isCancelled()) {
      onStep('identity', 'cancelled', 'CANCELLED', 0);
      throw new SmokeError('CANCELLED');
    }
    // Bringing up the browser (launch -> context -> page -> first navigation)
    // is now inside the `identity` mark(), same as everything else that has
    // to succeed before an identity can be asserted. Previously these ran
    // between steps: a launch failure here threw past every mark() with no
    // onStep() call at all, so the step set was just missing 4 steps and the
    // report surfaced as "blocked" with no reason pointing at the browser.
    await mark('identity', async () => {
      const { chromium } = await browserModule(loadBrowser);
      // `timeout` bounds Playwright's *own* wait for the browser to become
      // ready and -- unlike the outer deadline.race() below, which only
      // stops *awaiting* the launch promise -- Playwright documents that it
      // also kills the child process it spawned when this fires, instead of
      // leaving a startup that never signals readiness (e.g. AV still
      // scanning the freshly-installed binary) running past the deadline.
      const launchPromise = chromium.launch({ headless: true, timeout: deadline.remaining() });
      try { browser = await withDeadline(launchPromise, deadline); }
      catch (error) { void launchPromise.then((lateBrowser) => lateBrowser.close().catch(() => {})).catch(() => {}); throw launchFailure(error, { detail: true }); }
      const contextPromise = browser.newContext({ storageState: sessionFile, serviceWorkers: 'block' });
      try { context = await withDeadline(contextPromise, deadline); }
      catch (error) { void contextPromise.then((lateContext) => lateContext.close().catch(() => {})).catch(() => {}); throw launchFailure(error); }
      navigationGuards.push(observeNavigationOrigin(context, origin));
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || request.resourceType() === 'websocket' || request.resourceType() === 'eventsource') return route.abort();
        return route.continue();
      });
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', (socket) => socket.close());
      try { page = await context.newPage(); }
      catch (error) { throw launchFailure(error); }
      page.on('popup', (popup) => { popupSeen = true; void popup.close(); });
      const response = await withDeadline(page.goto(origin, { waitUntil: 'domcontentloaded', timeout: deadline.remaining() }), deadline);
      assertNavigationOrigin(page, response, origin);
      await pageFetch(page, workflow.checks.identityPath, deadline,
        (payload) => payload.status === 200 && payload.body?.email === workflow.identity.email && payload.body?.role === workflow.identity.role);
    });
    await mark('protected-page', async () => {
      const response = await withDeadline(page.goto(sameOriginUrl(origin, workflow.checks.protectedPath), { waitUntil: 'domcontentloaded', timeout: deadline.remaining() }), deadline);
      assertNavigationOrigin(page, response, origin);
      if (popupSeen) throw new SmokeError('POPUP_BLOCKED');
      const heading = page.getByRole('heading', { name: workflow.checks.protectedHeading, exact: true });
      await heading.waitFor({ state: 'visible', timeout: deadline.remaining() });
      assertNavigationOrigin(page, null, origin);
    });
    await mark('api', () => pageFetch(page, workflow.checks.apiPath, deadline, (payload) => payload.status >= 200 && payload.status < 300));
    await mark('anonymous-denied', async () => {
      const anonymous = await withDeadline(browser.newContext({ serviceWorkers: 'block' }), deadline);
      try {
        navigationGuards.push(observeNavigationOrigin(anonymous, origin));
        await anonymous.route('**/*', (route) => {
          try { return new URL(route.request().url()).origin === origin ? route.continue() : route.abort(); }
          catch { return route.abort(); }
        });
        const page = await anonymous.newPage();
        const response = await withDeadline(page.goto(origin, { waitUntil: 'domcontentloaded', timeout: deadline.remaining() }), deadline);
        assertNavigationOrigin(page, response, origin);
        await pageFetch(page, workflow.checks.apiPath, deadline, (payload) => payload.status === 401 || payload.status === 403);
      } finally { await anonymous.close(); }
    });
  } finally {
    let cleanupFailed = false;
    try { await cleanupHook?.(); } catch { cleanupFailed = true; }
    try { if (context) await deadline.cleanupRace(context.close()); } catch { cleanupFailed = true; }
    try { if (browser) await deadline.cleanupRace(browser.close()); } catch { cleanupFailed = true; }
    try { if (sessionFile) await rm(path.dirname(sessionFile), { recursive: true, force: true }); } catch { cleanupFailed = true; }
    // Request/response events can arrive after the final step, including while
    // contexts close. Finalize sticky guards only after every cleanup attempt.
    // Preserve an already-recorded failed step; otherwise fail cleanup so an
    // all-passed step set cannot produce a passed report.
    for (const guard of navigationGuards) { try { guard.assert(); } catch { if (!stepFailed) cleanupFailed = true; } }
    deadline.dispose?.();
    if (cleanupFailed) throw new SmokeError('CLEANUP_FAILED');
  }
  return { profile, actualBuild };
}

export async function writeEvidence(outputDir, report) {
  await mkdir(outputDir, { recursive: true });
  const stem = `workflow-smoke-${report.runId}`;
  await writeFile(path.join(outputDir, `${stem}.log`), `${report.steps.map((s) => `${s.id} ${s.status} ${s.reasonCode}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(outputDir, `${stem}.exit`), `${report.verdict === 'passed' ? '0' : '1'}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(outputDir, `${stem}.report.json`), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { report: path.join(outputDir, `${stem}.report.json`), log: path.join(outputDir, `${stem}.log`), exit: path.join(outputDir, `${stem}.exit`) };
}
