# Setup diagnostics

Run diagnostics from your app repository, with the same Node runtime, environment and
working directory as the agent or MCP process:

```sh
testlane doctor
testlane doctor --json
```

On PowerShell, use `testlane.cmd` when your execution policy blocks npm's `.ps1` shim.
For a project installation, use your package script or `npx --no-install testlane doctor`.
An explicit registry goes before the command: `testlane --profiles ./approved.json doctor`.

## Passive checks

The default command validates Node support and the selected registry, lists its configuration
sources, flags conflicting current/legacy environment names, checks store executable
prerequisites, resolves optional app-local Playwright dependencies and inspects audit-path
permissions. Registry loading uses the normal repo/user merge and account overrides.
Browser resolution does not import app code or launch Chromium. The passive command does
not read stored credentials, unlock a keychain, call the app, create files or append audit rows.

A passing executable check does not prove that the keychain is unlocked. A passing audit
check inspects permissions only; it cannot guarantee that a later append will succeed.
The report calls authentication unverified until you explicitly request it. Warnings
alone do not make the command fail.

| Result / diagnostic code | Next step |
| --- | --- |
| `registry.empty` / `registry.invalid` | Start in the app repository; check the approved file, JSON/schema and profile names using the [quickstart](quickstart.md) |
| `configuration.legacy_conflict` | Have the human consolidate `TESTLANE_*` and legacy `AGENT_AUTH_*` settings; the nonblank current name wins |
| `store.prerequisite_missing` / `store.bus_not_declared` | Follow [platform setup](platforms.md) in the environment where the agent runs |
| `store.interactive_passphrase` | Establish an unlocked platform keyring for unattended use; never place a passphrase in argv or environment variables |
| `store.platform_mismatch` | Remove a store override intended for another OS; review the supported stores in [platform setup](platforms.md) |
| `browser.optional_dependency_missing` | If you need browser workflows, follow [project installation](project-install.md); CLI/MCP session issuance does not require Playwright |
| `audit.not_writable` / `audit.directory_not_writable` | Use the normal client approval or a private writable broker home; avoid granting broad access to the vault |

## Explicit sign-in verification

```sh
testlane doctor --check myapp:testing:qa
testlane doctor --check myapp:testing:qa --json
```

This opt-in runs the same policy, stored-secret, audit and identity checks as `testlane check`.
It contacts the configured app and may trigger an OS keychain prompt. It issues a session,
verifies the identity endpoint and discards the local artifact without printing it or
writing a session file. The app may continue accepting that session until its own expiry;
Testlane does not implement generic server-side revocation.

The diagnostic report omits response bodies, email/role values, stored credentials and raw
exception text. It includes profile names, configuration paths and operational metadata.
Review paths and names before sharing a report publicly. A declared identity role is not
proof of an authorization boundary: test protected operations separately. An identity response
without a role produces `authentication.role_declared`; broker warnings, including unresolved
rotation, produce `authentication.broker_warnings` with a count and no warning text.

## JSON contract and exits

`--json` emits one report on stdout, conforming to
[`schema/doctor-report.schema.json`](../schema/doctor-report.schema.json):

- `schemaVersion: 1`, package `version`, `generatedAt` and Node/platform metadata.
- `checks`: each has `id`, `status` (`pass`, `warn`, `fail`), a machine-readable `code`,
  fixed `summary`, optional `remedy` and optional metadata `details`.
- `ok`: true when no check failed. `exitCode` matches the process exit.

Use codes to select an action; summaries/remedies are for people. Future releases may add
checks and codes. Do not parse the text formatter or interpret a warning as verified access.

| Exit | Meaning |
| --- | --- |
| 0 | No failed checks; warnings or unverified checks may remain |
| 1 | Setup failure or unexpected diagnostic/authentication failure |
| 2 | Explicit check refused by policy, or requested profile unavailable |
| 3 | Explicit sign-in or identity verification failed |
| 4 | Explicit check has no stored credential |
| 6 | Explicit check refused an origin-bound stored credential |

When an explicit authentication check fails, its exit code takes precedence over another
setup failure. A successful authentication check does not hide a failed setup check. Every
check remains in the report. Parser/secret-flag refusals occur before
report generation and retain the normal [CLI exit codes](cli.md#exit-codes).
