# @testlane/feature-acceptance-workflow

A runnable, two-role feature-acceptance template for Testlane: a **writer**
creates one record through a real browser, a **reader** is proven unable to
mutate it, and the run verifiably cleans up after itself. It is the
authenticated-smoke template's bigger sibling -- where
[`authenticated-smoke`](../authenticated-smoke) proves "can this profile sign
in and reach its protected page", this package proves "can two distinct
accounts exercise one create/read/deny-mutate/delete feature end to end,
against a data set this run is allowed to touch." Writer and reader profiles and
emails must differ; role labels need not. The runtime checks establish effective access.

This package is a **template for your own application**, not a finished
product to run as-is. Point `--manifest` at your app's own paths and form
labels; the runner never assumes anything about your app beyond the adapter
contract below.

**This template must stay installed next to
[`authenticated-smoke`](../authenticated-smoke):** its `runtime.mjs` imports
session and deadline helpers from `../authenticated-smoke/runtime.mjs`, so
`run.mjs` cannot execute the workflow with that sibling folder missing or
moved (it now fails fast with a fixed message instead of a raw stack trace;
see [Known limits](#known-limits)).

For an installed package, use the [project setup](../../../docs/project-install.md#run-the-shipped-workflows)
and `testlane workflow feature` from your app root. This resolves app-local Playwright without
installing dependencies inside Testlane. Direct runner instructions below also support
source/template development.

## How it works

1. `run.mjs` parses a strict, secret-free manifest (`manifest.mjs`, built on
   [`src/workflows/feature-contracts.ts`](../../../src/workflows/feature-contracts.ts))
   and, unless `--receipt` is omitted, a trusted test-environment receipt.
2. It runs the 13 steps in `REQUIRED_FEATURE_STEPS` order, serially, stopping
   at the first step that does not pass.
3. Cleanup always runs afterward, on its own bounded budget, regardless of
   how the run ended.
4. A sanitized report (`report.mjs`, `deriveFeatureReport`/`parseFeatureReport`)
   and evidence (`<runId>.log`, `.exit`, `.report.json`) are written
   create-only to `--output-dir`.
5. Exit code is `0` only when the report's verdict is `passed`.

Two brokers can drive the steps: the real `testlane` CLI (the default, used
by the `run.mjs` CLI and by `real-broker-proof.mjs`), or, for the package's
own tests only, a test-only IPC "broker double"
(`../test-support/broker-double.mjs`) that never touches a real secret
store. `runFeatureAcceptance` (exported from `runtime.mjs`) is the runtime
entry point the tests use directly; `ipcConfig`, `recordIdFactory`,
`loadBrowser` and `cleanupHook` are test hooks only and are never reachable
from the CLI.

## The application adapter this runner expects

The runner assumes your app under test behaves like the shared
[`reference-app.mjs`](../test-support/reference-app.mjs) fixture it is
tested against:

- `checks.readinessPath` -- 2xx, no redirect, and (since `target.buildId` is
  always required here) an `X-Build-Id` header matching the manifest exactly
  before the report records `target.actualBuild`.
- `checks.identityPath` -- 200 JSON `{ email, role }` for the session
  presented, fetched from inside a real headless-Chromium page for both the
  writer and the reader (`writer-identity`/`reader-identity`), proving the
  broker's own session artifact actually works in a browser, not just that
  the broker *says* it issued one.
- `checks.environmentPath` -- anonymous, 200 JSON `{ runId, dataScope,
  environment, buildId }`: the live values the app itself believes it is
  running with, compared to the trusted receipt (see below).
- `record.createPagePath` -- for the writer's session, an HTML form whose
  labelled inputs match `record.form.idLabel` / `record.form.titleLabel`
  (found with Playwright's `getByLabel(..., { exact: true })`) and whose
  submit control's visible text matches `record.form.submitLabel`
  (`getByRole('button', { name, exact: true })`); submitting it creates a
  record and shows `record.form.createdText`.
- `record.collectionPath + "/" + id` -- a REST-shaped record resource: `GET`
  returns `{ id, title, scope, createdBy, version }` for the writer or the
  reader (401 anonymous); `PUT` updates it for the writer and returns
  exactly `403` **with no state change** for the reader; `DELETE` removes it
  for the writer (403 for the reader).

The runner never assumes anything about your app beyond this contract --
it does not create accounts, read a vault, type a password, or execute an
arbitrary command string. The runner itself never handles a password at all;
seeding one is a separate, human `testlane store set <profile>` step (over
that command's own stdin), and, for this package's own proofs and tests
only, the `../test-support` harness does the same over stdin.

## The trusted receipt, and what it does NOT prove

`--receipt` names a `test-environment-receipt` JSON file (schema in
[`schema/test-environment-receipt.schema.json`](../../../schema/test-environment-receipt.schema.json),
issued in this repo's tests and proof by
[`../test-support/receipt.mjs`](../test-support/receipt.mjs)). It is a
contract with a **trusted setup adapter** -- something the operator already
trusts to have provisioned an isolated, dedicated-per-run backing store for
the app under test, and to say so in writing before the run starts. It is
**not cryptographic proof** of an application's backing data: a loopback
host or a `sandbox`/`testing` environment tag alone never establishes
isolated data by themselves.

`environment-receipt` (step 3) is the only step that consults it, in this
order: a missing or unreadable `--receipt` file reports `blocked` /
`blocked-prerequisite` (**no broker session is ever issued before this step
passes**); an unparsable or schema-invalid file, a `verifyReceiptForRun`
mismatch (wrong workflow id, origin, environment, build id, not-yet-valid,
or expired), or a live `checks.environmentPath` response that disagrees with
the receipt's `runId`/`dataScope`/`environment`/`buildId` all report
`failed` / `target-refused`. On success the report's `environmentRun` is set
to `{ runId, dataScope }` straight from the receipt.

## Steps

`REQUIRED_FEATURE_STEPS`, in run order: `profile-policy`, `readiness`,
`environment-receipt`, `writer-session`, `reader-session`,
`writer-identity`, `reader-identity`, `record-absent`, `browser-create`,
`api-readback`, `reader-read`, `reader-mutation-denied`,
`unchanged-after-denial`. Full behaviour for each is documented in
[`docs/workflows/feature-acceptance-contracts.md`](../../../docs/workflows/feature-acceptance-contracts.md)
and mirrored in this package's own step-by-step comments in `runtime.mjs`.
`profile-policy` mirrors the authenticated-smoke runner's own (unexported)
`assertProfilePolicy` rules, extended to two roles: neither profile may be
tagged production, the target host must not be the host of *any*
production-tagged profile in the registry (defense in depth -- the real
broker's own registry loader refuses that overlap first; see
"Known limits" below), each profile's strategy, origin, environment,
email and role must agree with the manifest, and the writer/reader profiles
and emails must differ.

`record-absent`, `api-readback`, `reader-read`, `reader-mutation-denied` and
`unchanged-after-denial` talk to the app with a plain, cookie-authenticated
Node `fetch` built from the role's own storage state -- only
`writer-identity`, `reader-identity` and `browser-create` need a real
browser, so only one headless Chromium instance is launched for the whole
run (bounded by the run's deadline; a late-arriving launch is closed rather
than leaked).

Browser checks validate the final page origin and navigation redirect chains,
including an off-origin hop that returns to the app. An observed off-origin
navigation fails the run. Playwright routing is best effort and can miss
server-redirect hops; these checks reject the result but do not guarantee
that the browser never contacts another origin.

## Cleanup and its limits

Cleanup always runs, in its own budget (`cleanupTimeoutMs`, separate from
the run's own `timeoutMs`), regardless of how the run ended: close both
browser contexts, verify and (only if owned by the writer) delete the
created record, close the browser, remove every owned session temp directory,
including one created by an issuance attempt that failed or was cancelled.
Record cleanup starts as soon as `browser-create` is attempted: a navigation
or either field fill can fail before submission, and the runner still checks
for a record and records verified absence or a cleanup failure.
`cleanup.record` is one of `FEATURE_CLEANUP_RECORD_STATES`:

- `none` -- `browser-create` was never observed.
- `absent-verified` -- the attempted record is confirmed absent without
  being deleted by this run (e.g. a field fill failed before submission or
  the app's own create silently no-opped).
- `deleted-verified` -- this run deleted it as the writer and confirmed the
  delete by re-reading.
- `retained-unowned` -- a record exists that this run cannot safely delete
  (ownership/scope does not check out); it is never deleted.
- `failed` -- cleanup could not determine or achieve any of the above.

**Known limit:** `absent-verified` proves absence only *at cleanup time*. If
the app applies a write after the client already gave up on it (a timeout or
cancellation mid-request), that write is outside what this runner can
observe -- the run has already failed for its own reason (timeout,
cancellation), the record id is random and scoped to this one run, and
teardown of the whole dedicated test environment is the trusted setup
adapter's job, not this runner's. See the
[feature-acceptance contracts](../../../docs/workflows/feature-acceptance-contracts.md)
for receipt ownership and cleanup verdicts.

## Evidence

Failed and cancelled steps still produce the report, log and nonzero exit
evidence, with a fixed step/reason diagnostic on stderr. If report validation
or evidence I/O itself fails, the runner exits nonzero with a fixed diagnostic
and does not claim a finalized report. Errors from operations that consume a
session are not printed; browser startup retains its bounded setup hint.

`<output-dir>/feature-acceptance-<runId>.log|.exit|.report.json`, all
create-only (`wx`): the log and exit files are written before the report, so
a collision on any of the three (same `runId`) leaves the earlier files
untouched and never produces a finalized report. The log has one
`<step> <status> <reasonCode>` line per observed step plus one final
`cleanup <status> <record>` line -- nothing else. Nothing about a response
body, header, cookie, storage state, broker output or browser error is ever
written to the log, the report, stdout, or a thrown error message.

## Running the tests

Requires a source checkout; not included in the npm package (`tests/` and
`../test-support` both ship only in the repo).

```text
npm --prefix examples/workflows/feature-acceptance install --no-audit --no-fund
TESTLANE_HOME=/tmp/testlane-feature-test-scratch AGENT_AUTH_HOME=/tmp/testlane-feature-test-scratch \
  npm --prefix examples/workflows/feature-acceptance test
```

Uses the shared reference app and broker double from
[`../test-support`](../test-support) plus a real headless Chromium (from the
`playwright` optional dependency installed above); accounts and session
tokens are generated in memory per test. Always point `TESTLANE_HOME`/
`AGENT_AUTH_HOME` at a scratch directory first -- these tests never touch a
real vault, but it costs nothing to be sure.

## Running the real-broker proof

Requires a source checkout; not included in the npm package
(`real-broker-proof.mjs` and `../test-support` both ship only in the repo).

This package's own `node_modules` (Playwright included) is separate from every other
template's, so `npm --prefix examples/workflows/feature-acceptance install --no-audit
--no-fund` must run at least once here even if you already ran it for
`authenticated-smoke`; only the Chromium *browser download* itself is shared:

```text
npm --prefix examples/workflows/feature-acceptance install --no-audit --no-fund
npx --prefix examples/workflows/feature-acceptance playwright install chromium
node examples/workflows/feature-acceptance/real-broker-proof.mjs --json
```

Runs the **unmodified** `run.mjs` CLI as a child process against a real
reference app and the actual built broker (`dist/cli.js`), inside a
throwaway scratch home, for four cases: `happy`, `deny-but-mutate`,
`missing-receipt`, `wrong-identity`. Requires a supported platform
(`realBrokerSupport()` in `../test-support/real-broker.mjs` -- Windows via
DPAPI always, Linux via secret-service only with `TESTLANE_REAL_KEYCHAIN=1`
and `secret-tool` on `PATH`, **never** macOS), the broker already built
(`dist/cli.js`, `dist/workflows/feature-contracts.js`), and Playwright +
Chromium installed in this package. A missing prerequisite makes the proof
**block** (exit 2), never silently pass or skip. Exit codes: `0` every case
met its expectation, `1` any case failed, `2` blocked. Evidence (a summary
`.json`, a short `.log`, the numeric `.exit`) is written create-only to
`--output-dir` (default `./output`). Every leak check (generated passwords,
every minted session token) across stdout/stderr, evidence, manifest,
receipt, registry and the scratch audit log is a boolean
(`text.includes(needle) === false`), never a comparison that could echo a
secret.

## Known limits

- Against the **real** broker, a production-tagged profile sharing a
  hostname with a non-production profile is refused by the registry loader
  itself (`src/profiles.ts`'s `productionOverlapIssues`) before this
  runner's own `profile-policy` step ever sees it, so that specific
  interface discrepancy documented for the smoke package's real-broker proof
  applies here too. This package's own `profile-policy` refusal is exercised
  against the broker **double** in `tests/runner.test.mjs`, where it
  reliably yields `production-refused` with zero app requests; the
  real-broker proof does not add a shared-host production case for the same
  reason the smoke package's proof does not.
- This package's fixture integration (the shared reference app, its faults,
  and the four real-broker-proof cases) is a **test fixture for this
  runner**, not a pilot against a real consumer application. Point
  `--manifest` at your own app's paths, form labels and roles to use this
  template for real.
- Copying this folder without its `../authenticated-smoke` sibling (its
  `runtime.mjs` imports from there) makes `run.mjs` exit 1 with `feature
  acceptance failed before execution: examples/workflows/authenticated-smoke
  must be installed next to this template; see README` and no stack trace,
  rather than executing anything.
