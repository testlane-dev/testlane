# Use Testlane with Codex

Configure and seed your app's profile with the [existing-app quickstart](quickstart.md),
then connect Codex to the reviewed registry. The examples here use a local stdio MCP server.

Use a [pinned project installation](project-install.md) for the entry point shown below.
A reviewed global installation may use `testlane` with `["mcp"]` instead.

## Merge the MCP configuration

Merge this server into `~/.codex/config.toml`, or the trusted project's
`.codex/config.toml`. Preserve existing servers and settings. The human sets the absolute
registry path; use forward slashes for Windows paths inside double-quoted TOML strings.

```toml
[mcp_servers.testlane]
command = "node"
args = ["/absolute/path/to/app/node_modules/@testlane/cli/dist/cli.js", "mcp"]
env = { TESTLANE_PROFILES = "/absolute/path/to/app/testlane.profiles.json", TESTLANE_REQUESTER = "codex" }
```

For a non-default home, add `TESTLANE_HOME` to that same `env` table. A table may be
declared only once; combine its entries instead of adding a second `env = ...` line.
For the demo, use the generated registry and home printed by `npm run demo`.

An explicit registry makes the server's profile selection independent of its startup
directory. If you choose discovery instead, set the server's `cwd` to the app repository.
The shell's current directory and environment may differ from the MCP server's.
Codex also supports explicitly forwarding selected environment variables with `env_vars`;
prefer human-controlled absolute paths for this registry.

The [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) describes
`cwd`, `env`, `env_vars` and project configuration. Reconnect the server after changing
its startup configuration. On PATH problems, use the absolute Node executable as
`command` and the absolute built `dist/cli.js` plus `"mcp"` as `args`.

## Keep MCP and shell access separate

MCP lets the broker access the keychain and audit log without adding the whole vault
directory to the agent shell's writable roots. It does not give the shell those same
permissions. The shell still needs network access to the app and permission to launch
Node/Playwright when using the CLI-based browser recipe.

Use your existing sandbox and approval policy. If networking is restricted, a human can
review whether the `sandbox_workspace_write.network_access` setting is appropriate for
that workspace. A CLI audit-write failure can require approval for that broker command;
prefer MCP for discovery and checks rather than making the entire vault writable.
Run the command in a normal terminal when diagnosing a sandbox-only failure.

These settings vary with client version, OS and managed policy. This guide does not
certify every Codex client/browser combination. Verify your actual setup with the
checks below instead of promising a prompt-free run.

## Add agent instructions

Merge [AGENTS.md.snippet.md](../examples/codex/AGENTS.md.snippet.md) into your app's existing
`AGENTS.md`. The snippet covers approved profiles, session use, human-only commands and
what to do on failure. `AGENTS.md` is model guidance, not an enforced permission boundary.
The [trust model](threat-model.md#4-trust-boundaries) explains same-user access and
why registry files are trusted configuration.

The human configures the server's registry/home. The agent must not override them,
read the credential store, edit account overrides, or run store/rotation commands.

## Confirm the connection

Ask Codex:

> List the Testlane profiles and check `shop:testing:qa`. Report the email, role and
> role source. Do not request or print a session yet.

The tools are `list_profiles`, `check`, `session_file`, `release_session_file`, `session`,
`handoff` and `status`.
`check` performs a fresh sign-in and discards its session; it does not authenticate an
existing browser. A declared role is configuration, not proof of effective permissions.

Then run the [existing-app browser check](quickstart.md#7-run-with-a-fresh-session-and-clean-up)
with your shell's normal approvals. [Session recipes](sessions.md) cover curl,
Playwright and URL-only browsers. An independent browser process does not inherit
another browser's cookies.

For a browser on the same filesystem, prefer MCP's `session_file`: pass its returned
path directly to the browser, then call `release_session_file` after loading the state.
The [complete recipe](sessions.md#mcp-managed-local-session-files) covers cleanup and limits.
The existing `session` result contains live credentials in the conversation. CLI `--out`
also writes a file; use a fresh ignored path and remove it after loading.
A `handoff` URL needs the app-side route and works once within 60 seconds.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP profile differs from CLI | Compare the server's explicit registry/home with the human's shell setup. |
| PowerShell blocks `testlane.ps1` | Use npm's `testlane.cmd` wrapper through normal client approvals, without changing execution policy. |
| MCP works; CLI audit append fails | Shell filesystem permissions. Do not make the store writable just to silence the error. |
| CLI cannot reach the app | Shell network access, the app's running port and profile origin (often exit 3). |
| A browser shows the login page | Import state into that exact context or use a supported handoff route. |
| Existing `--out` file | Use a fresh path; the examples intentionally avoid `--force`. |
| Exit 4 or 6 | Human checks the profile, keychain and origin/environment binding before re-seeding. |
| Overdue or pending rotation | Report the alert; the human resolves it outside the agent run. |

See [exit codes](cli.md#exit-codes), [platform setup](platforms.md) and
[session lifetime](sessions.md#lifetime-and-cleanup) for shared details.

Maintainers verifying harness behavior can use the
[agent acceptance procedure](verification/agent-acceptance.md); record Codex observations
separately from Claude Code permission-deny tests.
