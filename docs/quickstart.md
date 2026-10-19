# Sign into your existing app

Connect Testlane to an app you already run, then let an agent verify a protected page
and API without handling its test account's password. The human configures the profile
and seeds the password once. Each verification uses fresh session state and removes it.

This guide uses CLI session files. MCP also supports [managed local session files](sessions.md#mcp-managed-local-session-files)
whose tool results contain a path and expiry metadata. Its older `session` tool returns
live values inline. The browser example shares the CLI's machine and filesystem.

## 1. Check that your app fits

Use a dedicated account in a sandbox or testing deployment. The worked example assumes:

| App contract | Example value to replace with your app's value |
| --- | --- |
| Origin | `http://localhost:3000` (use HTTPS for a remote deployment) |
| Login | `POST /api/login`, JSON `{ email, password }`, sets `shop_session` |
| Identity | `GET /api/me`, returns `{ email, role }` when signed in; 401 or 403 anonymously |
| Protected page | `GET /dashboard`, shows the heading `Dashboard` after sign-in |
| Dedicated test account | `qa.agent@example.test`, role `QA`, already created in your app |

The example names and email are fictional. Review these routes and pages for server side
effects before running them. The script explicitly issues GET probes; application code
loaded in the browser can make additional requests. Choose pages safe for this account.

An existing JSON login endpoint that sets a cookie needs no handoff route. For next-auth
v4's credentials provider, use the [NextAuth variation](#nextauth-credentials-variation).
For HTML forms, see [form-post options](strategies.md#form-post). SSO, MFA, dynamic form
tokens and bearer tokens in browser storage need a separately supported integration;
do not place those credentials in a profile or improvise an agent bypass.

## 2. Install and prepare the app repository

Install Node 22 or newer. Run these commands from your **app's repository root**, using
its existing package manager and lockfile. This guide uses the published verification
preview so the same installed CLI can continue into the [feature verification guide](agent-verification.md):

```sh
npm install --save-dev --save-exact @testlane/cli@0.7.0-beta.2
npx --no-install testlane --version
```

If this version is already pinned in the app, keep that installation. For a reviewed
tarball, replace the package pin with its absolute path. The stable authentication-only
release `0.6.0` is a separate option described in [project installation](project-install.md);
it does not supply `verify` commands. Commit the app's dependency and lockfile changes.

All broker commands below use `npx --no-install testlane` to select this app-local CLI.
The direct equivalent is `node ./node_modules/@testlane/cli/dist/cli.js`. On Windows
PowerShell use `npm.cmd` and `npx.cmd` if execution policy blocks their `.ps1` shims;
no policy change is needed. The PowerShell run below uses `npx.cmd` explicitly.

Keep the non-production app running at the reviewed origin for the remaining steps.
On macOS/Linux, unlock the keychain first. Headless Linux, WSL and devcontainers need
the setup in [platforms.md](platforms.md#linux-headless-wsl-devcontainer).

Add this entry to the app's existing `.gitignore` before creating any session files:

```gitignore
.testlane/sessions/
```

## 3. Create a profile as the human

Save this complete file as `testlane.profiles.json` in the app repository, replacing
the routes, cookie name, origin and account with the values reviewed in step 1.
For an existing registry, add this entry under its `profiles` object instead.

```json
{
  "version": 1,
  "profiles": {
    "shop:testing:qa": {
      "app": "shop",
      "environment": "testing",
      "baseUrl": "http://localhost:3000",
      "strategy": "form-post",
      "account": { "email": "qa.agent@example.test", "role": "QA" },
      "session": { "ttlMinutes": 30 },
      "options": {
        "loginPath": "/api/login",
        "bodyFormat": "json",
        "fields": "{\"email\":\"{{email}}\",\"password\":\"{{secret}}\"}",
        "sessionCookieName": "shop_session",
        "mePath": "/api/me",
        "emailField": "email",
        "roleField": "role"
      }
    }
  }
}
```

Use a project-specific profile name: macOS/Linux keychain entries are keyed by profile
name across repositories, even with a different `TESTLANE_HOME`. Origin binding includes
the port, so switching a worktree's port requires a reviewed profile and human re-seeding.
Keep existing production-deny entries. Production hosts are denied when declared in the
loaded registry; Testlane cannot discover whether an undeclared deployment is production.

These are public configuration fields, never passwords or session values. Commit the
profile for review. The agent must not edit it or supply another registry.

After saving the registry, run `npx --no-install testlane doctor` for passive setup checks. Follow any
reported remedy before seeding the password. This command does not read credentials or
contact the app; [diagnostics](doctor.md) explains optional sign-in verification.

## 4. Seed and check the account

As the human, in your own terminal:

```sh
npx --no-install testlane profiles
npx --no-install testlane store set shop:testing:qa
npx --no-install testlane check shop:testing:qa
```

Type the password only at the hidden `store set` prompt. Do not put it in argv, an
environment variable, a chat, or this JSON file. This does not create the app account.
Expected `check` output reports `ok` for `shop:testing:qa` and includes
`qa.agent@example.test` and `role=QA (app)`. A declared role alone is not authorization evidence.

`check` signs in and discards its proving session. It does not sign an existing browser
in. The next steps issue a separate session and verify identity with that exact session.

## 5. Connect your agent

Merge the setup for [Claude Code](INTEGRATION-CLAUDE-CODE.md) or
[Codex](INTEGRATION-CODEX.md) into your existing configuration. Keep registry selection
and any non-default home under human control. Confirm the agent's `list_profiles` or
`npx --no-install testlane profiles` sees `shop:testing:qa` before continuing.

The CLI needs keychain access and permission to append the audit log. MCP's access does
not imply the agent's shell has the same permissions. For a blocked shell, use the
client's normal approval process or run the session step from your terminal; do not
disable the sandbox or grant blanket access to the vault.

## 6. Add the browser check

Use the app's package manager and lockfile. If Playwright is already installed, preserve
it and review differences from the tested 1.64.0 version using the [compatibility matrix](compatibility.md).
This example imports `playwright` directly; package managers with strict dependency
isolation need that direct dependency even when `@playwright/test` is already installed.
For a new installation with npm:

```sh
npm install --save-dev --save-exact playwright@1.64.0
npx --no-install playwright install chromium
```

On Linux, use `npx --no-install playwright install --with-deps chromium` if system
dependencies are missing; review those OS changes as the human.

Copy [verify.mjs](../examples/existing-app/verify.mjs) and
[verify.json](../examples/existing-app/verify.json) into the app's `tools/testlane/`
directory. Set the public `verify.json` fields to match the profile and app:

```json
{
  "baseUrl": "http://localhost:3000",
  "identityPath": "/api/me",
  "protectedPath": "/dashboard",
  "heading": "Dashboard",
  "expectedEmail": "qa.agent@example.test",
  "expectedRole": "QA"
}
```

`baseUrl` must be the same approved origin as the profile. This example expects top-level
`email` and `role` in the identity response. For a different shape, review and adapt the
two field comparisons in `verify.mjs`; configure the broker's `emailField` and `roleField`
too. The script checks identity with the issued session, a visible protected-page heading,
and anonymous API refusal. It prints fixed results without bodies, cookies or browser dumps.

For the app-local installation, find these two example files under
`node_modules/@testlane/cli/examples/existing-app/`, or follow their repository links above.
Copy them into your app so their `playwright` import resolves to your app's dependency.

## 7. Run with a fresh session and clean up

Bash, from the app repository:

```bash
(
  set -e
  mkdir -p .testlane/sessions
  session_dir=$(mktemp -d .testlane/sessions/run-XXXXXX)
  state="$session_dir/storage.json"
  trap 'rm -f -- "$state"; rmdir -- "$session_dir"' EXIT
  npx --no-install testlane session shop:testing:qa --format storage-state --out "$state"
  node tools/testlane/verify.mjs tools/testlane/verify.json "$state"
)
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force .testlane/sessions | Out-Null
$sessionDir = Join-Path (Resolve-Path .testlane/sessions) ("run-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $sessionDir | Out-Null
$state = Join-Path $sessionDir 'storage.json'
try {
  npx.cmd --no-install testlane session shop:testing:qa --format storage-state --out $state
  if ($LASTEXITCODE -ne 0) { throw 'Testlane session issuance failed' }
  node tools/testlane/verify.mjs tools/testlane/verify.json $state
  if ($LASTEXITCODE -ne 0) { throw 'Existing-app verification failed' }
} finally {
  if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state }
  Remove-Item -LiteralPath $sessionDir
}
```

Expect three `PASS` checks followed by `PASS existing-app checks; browser closed` and
exit 0. Repeat the same block: every run gets a new path, without `--force`. On Windows,
files inherit folder ACLs; use a folder private to your user. Killing the shell or machine
can leave a file behind; remove that run's file before sharing the repo. Deleting it does
not revoke the session at the app.

These checks cover the chosen routes and account. They do not establish general role
authorization, persistence, environment isolation or release readiness.

## 8. Give the agent a task

After the human setup, give your agent this prompt:

> Use the app's pinned Testlane CLI and approved `shop:testing:qa` profile to run our existing-app check in
> `tools/testlane/`. Use a fresh session file under `.testlane/sessions/`, run
> `verify.mjs` with `verify.json`, and remove the session file afterwards. Report the
> exit code and which checks passed or failed. Do not print session values, change the
> registry or vault, or work around a policy refusal. Report any human action or shell
> permission needed to continue.

For a reusable suite with separate roles and worker accounts, use the
[Playwright Test fixture](../examples/playwright/README.md). Check the
[compatibility matrix](compatibility.md) before choosing another browser/auth flow.
For a single API request or a URL-only browser, see [session recipes](sessions.md).

## Troubleshooting

| Result | Next step |
| --- | --- |
| Profile missing | Run from the app repo; compare CLI registry sources with the MCP server's configured registry. |
| Exit 1 | Check audit write access, syntax and existing output files. Use a fresh path. |
| Exit 2 | Check the non-production profile, approved host, strategy and TTL. Do not bypass the refusal. |
| Exit 3 | Confirm the app is reachable, account exists and cookie/identity options match. A wrong password needs human re-seeding. |
| Exit 4 | Human runs `npx --no-install testlane store set shop:testing:qa`. A locked Linux keyring can also look like a missing entry; see [platforms.md](platforms.md). |
| Exit 5 or 6 | Stop. Human checks the command or changed origin/environment before re-seeding. |
| `FAIL browser setup` | Install Chromium in the app, check shell permissions and state-file access on this machine. |
| `FAIL authenticated identity` | Check route, expected account/role, response shape and expiry. Do not print the response body. |
| `FAIL protected page` | Check the exact path/heading and whether browser login needs more than cookies. This example rejects observed cross-origin document navigation, including server redirect chains; a redirect target may already have been contacted. |
| `FAIL anonymous denial` | Choose an identity endpoint that refuses unsigned requests with 401/403. |

## NextAuth credentials variation

For next-auth v4's credentials provider, replace the strategy and options in the profile:

```json
"strategy": "nextauth-credentials",
"options": { "roleField": "user.role" }
```

Keep the rest of the profile. `check` uses `/api/auth/session` with `user.email` and
`user.role`. That endpoint can return 200 for signed-out visitors, so use an existing
protected identity API returning top-level `{ email, role }` and anonymous 401/403 in
`verify.json`. If none exists, adapt the browser check to the app's actual anonymous
response contract and document what it proves. See [strategy options](strategies.md#nextauth-credentials)
for custom routes and cookies. Auth.js versions and other providers need their own
verified recipe; a similar name is not a compatibility guarantee.
