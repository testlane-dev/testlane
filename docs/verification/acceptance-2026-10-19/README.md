# Recorded verification acceptance

## Current release: 0.7.0-beta.2

The [immutable beta.2 release](https://github.com/testlane-dev/testlane/releases/tag/v0.7.0-beta.2)
contains the following reviewed records. They bind the released public source
`3cf04f952562486d414367e1517a1805cc56b2ad` to the exact tarball, SHA-256
`fdce092977655166891375e094be1620b7b6e7e4381f6c153701b8c91aca46b0`
(440,062 bytes; 225 package files).

| Release asset | What it establishes |
| --- | --- |
| [Package manifest](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/release-manifest.json) | Version, public source commit, producing run, complete file inventory and SHA-512 integrity. |
| [Source/run binding](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/source-run-binding.public.json) | Successful released-source CI and candidate workflow; identical local/merged Git trees; byte-for-byte equality of the locally tested and hosted tarball, including all 225 installed files. |
| [Reviewed Codex acceptance](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/codex-reviewed-acceptance.public.json) | Actual Codex CLI 0.163.0-alpha.10.2 execution of the preserved five-case suite on Windows with a scratch DPAPI store; concrete business assertions, full-record 403/409 comparisons, anonymous denial, cleanup and independent shutdown checks. |
| [Codex execution summary](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/codex-local-acceptance.public.json) | Initial client run: five passed and 185 observed `expect` steps. Controller-driven replays of the unchanged suite: injected total 4199 against required 4200 produced two failures/three passes; correction restored five passes. All 15 case cleanups completed, with zero app records after each run. |
| [Windows startup regression](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/windows-ci-startup-fix.public.json) | Controlled Windows/Node 22.23.3/Playwright 1.64.0 regression for CI Git-metadata startup, with a failing-before/passing-after browser check and 71 focused tests passing without skips. Local synthetic CI is distinguished from hosted CI. |
| [Installed Linux proof](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/consumer-proof.txt) | Nine exact-package checks passed using isolated Secret Service: diagnostics, MCP browser file loading/release/disconnect cleanup, both workflow commands, unchanged package bytes and credential/session-output checks. This is separate from the Codex `verify` execution. |
| [Checksums](https://github.com/testlane-dev/testlane/releases/download/v0.7.0-beta.2/SHA256SUMS) | SHA-256 bindings for the tarball and reviewed proof assets. Hashes identify bytes; they are not signed attestations. |

The local Codex receipts were frozen before publication and retain that wording.
The source/run binding separately connects them to the identical hosted archive;
there was no new model run for that copy. The client ran the unchanged cases it had
authored during the earlier blocked beta.1 trial, rather than authoring new cases in
the beta.2 trial. The defect and corrected replays were performed by the controller.
The configured trial used one generated app and one client/model configuration; it
does not complete the broader live MCP/permission acceptance procedure or certify
other clients, models or applications.

Public npm verification on 2026-10-19 also matched the reviewed archive and installed
files. `@testlane/cli@0.7.0-beta.2` is available on `next`; stable `latest` remains
`0.6.0`. Registry publication is a separate observation from these frozen receipts;
no CI-generated npm provenance is claimed for this direct human-approved publication.
Start with the [current verification quickstart](../../agent-verification.md), or
read the [platform and client scope](../../compatibility.md#current-release-070-beta2).

## Historical local trials: 0.7.0-beta.1

The following maintainer-recorded summaries describe local acceptance on 2026-10-19 against
the exact [0.7.0-beta.1 GitHub tarball](https://github.com/testlane-dev/testlane/releases/tag/v0.7.0-beta.1).
They preserve that version and artifact hash. Later guidance changes do not relabel
them as runs against another package.

| Record | What it establishes |
| --- | --- |
| [Existing app](existing-app.json) and [bindings](existing-app-bindings.json) | Installation and adapted quickstart/verification against an existing public Express HTML authentication example, including the explicit read-only identity adapter and absence of an application role model. |
| [Recovery](recovery.json) | Non-passing cancellation with unavailable cleanup, a surviving separate owned-record journal, scoped recovery, a fresh successful run, denied mutations and early app-session expiry. |
| [Claude functional trial](claude-functional-incomplete.json) | Six positive cases passed, but the fixed client-policy gate and assertion review remained incomplete. The summary preserves the denied discovery and unexercised cleanup/oracle limits. |
| [Claude fresh trial](claude-discovery-incomplete.json) | Init succeeded and a denied discovery pipe stopped the client before test authoring/execution. |
| [Codex beta.1 trial](codex-beta1-blocked.json) | Five authored cases remained unexecuted after a child-launch failure; no business behavior was accepted. The corrected artifact requires its own separate execution evidence. |

The existing-app binding retains its original receipt filename, `acceptance.public.json`;
`existing-app.json` here is the identical frozen file. The recovery trial's unchanged-state
checks compared status, total and subject, rather than every stable resource field.
The original Codex summary's secret-variant scan covers captured client/CLI streams;
it is not an all-files canary scan. Its network permission was enabled generally,
with loopback-only use instructed by the trial, rather than technical network confinement.

The public records contain reviewed outcomes, source/artifact hashes and limitations.
Private app fixtures, generated credentials, transcripts, HTML reports and screenshots
are not included. Local JSON and hashes are review evidence, not signed attestations or
an independent security audit. A passing harness does not establish that arbitrary
agent-written assertions are sufficient.
