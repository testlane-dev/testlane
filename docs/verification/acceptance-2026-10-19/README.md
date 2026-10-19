# Recorded verification acceptance

These maintainer-recorded summaries describe local acceptance on 2026-10-19 against
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
