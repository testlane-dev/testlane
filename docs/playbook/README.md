# Playbook: letting coding agents verify web apps unattended

This playbook offers optional practices for longer unattended verification. Start with the
[existing-app quickstart](../quickstart.md) for ordinary setup. Choose the evidence,
isolation and review practices that fit the operations your agent will perform.

The broker handles authentication. The chapters below discuss test accounts, data,
verification evidence and credential maintenance.

It is written for teams that already use a coding agent (Claude Code, Codex, or any agent that
runs shell commands or speaks MCP) and want it to exercise real sign-in flows on sandbox and test
deployments: run end-to-end checks, click through a preview in a browser pane, call APIs as a
given role, and hand back evidence.

The [authenticated smoke workflow](../workflows/README.md) is the smallest
complete example: it consumes one approved sandbox or testing profile and
checks readiness, identity, a protected page, an API and anonymous denial
without capturing a session. The
[feature-acceptance workflow](../workflows/README.md#feature-acceptance-workflow-two-role)
extends that to a writer and a reader exercising one create/read/deny-mutate/
delete feature end to end.

## The principles in ten lines

1. Keep stored passwords out of agent interactions; treat issued sessions as live credentials.
2. Agents sign in as dedicated, least-privilege agent accounts, never as a person.
3. Declare production hosts and tags, and gate agent-only sign-in routes in the app.
4. Session lifetime is enforced by the app on the server, not by the artifact the agent holds.
5. Keep store/account changes and rotation human-controlled; configure the client and review its actual permission behavior.
6. For auditable runs, retain outputs and exit codes without overwriting earlier attempts.
7. Review a fixed version of every change, independently, and commit exactly what was approved.
8. One job per agent, non-overlapping files, and a return that someone else can verify.
9. Mutating tests need isolated data and owned fixtures; read-only checks can use an approved existing environment.
10. Credentials rotate on a schedule, two-phase, with alerts that reach a human.

## Chapters

| Chapter | Rule in one line |
| --- | --- |
| [01 Accounts](01-accounts.md) | One dedicated, password-less agent account per role per environment. |
| [02 Environments](02-environments.md) | Tag every profile, declare production explicitly, and make the app refuse production on its own. |
| [03 Sign-in](03-sign-in.md) | Hand agents session artifacts, pick the artifact for the client, enforce TTL in the app. |
| [04 Harness permissions](04-harness-permissions.md) | Allow sign-in, deny human-only commands on every shell tool, never rely on the rules alone. |
| [05 Evidence](05-evidence.md) | `output/<label>-<n>.log` plus `.exit` for every check; never overwrite a failure. |
| [06 Review loop](06-review-loop.md) | Pin the change, review it independently, re-verify every fix, commit exactly what was approved. |
| [07 Throwaway infrastructure](07-throwaway-infrastructure.md) | A fresh database, container and vault home per verification, cleaned up afterwards. |
| [08 Rotation and hygiene](08-rotation-and-hygiene.md) | Two-phase rotation on a human-owned schedule, daily status alerts, per-run credentials. |

Each chapter has the same shape: **the rule**, **why** (the failure it prevents), **how**
(commands and configuration), and a **checklist** you can paste into a pull request or a runbook.

## Conventions used in the examples

- `testlane` is the CLI. MCP/HTTP provide corresponding agent operations with different
  input/output contracts; CLI `--out` has no MCP equivalent.
- Profile names are `<app>:<environment>:<role>`, for example `acme:staging:sales`.
- Hosts use reserved names: `localhost`, `*.test` for sandbox and test deployments,
  `*.example` for production.
- `TESTLANE_HOME` is the broker's state directory (audit log, store files, locks, HTTP token).
  It defaults to `~/.testlane` (or to an existing `~/.agent-auth` from before the rename, when
  `~/.testlane` does not exist).
- Shell examples are POSIX `sh`/`bash`; where Windows differs materially, a PowerShell form is
  given.

## How the pieces fit

```text
human (once)          store set, account set, rotate schedule          -> vault, overrides
agent (all day)       profiles, check, session, handoff, status, audit -> session artifacts
harness               allow the agent list, deny the human list, on every shell tool
app                   agent accounts seeded, handoff route gated, TTL enforced server-side
verification          throwaway infra -> checks with evidence -> pinned change -> review -> commit
```

Related documents: [threat model](../threat-model.md), [handoff route contract](../HANDOFF-ROUTE-CONTRACT.md),
[security policy](../../SECURITY.md).
