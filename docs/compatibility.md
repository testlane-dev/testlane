# Compatibility and verification status

Use the [verification quickstart](agent-verification.md) for the current preview,
including its authentication prerequisites. The [existing-app quickstart](quickstart.md)
and [Playwright Test fixture](../examples/playwright/README.md) also cover standalone
authenticated checks.
The tables distinguish supported contracts, reproducible package tests and live
agent-client verification. A package/browser test does not certify a client version.

For artifact evidence, use the matching release's exact manifest and proof files.
Historical observations below retain their original package versions and scope.

## Current release: 0.7.0-beta.2

The opt-in [0.7.0-beta.2 release](https://github.com/testlane-dev/testlane/releases/tag/v0.7.0-beta.2)
is available as `@testlane/cli@0.7.0-beta.2` on npm's `next` channel; `latest` remains
`0.6.0`. On 2026-10-19, the public npm archive matched the reviewed GitHub tarball:
440,062 bytes, 225 package files, SHA-256
`fdce092977655166891375e094be1620b7b6e7e4381f6c153701b8c91aca46b0`.
Use the [versioned manifest](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/release-manifest.json)
for the full inventory and SHA-512 integrity.

| Evidence | Result and scope |
| --- | --- |
| [Released-source CI](https://github.com/testlane-dev/testlane/actions/runs/39265706792) | Passed for public source `3cf04f952562486d414367e1517a1805cc56b2ad`: core tests, browser-backed workflow tests and clean-room package checks on Windows, Linux and macOS; an additional Linux core job used Node 24. Windows DPAPI and isolated Linux Secret Service real-broker jobs passed. These are package/platform checks, not live-client certification. |
| [Candidate workflow](https://github.com/testlane-dev/testlane/actions/runs/39265755156) and [installed Linux proof](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/consumer-proof.txt) | macOS validation, including the temporary-keychain adapter tests, passed. The exact Linux tarball passed nine installed-package checks covering diagnostics, MCP session-file delivery into Chromium, explicit/disconnect cleanup, both workflow commands, unchanged package files and output/audit leak checks. That launch proof does not itself exercise the agent-authored `verify` workflow. |
| [Reviewed Codex workflow](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/codex-reviewed-acceptance.public.json) and [execution summary](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/codex-local-acceptance.public.json) | Desktop-bundled Codex CLI `0.163.0-alpha.10.2` ran the preserved five-case suite on Windows with a scratch DPAPI store: five passed with 185 observed `expect` steps. Controller replays of the unchanged suite produced two failures and three passes for an injected one-cent total defect, then five passes after correction. All 15 case cleanups completed; no app records remained after any run. |

The [source/artifact binding](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/source-run-binding.public.json)
connects those local Codex results to the hosted release: the local and merged source
trees are identical, and the complete tarball and all 225 installed files match.
The local receipts retain their original pre-publication wording; no new model run
was performed for the identical hosted copy. The client reran cases it had authored
during the earlier blocked beta.1 trial; it did not author new cases in this trial.
The fault and corrected replays were controller-driven, not additional client runs.

This establishes one configured CLI/browser workflow against a generated app, with
business-total checks, role denials and cleanup. It does not complete the broader
live MCP/permission-probe procedure, certify other clients/models/apps, or establish
assertion quality from the count alone. See the [evidence index](verification/acceptance-2026-10-19/README.md)
for exact records and the unchanged historical trial verdicts.

## Historical preview acceptance: 0.7.0-beta.1

On 2026-10-19, the following local trials used the exact GitHub prerelease tarball for
`@testlane/cli@0.7.0-beta.1`, SHA-256
`77ca384a3716c50d40906a27d340c5742aaee466e31c7662b2e77bb3a7c44aba`.
Both used Windows, fresh scratch DPAPI stores, and installed package files matched to
the tarball. They are separate from the historical observations below and from live
coding-agent client acceptance. See the [reviewed summaries](verification/acceptance-2026-10-19/README.md).

| Trial | Result | Scope |
| --- | --- | --- |
| Existing HTML authentication app | Copied quickstart check and installed `verify init` → authored tests → `verify run` → `verify report` passed. Ten observed assertions covered identity, protected content, anonymous denial and logout; cleanup completed. | Immutable [Express auth example](https://github.com/expressjs/express/tree/0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8/examples/auth), with explicit generated credential/session configuration, selector adjustments and a read-only JSON identity adapter. The app has no role model; this establishes no role-boundary coverage. |
| Interruption and owned-record recovery | Cancellation stayed non-passing and reported failed cleanup with one journaled owned record. Separate recovery deleted that exact record and verified 404. A fresh run using the original plan/spec passed. Denied operations were refused and selected status/total/subject checks stayed unchanged; early app-session expiry failed. | Four focused installed-runner scenarios against a generated local app. This checks a separate recovery journal and honest cleanup status, not guaranteed cleanup after any crash or broker TTL revocation. The denial checks did not compare every resource field. |

The owned apps were stopped and scratch stores/session files were removed. The Express
session store and recovery app's owned-record count were zero at shutdown. Application
logout/deletion was checked separately from local file removal. These observations cover
the configured scenarios; they do not certify arbitrary assertions, production apps or
every coding-agent client.

## Authentication and browser mechanisms

| Flow or mechanism | Broker support | Recipe and limit |
| --- | --- | --- |
| Existing JSON/HTML login that sets cookies | Supported: `form-post` | [Quickstart](quickstart.md); dynamic form tokens and cross-origin login need another integration |
| next-auth v4 credentials provider | Supported: `nextauth-credentials` | [Variation](quickstart.md#nextauth-credentials-variation); Auth.js/other providers are unverified |
| App implements Testlane's signed, one-time route | Supported: `app-handoff` | [Contract](HANDOFF-ROUTE-CONTRACT.md); URL-only navigation needs the route; cookie sessions additionally need `mePath` opt-in |
| MCP local session-file delivery | Supported by `session_file` / `release_session_file` | [Recipe](sessions.md#mcp-managed-local-session-files); same server filesystem; protocol tests cover token-free results, audit refusal and disconnect cleanup |
| Cookie-based Playwright contexts | Supported | [Standalone check](quickstart.md#6-add-the-browser-check) or [Test fixture](../examples/playwright/README.md); same machine/filesystem as the CLI |
| Session plus token headers | Supported by the broker's `headers`/`json` formats | [Format reference](cli.md#session-formats); not supported by the cookie-only Playwright fixture |
| localStorage, sessionStorage or IndexedDB authentication | Unsupported by the storage-state exporter | It emits cookies and an empty `origins` array; a different browser adapter is required |
| Generic SSO/MFA, hosted identity-provider redirects | Unsupported as a generic login flow | Use a separately verified integration or an approved app-side handoff route; do not bypass MFA |
| OAuth client credentials / API key strategies | Not implemented | `session`/`check` refuse them |
| Remote browser unable to read local paths | Session-file recipe unsupported | A local path is not transferred to the worker; a URL-only browser needs the reviewed app handoff route |

Profiles and app code are trusted configuration. Production-tag/declared-host refusal
cannot discover an undeclared production environment. Review endpoints and browser pages
for side effects, and keep credentials limited to dedicated test accounts.

## Historical package and platform evidence: 0.5.0

Recorded on 2026-10-18 for the 0.5.0 release candidate. The fixture is tested with
`@playwright/test` 1.64.0 and Chromium; Firefox/WebKit and other Playwright versions are
unverified for this recipe. Existing browser checks also use Playwright 1.64.0.

| Evidence | Platforms/runtime | What was verified |
| --- | --- | --- |
| [Existing-app check](../examples/existing-app/tests/verify.test.mjs) | Windows, Linux, macOS hosted runners; Node 22 | A copied cookie-based check opens Chromium, validates identity/page/anonymous denial, refuses false passes and keeps generated session values out of output |
| [Fixture consumer tests](../examples/playwright/tests/fixture.test.mjs) | Run locally on Windows / Node 22.14.0; CI runs on Windows, Linux and macOS | A packed-package consumer exercises fresh two-role sessions, parallel worker mappings, expiry, failure/cancellation cleanup and refusal cases using a broker double |
| [Fixture real-broker proof](../examples/playwright/tests/real-broker-proof.mjs) | Windows DPAPI; CI also runs in isolated Linux Secret Service | The installed packed CLI signs into a local app through the native scratch store; two roles run twice in real Chromium, with audit/output leak checks and no retained session files |
| [Launch consumer proof](../scripts/launch-consumer-proof.mjs) | Windows DPAPI locally; CI also runs in isolated Linux Secret Service | An installed tarball drives diagnostics, actual stdio MCP file delivery into Chromium, explicit/disconnect cleanup, both workflow CLI commands and token-free output/audit/evidence; the installed package stays unchanged |
| [Core, clean-room and native-store CI](../.github/workflows/ci.yml) | Windows/Linux/macOS; Node 22, plus Linux core tests on Node 24 | Broker/package behavior and platform store adapters; not live agent-client or browser-pane configuration |

For the fixture and launch proof, the pull request's CI run is the source of hosted results; the table's
CI coverage is the configured scope, not a claim that an unrun job passed. Hosted OS
images can change; use the run's runner-image details for the exact OS version. Node 24
browser-fixture execution and macOS real-broker fixture execution are unverified. The
macOS proof is deliberately not run because a scratch home does not isolate its keychain.

To reproduce from source, build first, install the fixture example's locked dependencies
and Chromium, then run `npm run test:playwright`. The real-broker proof additionally
requires Windows, or Linux with `TESTLANE_REAL_KEYCHAIN=1` inside a private D-Bus session
with an unlocked throwaway keyring. See the [fixture README](../examples/playwright/README.md)
and [platform setup](platforms.md#linux-headless-wsl-devcontainer). Run `npm run proof:launch-consumer`
for the installed diagnostics/MCP/workflow proof under the same isolated-store restrictions.
Set `TESTLANE_PACKAGE_TARBALL` to an absolute reviewed tarball path to test those exact bytes;
otherwise the proof packs the current built checkout. Proof/test sources
are checkout-only; consumer fixtures and docs ship in npm.

## Agent-client matrix

| Client / mechanism | Tested client version | Status | Reproduction |
| --- | --- | --- | --- |
| Codex: installed CLI/browser verification workflow | Desktop-bundled CLI 0.163.0-alpha.10.2; Windows DPAPI; Testlane 0.7.0-beta.2 | Passed preserved-suite execution and separately controlled defect/corrected replays; no new test authorship or broader MCP/permission acceptance claimed | [Current release evidence](#current-release-070-beta2) and [verification quickstart](agent-verification.md) |
| Claude Code: local stdio MCP, four-tool sandbox sequence | 2.1.268; Windows build 19045, Node 22.14.0 | Historical Testlane 0.5.0 check recorded on 2026-10-18 | [Recorded transport check](#recorded-claude-code-transport-check) |
| Claude Code: shell/browser workflow and permission probes | No complete procedure run recorded | Unverified | [Setup](INTEGRATION-CLAUDE-CODE.md), then [acceptance procedure](verification/agent-acceptance.md) |
| Codex: broader local stdio MCP and permission-probe procedure | No complete procedure run recorded for 0.7.0-beta.2 | Unverified; the scoped CLI/browser workflow above is separate evidence | [Setup](INTEGRATION-CODEX.md), then the same acceptance procedure with Codex observations recorded separately |
| Other MCP clients and managed browser panes | None recorded | Unverified | Check the client's tool permissions, process environment and artifact-loading mechanism |

Record the exact client version, OS/build, Node/Testlane/browser versions, configuration,
registry/home paths, browser mechanism, date and results when performing acceptance.
Keep credentials out of that record. Claude deny-rule observations and Codex approval
observations are different evidence and must be recorded separately. Passing CLI/MCP
protocol tests alone does not establish either live client's permission behavior.

### Recorded verification-client trials: 0.7.0-beta.1

These 2026-10-19 trials used the beta.1 tarball identified above, generated local
accounts and a fixed local controller for installed CLI commands. Functional test
outcomes and conformance to each trial's client policy are separate observations.

| Client | Observed workflow | Overall trial result |
| --- | --- | --- |
| Claude Code 2.1.268 | Independently authored six cases and invoked init/run/report. All six passed with 105 observed assertions and zero records after the positive run. | **Incomplete:** one discovery command was denied by the trial hook. Review also found incomplete ID/owner comparisons and a creation-helper cleanup gap that the positive run did not exercise. See the [functional summary](verification/acceptance-2026-10-19/claude-functional-incomplete.json). |
| Claude Code 2.1.268, fresh strict trial | Read the skill/app/brief and invoked init; no cases or test report ran. | **Incomplete:** a discovery pipe was denied under the upfront policy and the client stopped. See the [separate summary](verification/acceptance-2026-10-19/claude-discovery-incomplete.json). |
| Desktop-bundled Codex CLI 0.163.0-alpha.10.2 | Authored five cases with full-state comparisons and early owned-ID journals; invoked init/run/report. The run blocked before case execution, with zero assertions and no app mutations. | **Incomplete:** the beta.1 runner could not start its child in the deep Windows report directory. That launch boundary was reproduced separately and fixed in beta.2; the [original blocked record](verification/acceptance-2026-10-19/codex-beta1-blocked.json) remains unchanged. Use the matching release's evidence for any corrected-artifact rerun. |

These scoped trials do not complete the broader permission-probe procedure above or
certify every client/model/browser combination. The client-authored tests remain
reviewable app code. Later successful runs do not change an earlier blocked or
incomplete verdict.

## Recorded Claude Code transport check

Claude Code 2.1.268 connected to Testlane 0.5.0 over stdio MCP (protocol
2025-11-25) and completed `list_profiles`, `check`, `session_file` and
`release_session_file` against generated accounts in a local reference app.
The installed package came from a reviewed tarball; its SHA-512 integrity was
unchanged afterward. The check matched the generated identity, file delivery
returned metadata only, release removed the file, and no broker session files
remained. Generated passwords and session tokens, including encoded variants,
were absent from the captured client output and broker audit.

This run used a scratch DPAPI store, a temporary explicit MCP configuration,
`--restricted`, `--strict-mcp-config`, disabled built-in tools/skills/browser
integration, and Manual mode with a per-run allowlist naming only those four
tools. Unresolved approval requests were denied. A transport proxy additionally
restricted calls to the generated profile, the reference app and the returned
file id. No other MCP servers or plugins loaded. The package binary was unchanged.

These observations cover that four-tool configuration. They do not verify manual
approval prompts, the shipped Claude deny rules, browser or shell work performed
by Claude, or the complete [agent acceptance procedure](verification/agent-acceptance.md).
The separate installed-package Chromium proof verifies file loading into a browser.

## Operating conditions

- **Workers and worktrees:** map each role/parallel worker to its own account and profile;
  use a separate mapping for another invocation, shard or worktree. Cookies and contexts
  do not isolate shared application records. [Fixture recipe](../examples/playwright/README.md#parallel-workers-and-separate-roles).
- **Changing ports:** origin binding includes the port. Review and human-seed a profile
  for the new origin; cookies themselves are not port-scoped.
- **Headless/CI:** the broker and browser need the same filesystem plus an available,
  unlocked store. DPAPI is user/machine-bound. Linux needs Secret Service and its D-Bus
  session; a different home does not isolate macOS/Linux keychain entries.
- **Lifetime:** check the issued session's expiry before work. Request a new session for
  a new run; do not automatically replay a mutation. The app can invalidate it earlier
  or accept it longer than broker metadata suggests.
- **Revocation and cleanup:** remove local files and close contexts, then use the app's
  own session/account controls when server-side access must end. File deletion is not
  revocation. [Session lifecycle](sessions.md#lifetime-and-cleanup).
