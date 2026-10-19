<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/testlane-logo-dark.svg">
    <img src="assets/brand/testlane-logo-light.svg" alt="Testlane" width="320">
  </picture>
</p>

# Testlane

Testlane is a local credential broker for coding agents working with **sandbox and test
apps**. A human stores a dedicated test account's password in the OS keychain once. The
broker signs in on the agent's behalf and issues a session for curl, Playwright, an MCP
client or a browser handoff.

Stored passwords stay out of normal agent interactions. Issued cookies, session files
and handoff URLs are live credentials; MCP session results enter the conversation.
Testlane refuses production-tagged profiles and declared production hosts with no
override. It relies on human-reviewed configuration to identify those environments.

**Start with [your existing app](docs/quickstart.md)** for a complete profile, agent setup,
browser/API check, troubleshooting and repeatable cleanup. To try a disposable example
first, use the [bundled demo](#try-the-demo).

Requires Node 22 or newer. Pre-1.0; no independent security audit yet
([security policy](SECURITY.md)).

## The 60-second mental model

1. **Human setup:** review a secret-free `testlane.profiles.json` for the app and
   run `testlane store set <profile>` in your terminal. Type the password at the hidden
   prompt, never in a command argument, environment variable or chat.
2. **Broker sign-in:** the broker checks environment/host policy and lifetime, loads
   the origin-bound password, signs in, and appends an audit row before issuing a session.
3. **Agent use:** the agent consumes the session in its HTTP client or browser context.
   Store/account changes and rotation are absent from MCP and HTTP tools; the example
   agent permissions also deny those human commands.

The broker does not create test accounts, isolate processes running as the same OS user,
or discover whether an undeclared host is production. The application controls the
server-side session lifetime. See the [trust model](docs/threat-model.md).

## Install

```sh
npm install -g @testlane/cli@0.6.0
testlane --version
testlane --help
```

The npm package is `@testlane/cli`; the installed command remains `testlane`.

To try a reviewed tarball, install its absolute path in place of the package name.
For a source checkout, use `npm ci`, `npm run build`, then `npm link`. Consuming repos commit the profile and agent
configuration; installation does not provision an account or seed credentials.

For a lockfile-pinned broker and MCP entry point, use the [project installation](docs/project-install.md).
It also runs the shipped workflows using your app's Playwright dependency.

Secrets are protected by Windows DPAPI, macOS Keychain, or Linux Secret Service.
Linux needs `secret-tool` and an unlocked keyring. Headless/WSL/devcontainer setup,
error messages and the encrypted-file option are in [platforms.md](docs/platforms.md).

## Use it in your repo

Follow [Sign into your existing app](docs/quickstart.md). It covers an existing JSON
login endpoint that sets a cookie, a NextAuth credentials variation, and a browser check
that confirms identity, a protected page and anonymous API denial.

The default registry is the nearest `testlane.profiles.json` found walking up from the
working directory. An optional user-level registry is merged from `<TESTLANE_HOME>`
(default `~/.testlane`); duplicate names are refused. A human can select an explicit
registry with `TESTLANE_PROFILES` or the global `--profiles` option. The agent must not
change that selection or edit the registry.

`TESTLANE_HOME` holds audit, overrides, locks and file-based stores. On macOS/Linux,
changing it does not isolate keychain entries. Use project-specific profile names.
See [session recipes](docs/sessions.md) for curl, Playwright, handoff and session cleanup.

## Connect your agent

| Client | Setup |
| --- | --- |
| Claude Code | [Integration guide](docs/INTEGRATION-CLAUDE-CODE.md), merge the [permission rules](examples/claude-code/settings.json) and [MCP entry](examples/claude-code/mcp.json) |
| Codex | [Integration guide](docs/INTEGRATION-CODEX.md), [config example](examples/codex/config.toml) and [AGENTS.md instructions](examples/codex/AGENTS.md.snippet.md) |
| Other MCP clients | Start `testlane mcp` over stdio; tools: `list_profiles`, `check`, `session_file`, `release_session_file`, `session`, `handoff`, `status` |
| Local HTTP clients | Start `testlane serve` on `127.0.0.1` with its per-boot bearer token; see [CLI and surfaces](docs/cli.md#agent-surfaces) |

For clients sharing the broker's filesystem, prefer MCP `session_file`: pass the returned
path directly to the client and call `release_session_file` after loading, with cleanup in
`finally`. See the [complete recipe](docs/sessions.md#mcp-managed-local-session-files).
MCP `session` returns live values inline; CLI `--out` is another local-file option.
`check` returns identity and discards its proving session; it does not sign an existing browser in.

## Try the demo

```sh
git clone https://github.com/testlane-dev/testlane
cd testlane
npm install
npm run demo
```

This starts a local Next.js/NextAuth app on `http://localhost:3000` with generated
throwaway credentials. Paste its setup line into a second terminal, then try:

```sh
testlane check demo:admin
testlane handoff demo:handoff:qa
testlane session demo:production
```

The check reports identity. Open the handoff URL once within 60 seconds. The production
request is refused with exit 2. The [demo README](examples/demo-app/README.md) covers ports,
browser use and cleanup. Keep the demo local.

On macOS/Linux, the demo's generated secrets go into your user keychain even though
its registry and audit use a separate home. Stop it and run
`npm --prefix examples/demo-app run clean` to remove its entries.

## What the broker enforces

- Password input through a prompt or stdin; secret-looking command-line arguments are refused.
- Registered stored-secret values are scrubbed on output paths. Short numeric PINs and
  split writes have documented [redaction limits](docs/threat-model.md#9-known-limits).
- Production-tag and declared production-host refusal; origin and environment binding
  when a stored password is loaded.
- An audit append before issuing a session or handoff. Failed audit writes block issuance.
- Requested lifetimes above the profile/policy cap are refused. The app can still accept
  a copied cookie for its own session lifetime.
- Create-only CLI session files unless `--force` is explicitly used. MCP managed files
  use broker-owned paths, explicit release and expiry/disconnect cleanup.

Configuration and permissions remain part of the trust boundary. Review the
[security guarantees](SECURITY.md#design-guarantees) and [known limits](docs/threat-model.md#9-known-limits).

## Strategies

| Strategy | Supported flow |
| --- | --- |
| `nextauth-credentials` | next-auth v4 credentials provider; cookie session |
| `form-post` | HTML form or JSON login endpoint; cookie session |
| `dependent-token` | Existing same-origin session followed by a PIN/password/key exchange |
| `app-handoff` | App implements the one-time sign-in route; cookie sessions additionally require `options.mePath` opt-in |

[Strategy options](docs/strategies.md) describe exact endpoints and artifact formats.
`oauth-client-credentials` and `api-key` are not implemented. Generic SSO/MFA or browser
storage authentication is not implied by cookie support.

## Workflow templates

For agent-designed checks beyond the two fixed templates, the
[source-preview verification workflow](docs/agent-verification.md) packages a
`testlane-verify` skill, a draft workspace initializer and a Playwright execution harness.
Describe the behavior to your coding agent; it inspects your app and writes the tests.
The harness maps planned cases to executed results and cleanup, with optional private
screenshots. This **source-only `0.7.0-dev.0` preview is not a published release** and is absent
from npm 0.6.0. `verify report` can render a private local HTML summary of the case
expectations, results and screenshots; the agent remains responsible for assertion quality.

Optional [smoke and two-role feature templates](docs/workflows/README.md) exercise fixed
checks and emit sanitized reports. They accept loopback targets in this release;
the feature template also requires a trusted test-environment receipt. They are separate
from the ordinary browser/API recipe and from the core broker.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Existing-app quickstart](docs/quickstart.md) | Human setup through an agent's first repeatable browser/API check |
| [Playwright Test fixture](examples/playwright/README.md), [compatibility](docs/compatibility.md) | Reusable role/worker sessions, expiry, cleanup and verified integration scope |
| [Session recipes](docs/sessions.md) | curl, Playwright, URL-only browsers, lifetime and cleanup |
| [CLI and surfaces](docs/cli.md) | Commands, formats, MCP/HTTP contracts and exit codes |
| [Project installation](docs/project-install.md) | Pinned local CLI/MCP and supported workflow commands |
| [Setup diagnostics](docs/doctor.md) | Passive setup checks, optional sign-in verification and machine-readable remedies |
| [Platforms](docs/platforms.md) | Keychain setup, headless environments and store errors |
| [Strategies](docs/strategies.md), [handoff contract](docs/HANDOFF-ROUTE-CONTRACT.md) | Adapting the broker to an app's login flow |
| [Rotation/status](docs/rotation.md), [upgrading](docs/upgrading.md) | Credential maintenance and version changes |
| [Optional playbook](docs/playbook/README.md) | Suggested practices for longer unattended verification |
| [Maintainer release process](docs/verification/release.md) | Exact tarball review, provenance and staged npm publication |
| [Maintainer acceptance check](docs/verification/agent-acceptance.md) | Testing agent permissions and demo evidence |

## Status and stability

Pre-1.0. CLI flags, profiles, strategy options and stored envelopes can change between
minor releases, with an [upgrade path](docs/upgrading.md). The supported interfaces are
CLI, MCP and local HTTP. JavaScript exports are not yet a stable API.

## Contributing, security, license

[CONTRIBUTING.md](CONTRIBUTING.md) covers development and review; participants follow
the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately using
[SECURITY.md](SECURITY.md). Licensed under [Apache-2.0](LICENSE).
