# Use Testlane with Claude Code

First configure and seed your app's profile with the [existing-app quickstart](quickstart.md).
Then connect Claude Code to the same reviewed registry. The human owns registry selection,
vault changes and rotation; the agent requests sessions for approved test accounts.

Use a [pinned project installation](project-install.md) for the entry point shown below.
A reviewed global installation may use `testlane` with `["mcp"]` instead.

## Merge the MCP configuration

Merge the `testlane` entry into your existing `.mcp.json` under `mcpServers`. Preserve
your other servers. Set the absolute registry path as the human so discovery does not
depend on the server's working directory:

```json
{
  "mcpServers": {
    "testlane": {
      "command": "node",
      "args": ["/absolute/path/to/app/node_modules/@testlane/cli/dist/cli.js", "mcp"],
      "env": {
        "TESTLANE_PROFILES": "/absolute/path/to/app/testlane.profiles.json",
        "TESTLANE_REQUESTER": "claude-code"
      }
    }
  }
}
```

On Windows use forward slashes, such as `C:/projects/shop/testlane.profiles.json`.
For a non-default home, add `TESTLANE_HOME` to this same `env` object. The demo needs
its generated registry and home from the setup block printed by `npm run demo`.
Restart/reconnect the server after a configuration change.

If a desktop client cannot find `testlane` on PATH, configure the absolute Node executable
and built CLI path: `"command": "/absolute/path/to/node"` and
`"args": ["/absolute/path/to/testlane/dist/cli.js", "mcp"]`.

## Merge permission rules

Merge the `permissions.allow` and `permissions.deny` arrays from
[settings.json](../examples/claude-code/settings.json) into `.claude/settings.json`.
Preserve existing rules and unrelated settings. Review the combined result: an existing
deny rule can still block an allowed call, and broader permissions can expose other routes.

The supplied rules cover `npx --no-install testlane`, `npx.cmd --no-install testlane`
and `node node_modules/@testlane/cli/dist/cli.js` from the app root, plus installed-bin and
source-checkout launchers. They allow profile discovery, sessions, identity checks,
audit, status and diagnostics. They deny store/account changes, rotation, store reads,
session-file overwrites, `--profiles` before or after a subcommand, and current/legacy
registry or home environment overrides.

Windows needs both `Bash(...)` and `PowerShell(...)` rules: each tool uses its own rules.
The environment-name deny rules also match harmless searches mentioning those names;
review configuration as the human instead of removing the protection. Other launchers,
absolute executable paths and npm script wrappers need their own reviewed permissions.
Claude Code's [permission reference](https://code.claude.com/docs/en/permissions) explains
pattern matching; these examples are not OS isolation or a certification of live rule behavior.

These rules cover broker calls. Your browser, Node scripts and HTTP requests have their
own permissions; approve the needed operation through Claude Code's normal controls.
See [permission boundaries](cli.md#permission-rules-for-agents) and
[the trust model](threat-model.md#4-trust-boundaries). A process with the same OS account
can access user-scoped credentials, so text rules do not isolate a hostile local agent.

## Confirm the connection

Ask Claude Code:

> List the Testlane profiles. Check `shop:testing:qa` and report its identity and role
> source. Do not request or print a session yet.

The MCP tools are `list_profiles`, `check`, `session_file`, `release_session_file`, `session`,
`handoff` and `status`.
Claude Code exposes them under names such as `mcp__testlane__check`.
`check` signs in and discards that session; it does not sign the browser in.

Next run the [existing-app browser check](quickstart.md#7-run-with-a-fresh-session-and-clean-up).
Shared [session recipes](sessions.md) cover curl, Playwright and a URL-only browser.

For a local browser sharing the server's filesystem, prefer `session_file`, pass its
returned path directly to the browser, then call `release_session_file` after loading.
Use the [complete recipe](sessions.md#mcp-managed-local-session-files) for cleanup and limits.
`session` still returns live credentials inline; CLI `--out` also supports local files.
Never print, commit, upload or paste session files. `handoff` returns a single-use sign-in URL and requires an app-side route.

## Agent instructions

Add the [Testlane instructions](../examples/codex/AGENTS.md.snippet.md) to your existing
`CLAUDE.md`, adapting only the approved profile names. Keep these boundaries:

- The human seeds the vault, changes account overrides and rotates credentials.
- The agent never edits or substitutes a registry, home or store.
- The agent prefers MCP `session_file`, releases its id after loading, and closes browser contexts.
  CLI files use fresh ignored paths and are removed after use.
- Policy refusals stop the run; missing credentials or unresolved rotations go to the human.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server missing | Installation/PATH, existing MCP configuration and the client's connection status. |
| Profile missing | The server's absolute `TESTLANE_PROFILES` path; shell variables are separate from server configuration. |
| CLI fails but MCP works | Shell keychain, audit-log and network access. On Windows try `testlane.cmd` if the `.ps1` shim is blocked; use normal approval for that command form. |
| Browser still signed out | An issued session must be loaded into that browser context; see [session recipes](sessions.md). |
| App unreachable or sign-in rejected | App availability and profile endpoints/account; both can surface as exit 3. |
| No stored secret / origin mismatch | Human checks the registry and keychain, then runs `store set` if appropriate (exit 4 or 6). |

All [exit codes](cli.md#exit-codes), [platform setup](platforms.md), and
[rotation/status](rotation.md) are documented separately.

## Real-agent acceptance check

Maintainers testing client permissions and demo provenance should use the
[agent acceptance procedure](verification/agent-acceptance.md). It is separate from
ordinary application setup.
