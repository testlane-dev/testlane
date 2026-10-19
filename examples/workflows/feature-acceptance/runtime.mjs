/**
 * Runtime for the two-role feature-acceptance workflow: a writer creates one
 * record, a reader is proven unable to mutate it, and the run verifiably
 * cleans up after itself. Serial, 13 required steps
 * (`REQUIRED_FEATURE_STEPS`), stop at the first non-passed step; cleanup
 * always runs afterward, on its own bounded budget.
 *
 * Reuses `../authenticated-smoke/runtime.mjs` unchanged for the broker
 * transport (`brokerCall`), the run/cleanup deadlines (`createDeadline`),
 * the failure envelope (`SmokeError`) and the readiness check
 * (`fetchStatus`); none of their guards are weakened here. Everything else
 * (profile policy for two roles, the trusted-receipt check, browser
 * identity, the record lifecycle, and cleanup) is specific to this runner.
 *
 * Never surfaces a response body, header, cookie, storage state, broker
 * output or browser error: every failure is a fixed `SmokeError` code, and
 * every leak check downstream compares booleans, never raw values. The one
 * exception is outside the report: a `chromium.launch()` failure carries a
 * bounded line of its own error text for the runner's stderr hint, because
 * that call is made with no session-derived input (see `launchFailure` in
 * ../authenticated-smoke/runtime.mjs).
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { brokerCall, createDeadline, SmokeError, fetchStatus, launchFailure, launchHintLine, loadProjectBrowser, browserInstallDirectory, assertNavigationOrigin, observeNavigationOrigin } from '../authenticated-smoke/runtime.mjs';
import { allowedStrategy, verifyReceiptForRun } from './manifest.mjs';

// Re-exported so run.mjs (and any other caller) can import the run/cleanup
// deadline factory and the launch-failure stderr hint formatter from this
// module alone, without reaching into the smoke package's runtime directly.
// `launchFailure` (imported above) is the shared LAUNCH_FAILED classifier:
// see the comment on it in ../authenticated-smoke/runtime.mjs.
export { createDeadline, launchHintLine, browserInstallDirectory };

const SESSION_TEMP_PREFIX = 'testlane-feature-';

/** Step codes that block rather than fail: an unavailable prerequisite, never the app under test. */
const BLOCKED_CODES = ['PLAYWRIGHT_UNAVAILABLE', 'BROKER_UNAVAILABLE', 'READINESS_UNAVAILABLE', 'READINESS_HTTP', 'RECEIPT_MISSING'];

function safeError(error) {
  if (error instanceof SmokeError) return error;
  const code = error?.name === 'AbortError' ? 'TIMEOUT' : error?.code === 'ENOENT' ? 'BROKER_UNAVAILABLE' : 'PROCESS_ERROR';
  return new SmokeError(code);
}

function classify(code) {
  if (code === 'CANCELLED') return 'cancelled';
  if (BLOCKED_CODES.includes(code)) return 'blocked';
  return 'failed';
}

function jsonOutput(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeError('BROKER_OUTPUT_INVALID');
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return '';
  }
}

function loopback(value) {
  const host = new URL(value).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function productionHost(value) {
  try {
    return new URL(value)
      .hostname.toLowerCase()
      .replace(/\.$/u, '')
      .split('.')
      .some((label) => ['prod', 'production', 'live'].includes(label));
  } catch {
    return true;
  }
}

function originOf(value) {
  return new URL(value).origin;
}

function sameOriginUrl(origin, pathname) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin) throw new SmokeError('OFF_ORIGIN_PATH');
  return url.href;
}

function withDeadline(promise, deadline) {
  return deadline.race(promise);
}

// ---------------------------------------------------------------------------
// Step 1: profile-policy (zero app requests; mirrors the smoke
// `assertProfilePolicy` rules for two roles, faithfully reimplemented since
// that function is not exported).
// ---------------------------------------------------------------------------

function findProfile(profiles, name) {
  const profile = profiles.find((candidate) => candidate && candidate.name === name);
  if (!profile) throw new SmokeError('PROFILE_NOT_FOUND');
  return profile;
}

function assertRolePolicy(workflow, profile, role) {
  if (profile.environment === 'production' || workflow.target.environment === 'production') throw new SmokeError('PRODUCTION_REFUSED');
  if (productionHost(profile.baseUrl)) throw new SmokeError('PRODUCTION_REFUSED');
  if (profile.environment !== workflow.target.environment) throw new SmokeError('PROFILE_ENVIRONMENT_MISMATCH');
  if (!allowedStrategy(profile.strategy)) throw new SmokeError('STRATEGY_UNSUPPORTED');
  if (originOf(profile.baseUrl) !== workflow.target.origin) throw new SmokeError('ORIGIN_MISMATCH');
  if (profile.email !== role.email || profile.role !== role.role) throw new SmokeError('PROFILE_IDENTITY_MISMATCH');
}

function assertFeatureProfilePolicy(workflow, profiles) {
  if (!Array.isArray(profiles)) throw new SmokeError('PROFILE_METADATA_INVALID');
  if (!loopback(workflow.target.origin)) throw new SmokeError('NON_LOOPBACK_TARGET');
  const targetHost = hostname(workflow.target.origin);
  const productionHosts = profiles
    .filter((candidate) => candidate?.environment === 'production')
    .map((candidate) => hostname(candidate.baseUrl))
    .filter(Boolean);
  if (productionHosts.includes(targetHost)) throw new SmokeError('PRODUCTION_REFUSED');
  const writerProfile = findProfile(profiles, workflow.roles.writer.profile);
  const readerProfile = findProfile(profiles, workflow.roles.reader.profile);
  assertRolePolicy(workflow, writerProfile, workflow.roles.writer);
  assertRolePolicy(workflow, readerProfile, workflow.roles.reader);
  if (writerProfile.name === readerProfile.name) throw new SmokeError('PROFILE_IDENTITY_MISMATCH');
  if (workflow.roles.writer.email.toLowerCase() === workflow.roles.reader.email.toLowerCase()) throw new SmokeError('PROFILE_IDENTITY_MISMATCH');
}

// ---------------------------------------------------------------------------
// Step 3: environment-receipt (anonymous Node fetch; no session issued
// before this step passes).
// ---------------------------------------------------------------------------

async function anonymousGet(deadline, url) {
  const controller = new AbortController();
  return deadline.race(fetch(url, { redirect: 'manual', signal: controller.signal }), () => controller.abort());
}

// ---------------------------------------------------------------------------
// Steps 4-5: writer-session / reader-session.
// ---------------------------------------------------------------------------

async function establishSession({ role, brokerCli, deadline, ipcConfig, sessionRoots }) {
  const result = await brokerCall({ brokerCli, args: ['--json', 'check', role.profile], deadline, ipcConfig });
  const check = jsonOutput(result.stdout);
  if (check.ok !== true || check.email !== role.email || check.role !== role.role) throw new SmokeError('BROKER_IDENTITY_MISMATCH');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), SESSION_TEMP_PREFIX));
  // Keep ownership before any later await: issuance may write a live session
  // and then fail or be cancelled before it can return a session state.
  sessionRoots.add(tempRoot);
  await chmod(tempRoot, 0o700).catch(() => {});
  const sessionFile = path.join(tempRoot, 'session.json');
  await brokerCall({ brokerCli, args: ['session', role.profile, '--format', 'storage-state', '--out', sessionFile], deadline, ipcConfig });
  const state = JSON.parse(await readFile(sessionFile, 'utf8'));
  if (!Array.isArray(state.cookies) || state.cookies.length === 0 || state.origins === undefined) throw new SmokeError('SESSION_INVALID');
  return { file: sessionFile, root: tempRoot, cookies: state.cookies };
}

// ---------------------------------------------------------------------------
// Steps 6-7 (and browser use in step 9): one shared headless Chromium,
// bounded by the deadline, one context per role.
// ---------------------------------------------------------------------------

async function browserModule(loadBrowser) {
  try {
    return await (loadBrowser ? loadBrowser() : loadProjectBrowser());
  } catch {
    throw new SmokeError('PLAYWRIGHT_UNAVAILABLE');
  }
}

async function pageFetch(page, pathname, deadline, expected) {
  const payload = await withDeadline(
    page.evaluate(async ({ pathname }) => {
      const response = await fetch(pathname, { redirect: 'manual', credentials: 'same-origin' });
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* body intentionally not surfaced */
      }
      return { status: response.status, redirected: response.redirected, body };
    }, { pathname }),
    deadline,
  );
  if (payload.redirected || !expected(payload)) throw new SmokeError('ASSERTION_FAILED');
  return payload;
}

// ---------------------------------------------------------------------------
// Steps 8, 10-13: Node-fetch, cookie-authenticated record calls (no browser
// needed once the identity steps have proven the session file works).
// ---------------------------------------------------------------------------

function cookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function authorizedFetch(deadline, origin, pathname, cookies, init = {}) {
  const url = sameOriginUrl(origin, pathname);
  const controller = new AbortController();
  const headers = { ...(init.headers ?? {}), cookie: cookieHeader(cookies) };
  return deadline.race(fetch(url, { ...init, headers, redirect: 'manual', signal: controller.signal }), () => controller.abort());
}

async function discardBody(response) {
  if (response.body) await response.body.cancel().catch(() => {});
}

async function readJsonBody(response, failureCode) {
  try {
    return await response.json();
  } catch {
    throw new SmokeError(failureCode);
  }
}

function defaultRecordId() {
  return `tl-${randomBytes(10).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Cleanup: record verification is a Node fetch built from the writer's own
// storage state, same-origin only, never a delete without proven ownership.
// ---------------------------------------------------------------------------

async function cleanupRecordState({ cleanupDeadline, origin, workflow, recordId, writerCookies, dataScope, writerEmail }) {
  const url = sameOriginUrl(origin, `${workflow.record.collectionPath}/${recordId}`);
  const headers = { cookie: cookieHeader(writerCookies) };

  const getController = new AbortController();
  const getResponse = await cleanupDeadline.race(fetch(url, { redirect: 'manual', headers, signal: getController.signal }), () => getController.abort());
  if (getResponse.status === 404) {
    await discardBody(getResponse);
    return 'absent-verified';
  }
  if (getResponse.status !== 200) {
    await discardBody(getResponse);
    return 'failed';
  }
  let body;
  try {
    body = await getResponse.json();
  } catch {
    return 'failed';
  }
  const owned = body && body.id === recordId && body.scope === dataScope && body.createdBy === writerEmail;
  if (!owned) return 'retained-unowned';

  const delController = new AbortController();
  const deleteResponse = await cleanupDeadline.race(fetch(url, { method: 'DELETE', redirect: 'manual', headers, signal: delController.signal }), () => delController.abort());
  await discardBody(deleteResponse);
  if (deleteResponse.status !== 204 && deleteResponse.status !== 200) return 'failed';

  const verifyController = new AbortController();
  const verifyResponse = await cleanupDeadline.race(fetch(url, { redirect: 'manual', headers, signal: verifyController.signal }), () => verifyController.abort());
  await discardBody(verifyResponse);
  return verifyResponse.status === 404 ? 'deleted-verified' : 'failed';
}

function verifiedTempDir(root) {
  if (root === undefined) return false;
  const resolved = path.resolve(root);
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith(SESSION_TEMP_PREFIX);
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

/**
 * Run the 13 required feature-acceptance steps against `workflow`, then
 * always clean up on its own budget. Resolves `{ actualBuild, environmentRun,
 * cleanup: { status, record } }` when every step passes and cleanup does not
 * fail; otherwise throws the step's `SmokeError` (or a `CLEANUP_FAILED`
 * `SmokeError` when cleanup itself fails, even after 13 passes) carrying
 * `.cleanup`, `.actualBuild` and `.environmentRun` properties with whatever
 * was actually observed before the failure, so a caller can always build a
 * complete, schema-valid report (a passed `readiness`/`environment-receipt`
 * step earlier in the run must still be reflected even when a later step
 * fails).
 */
export async function runFeatureAcceptance({
  workflow,
  receipt,
  receiptProblem = null,
  brokerCli,
  deadline,
  ipcConfig,
  onStep = () => {},
  now,
  recordIdFactory,
  loadBrowser,
  cleanupHook,
}) {
  const origin = workflow.target.origin;

  let actualBuild = null;
  let environmentRun = null;
  let creationAttempted = false;
  let recordId;
  let title;
  let mutationTitle;
  let recordVersion;
  let writerState;
  let readerState;
  let browser = null;
  let writerContext = null;
  let writerPage = null;
  let writerPopupSeen = () => false;
  let readerContext = null;
  const sessionRoots = new Set();
  const navigationObservers = [];

  const mark = async (id, action) => {
    const started = Date.now();
    try {
      const value = await action();
      for (const observer of navigationObservers) observer.assert();
      onStep(id, 'passed', 'OK', Date.now() - started);
      return value;
    } catch (error) {
      const failure = safeError(error);
      onStep(id, classify(failure.code), failure.code, Date.now() - started);
      throw failure;
    }
  };

  async function ensureBrowser() {
    if (browser) return browser;
    const { chromium } = await browserModule(loadBrowser);
    // `timeout` bounds Playwright's own wait for the browser to become ready
    // and -- unlike deadline.race() below, which only stops *awaiting* the
    // launch promise -- Playwright documents that it also kills the child
    // process it spawned when this fires, instead of leaving a startup that
    // never signals readiness (e.g. AV still scanning the freshly-installed
    // binary) running past the deadline.
    const launchPromise = chromium.launch({ headless: true, timeout: deadline.remaining() });
    try {
      browser = await withDeadline(launchPromise, deadline);
      return browser;
    } catch (error) {
      void launchPromise.then((lateBrowser) => lateBrowser.close().catch(() => {})).catch(() => {});
      throw launchFailure(error, { detail: true });
    }
  }

  async function createRoleContext(sessionFile) {
    const activeBrowser = await ensureBrowser();
    const contextPromise = activeBrowser.newContext({ storageState: sessionFile, serviceWorkers: 'block' });
    let context;
    try {
      context = await withDeadline(contextPromise, deadline);
    } catch (error) {
      void contextPromise.then((lateContext) => lateContext.close().catch(() => {})).catch(() => {});
      throw launchFailure(error);
    }
    navigationObservers.push(observeNavigationOrigin(context, origin));
    await context.route('**/*', async (route) => {
      const request = route.request();
      let url;
      try {
        url = new URL(request.url());
      } catch {
        return route.abort();
      }
      if (url.origin !== origin || request.resourceType() === 'websocket' || request.resourceType() === 'eventsource') return route.abort();
      return route.continue();
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', (socket) => socket.close());
    let page;
    try {
      page = await context.newPage();
    } catch (error) {
      throw launchFailure(error);
    }
    let popupSeen = false;
    page.on('popup', (popup) => {
      popupSeen = true;
      void popup.close();
    });
    return { context, page, popupSeen: () => popupSeen };
  }

  let stepError = null;
  try {
    await mark('profile-policy', async () => {
      const result = await brokerCall({ brokerCli, args: ['--json', 'profiles'], deadline, ipcConfig });
      assertFeatureProfilePolicy(workflow, jsonOutput(result.stdout).profiles);
    });

    await mark('readiness', async () => {
      const result = await fetchStatus(sameOriginUrl(origin, workflow.checks.readinessPath), deadline, workflow.target.buildId);
      actualBuild = result.actualBuild;
    });

    await mark('environment-receipt', async () => {
      if (receiptProblem === 'missing') throw new SmokeError('RECEIPT_MISSING');
      if (receiptProblem === 'invalid') throw new SmokeError('RECEIPT_INVALID');
      const check = verifyReceiptForRun(receipt, workflow, { now });
      if (!check.ok) throw new SmokeError('RECEIPT_MISMATCH');
      const response = await anonymousGet(deadline, sameOriginUrl(origin, workflow.checks.environmentPath));
      if (response.status !== 200) {
        await discardBody(response);
        throw new SmokeError('ENVIRONMENT_MISMATCH');
      }
      const body = await readJsonBody(response, 'ENVIRONMENT_MISMATCH');
      if (body?.runId !== receipt.runId || body?.dataScope !== receipt.dataScope || body?.environment !== receipt.environment || body?.buildId !== receipt.buildId) {
        throw new SmokeError('ENVIRONMENT_MISMATCH');
      }
      environmentRun = { runId: receipt.runId, dataScope: receipt.dataScope };
    });

    writerState = await mark('writer-session', () => establishSession({ role: workflow.roles.writer, brokerCli, deadline, ipcConfig, sessionRoots }));
    readerState = await mark('reader-session', () => establishSession({ role: workflow.roles.reader, brokerCli, deadline, ipcConfig, sessionRoots }));

    await mark('writer-identity', async () => {
      const created = await createRoleContext(writerState.file);
      writerContext = created.context;
      writerPage = created.page;
      writerPopupSeen = created.popupSeen;
      const response = await withDeadline(writerPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: deadline.remaining() }), deadline);
      assertNavigationOrigin(writerPage, response, origin);
      await pageFetch(
        writerPage,
        workflow.checks.identityPath,
        deadline,
        (payload) => payload.status === 200 && payload.body?.email === workflow.roles.writer.email && payload.body?.role === workflow.roles.writer.role,
      );
    });

    await mark('reader-identity', async () => {
      const created = await createRoleContext(readerState.file);
      readerContext = created.context;
      const readerPage = created.page;
      const response = await withDeadline(readerPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: deadline.remaining() }), deadline);
      assertNavigationOrigin(readerPage, response, origin);
      await pageFetch(
        readerPage,
        workflow.checks.identityPath,
        deadline,
        (payload) => payload.status === 200 && payload.body?.email === workflow.roles.reader.email && payload.body?.role === workflow.roles.reader.role,
      );
    });

    recordId = (recordIdFactory ?? defaultRecordId)();
    title = `Testlane acceptance ${randomBytes(6).toString('hex')}`;
    mutationTitle = `Testlane denied mutation ${randomBytes(6).toString('hex')}`;

    await mark('record-absent', async () => {
      const response = await authorizedFetch(deadline, origin, `${workflow.record.collectionPath}/${recordId}`, writerState.cookies);
      await discardBody(response);
      if (response.status !== 404) throw new SmokeError('RECORD_PRESENT');
    });

    await mark('browser-create', async () => {
      // Navigation and field events can trigger app work before submission.
      // Every observed creation attempt needs a verified cleanup outcome,
      // including a failed/cancelled navigation or either fill.
      creationAttempted = true;
      const response = await withDeadline(writerPage.goto(sameOriginUrl(origin, workflow.record.createPagePath), { waitUntil: 'domcontentloaded', timeout: deadline.remaining() }), deadline);
      assertNavigationOrigin(writerPage, response, origin);
      await withDeadline(writerPage.getByLabel(workflow.record.form.idLabel, { exact: true }).fill(recordId), deadline);
      await withDeadline(writerPage.getByLabel(workflow.record.form.titleLabel, { exact: true }).fill(title), deadline);
      await withDeadline(writerPage.getByRole('button', { name: workflow.record.form.submitLabel, exact: true }).click(), deadline);
      await withDeadline(writerPage.getByText(workflow.record.form.createdText, { exact: true }).waitFor({ state: 'visible', timeout: deadline.remaining() }), deadline);
      assertNavigationOrigin(writerPage, null, origin);
      if (writerPopupSeen()) throw new SmokeError('POPUP_BLOCKED');
    });

    await mark('api-readback', async () => {
      const response = await authorizedFetch(deadline, origin, `${workflow.record.collectionPath}/${recordId}`, writerState.cookies);
      if (response.status !== 200) {
        await discardBody(response);
        throw new SmokeError('API_READBACK_FAILED');
      }
      const body = await readJsonBody(response, 'API_READBACK_FAILED');
      if (
        body.id !== recordId ||
        body.title !== title ||
        body.scope !== receipt.dataScope ||
        body.createdBy !== workflow.roles.writer.email ||
        !Number.isInteger(body.version) ||
        body.version < 1
      ) {
        throw new SmokeError('API_READBACK_FAILED');
      }
      recordVersion = body.version;
    });

    await mark('reader-read', async () => {
      const response = await authorizedFetch(deadline, origin, `${workflow.record.collectionPath}/${recordId}`, readerState.cookies);
      if (response.status !== 200) {
        await discardBody(response);
        throw new SmokeError('READER_READ_FAILED');
      }
      const body = await readJsonBody(response, 'READER_READ_FAILED');
      if (body.id !== recordId || body.title !== title || body.scope !== receipt.dataScope || body.version !== recordVersion) {
        throw new SmokeError('READER_READ_FAILED');
      }
    });

    await mark('reader-mutation-denied', async () => {
      const response = await authorizedFetch(deadline, origin, `${workflow.record.collectionPath}/${recordId}`, readerState.cookies, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: mutationTitle }),
      });
      await discardBody(response);
      if (response.status !== 403) throw new SmokeError('MUTATION_NOT_DENIED');
    });

    await mark('unchanged-after-denial', async () => {
      const response = await authorizedFetch(deadline, origin, `${workflow.record.collectionPath}/${recordId}`, writerState.cookies);
      if (response.status !== 200) {
        await discardBody(response);
        throw new SmokeError('RECORD_CHANGED_AFTER_DENIAL');
      }
      const body = await readJsonBody(response, 'RECORD_CHANGED_AFTER_DENIAL');
      if (body.title !== title || body.version !== recordVersion || body.scope !== receipt.dataScope) {
        throw new SmokeError('RECORD_CHANGED_AFTER_DENIAL');
      }
    });
  } catch (error) {
    stepError = error;
  }

  // ---- Cleanup: always, on its own budget, regardless of the run's outcome.
  const cleanupDeadline = createDeadline(workflow.cleanupTimeoutMs);
  let cleanupFailed = false;

  // Reserved for cleanupRecordState below (the safety-critical GET/DELETE/
  // verify step): the writer/reader context closes run first on purpose (so
  // in-flight browser requests are aborted before we GET/DELETE), but a
  // single hung context.close() must not be allowed to consume the WHOLE
  // cleanup budget and leave no time for record cleanup -- that would leave
  // a created record undeleted. Each context close's own cleanupRace cap is
  // reduced by this reserve; record cleanup and the final browser.close()
  // are unaffected (browser.close() runs after record cleanup, so it keeps
  // the plain remaining-budget cap).
  const RECORD_CLEANUP_RESERVE_MS = Math.floor(workflow.cleanupTimeoutMs / 2);

  try {
    await cleanupHook?.();
  } catch {
    cleanupFailed = true;
  }
  try {
    if (writerContext) await cleanupDeadline.cleanupRace(writerContext.close(), { reserveMs: RECORD_CLEANUP_RESERVE_MS });
  } catch {
    cleanupFailed = true;
  }
  try {
    if (readerContext) await cleanupDeadline.cleanupRace(readerContext.close(), { reserveMs: RECORD_CLEANUP_RESERVE_MS });
  } catch {
    cleanupFailed = true;
  }

  let recordState = 'none';
  if (creationAttempted) {
    try {
      recordState = await cleanupRecordState({
        cleanupDeadline,
        origin,
        workflow,
        recordId,
        writerCookies: writerState?.cookies ?? [],
        dataScope: receipt?.dataScope,
        writerEmail: workflow.roles.writer.email,
      });
    } catch {
      recordState = 'failed';
    }
    if (recordState === 'retained-unowned' || recordState === 'failed') cleanupFailed = true;
  }

  try {
    if (browser) await cleanupDeadline.cleanupRace(browser.close());
  } catch {
    cleanupFailed = true;
  }
  for (const root of sessionRoots) {
    try {
      if (!verifiedTempDir(root)) throw new SmokeError('CLEANUP_FAILED');
      await rm(path.resolve(root), { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }

  // Late document events must still prevent a passed report. Keep record,
  // browser and session-file cleanup independent of observer finalization.
  // A violation already recorded in a failed step keeps that diagnosis; a
  // new late violation must fail cleanup rather than allow all-passed steps.
  for (const observer of navigationObservers) { try { observer.assert(); } catch { if (!stepError) cleanupFailed = true; } }
  cleanupDeadline.dispose?.();
  deadline?.dispose?.();

  const cleanupOutcome = { status: cleanupFailed ? 'failed' : 'complete', record: recordState };

  if (cleanupFailed) {
    const err = new SmokeError('CLEANUP_FAILED');
    err.cleanup = cleanupOutcome;
    err.actualBuild = actualBuild;
    err.environmentRun = environmentRun;
    throw err;
  }
  if (stepError) {
    stepError.cleanup = cleanupOutcome;
    stepError.actualBuild = actualBuild;
    stepError.environmentRun = environmentRun;
    throw stepError;
  }
  return { actualBuild, environmentRun, cleanup: cleanupOutcome };
}

/**
 * Write create-only evidence for one run: `<stem>.log` (one `<step> <status>
 * <reasonCode>` line per step plus one `cleanup <status> <record>` line),
 * `<stem>.exit` (numeric), then `<stem>.report.json`. A collision on any file
 * leaves the earlier files untouched and never produces a finalized report.
 */
export async function writeFeatureEvidence(outputDir, report) {
  await mkdir(outputDir, { recursive: true });
  const stem = `feature-acceptance-${report.runId}`;
  const logPath = path.join(outputDir, `${stem}.log`);
  const exitPath = path.join(outputDir, `${stem}.exit`);
  const reportPath = path.join(outputDir, `${stem}.report.json`);
  const logLines = [...report.steps.map((step) => `${step.id} ${step.status} ${step.reasonCode}`), `cleanup ${report.cleanup.status} ${report.cleanup.record}`];
  await writeFile(logPath, `${logLines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(exitPath, `${report.verdict === 'passed' ? '0' : '1'}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { report: reportPath, log: logPath, exit: exitPath };
}
