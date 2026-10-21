# Local Supabase and NextAuth provisioning experiment

This source-only experiment connects the [account lifecycle controller](../README.md)
to real Supabase Auth, PostgreSQL and PostgREST services in a new disposable local
Docker stack. Two small public app fixtures use those accounts: an app-owned login
handler and the actual `next-auth` v4 Credentials handler. The installed Testlane
broker signs in through each fixture's normal authentication endpoints.

It is unreleased and excluded from the npm package. It does not connect to an
existing hosted Supabase project, install into an arbitrary application, add a
provisioning CLI/MCP command, or establish support for every Next.js deployment.
Do not apply this migration to an existing database: it deliberately refuses new
Auth users without a reservation owned by this experiment.

## Prerequisites and commands

Use Node 22, npm 10+, a running local Linux Docker 29.x engine and sufficient disk space
for the pinned database, Auth, REST and small gateway images. Docker Desktop's Linux
engine on Windows and local Unix-socket Docker contexts are accepted. Remote Docker
contexts and `DOCKER_HOST` overrides are refused. Docker is a privileged local
dependency; review and trust its engine, image sources and this checkout.

The real broker proof uses Windows DPAPI in a fresh scratch home. Linux requires
`TESTLANE_REAL_KEYCHAIN=1` inside an already isolated D-Bus/Secret Service session.
The proof refuses macOS rather than using the login keychain. Provider unit tests
do not require Docker, a browser, provider credentials or a native credential store.

From the repository root, use a trusted local filesystem and choose new absolute
directories under a private canonical parent. On Windows, create a new parent under
your own local app-data directory with the same permission guard used by the proof:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:account-provisioning

$proofParent = Join-Path $env:LOCALAPPDATA 'testlane-provider-proof-1'
node --input-type=module -e "import {createPrivateRuntimeDirectory as create} from './examples/account-provisioning/supabase/tools/private-directory.mjs'; await create(process.argv[1]);" "$proofParent"

# Explicitly download the optional dependencies and pinned Docker images.
node examples/account-provisioning/supabase/tools/setup.mjs --output-dir "$proofParent/tools"

# Separate stacks and account lifecycles, sharing only immutable tooling.
npm.cmd run proof:account-provisioning:supabase -- --tools-root "$proofParent/tools" --output-dir "$proofParent/form-proof" --auth-mode form-post
npm.cmd run proof:account-provisioning:supabase -- --tools-root "$proofParent/tools" --output-dir "$proofParent/nextauth-proof" --auth-mode nextauth
```

On Linux, use a new mode-0700 directory beneath your own home as `proof_parent`,
omit `.cmd`, and use the same setup/proof commands with that absolute path. Setup
uses a pinned lockfile and `npm ci --ignore-scripts`;
starting a stack does not install dependencies or pull missing images. The runtime
verifies the optional manifests and exact image digests. No Supabase account, hosted
project URL, API key, SMTP service or manually created test user is required.

By default, acceptance packs and installs the current built broker checkout. Set
`TESTLANE_PACKAGE_TARBALL` to an absolute reviewed candidate tarball to test those
exact bytes. Neither path publishes a package. These are HTTP, database and installed
broker checks; they do not run a browser or prove agent-authored test quality.
Run one proof per process. Its temporary-directory environment lease is for this
trusted CLI controller, not a concurrent in-process integration API.

## What the two fixtures establish

`form-post` exercises an app-owned login handler that validates passwords with the
real Auth service. Its private server-side sessions check the live account grant on
every protected request.

`nextauth` loads `next-auth@4.24.15` and its Credentials provider from the pinned
optional tools. It exercises actual CSRF, credentials callback, encrypted JWT cookie,
`getServerSession` and session callbacks through a small Node NextApi-compatible
request/response adapter. Account persistence belongs to the app/provider; NextAuth
Credentials does not create users for the application. This fixture uses Supabase
Auth for password verification and the same private grant ledger for authorization.
The provider access/refresh token and admin key never enter the framework JWT.
The fixture leases and restores only the public `NEXTAUTH_URL` process setting.

This is library/API evidence, not certification of Next.js App Router, middleware,
OAuth, all Auth.js versions or the separate Auth.js Supabase database adapter. A real
app may use its own database or a different upstream identity provider and needs a
separate reviewed adapter and session-revocation check.

Both modes require real Editor/Reviewer creation, live allowed and denied role
checks, native-store delivery, narrow account deletion and refused old sessions and
new sign-ins. Direct PostgREST checks exercise database RLS. A key test revokes an
Editor's grant while its Auth user still exists and its access JWT has not expired:
the app and database must already refuse protected access. User deletion alone is
not treated as immediate JWT invalidation. See Supabase's
[session revocation limitation](https://supabase.com/docs/reference/javascript/auth-signout).

## Authority and abuse boundaries

Only a runtime created by this module's owned-stack factory is accepted. There is
no caller-supplied host, admin key, SQL query or plugin registry. Controller methods
stay local; app HTTP routes do not create, delete, reset or enumerate accounts.

The SQL ledger binds one target UUID, policy hash, source release hash and canonical
controller root. It serializes reservations, fixes roles and generated
`example.test` addresses, allows two accounts per run/four active reservations/ten
attempts per hour, and expires grants after ten minutes. Attempts still count after
deletion. A deferred Auth-insert constraint checks the final provider row and owned
reservation at transaction commit. A cancellation tombstone must reject a delayed
Admin API create rather than letting an account appear after cleanup.

The app, framework session callback and RLS policies consult current grants. The
client cannot select an administrator role, extend grant lifetime or authorize itself
by changing user-editable metadata. Ledger functions and tables are unavailable to
ordinary Auth roles; only narrow identity/RLS checks are granted. A separate foreign
control account must remain present and usable throughout the proof.

Backend containers use an internal network without external egress. A fixed
unprivileged gateway forwards exactly three owned backend TCP ports to host
loopback; it is not a general proxy and has no credentials or Docker socket. Public
signup and phone/anonymous providers are disabled, and no email/SMS/hook service is
configured. No host path or Docker socket is mounted into these services. Generated
service secrets live in private owned config files and container configuration,
never command arguments or public output. The trusted OS user and Docker
administrator can read them; this design does not sandbox those principals.

Before writing secrets, the runtime creates and verifies a protected current-user
NTFS DACL on Windows or current-user ownership/mode 0700 on POSIX. Windows `0700`
alone is not treated as access control. The guard refuses aliases, existing outputs
and unsafe immediate parents; it does not relax an existing directory's permissions.
The proof keeps native-store homes, installed consumer trees and temporary session
files under its own private roots and restores the prior temporary-directory
environment after their helpers settle. Trust the checkout, tools and filesystem
ancestors; these local permission checks do not sandbox malicious host code.

Broad provider-admin credentials can bypass the controller and database owner
controls. A compromised host, dependency, trusted adapter or Docker engine can also
bypass them. This is a bounded disposable test target, not a claim of complete
security or a production provisioning service. Do not give these privileges to
untrusted pull requests, forks or downloaded adapters.

## Evidence and recovery

Both modes passed on Windows with DPAPI and Docker 29.8.0 using the pinned Linux
provider images: [app-owned form proof](../../../docs/verification/provisioning-2026-10-19/supabase-form.public.json)
and [NextAuth proof](../../../docs/verification/provisioning-2026-10-19/supabase-nextauth.public.json).
These receipts bind the final source files and a fresh source-packed broker; they
do not describe a new npm release or a hosted-provider test. The 40 unit/control
tests include actual Windows ACL checks as well as contract and abuse cases.

A passing `receipt.json` binds the exact source inputs, app authentication mode,
installed broker tree and resolved provider image digests. It requires live role,
revocation, direct RLS, late-create fence, concurrent quota and churn checks;
account/reservation/pending-delivery/record counts must reach zero. Native vault
entries, owned child processes, containers, networks, volume and private config
files each require separate cleanup confirmation. Removing a Docker volume does
not substitute for deleting and independently checking accounts and records.

Passwords, provider JWT/refresh tokens, framework cookies/secrets and service config
secrets are scanned in raw and encoded forms before a passing receipt is written.
Only fixed codes, numeric observations, versions and hashes belong in public
evidence. Do not publish raw provider responses, Docker environment inspection,
native homes, config files or recovery directories.

An uncertain create, child stop, delivery or deletion fails acceptance. When account
absence cannot be confirmed, services are stopped but the exact owned data/config
is retained for private recovery. Resolve ownership and the original outcome before
retrying; a new directory does not make the unresolved operation safe. Cleanup
never broadly prunes Docker resources or adopts an unrelated container or volume.
Permission setup failures can leave a newly created empty private directory; refusal
does not establish that path is absent. Inspect it before recovery or removal.

## Integrating a real application next

### Browser lifecycle candidate

The separate source-only browser controller is **not yet accepted by a real browser
run**. Its contract tests do not start Docker, a broker, Chromium or a provider.
After review, the real proof requires the same private parent, pinned local tools,
Docker and isolated native store described above. Install the matching browser
explicitly from the repository root before the proof:

```powershell
npm.cmd --prefix examples/playwright ci --ignore-scripts
node examples/playwright/node_modules/@playwright/test/cli.js install chromium
```

This setup downloads Playwright 1.64.0's Chromium into the current user's browser
cache. Run setup and the proof as the same OS user. The proof installs the consumer's
pinned Playwright dependency but never downloads a browser. On Linux, Chromium's
system libraries must also already be available. From a built checkout, use a new
output directory:

```powershell
npm.cmd run proof:account-provisioning:browser -- --tools-root "$proofParent/tools" --output-dir "$proofParent/browser-proof"
```

This candidate covers only the synthetic local Supabase **form-post** app. It creates
Editor and Reviewer accounts through the local controller and transfers their
sessions through the installed broker's unmodified Playwright fixture. The browser
receives the existing opaque HttpOnly app cookie; passwords and provider JWTs remain
outside browser code. Fixed DOM controls exercise both allowed and denied roles,
an Editor-owned database record, and rejection in the original contexts after account
revocation while the same app is live. The record is deleted and independently
checked before revocation. Original cookies must remain present and unchanged.

Positive, deliberately failed-after-persistence and corrected runs use unchanged
plan/spec/helper bytes. They create six accounts total, within the unchanged target
quota, in a fresh stack separate from the existing ten-attempt abuse proof. Only
the specifically located injected assertion is an expected failure; timeout, missing
cleanup, fixture teardown or another assertion failure cannot substitute for it.

This single integration case allows 90 seconds for broker setup, browser checks,
persisted-state cleanup and live account revocation. Its verification suite retains
the 175-second global deadline and the controller's CLI wrapper retains 210 seconds.
The provider fetch deadline remains eight seconds and the browser's revocation
barrier remains 15 seconds. These limits do not change the account quotas or retries.

The parent owns a loopback Playwright BrowserServer and its retained process handle.
A settled runner does not prove that browser stopped. Its close acknowledgement and
retained process closure are required before vault/files disposal; this is not an
independent claim that every descendant or listener is absent. The private WebSocket
endpoint is a browser-control credential and is removed from private configuration
before the credential scans. Screenshots, video, tracing and raw error reporting
remain disabled. A final application request drain precedes fallback data deletion.
Unknown runner/browser/request outcomes preserve backend data, native homes and
consumer recovery instead of deleting uncertain state or publishing a passing receipt.

No existing-app installer, NextAuth browser acceptance, agent-authored test acceptance,
CLI/MCP account-creation tool or native-provider bridge is established by this candidate.

Keep creation in a reviewed local app-owned adapter, behind the trusted controller.
Give it an explicit disposable auth/database target, fixed tenant/roles, immutable
ownership and provider-side bounds. Use the app's real authentication/session path
and enforce revocation in every protected API and database path. Disable and verify
external effects before enabling account creation.

The synthetic app-owned adapter, this disposable Supabase stack and this NextAuth
library fixture provide reference contracts and tests. A generic installer,
existing-project migration, tenant-aware provider adapter, hosted provisioning,
automatic scheduled expiry/deletion and mobile-app delivery integration remain
separate work. Expiry denies access here; the coordinator still owns physical
account and credential cleanup.
