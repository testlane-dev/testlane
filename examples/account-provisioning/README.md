# Local test-account provisioning experiment

This **source-only, unreleased experiment** creates dedicated accounts in a public
synthetic loopback app, then signs in through the real installed Testlane broker.
It adds no CLI or MCP commands, provider SDK, hosted account factory, admin HTTP
route or production capability. It is not included in the npm package inventory.
The separate [local Supabase and NextAuth experiment](supabase/README.md) exercises
real provider services and a NextAuth v4 Credentials fixture; its optional tools and
authority remain outside the installed broker too.

The app owns account creation and revocation through local controller functions.
Its HTTP surface contains only login, identity and two fixed role-check routes.
It uses salted scrypt password hashes; passwords stay in private memory and reach
the native credential store through stdin. Generated session tokens remain live
credentials readable by trusted app/test code.

## Run

From this checkout, with Node 22 and npm 10+:

```powershell
npm.cmd ci
npm.cmd run build
node --test examples/account-provisioning/tests/*.test.mjs
npm.cmd run proof:account-provisioning -- --output-dir C:/temp/testlane-provision-proof-1
```

Use a **new absolute output directory** whose parent exists. Omit `.cmd` on systems
that do not use Windows shims. Real-broker acceptance uses Windows DPAPI in a scratch
home. Linux requires `TESTLANE_REAL_KEYCHAIN=1` inside an already isolated D-Bus and
Secret Service session. This baseline's proof refuses macOS rather than using the
login keychain. Unit tests need no provider, keychain or browser.

The proof packs and installs the built broker into a fresh consumer. The experiment
itself runs from these source files; a receipt binds their hashes, the three reused
source support helpers, and the installed broker tree before/after execution. The
imported native child helper must match the installed package's exact bytes. Tree
digests use canonical JSON tuples of normalized relative paths and file SHA-256
digests, with unambiguous file boundaries. By default the broker is a fresh pack of
this built checkout, not a download of the already published npm version; the receipt
identifies that mode and the installed bytes. No package is published. Playwright dependencies
are installed by the reused consumer helper, but this proof performs HTTP and broker
checks, not browser actions or agent-authored testing.

It creates Editor and Reviewer accounts, seeds fresh native-store profiles, confirms
live identity/role and both allowed/denied operations, revokes/deletes only owned
accounts, and proves the **old sessions return 401 while the same server is running**.
A foreign control account remains unchanged and usable. The proof then deletes every
attempted native entry, verifies absence, removes session files, confirms owned
children stopped, and scans raw/URI/base64/base64url credential canaries before
writing a passing receipt.

## Bounds and recovery

The fixed policy allows two accounts per run, four active owned accounts per target,
and ten creation attempts per hour. Roles and the `example.test` email namespace are
fixed; accounts/grants expire after ten minutes. The adapter enforces target quotas
as well as the coordinator. Fresh directories or run IDs do not reset target state.
This bounded experiment retains at most 1,000 runs and 1,000 lifetime operation
entries, then refuses further growth; it is not a long-lived provider backend.

One canonical ledger root is bound to the live target. It uses exclusive locks,
fsynced atomic updates, durable intents and immutable operation ownership. Lost
responses retain quota and require reconciliation. Missing/corrupt bound state is
refused, never silently replaced. Locks are not automatically stolen after a crash.
Expired grants permit narrow owned cleanup, not new creation. Clock rollback fails
closed. Account eligibility is checked on every request; deleting a local cookie or
keychain entry alone is not revocation.

Cleanup writes an adapter tombstone that fences late creates. A pending credential
sink prevents cleanup completion and new runs until it actually settles. Arbitrary
trusted callbacks are not sandboxed or forcibly interrupted by this library; the
proof awaits bounded owned native-store children. An unconfirmed child, unresolved
delivery, account deletion or filesystem outcome prevents a passing receipt and
retains private recovery metadata. Any recorded PID describes that attempt; it is
not authority to kill a later process after PID reuse. Do not publish recovery directories.
`cleanupRun()` returns the explicit scope `accounts-and-sessions`; it does **not**
delete native vault credentials. The proof/coordinator owns every attempted native
entry and must confirm all seed helpers stopped before deleting and verifying those
entries separately.

The backend is in-memory. Controller restart recovery is demonstrated against the
**same live synthetic target**. Losing that target does not authorize a replacement
target to adopt its journal. This is single-host locking/quota evidence, not a
cross-machine provider quota system or a power-failure durability certification.

## Real application integrations require separate review

Local adapters and their imports are trusted code. A modified repository or another
process running as the same OS user can bypass local rules or read credentials;
this is not an isolation boundary or a claim of complete security. Policy labels
such as `testing` cannot prove that a remote auth/database project is not production.

Before building a real adapter, use a separate disposable test **auth and database**
project with dedicated accounts, explicit human-reviewed target/issuer identity,
fixed roles/tenant scope, quotas, TTL and immutable ownership. Provider-wide admin or
`service_role` keys may retain broad authority regardless of an adapter's checks;
prefer provider-enforced scope. Disable email, SMS, invitations, billing and external
hooks, and prove that configuration for the exact provider.

Never expose creation/deletion through handoff or authentication HTTP routes. Never
inject provisioning/admin credentials into untrusted pull-request/fork builds, or
automatically execute an adapter downloaded from an arbitrary repository. A human
must review the code and authority before enabling it.

Deleting a provider user or revoking refresh tokens may leave existing access JWTs
valid. A real integration needs demonstrated app-side account/epoch checks or an
equivalent provider guarantee before claiming immediate session invalidation.
The synthetic proof does not establish external-provider support. The separate
Supabase experiment uses a new owned local stack, not a hosted project or existing
application. Hosted Supabase, Clerk, Auth0, Firebase and other integrations still
need their own authority review, abuse tests and acceptance.
