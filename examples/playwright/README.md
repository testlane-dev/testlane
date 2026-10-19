# Reuse Testlane sessions in Playwright Test

Use this after the [existing-app quickstart](../../docs/quickstart.md) works. The fixture
creates a fresh cookie session for each requested role in each test, gives it a separate
browser context, and removes the session file as soon as Playwright has loaded it.
Contexts close during fixture teardown, including when the test fails.

## Add it to your app

1. Install `@playwright/test` in your app with its existing package manager and lockfile.
   The checked version is `1.64.0`: `npm install --save-dev @playwright/test@1.64.0`, then
   `npx playwright install chromium` (Linux may need `--with-deps`). Installing it inside
   Testlane's global package directory is unnecessary.
2. Copy [fixtures.mjs](fixtures.mjs), [app.spec.mjs](app.spec.mjs) and
   [playwright.config.mjs](playwright.config.mjs) into `e2e/testlane/` in your app.
   Preserve your existing suite/configuration; merge these settings if you prefer to
   use that suite. Only tests importing this extended `test` receive the fixture.
3. As the human, edit the public configuration in `app.spec.mjs`. Set the exact app
   origin, approved profile names and absolute installed `dist/cli.js` path. With an
   npm global installation, `npm root -g` prints the directory containing
   `@testlane/cli/dist/cli.js`. Use forward slashes in Windows JavaScript strings.
4. Create and human-seed the profiles/accounts using the quickstart. The example needs
   separate QA and admin accounts, with `/api/me` returning top-level `email`/`role`
   and `/dashboard` showing `Dashboard`. Change those public route/assertion values
   for your app. No account is created by the fixture.
5. From the app repository, run:

   ```sh
   npx playwright test --config e2e/testlane/playwright.config.mjs
   ```

On Windows use `npm.cmd`/`npx.cmd` when PowerShell blocks npm's script shims. The fixture
itself invokes Node with an argv array and the configured CLI path; it uses no shell.
For an npm-only Testlane installation, these files are under
`<npm root -g>/@testlane/cli/examples/playwright/`.

The expected result is one passing test that checks both accounts and protected pages.
Run it again; it issues new sessions without overwriting a file or using `--force`.
Failures show fixed fixture reasons or your test assertions; the helper never forwards
captured broker output or raw browser setup errors. Run the indicated broker command
in a normal terminal for human diagnosis, without printing session values.

## Use it in more tests

Create an app-owned `test.mjs` that calls `createTestlaneTest` once with your reviewed
configuration, exports its `test`, and re-exports `expect`. Import it in each spec.

```js
const qa = await testlane.open('qa');
qa.assertFresh();
await qa.page.goto('/dashboard');
// Public metadata for this exact issued session:
const { expiresAt } = qa;
const remaining = qa.remainingMs();
```

`open(role)` returns `page`, `context`, `profile`, declared `account`, `expiresAt`,
`remainingMs()` and `assertFresh()`. Use `context.request` for API calls authenticated
with this context's cookies. The built-in Playwright `page` and `request` fixtures do
not inherit these sessions. Open a role once per test and reuse that context.

Expiry is parsed from Testlane 0.5's `--out` confirmation for this exact session.
Missing or already elapsed expiry is refused. Call `assertFresh()` before an operation,
especially a mutation. It throws after expiry or teardown. There is no automatic refresh,
request replay, or guarantee that a request completing later remains within the lifetime.
On refusal, stop and start a fresh test run after inspecting any partial app changes.
The app may revoke access earlier or accept copied cookies longer than broker metadata.

`account` is the registry's declared identity, including human overrides. The example
compares it with a live identity response. Declared roles and a visible heading alone
do not establish general application authorization. Add explicit allow/deny checks for
your feature; the broker does not decide an account's application permissions.

## Parallel workers and separate roles

Each role is an array indexed by Playwright's `parallelIndex`. Start with one worker.
For two workers, human-create and seed four distinct accounts/profiles:

```js
roles: {
  qa: ['shop:testing:qa:worker-0', 'shop:testing:qa:worker-1'],
  admin: ['shop:testing:admin:worker-0', 'shop:testing:admin:worker-1'],
}
```

Then run the suite with `--workers=2`. Both the profile names and declared emails must
be distinct across this mapping. A missing slot is refused; there is no wraparound or
fallback account. Worker restarts keep their `parallelIndex`, and the new test gets a
fresh session. A separate process, shard or worktree needs its own reviewed account
mapping; worker indices are local to a Playwright invocation. The fixture cannot detect
another machine/process using the same account.

Separate contexts/files isolate cookies, not app records. Mutating tests need owned
fixtures and suitable data/account isolation. Keep retries at zero until tests can
safely handle partial mutations. Do not reuse a worker account in another concurrent
run merely because that run uses a different session filename.

A different worktree port is a different origin for vault binding, even though browser
cookies are not port-scoped. Use a reviewed profile with that port and have the human
re-seed it. On macOS/Linux profile names also namespace user-keychain entries; changing
`TESTLANE_HOME` alone does not isolate them.

## Output, cleanup and supported flows

Leave trace, video and automatic screenshot recording off. The fixture refuses these
settings, plus `DEBUG`, `PWDEBUG` or `NODE_DEBUG`, before issuing a session. Recordings,
manual screenshots, response dumps, `storageState()` exports and custom test attachments
can expose session or app data. Your test code remains trusted; this is not a sandbox.
Tests should compare sensitive observations as booleans, as the example does, rather than
let assertion failures print entire responses. The shipped spec also catches authenticated
network/JSON/browser failures and reports a fixed stage. Keep that boundary when extending
the example. Review CI reporters and artifact uploads; custom reporters can retain caught
Playwright step errors even when the test replaces the final exception.

Session files live in a fresh private directory under the process's OS temp directory,
not Playwright's retained test results. POSIX directories are mode 0700 and the CLI writes
mode 0600. Windows files inherit folder ACLs; the temp location must be private to the
runner's OS user. Files are removed after loading, and also on issuance/setup failures.
Normal teardown closes contexts. A killed process/machine can leave files or a live app
session behind: remove its private `testlane-playwright-*` directory after stopping the
run, and use application-side revocation when access must end. Local deletion is not logout.

The fixture accepts approved non-production `form-post`, `nextauth-credentials` and
opted-in `app-handoff` cookie profiles whose origin matches `baseURL`. Any broker warning
stops setup. Token-header strategies, local storage, session storage and IndexedDB auth
need a different adapter. The fixture aborts routed off-origin document requests and
fails `assertFresh()` or teardown if it observes an off-origin navigation or redirect
hop. Playwright does not route every server-redirect hop, so its target may already
have been contacted. This is validation, not network isolation; normal app code can
still make other requests. Review pages and endpoints for side effects.

Use an unlocked keychain in the same machine/session as the CLI. Linux CI, WSL and
containers need [platform setup](../../docs/platforms.md). Windows DPAPI artifacts are
user/machine bound; do not copy a local vault into a CI runner. Seed credentials in the
runner's approved store through a human-controlled setup process, never argv or a chat.
The [compatibility matrix](../../docs/compatibility.md) separates package/browser proofs
from live agent-client verification.

Maintainers can run `npm run test:playwright` after `npm ci`, `npm run build`,
`npm --prefix examples/playwright ci`, and the example's Chromium installation. It packs
the repo and installs a small consumer project before exercising the copied fixture.
`npm run proof:playwright-real-broker` also drives the packed CLI with an isolated native
store; only Windows and an explicitly isolated Linux D-Bus/keyring session are permitted.
