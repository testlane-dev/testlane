import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupReceiptDirs, hex, reportFor, runCase, setupCase, stepFor } from './helpers.mjs';

after(async () => {
  await cleanupReceiptDirs();
});

test('happy path: all 13 steps pass, the record is created then verifiably deleted', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.equal(run.error, null, run.error?.message);
  assert.equal(run.steps.length, 13);
  assert.ok(run.steps.every((step) => step.status === 'passed'));
  assert.equal(run.result.actualBuild, setup.buildId);
  assert.deepEqual(run.result.environmentRun, { runId: setup.appRunId, dataScope: setup.dataScope });
  assert.deepEqual(run.result.cleanup, { status: 'complete', record: 'deleted-verified' });

  const stats = setup.app.stats();
  assert.equal(stats.creates, 1);
  assert.equal(stats.deniedMutations, 1);
  assert.equal(stats.deletes, 1);
  assert.equal(setup.app.records().length, 0);

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.counts.passed, 13);

  // Leak check: the generated passwords and every minted session token never
  // appear in the derived report (booleans only).
  const reportText = JSON.stringify(report);
  const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
  assert.equal(needles.some((needle) => reportText.includes(needle)), false);
});

test('wrong identity at the app (identityRoleOverride for the writer) fails writer-identity', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  // The account email is only known once accounts are minted, so the fault is
  // applied after setupCase() rather than baked into startReferenceApp().
  setup.app.setFaults({ identityRoleOverride: { [setup.writer.email]: 'Impersonator' } });
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'writer-identity')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'writer-session')?.status, 'passed');

  // Leak check: a real writer session was established before this failure;
  // the generated passwords and every minted session token must still never
  // appear in the derived report (booleans only).
  const report = reportFor(setup, run);
  const reportText = JSON.stringify(report);
  const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
  assert.equal(needles.some((needle) => reportText.includes(needle)), false);
});

test('manifest/profile identity mismatch fails profile-policy before any app request', async (t) => {
  const setup = await setupCase({
    // The registry's writer profile is declared with the READER's (still a
    // real, registered) email, so it disagrees with the manifest's writer
    // role -- mintSession still succeeds during ipcConfig setup, but
    // profile-policy must still refuse the mismatch before any app request.
    profilesFactory: ({ origin, environment, writer, reader }) => [
      { name: 'reference:local:writer', email: reader.email, role: writer.role, environment, baseUrl: origin, strategy: 'form-post' },
      { name: 'reference:local:reader', email: reader.email, role: reader.role, environment, baseUrl: origin, strategy: 'form-post' },
    ],
  });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'profile-policy')?.status, 'failed');
  assert.equal(run.steps.length, 1);
  assert.equal(setup.app.stats().requests, 0);
});

for (const role of ['writer', 'reader']) {
  test(`a production-tagged ${role} profile fails profile-policy production-refused with zero app requests`, async (t) => {
    const setup = await setupCase({
      profilesFactory: ({ origin, environment, writer, reader }) => [
        {
          name: 'reference:local:writer',
          email: writer.email,
          role: writer.role,
          environment: role === 'writer' ? 'production' : environment,
          baseUrl: origin,
          strategy: 'form-post',
        },
        {
          name: 'reference:local:reader',
          email: reader.email,
          role: reader.role,
          environment: role === 'reader' ? 'production' : environment,
          baseUrl: origin,
          strategy: 'form-post',
        },
      ],
    });
    t.after(() => setup.app.close());
    const run = await runCase(setup);
    assert.ok(run.error);
    assert.equal(stepFor(run.steps, 'profile-policy')?.status, 'failed');
    assert.equal(stepFor(run.steps, 'profile-policy')?.code, 'PRODUCTION_REFUSED');
    assert.equal(setup.app.stats().requests, 0);
  });
}

test('a declared production profile sharing the target host fails profile-policy production-refused with zero app requests', async (t) => {
  const setup = await setupCase({
    profilesFactory: ({ origin, environment, writer, reader }) => [
      { name: 'reference:local:writer', email: writer.email, role: writer.role, environment, baseUrl: origin, strategy: 'form-post' },
      { name: 'reference:local:reader', email: reader.email, role: reader.role, environment, baseUrl: origin, strategy: 'form-post' },
      { name: 'reference:local:production', email: writer.email, role: writer.role, environment: 'production', baseUrl: origin, strategy: 'form-post' },
    ],
  });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'profile-policy')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'profile-policy')?.code, 'PRODUCTION_REFUSED');
  assert.equal(setup.app.stats().requests, 0);
});

test('an unrelated production profile on another host does not block the loopback target', async (t) => {
  const setup = await setupCase({
    profilesFactory: ({ origin, environment, writer, reader }) => [
      { name: 'reference:local:writer', email: writer.email, role: writer.role, environment, baseUrl: origin, strategy: 'form-post' },
      { name: 'reference:local:reader', email: reader.email, role: reader.role, environment, baseUrl: origin, strategy: 'form-post' },
      { name: 'reference:local:production-other', email: writer.email, role: writer.role, environment: 'production', baseUrl: 'http://localhost:9999', strategy: 'form-post' },
    ],
  });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.equal(run.error, null, run.error?.message);
  assert.ok(run.steps.every((step) => step.status === 'passed'));
});

test('a missing receipt blocks environment-receipt, verdict blocked, and issues no sessions', async (t) => {
  const setup = await setupCase({ receiptProblem: 'missing' });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'environment-receipt')?.status, 'blocked');
  // No session step is even attempted (the broker double still pre-mints one
  // token per configured profile as part of ipcConfig setup, regardless of
  // whether the runner ever calls `session`; app.stats().logins is the
  // ground truth for whether the app itself was ever asked to authenticate).
  assert.equal(stepFor(run.steps, 'writer-session'), undefined);
  assert.equal(stepFor(run.steps, 'reader-session'), undefined);
  assert.equal(setup.app.stats().logins, 0);
  assert.equal(run.error.cleanup.record, 'none');

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'blocked');
});

test('an invalid receipt fails environment-receipt target-refused', async (t) => {
  const setup = await setupCase({ receiptProblem: 'invalid' });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'environment-receipt')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'environment-receipt')?.code, 'RECEIPT_INVALID');
});

test('a receipt with the wrong buildId fails environment-receipt target-refused', async (t) => {
  const setup = await setupCase({ receiptOverrides: { buildId: 'different-build' } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'environment-receipt')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'environment-receipt')?.code, 'RECEIPT_MISMATCH');
});

test('a receipt with the wrong workflowId fails environment-receipt target-refused', async (t) => {
  const setup = await setupCase({ receiptOverrides: { workflowId: 'different-workflow' } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'environment-receipt')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'environment-receipt')?.code, 'RECEIPT_MISMATCH');
});

test('an expired receipt fails environment-receipt target-refused', async (t) => {
  const setup = await setupCase({ receiptOverrides: { ttlMs: 1000, now: new Date(Date.now() - 5 * 60 * 1000) } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'environment-receipt')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'environment-receipt')?.code, 'RECEIPT_MISMATCH');
});

test('a live environment mismatch (wrong runId/dataScope reported by the app) fails environment-receipt target-refused, no record requests', async (t) => {
  const setup = await setupCase({ faults: { environmentOverride: { runId: 'other-run', dataScope: 'other-scope' } } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'environment-receipt')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'environment-receipt')?.code, 'ENVIRONMENT_MISMATCH');
  assert.equal(setup.app.stats().byPath[setup.workflow.record.collectionPath] ?? 0, 0);
});

test('a pre-existing (phantom) record fails record-absent, creates and deletes zero, cleanup complete with record none', async (t) => {
  const setup = await setupCase({ faults: { phantomRecords: true } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'record-absent')?.status, 'failed');
  assert.equal(setup.app.stats().creates, 0);
  assert.equal(setup.app.stats().deletes, 0);
  assert.equal(run.error.cleanup.record, 'none');
  assert.equal(run.error.cleanup.status, 'complete');
});

test('a pre-existing foreign record at the chosen id fails record-absent and is left unchanged', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const seededId = `tl-seededforeign${hex(2)}`;
  const seeded = { id: seededId, title: 'Foreign record', scope: 'someone-elses-scope', createdBy: 'foreign@example.test', version: 1 };
  setup.app.seedRecord(seeded);
  const run = await runCase(setup, { recordIdFactory: () => seededId });
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'record-absent')?.status, 'failed');
  assert.equal(setup.app.stats().creates, 0);
  assert.equal(setup.app.stats().deletes, 0);
  const stillThere = setup.app.records().find((record) => record.id === seededId);
  assert.deepEqual(stillThere, seeded);
});

test('createNoop fails api-readback; cleanup is absent-verified and complete', async (t) => {
  const setup = await setupCase({ faults: { createNoop: true } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'browser-create')?.status, 'passed');
  assert.equal(stepFor(run.steps, 'api-readback')?.status, 'failed');
  assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'absent-verified' });
});

test('createScope (foreign) fails api-readback; cleanup retains the record unowned and fails; no DELETE issued', async (t) => {
  const setup = await setupCase({ faults: { createScope: 'foreign-scope' } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'api-readback')?.status, 'failed');
  assert.deepEqual(run.error.cleanup, { status: 'failed', record: 'retained-unowned' });
  assert.equal(setup.app.stats().deletes, 0);
  assert.equal(setup.app.records().length, 1);
});

test("readerMutation 'allow' fails reader-mutation-denied; cleanup still deletes and verifies", async (t) => {
  const setup = await setupCase({ faults: { readerMutation: 'allow' } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'reader-mutation-denied')?.status, 'failed');
  assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'deleted-verified' });

  // Leak check: writer and reader sessions were both established before this
  // failure; the generated passwords and every minted session token must
  // still never appear in the derived report (booleans only).
  const report = reportFor(setup, run);
  const reportText = JSON.stringify(report);
  const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
  assert.equal(needles.some((needle) => reportText.includes(needle)), false);
});

test("readerMutation 'deny-but-mutate' passes reader-mutation-denied but fails unchanged-after-denial; cleanup deletes; verdict failed", async (t) => {
  const setup = await setupCase({ faults: { readerMutation: 'deny-but-mutate' } });
  t.after(() => setup.app.close());
  const run = await runCase(setup);
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'reader-mutation-denied')?.status, 'passed');
  assert.equal(stepFor(run.steps, 'unchanged-after-denial')?.status, 'failed');
  assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'deleted-verified' });

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'failed');

  // Leak check: writer and reader sessions were both established before this
  // failure; the generated passwords and every minted session token must
  // still never appear in the derived report (booleans only).
  const reportText = JSON.stringify(report);
  const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
  assert.equal(needles.some((needle) => reportText.includes(needle)), false);
});

for (const deleteMode of ['error', 'ignore']) {
  test(`deleteMode '${deleteMode}': all 13 steps pass but cleanup fails (record failed)`, async (t) => {
    const setup = await setupCase({ faults: { deleteMode } });
    t.after(() => setup.app.close());
    const run = await runCase(setup);
    assert.ok(run.error, 'cleanup failure must surface as a thrown error, not a silent pass');
    assert.equal(run.error.code, 'CLEANUP_FAILED');
    assert.equal(run.steps.length, 13);
    assert.ok(run.steps.every((step) => step.status === 'passed'));
    assert.deepEqual(run.error.cleanup, { status: 'failed', record: 'failed' });

    const report = reportFor(setup, run);
    assert.equal(report.counts.passed, 13);
    assert.equal(report.verdict, 'failed');

    // Leak check: this is a cleanup-failure case with both real sessions
    // established (all 13 steps passed); the generated passwords and every
    // minted session token must still never appear in the derived report
    // (booleans only).
    const reportText = JSON.stringify(report);
    const needles = [setup.writer.password, setup.reader.password, ...setup.app.issuedSessionTokens()];
    assert.equal(needles.some((needle) => reportText.includes(needle)), false);
  });
}

test('a timeout during record-absent (delay on the records API) fails/timeout; cleanup record none', async (t) => {
  // The delay fault is armed only once reader-identity (the step immediately
  // before record-absent) has passed, rather than from the start: arming it
  // from the start made this test's outcome depend on the wall-clock cost of
  // every earlier step (including a real Chromium launch in writer-identity),
  // so under load an EARLIER step could time out instead of record-absent.
  // timeoutMs is given ample headroom for those earlier steps, and the delay
  // is comfortably longer than the whole run budget, so record-absent is the
  // step that times out regardless of machine speed.
  const setup = await setupCase({ timeoutMs: 15000, cleanupTimeoutMs: 8000 });
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    onStepExtra: (id, status) => {
      if (id === 'reader-identity' && status === 'passed') setup.app.setFaults({ delayMs: 30000, delayPaths: ['/api/records'] });
    },
  });
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'record-absent')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'record-absent')?.code, 'TIMEOUT');
  assert.equal(run.error.cleanup.record, 'none');
});

test('a timeout during reader-read (after creation) fails/timeout; cleanup still deletes and verifies within its budget', async (t) => {
  // Same determinism as the record-absent case above: the delay is armed only
  // once api-readback has passed, but every step before it (including a real
  // Chromium launch in writer-identity) still has to finish inside timeoutMs.
  // With a 6s budget a cold browser start on a loaded runner could use it up
  // first, so writer-identity -- not reader-read -- timed out (reproduced 1 in
  // 12 runs under CPU load). A 15s budget and a delay well past it (30s) make
  // reader-read the step that times out regardless of machine speed; the
  // cleanup budget is separate, so the record is still deleted and verified.
  const setup = await setupCase({ timeoutMs: 15000, cleanupTimeoutMs: 8000 });
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    onStepExtra: (id, status) => {
      if (id === 'api-readback' && status === 'passed') setup.app.setFaults({ delayMs: 30000, delayPaths: ['/api/records'] });
      if (id === 'reader-read' && status === 'failed') setup.app.setFaults({ delayMs: 0, delayPaths: null });
    },
  });
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'reader-read')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'reader-read')?.code, 'TIMEOUT');
  assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'deleted-verified' });
});

test('cancellation before creation ends cancelled with cleanup record none', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    onStepExtra: (id, status, code, durationMs, deadline) => {
      if (id === 'reader-identity' && status === 'passed') deadline.cancel();
    },
  });
  assert.ok(run.error);
  assert.ok(run.steps.some((step) => step.status === 'cancelled'));
  assert.equal(run.error.cleanup.record, 'none');

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'cancelled');
});

test('cancellation right after browser-create passes ends cancelled with cleanup deleted-verified', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, {
    onStepExtra: (id, status, code, durationMs, deadline) => {
      if (id === 'browser-create' && status === 'passed') deadline.cancel();
    },
  });
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'browser-create')?.status, 'passed');
  assert.ok(run.steps.some((step) => step.status === 'cancelled'));
  assert.deepEqual(run.error.cleanup, { status: 'complete', record: 'deleted-verified' });

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'cancelled');
});

test('a throwing cleanupHook fails cleanup even after 13 passes', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, { cleanupHook: async () => { throw new Error('injected cleanup failure'); } });
  assert.ok(run.error);
  assert.equal(run.error.code, 'CLEANUP_FAILED');
  assert.equal(run.steps.length, 13);
  assert.ok(run.steps.every((step) => step.status === 'passed'));
  assert.equal(run.error.cleanup.status, 'failed');
});

test('a throwing loadBrowser (Playwright unavailable) blocks writer-identity; verdict blocked, never passed', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  const run = await runCase(setup, { loadBrowser: async () => { throw new Error('no playwright here'); } });
  assert.ok(run.error);
  assert.equal(stepFor(run.steps, 'writer-identity')?.status, 'blocked');
  assert.equal(stepFor(run.steps, 'writer-identity')?.code, 'PLAYWRIGHT_UNAVAILABLE');
  assert.equal(stepFor(run.steps, 'reader-identity'), undefined);

  const report = reportFor(setup, run);
  assert.equal(report.verdict, 'blocked');
  assert.notEqual(report.verdict, 'passed');
});

test('a run failing before record creation (record-absent) with a hung browser.close() ends CLEANUP_FAILED with record none, no process crash', async (t) => {
  // Regression test: `cleanupRecordState` (the only caller of
  // `cleanupDeadline.race()`) never runs when the run fails before record
  // creation is even attempted, so cleanup here relies entirely on
  // `cleanupDeadline.cleanupRace()`. `createDeadline()`'s internal
  // `timeoutPromise` only gets a rejection handler by way of `race()` --
  // before the fix, once `cleanupDeadline`'s own timer fired (here, right
  // around when the stalled `browser.close()` below exhausts its
  // `cleanupRace` cap), that rejection had no handler and crashed the whole
  // process with an unhandled rejection before the run could return its
  // outcome at all. `phantomRecords` fails `record-absent` (after both
  // identity steps -- and so the browser and both contexts -- exist), and a
  // small `cleanupTimeoutMs` keeps this fast while still reproducing the
  // synchronization between `cleanupRace`'s per-op cap and the cleanup
  // deadline's own timer.
  const setup = await setupCase({ faults: { phantomRecords: true }, cleanupTimeoutMs: 3000 });
  t.after(() => setup.app.close());
  // Test-only seam: reuse the existing `loadBrowser` override (see 'a hung
  // writerContext.close()' below), but stall `browser.close()` itself
  // instead of a context's close -- record-absent fails before any context
  // needs to be closed early, so only the final `browser.close()` cleanup
  // op is ever at risk of hanging here. The real close is stashed and run
  // via `t.after` regardless of outcome, so this test never leaks a live
  // Chromium process into the rest of the suite (the runtime under test only
  // ever sees the never-resolving stub, exactly as the regression needs).
  let realClose;
  t.after(() => realClose?.().catch(() => {}));
  const run = await runCase(setup, {
    loadBrowser: async () => {
      const real = await import('playwright');
      return {
        chromium: {
          launch: async (options) => {
            const browser = await real.chromium.launch(options);
            realClose = browser.close.bind(browser);
            browser.close = () => new Promise(() => {});
            return browser;
          },
        },
      };
    },
  });
  assert.ok(run.error, 'the run must still return a rejected outcome rather than crash the process');
  assert.equal(stepFor(run.steps, 'record-absent')?.status, 'failed');
  assert.equal(stepFor(run.steps, 'record-absent')?.code, 'RECORD_PRESENT');
  assert.equal(run.error.cleanup.status, 'failed');
  assert.equal(run.error.cleanup.record, 'none');
});

test('a hung writerContext.close() during cleanup does not starve record cleanup; cleanup fails but the record still ends deleted-verified', async (t) => {
  const setup = await setupCase();
  t.after(() => setup.app.close());
  // Test-only seam: reuse the already-existing `loadBrowser` override (see
  // 'a throwing loadBrowser' above) rather than adding a new one. It wraps
  // the real `chromium.launch()`/`browser.newContext()` so the FIRST context
  // created (always the writer's -- writer-identity runs before
  // reader-identity) has its `close()` replaced with a promise that never
  // resolves, simulating a stuck browser context close under load. Nothing
  // else about the real browser/context is touched.
  let contextsCreated = 0;
  const run = await runCase(setup, {
    loadBrowser: async () => {
      const real = await import('playwright');
      return {
        chromium: {
          launch: async (options) => {
            const browser = await real.chromium.launch(options);
            const originalNewContext = browser.newContext.bind(browser);
            browser.newContext = async (contextOptions) => {
              const context = await originalNewContext(contextOptions);
              contextsCreated += 1;
              if (contextsCreated === 1) context.close = () => new Promise(() => {});
              return context;
            };
            return browser;
          },
        },
      };
    },
  });
  assert.ok(run.error);
  assert.equal(run.error.code, 'CLEANUP_FAILED');
  assert.equal(run.steps.length, 13);
  assert.ok(run.steps.every((step) => step.status === 'passed'));
  // The safety-critical assertion: even though writerContext.close() never
  // resolves and cleanup as a whole fails, cleanupRace's reserve for
  // cleanupRecordState must still leave it enough budget to GET, DELETE and
  // verify the created record -- it must never be silently left behind.
  assert.deepEqual(run.error.cleanup, { status: 'failed', record: 'deleted-verified' });
});
