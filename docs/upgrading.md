# Upgrading

Testlane is pre-1.0, so minor releases can change configuration and APIs. The full change list
is in [CHANGELOG.md](../CHANGELOG.md).

## Upgrading to 0.6.0

Install `@testlane/cli@0.6.0`. The executable remains `testlane`.

- The application-specific legacy strategy has been removed. Use `dependent-token` and
  explicitly configure your own dependency, endpoints, request fields, response fields and
  identity mapping. Testlane no longer provides an application-specific adapter.
- Generic subject identifiers use `account.identifier`, the `{{identifier}}` field placeholder
  and `account set --identifier`. Update your profiles, account overrides and programmatic
  integrations to the current schema before running the new version. Unknown keys and
  strategies are refused; there is no silent fallback.
- The secret-store envelope and profile-name keys are unchanged. Configuration-only migration
  needs no re-seeding when origin, environment and profile name stay the same. A changed
  origin or environment still requires a human to store the secret again.
- Review any existing account override file against the current schema before upgrading.
  Record the existing values privately, migrate only the account identity keys, then run
  `testlane doctor`. A human can use `account set` to recreate an override after migration.

Earlier application-specific examples and compatibility adapters are not part of this release.
The older release notes below describe historical behavior; they do not verify this package.

## Upgrading to 0.5.2

Version 0.5.2 introduced `@testlane/cli` instead of the unpublished unscoped package. Update explicit
module paths to `node_modules/@testlane/cli`; `npx --no-install testlane` and the global
`testlane` command are unchanged.

0.5.2 changes no stored data: the envelope is still version 3, so **no re-seeding is needed**.
The public package installs only the `testlane` executable; update scripts that used
`agent-auth`. Deliberate legacy home, store and `AGENT_AUTH_*` environment compatibility
remains. It includes the behaviour changes from the unpublished 0.5.1 candidate; a registry,
script or app that relied on the older behaviour needs a change:

- **`http://*.localhost` now needs https.** Only `localhost`, `127.0.0.1` and `::1` keep plain
  http, for `baseUrl` and `--target`. Switch the profile to `http://localhost:<port>` (or
  `http://127.0.0.1:<port>`), or serve the name over https.
- **`allowedHosts` entries are canonicalised through the URL parser.** An entry must parse as a
  host (lowercase, no trailing dot) and is stored in canonical form (`127.1` becomes `127.0.0.1`,
  `[2001:db8:0:0::1]` becomes `[2001:db8::1]`). An entry the parser rejects (for example
  `foo.123` or `1.2.3.4.5`) now fails when the registry loads, with an invalid-profile error
  (exit 2) that names it.
- **Production overlap is checked on the merged registry.** A non-production profile that shares
  a host with a production profile in the other file (repo versus user-level,
  `<TESTLANE_HOME>/testlane.profiles.json`) now makes the whole registry fail to load (exit 2),
  so every command that uses it stops until the overlap is removed. `store set` also refuses any
  profile whose base or allowed host belongs to a production profile, and the production
  denylist now folds IPv4-mapped IPv6 (`[::ffff:10.0.0.5]`) onto IPv4. Rename or retarget such a
  profile; there is no override.
- **A copied handoff route needs `AGENT_HANDOFF_ENV`.** The reference route in
  `examples/demo-app` now answers 404 unless `AGENT_HANDOFF_ENABLED=true` and `AGENT_HANDOFF_ENV`
  is exactly one of `local`, `sandbox`, `testing` or `preview` (fail closed). If you copied it
  into an app, set both in the sandbox deployment only, and see
  [HANDOFF-ROUTE-CONTRACT.md](HANDOFF-ROUTE-CONTRACT.md).
- **An `encrypted-file` passphrase is asked twice on first use**, and a mismatch writes nothing.
  A salt file from before the passphrase check takes its check value from the first passphrase
  typed afterwards (asked twice then); type the right one.
- **`store set` checks the store before it reads the secret.** With no usable keychain it now
  fails first, with a message that names what is missing, instead of after you typed the value.
  [platforms.md](platforms.md) lists the messages.
- **All output paths use the stored-secret redactor.** HTTP bodies, `session --out` files and
  MCP `structuredContent` now use it too. Recognized raw/common derived forms are replaced with
  `[REDACTED]`; alternate encodings, transformations and split writes have
  [documented limits](threat-model.md#9-known-limits). Do not use credential-echoing session material.
- **`check` is stricter.** On an identity mismatch it no longer reports the email the app
  returned (the failure names the expected email only), and it takes the role the app reports
  only when the identity matched; otherwise it reports the role the profile declares.
- **A locked Linux keyring is reported as an error by `store list`**, instead of an empty list
  ([platforms.md](platforms.md#what-the-messages-mean)). `status` and `session` still read a
  locked keyring as "no secret stored", so unlock it before trusting those.
- **The JavaScript export `NO_KEYCHAIN_MESSAGE` was removed.** The package's JavaScript exports
  are not yet a stable API in 0.x; the supported interfaces are the CLI, the MCP server and the
  localhost HTTP API.
- **Smaller changes:** cookies whose `Path` or `Domain` contains a control character are ignored,
  and audit rows printed by `testlane audit` replace C1 controls and U+2028 / U+2029 too.

Also included and optional: `--format json` on the CLI, HTTP and MCP
sessions, and the per-platform setup guide in [platforms.md](platforms.md).

## Upgrading to 0.4

0.4 lets the broker consume an `app-handoff` profile's one-time URL itself, so `session` and
`check` (and a `dependent-token` profile that depends on it) can return that account's session
cookies. **Nothing changes for an existing `app-handoff` profile until a human opts it in**:
without `options.mePath`, `session` and `check` are refused exactly as in 0.3.x (exit 2, before
the store is read), and `handoff` works as before.

Opting a profile in (adding `mePath`, plus `emailField` when the email is not at `email`) is a
real change in what an agent can hold. Under 0.3.x a navigate-only harness only ever saw a
60-second URL; the session cookie the route set stayed inside the browser (HttpOnly). After the
opt-in the agent receives that cookie and can reuse it until the app expires the session. So
**re-check the account's privileges first**: it should be a dedicated, least-privilege sandbox
account, the same as any account whose session the broker hands out. See
[strategies.md](strategies.md#app-handoff) and [threat-model.md](threat-model.md) (T9).

Also new in 0.4 for every strategy: cookies that break the `__Secure-` / `__Host-` name-prefix
rules are ignored, as browsers ignore them.

## Upgrading from agent-auth

Testlane was called Agent Auth Vault (`agent-auth`) before 0.3.0. After
`npm install -g @testlane/cli@0.6.0`, use the `testlane` command. **No re-seeding is needed**:
stored secrets stay where they are and are found under the same storage identifiers.

| Before | Now | Compatibility |
| --- | --- | --- |
| `agent-auth` command | `testlane` | the public package installs only `testlane`; update scripts and command allow rules |
| `AGENT_AUTH_HOME`, `AGENT_AUTH_PROFILES`, `AGENT_AUTH_REQUESTER`, `AGENT_AUTH_STORE` | `TESTLANE_HOME`, `TESTLANE_PROFILES`, `TESTLANE_REQUESTER`, `TESTLANE_STORE` | each old name is read when the new one is unset (or blank) |
| `~/.agent-auth` | `~/.testlane` | when `~/.testlane` does not exist and `~/.agent-auth` does, the old directory is used as the home. Nothing is moved, copied or deleted; to switch, move the directory yourself |
| `agent-auth.profiles.json` | `testlane.profiles.json` | discovery looks for both names in every directory while walking up; when both are in the same directory the new one wins and one notice is printed on stderr |
| `<home>/agent-auth.profiles.json`, `<home>/agent-auth.overrides.json` | `testlane.profiles.json`, `testlane.overrides.json` | the old file is read (and `account set` keeps updating it) as long as the new one does not exist |
| MCP server `agent-auth`, tools `agent_auth.session`, ... | server `testlane`, tools `list_profiles`, `session_file`, `release_session_file`, `session`, `check`, `handoff`, `status` | the dotted tool names are gone (the MCP SDK cannot keep unlisted aliases); Claude Code exposes the new tools as `mcp__testlane__session` and so on |

Unchanged on purpose: the store keys (`agent-auth/<profile>`), the macOS keychain service and
Secret Service attribute (`agent-auth`), the DPAPI entropy and the encrypted-file identifiers,
the stored envelope format, and the HTTP headers (`X-Agent-Auth-*`). These are stable storage
and wire identifiers; renaming them would orphan every stored secret.

Replace old command allow rules with the `testlane` rules in the
[example settings](../examples/claude-code/settings.json). Keep the legacy deny patterns:
older checkouts and compatible registry/home names can still exist. If your MCP client
config registers the server under the key `agent-auth`, rename the key and its
`mcp__agent-auth` permission rule to `testlane` together.

## Downgrading: the stored envelope

Every entry written by 0.2.x or later is a version-3 envelope, which 0.1.x refuses as
`origin-unknown` (exit 6); going back to 0.1.x therefore needs a fresh `store set` per profile.
Going forward needs nothing: a version-2 envelope written by 0.1.x is still read, and `status`
flags it `legacy-envelope` (its age is unknown) until the next `store set` or `rotate`. The layout
is in [threat-model.md](threat-model.md#7-more-rules-the-code-enforces). A change to the envelope
format always comes with a documented upgrade path on this page.
