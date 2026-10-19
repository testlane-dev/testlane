# Changelog

All notable changes to Testlane are listed here, newest first. The format follows Keep a
Changelog. Testlane is pre-1.0, so a minor version can change behaviour; each such change names
what to do about it in [docs/upgrading.md](docs/upgrading.md).

## [0.7.0-beta.2] - 2026-10-19

### Fixed

- Playwright starts from the canonical app project directory. Deep private output
  directories no longer cause Windows child-process startup failure; app-relative
  fixture reads use the app root.
- The existing-app quickstart now locates globally installed examples under the
  scoped `@testlane/cli` package directory.
- Case-design guidance calls out full stable-state comparisons after denied mutations
  and capture of owned IDs before a creation helper can fail an assertion.

This carries the verification preview with corrected process startup and reviewed
installation/case-design guidance. Credential profiles and stored-secret formats are unchanged.
Use the exact reviewed beta version; stable npm `latest` remains 0.6.0.

## [0.7.0-beta.1] - 2026-10-19

### Added

- A `testlane-verify` agent skill for turning feature requirements and app code into
  concrete acceptance cases and app-owned Playwright tests.
- `verify init` creates a draft verification workspace without replacing existing tests
  or changing accounts, credentials or profiles.
- `verify run` reconciles planned cases with actual Playwright outcomes, cleanup and
  source hashes. Missing, skipped, duplicated and expected-failure cases cannot pass.
  Passing cases need an observed Playwright `expect` step; assertion counts do not prove
  the quality or coverage of the business checks.
- `verify report` creates a private local HTML summary bound to the exact plan and
  retained screenshot hashes, without rerunning tests or overwriting an existing summary.
- Failed assertions can report a line and column in the hashed planned spec, without
  retaining error messages or values. Caught failed assertions still fail acceptance.
- Generated suites preserve the bound helper's LF bytes through Windows Git checkouts.
- Explicitly enabled local screenshots carry private/unreviewed artifact metadata;
  traces, video and automatic screenshots stay disabled.

The preview package bundles the skill, fixture and harness with the broker. Use a reviewed
`0.7.0-beta.1` tarball, or that exact npm version when available; its intended dist-tag is
`next`. Stable `latest` remains 0.6.0. See the [installed preview quickstart](docs/agent-verification.md).

## [0.6.0] - 2026-10-19

### Changed

- Removed the application-specific legacy strategy and compatibility defaults. Configure
  custom integrations explicitly through `dependent-token`.
- Generic account identifiers use `identifier` in profiles and overrides, `{{identifier}}`
  in request templates and `--identifier` on the human account command.
- Public examples use an independent fictional API contract. Integration-specific mappings
  belong in the consuming application's private configuration.

This is a breaking pre-1.0 minor release. See [the migration guide](docs/upgrading.md#upgrading-to-060).
It changes no secret-store envelope or profile-name keys.

## [0.5.2] - 2026-10-18

First public npm release, under `@testlane/cli`. The registry rejected the unscoped
`testlane` package name because it was too similar to existing names; 0.5.1 was not published
to npm. Its tag and reviewed artifacts remain unchanged.

### Changed

- The npm package is `@testlane/cli`; the executable, MCP server, profiles, environment
  variables and stored credentials retain their existing Testlane names and behavior.
- Installation instructions, explicit module paths and release-artifact checks use the
  scoped package. A fresh 0.5.2 candidate and matching proofs are required; earlier evidence
  does not verify these new bytes.

## [0.5.1] - 2026-10-18

Unpublished npm candidate. Its reviewed source and artifacts are retained unchanged; the
registry blocked the unscoped package name. Version 0.5.0 also remained an unpublished
candidate. Versions 0.1 to 0.4 were private pre-releases (0.1 and 0.2 under the name
`agent-auth`); see [docs/upgrading.md](docs/upgrading.md).

### Added

- An exact-artifact release process: tags prepare and prove a candidate; reviewed CI stages
  its SHA-512-bound tarball with provenance before separate human npm approval.

- Supported `testlane workflow smoke` / `workflow feature` commands using app-local Playwright,
  with a [pinned project CLI/MCP installation guide](docs/project-install.md).

- MCP `session_file` and `release_session_file`: local private session files with metadata-only
  results, bounded capacity, explicit release and expiry/disconnect cleanup.

- `testlane doctor` with passive setup diagnostics, explicit `--check <profile>` sign-in,
  machine-readable reports and [remedies](docs/doctor.md).

- A copyable [Playwright Test fixture](examples/playwright/README.md) with fresh role/worker
  sessions, expiry metadata/guards, private-file cleanup and packed-consumer proofs.
- An explicit [compatibility matrix](docs/compatibility.md) distinguishing tested package
  and browser behavior from unverified agent-client combinations.

- An [existing-app quickstart](docs/quickstart.md) with a copyable browser/API check,
  unique session files and cleanup on Bash and PowerShell.
- Shared [session recipes](docs/sessions.md). Agent integration guides now focus on
  setup; demo acceptance procedures live in [maintainer documentation](docs/verification/agent-acceptance.md).

- `--format json` sessions on the CLI, the HTTP surface and MCP: the same headers as
  `--format headers`, as one JSON object ([docs/cli.md](docs/cli.md#json-format)).
- [docs/platforms.md](docs/platforms.md): setting up the secret store on Windows, macOS and
  Linux, including headless machines, WSL and devcontainers.
- Actionable errors for a missing `secret-tool`, a missing D-Bus session, a missing Secret
  Service and a locked keyring. Each says what is missing and points to docs/platforms.md.
- The workflow templates name a missing browser build, and the command that installs it, on
  stderr when the browser cannot launch.
- A Node 24 CI job, and Dependabot for npm and GitHub Actions.

### Changed

- The public package installs only the `testlane` executable. Private pre-release home,
  registry and store migration support remains; the deprecated `agent-auth` bin is removed.
- The MCP SDK is pinned to the version tested with the input-redaction adapter. MCP `check`
  is correctly annotated as a sign-in operation, rather than a read-only tool.

- An `encrypted-file` passphrase is asked twice on first use; a mismatch writes nothing.
- `store set` checks the store before it reads the secret, so a missing keychain fails before
  anything is typed.
- `http://*.localhost` subdomains now need https. Only `localhost`, `127.0.0.1` and `::1` keep
  plain http.
- `allowedHosts` entries are canonicalised through the URL parser. An entry the parser rejects
  (for example `foo.123` or `1.2.3.4.5`) is now a load error, and accepted entries are stored and
  shown in canonical form.
- A host overlap between a production profile and a non-production profile that spans the repo
  registry and the user-level `<TESTLANE_HOME>/testlane.profiles.json` now makes the whole
  registry fail to load (exit 2).
- On an identity mismatch, `check` no longer reports the email the app returned, and reports the
  profile's declared role instead of the app's.
- `store list` reports an error on a locked Linux keyring instead of an empty list. (`status`
  and `session` still read a locked keyring as "no secret stored"; see docs/platforms.md.)
- The JavaScript export `NO_KEYCHAIN_MESSAGE` was removed. The package's JavaScript exports are
  not a stable API in 0.x.
- The demo handoff route requires `AGENT_HANDOFF_ENV` to be `local`, `sandbox`, `testing` or
  `preview` (it fails closed), and the route contract says so.
- The demo clean-up (`npm --prefix examples/demo-app run clean`) deletes the demo's keychain
  entries.
- The README is a front page. The command, session-format, MCP and HTTP reference moved to
  [docs/cli.md](docs/cli.md), rotation and status to [docs/rotation.md](docs/rotation.md), the
  upgrade notes to [docs/upgrading.md](docs/upgrading.md), and the rules, trust model and known
  limits to [docs/threat-model.md](docs/threat-model.md).

### Fixed

- Shipped agent instructions prefer MCP session files and explicit release. Claude Code
  permission examples cover project-local invocations and registry/home override denials.
- Browser verification rejects off-origin document navigation and redirect chains, including
  an external hop returning to the app. Same-origin redirects remain supported. A redirect
  target may already have been contacted before rejection; this is not network isolation.
  Observed navigation during anonymous checks or browser shutdown also prevents a pass.
- Feature runs write failure/cancellation evidence when either form fill fails, and report
  evidence-finalization errors with a fixed diagnostic.
- Feature cleanup owns temporary session directories before issuance, including failed and
  cancelled issuance, and removes all of them before reporting cleanup success.
- Cookie Domain suffix matching no longer treats an IP address as a DNS hostname.

- A closed stdout pipe (`testlane profiles | head -1`) no longer crashes with `EPIPE`.
- The smoke `identity-timeout` and the feature `reader-read` self-test cases are deterministic.
- The issue-template config is valid YAML.

### Security

- All output paths use the stored-secret redactor: HTTP bodies, `session --out` files and MCP
  `structuredContent` now, as stdout and MCP text already did. Exact registered forms are
  replaced; alternate encodings and transformations have
  [documented limits](docs/threat-model.md#9-known-limits).
- IPv4-mapped IPv6 folds onto IPv4 in the production denylist.
- Production-host overlap is checked on the merged repo + user-level registry, and `store set`
  refuses profiles on production hosts.
- `check` no longer echoes a mismatching app-reported email, trusts the app's role only on an
  identity match, and keeps reflected session material off the process-wide redactor.
- Cookies with control characters in `Path` or `Domain` are ignored.
- Audit rows strip C1 controls and U+2028 / U+2029.
