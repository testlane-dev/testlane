# Disposable accounts for browser verification

This is the **unreleased browser-account preview**. The published
`0.7.0-beta.2` package requires existing accounts; it does not include this API.
Until a matching release is published, install only a reviewed candidate tarball.
Local installed-package verification covers a synthetic Supabase form-post app
on Windows with DPAPI. It exercised a positive run, an intentional failure after
saving data, and a corrected run, with account revocation and cleanup in each.
Linux/macOS keychains and NextAuth DOM remain unverified for this workflow.

The workflow creates one Editor and one Reviewer, puts their generated passwords
into the native broker store through stdin, runs your app's Playwright cases,
revokes their app access, and checks account, credential and temporary-file cleanup.
You describe the behavior to your coding agent; the agent writes ordinary tests
and a reviewable plan. Testlane has no embedded model or hosted test service.

## Choose the right setup

Use this workflow when you control the app and can implement a server-side adapter
for a dedicated test account store. Once that integration is reviewed, individual
runs need no manually created accounts or password seeding. For an app you cannot
change, continue with the [existing-account quickstart](quickstart.md).

This preview does not install a generic Supabase or NextAuth account backend.
NextAuth Credentials handles sign-in; your app still owns user persistence and
revocation. The Supabase example is a proof harness for a new, disposable local
stack. Its database setup is not an existing-project migration or a hosted-project
recipe.

Prerequisites:

- Node 22 or newer, app-local `@playwright/test@1.64.0`, and Chromium installed.
- A running app on the exact reviewed loopback origin. Remote targets, SSO/MFA,
  browser-storage tokens and bearer-header browser authentication are outside this
  first account workflow. Login uses `form-post` or next-auth v4 Credentials cookies.
- A reviewed app-owned adapter with administrative access only to a separate
  non-production account/data target, with email, SMS, billing and webhooks disabled.
  A localhost URL does not establish which database the app uses.
- A persistent private directory for this target and access to the native store.
  Windows uses DPAPI. Linux/macOS require `allowUserKeychain: true`; the home
  directory does not isolate Secret Service or the macOS login keychain. Do not
  infer runtime verification on those platforms from TypeScript or fake-store tests.

The wrapper, adapter, tests and same-OS-user processes are trusted code. The clean
worker environment keeps ambient provider credentials out of child configuration;
it is not an OS sandbox. Keep untrusted pull-request code out of privileged runs.

## 1. Install the reviewed package in the app

From the app repository, use its package manager and lockfile. Replace the archive
path with the exact tarball whose manifest you reviewed:

```sh
npm install --save-dev --save-exact /absolute/path/to/reviewed-testlane.tgz @playwright/test@1.64.0
npx --no-install playwright install chromium
npx --no-install testlane --version
```

On Windows, use a quoted forward-slash archive path and `npm.cmd`/`npx.cmd` when
PowerShell blocks the script shims. Preserve existing Playwright setup rather than
silently replacing it. Linux may also need reviewed browser OS dependencies.

## 2. Implement and review the app adapter once

Implement the `BrowserAccountAdapter` type from `@testlane/cli/browser` in your app's
server code. Export a plain object of flat async functions; methods are called with
`this` undefined. Provider credentials stay in this parent module, never in the
feature brief, plan, profile, browser fixture or test environment.

| Method | Required behavior |
| --- | --- |
| `metadata` | Declare protocol `testlane-disposable-browser-v1` and the persistent target's `id`, exact `origin` and non-production `environment`. |
| `verifyTarget(binding, bindingHash)` | Check the actual backing target. Return its identity, binding hash and enforcement acknowledgements only when the real store enforces them. |
| `coordinatorBinding()` / `bindCoordinator(binding)` | Atomically bind the target to the persistent coordinator root, target ID, binding hash and nonce. Refuse a different binding. |
| `createOwned(owner, password)` | Persist the complete immutable owner tuple and a creation reservation before making an account. Enforce target-wide quotas, expiry and tombstones; return exactly `{ id: <lower-case UUID string> }`. A repeated request must not create another user. |
| `inspectOwned(owner)` | Inspect only the original owner. Return `present`, `id`, `revoked`, `deliveryPending`, `ownedRecords` and `activeReservations`, including durable tombstones after deletion. |
| `beginCredentialDelivery(owner)` / `endCredentialDelivery(owner)` | Persist a delivery fence so cleanup cannot succeed while credential delivery may still finish. Return `{ pending: true }` / `{ pending: false }`. |
| `revokeDeleteOwned(owner)` | Fence late creation/delivery, revoke live access and delete only the exact owned account. Confirm identity before deletion and return `{ revoked: true }`. User deletion alone is insufficient if old sessions still work. |

Return ordinary, exact records matching the exported types, not entire SDK responses
or class instances. `coordinatorBinding()` returns `null` before binding, then the
exact `{ root, targetId, bindingHash, nonce }` record. `bindCoordinator` returns
`{ bound: true }`. `verifyTarget` returns `{ target, bindingHash, enforced }`, where
`enforced` has exactly seven true keys: `targetBinding`, `immutableOwnership`,
`targetWideQuotas`, `expiry`, `disabledEffects`, `tombstones`, and `liveRevocation`.
Those acknowledgements must follow real store checks and enforcement; returning
true flags alone does not establish these properties.

Target, run, operation and returned account IDs must be lower-case UUID strings.
Opaque/numeric account IDs are not accepted directly. A provider with another ID
format needs a reviewed, durable adapter mapping that retains the original provider
identity and verifies it during inspection and deletion; do not replace it with a
fresh random alias on each call. Reject an incompatible configuration before account
creation. Test the adapter's unknown-create, late-delivery, target-mismatch, quota,
ownership and original-session revocation behavior against its actual account store.

The owner tuple is `{ targetId, bindingHash, runId, operationId, role, email,
expiresAt }`. Never authorize deletion using an email prefix alone. Quotas and
creation history must survive new run IDs, different coordinator roots and process
restarts. The account API does not delete arbitrary business records; tests must
track and remove their exact owned records, and the adapter must refuse a clean
receipt while records or delivery reservations remain.

Review the adapter entry, its imports, provider settings and target before running
it. Record the entry file's SHA-256 in an app-owned `e2e/adapter.sha256` file after
review. A hash checks entry bytes; it does not certify imported code, the already
loaded adapter object or the configured provider. Do not recompute and silently
approve a new hash inside every run.

## 3. Add the parent wrapper

For a fictional records app, save `e2e/run-disposable.mjs` and substitute the reviewed
adapter, fixed target ID, routes, cookie name and role labels. The example adapter
path denotes code you implement; this is not a bundled provider installer.

```js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  normalizeBrowserAccountBinding,
  runDisposableBrowserVerification,
} from '@testlane/cli/browser';
import { adapter } from '../server/test-account-adapter.mjs';

const binding = normalizeBrowserAccountBinding({
  schemaVersion: 1,
  status: 'reviewed',
  target: {
    id: '3cf274f7-7639-4ea3-b9e8-43d81f1b6839',
    origin: 'http://127.0.0.1:3000',
    environment: 'testing',
  },
  adapter: {
    protocol: 'testlane-disposable-browser-v1',
    modulePath: fileURLToPath(new URL('../server/test-account-adapter.mjs', import.meta.url)),
    sha256: (await readFile(new URL('./adapter.sha256', import.meta.url), 'utf8')).trim(),
  },
  roles: ['Editor', 'Reviewer'],
  ttlMs: 600000,
  maxAccountsPerRun: 2,
  maxActiveAccounts: 4,
  maxCreateAttemptsPerHour: 10,
  effects: { email: false, sms: false, billing: false, webhooks: false },
  authTemplate: {
    strategy: 'form-post',
    roleLabels: { Editor: 'Editor', Reviewer: 'Reviewer' },
    options: {
      loginPath: '/api/login',
      bodyFormat: 'json',
      fields: '{"email":"{{email}}","password":"{{secret}}"}',
      sessionCookieName: 'shop_session',
      mePath: '/api/me',
      emailField: 'email',
      roleField: 'role',
    },
  },
});

const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const report = await runDisposableBrowserVerification({
    adapter,
    binding,
    planFile: fileURLToPath(new URL('./verification/plan.json', import.meta.url)),
    // Persistent and ignored; parent directory must meet the privacy checks.
    outputDir: fileURLToPath(new URL('../.testlane/disposable', import.meta.url)),
    signal: cancellation.signal,
    // Set allowUserKeychain: true only after reviewing the Linux/macOS store.
  });
  console.log(JSON.stringify(report));
  process.exitCode = report.verdict === 'passed' ? 0 : 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
```

The immediate parent of the private output directory must already exist with a
trusted owner and permissions. Testlane creates a new private directory or verifies
an existing marked one; it does not repair permissive directories. On first use,
leave `outputDir` itself absent: an existing empty directory has no managed owner
marker and is refused. Create/review only its parent. Add `.testlane/` to the
app's `.gitignore`. Keep this directory across runs: it holds ownership, quota and
recovery state, not a disposable cache. Do not copy or edit a target's owner files to
reset a refusal. On Windows, a user-owned application-data directory can be used
when a workspace parent does not meet the ACL requirements.

## 4. Author app-specific tests and a reviewed plan

Use the [verification guide](agent-verification.md) for case design and expected
behavior. Its existing-account setup and `verify init --profile` steps are not
needed here: the parent supplies generated profiles. Do not manually seed or
override them. Create an app-owned `e2e/verification/` suite and copy the installed
`examples/agent-verification/authoring.mjs` to `testlane-authoring.mjs` in that folder.
Keep that copy byte-identical; add `testlane-authoring.mjs text eol=lf` to a suite-local
`.gitattributes` so Git preserves its bytes on Windows.

For example, `e2e/verification/plan.json` can contain:

```json
{
  "schemaVersion": 1,
  "status": "reviewed",
  "title": "Disposable records workflow",
  "projectDir": "../..",
  "target": { "baseUrl": "http://127.0.0.1:3000", "environment": "testing" },
  "evidence": { "screenshots": "off" },
  "cases": [{
    "id": "records-lifecycle",
    "title": "Editor records respect role boundaries and revoked sessions",
    "spec": "e2e/verification/records.spec.mjs",
    "expected": [
      "The browser-created record has the expected saved fields",
      "Reviewer and anonymous requests cannot perform the denied operations",
      "Original sessions are refused after revocation while the app is live"
    ],
    "cleanup": {
      "required": true,
      "description": "Delete the exact owned record, verify absence, revoke accounts and verify old-session refusal"
    }
  }]
}
```

Mark the plan reviewed only after its cases and cleanup match the task's authorized
scope. The app-specific `records.spec.mjs` imports the fixture and worker helper:

```js
import { createTestlaneTest, expect } from '@testlane/cli/examples/playwright/fixtures.mjs';
import {
  loadBrowserWorkerBinding,
  browserFixtureOptions,
  requestBrowserRunRevocation,
} from '@testlane/cli/browser-worker';

const binding = await loadBrowserWorkerBinding();
const test = createTestlaneTest(browserFixtureOptions(binding, Date.now()));
```

Import `runCase` from `./testlane-authoring.mjs`, annotate the actual Playwright test
with `{ type: 'testlane-case', description: 'records-lifecycle' }`, and execute its
body and cleanup with `await runCase(info, 'records-lifecycle', { run, cleanup })`.
Both callbacks must contain the app-specific behavior and cleanup assertions; an
empty callback or a plan alone is not a complete test. The installed
`examples/verification-demo/feature.spec.mjs` shows the authoring pattern for an
existing-account workflow; retain the generated worker mapping in this workflow.

Use `testlane.open('editor')` and `testlane.open('reviewer')` in the actual tests.
The original `page`, `context`, declared account and expiry belong to that exact
issued session. Playwright's unrelated default page/request do not inherit it.
Only one worker and one managed run are supported; profile aliases are not a way
to request extra users. Keep the plan's target/environment identical to the binding
and set screenshots to `off` for this workflow.
`roleLabels` declares the app's expected identity labels for the fixed logical
Editor/Reviewer roles. It does not change an account's permissions; the reviewed
adapter must assign the corresponding real application roles.

Every case still needs meaningful browser and data assertions. For example, create
a record through the Editor UI, capture its returned ID before later assertions,
verify saved fields through a fresh request, and show the Reviewer cannot change it.
Use `runCase` cleanup to remove that exact record and verify absence even when a
body assertion fails. Do not delete by a broad prefix or clear a shared table.

The revocation barrier is once per managed run, in the final case after all owned
business records have been removed. Accounts are then revoked and cannot serve
later cases. At that step, keep both original contexts open and call
`await requestBrowserRunRevocation(binding)`. The parent acknowledges only after
owned account/session cleanup is confirmed. With the same cookies still present,
assert an endpoint that returned 200 for each original account before revocation
(such as its identity endpoint) now returns 401/403, and the browser clears protected UI
while the app is live. An acknowledgement alone is not a business assertion or
proof that your application's session revocation works.

Ask the agent to cover your feature, for example:

> Use the reviewed disposable-account wrapper. Editors can create a draft record;
> Reviewers can read their permitted records but cannot change Editor-owned data.
> Verify browser behavior, saved fields, cross-role denial and anonymous denial.
> Remove only records owned by this run, then check that the original browser
> sessions are rejected after revocation. Keep screenshots off. Return the plan,
> actual report and any cleanup or recovery requirement. Do not change the adapter,
> target, account policy or stored credentials to make a test pass.

Run the reviewed wrapper with `node e2e/run-disposable.mjs`. The existing agent skill
can help author the tests; it does not grant administrative authority or automatically
install the server adapter. MCP continues to expose sessions and metadata, with no
raw account-create/delete or provider-admin tools.

## Results, limits and recovery

The fixed outer report separates `verification` from `cleanup`, `accounts`,
`nativeEntries` and `temporaryFiles`. A failed assertion can have completed cleanup;
completed cleanup cannot turn that assertion into a passing result. A pass requires
the bound runner result, successful revocation handshake and all cleanup gates.
Cancellation observed before the wrapper returns prevents a pass even when
verification and cleanup finished. It preserves confirmed child and cleanup facts;
it does not turn them into unknown outcomes.
The existing richer runner report remains private under the owned run directory.
It can contain app-specific paths/context; do not upload the directory as a public
Actions artifact or paste it into a public issue without reviewing it.

Limits are two accounts per run, four active accounts per target, a ten-minute
account lifetime, and ten creation attempts per target per rolling hour. That is
at most five fresh two-role runs per hour; failed and unknown attempts also count.
Expiry is an adapter-enforced access fence, not scheduled physical deletion of
accounts, records or broker entries. Cleanup/recovery is still required.
A quota refusal is a stop condition, not permission to retry or reset history.
There are no automatic retries, worker scaling, screenshots, traces or videos in
this managed workflow. Adapter and delivery callbacks are trusted and awaited;
Testlane cannot forcibly stop arbitrary hung application code.

Temporary-file cleanup admits at most 4,096 entries including the temporary root,
16 levels below it, 16 MiB per file and 64 MiB in total. Changing entries or
exceeding these limits makes cleanup fail; remaining files stay for review.

If `recoveryRequired` is true, stop and preserve the original target and private
directory. For a known-settled cleanup failure, the reviewed wrapper can call
`recoverDisposableBrowserVerification({ adapter, binding, outputDir, runId })`
using the original values and native-store environment. Recovery only cleans the
original owned run; it does not create, seed, rerun tests or allocate a new ID.
On Linux/macOS it also needs the reviewed keychain opt-in.

An unconfirmed child or credential-seeding process stop retains a lock and stays
nonpassing. A lost acknowledgement from a known-settled child can instead receive
scoped cleanup/recovery; uncertainty alone is never a pass. Do not steal a lock,
delete journals or try another output root. A changed store environment cannot
confirm deletion from the original store. Business-record crash recovery is the
app test's responsibility: journal exact owned IDs durably before later assertions
if you need it, and reconcile them only after writers stop. This preview does not
guarantee cleanup after every forced process termination.
The automatic recovery API refuses a retained unknown-child or unknown-seeding
lock. A later observation that writers stopped does not automatically clear that
quarantine; it needs explicit manual reconciliation of the original owned state.
