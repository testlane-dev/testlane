# Runnable request approval verification

This disposable app demonstrates the complete Testlane verification loop with
real Chromium, generated sandbox accounts and the native credential store:

1. Five reviewed browser/API cases pass.
2. An in-process controller injects a one-cent server calculation defect. The
   **unchanged** suite catches it in two cases; the run fails.
3. The controller corrects the server. The same plan and spec pass again.

All four mutating cases delete only their owned records and assert 404 afterward.
The app contains zero records after each run. The fifth case checks anonymous 401.
The failing run remains in the output beside both passing runs.

This example is new source work for the next release. **It is not included in
`@testlane/cli@0.7.0-beta.2`.** Use the source instructions until a package containing
this directory is published. It is a reproducible teaching example with prewritten
tests, not evidence that a coding agent independently designed these tests.

## Run from a source checkout

Requires Node 22+, an available native store, and the example's existing Playwright
1.64.0 dependencies and Chromium. From the Testlane repository root:

```sh
npm ci
npm run build
npm --prefix examples/playwright ci
npm --prefix examples/playwright exec -- playwright install chromium
npm run demo:verification -- --json
```

On PowerShell use `npm.cmd` when execution policy blocks the `.ps1` shim. Linux may
need `playwright install --with-deps chromium`; review those OS package changes first.
The runner never installs dependencies or browsers itself. It uses app-local
Playwright if available, or the installed `examples/playwright` dependencies when
started from this source checkout. Advanced development can select another existing
dependency project with `TESTLANE_VERIFICATION_TEST_PROJECT`; it must already have
`package.json` and `@playwright/test`. This variable selects dependencies, not an app
target or credential source.

Windows uses DPAPI under a newly created private demo home. On **Linux or macOS**,
a different home does not isolate native keychain entries, so the command above
refuses before seeding. Read [platform prerequisites](../../docs/platforms.md), unlock
the store, then explicitly acknowledge creating and deleting this run's uniquely
named entries in your current user's Secret Service/macOS Keychain:

```sh
npm run demo:verification -- --allow-user-keychain --json
```

Linux requires `secret-tool`, a D-Bus session and an unlocked Secret Service keyring;
macOS may show its normal Keychain prompt. The acknowledgement authorizes only the
new generated accounts for this demo. Existing profiles and credentials are not used.
Do not run unattended unless that native store/session is available.

## Run an installed version that contains this example

From an app project with that exact Testlane version, `@playwright/test` and its
Chromium already installed:

```sh
node node_modules/@testlane/cli/examples/verification-demo/run.mjs --json
```

Linux/macOS also require `--allow-user-keychain` as described above. The installed
command uses the app's dependencies and its own installed broker; checkout-only
test support is not needed. It creates a separate disposable project under
`output/testlane-demo/run-<uuid>/app/`, whose local ignore file keeps reports and
generated configuration private. It never modifies an existing app suite or starts
the app from which you ran the command.

## Inspect and adapt the example

- [brief.md](brief.md) states the independent business requirements.
- [feature.spec.mjs](feature.spec.mjs) contains five real Playwright cases.
- [suite.mjs](suite.mjs) prepares a new reviewed `plan.json` and fixture configuration.
- [app.mjs](app.mjs) is a built-in Node HTTP/HTML app with no new runtime dependency.
- [native.mjs](native.mjs) bounds subprocesses and gates native-keychain access.
- [run.mjs](run.mjs) performs the three runs and removes native credential entries.

The demo server always binds `127.0.0.1` on an ephemeral port. Its only login is
`POST /api/login` with generated email/password JSON, setting an HttpOnly cookie.
The controller's defect switch is an exported in-process method; there is no test
admin or authentication-bypass HTTP endpoint. The app is in-memory teaching code;
do not deploy it or use real accounts.

The saved request contains nine compared fields: identifier, run marker, owner,
quantity, unit price, total, status, approver and version. The Editor cannot approve;
the Reviewer can approve once; repeat approval returns 409 without changing any
field. Only the two arithmetic/approval feature cases assert the independent
4,200-cent oracle. Denial/conflict cases compare full before/after snapshots so the
injected price defect does not disguise an authorization result.

`prepareDemoSuite({projectRoot, packageRoot, origin, editorProfile, reviewerProfile,
editor, reviewer})` returns absolute `planFile` and `specFile` paths. Both roots must
be absolute; `projectRoot` already needs `package.json` and installed Playwright.
`packageRoot` is the installed Testlane root or a built checkout. Preparation creates
a new `e2e/testlane-demo/` and refuses an existing directory. It copies the canonical
fixture and authoring helper byte-for-byte; no account is created by preparation.
`editor`/`reviewer` need only an `email`; passwords are never written into the suite.

`startDemoApp({accounts})` accepts `{editor:{email,password},reviewer:{email,password}}`
and returns `origin`, `setDefect(boolean)`, `records()`, `issuedSessionTokens()` and
`close()`. Roles are `Editor` and `Reviewer`. The last two inspection methods are
controller-only: session values are live credentials intended only for private
leak checks, never output. Close the app in `finally`.

## Results and cleanup

Successful output reports **5 passed → 2 expected failures → 5 passed**, zero records
after each run, identical plan/spec hashes and native-entry removal. Private JSON and
HTML reports live under the printed owned output directory. Screenshots, traces,
video, raw browser errors and response dumps are not retained. HTML restores the
generic case descriptions; inspect even these files before sharing them.

The runner creates unique profile names, seeds generated passwords over stdin only,
and deletes every attempted native entry in `finally`, including partial setup. It
checks absence afterward. Never treat deleting a session file as application logout.
The app's sessions are destroyed when this demo server closes.

A failed cleanup produces `DEMO_CLEANUP_INCOMPLETE` and retains a minimal
`recovery.json` with the owned profile names and paths. Inspect that directory
before another run. For a remaining native entry, a human can use its exact retained
registry/home and `testlane store delete <owned-profile>`; remove only the listed demo
entries. Do not reset the entire user keychain. A forced stop can bypass finally and
leave native entries, temporary sessions or processes; it is not reported as a pass.

Browser/session temporary files use a separate private, randomly named directory in
the OS temp location. Keeping that path short avoids Chromium launch failures in
deep Windows worktrees. It is scanned and must be empty before removal; a nonempty
directory is retained and named in recovery information. The private Playwright
transform cache stays under the owned output directory and is scanned too.

The harness still has one worker, no retries, a 30-second test timeout, a 175-second
suite timeout and a separate 180-second cancellation timer. It creates its own
Playwright config rather than loading an app config. See [runner limits](../../docs/agent-verification.md#runner-limits)
and [the verification guide](../../docs/agent-verification.md) before adapting the
pattern to your actual app. Your agent must design that app's assertions and cleanup;
this demo does not certify generic SSO/MFA, remote browsers or every agent client.

## Focused source tests

```sh
node --test examples/verification-demo/tests/app.test.mjs examples/verification-demo/tests/native.test.mjs
```

These tests check the teaching app's API rules and the subprocess/native-store
guardrails. They do not stand in for the installed-package Chromium acceptance run.
