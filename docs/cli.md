# CLI and agent surfaces

Reference for every `testlane` command, the session output formats, the MCP and HTTP surfaces,
the permission rules that keep human-only commands away from agents, and the exit codes. For the
overview see the [README](../README.md); for the rules the broker enforces and what it does not
defend against see [threat-model.md](threat-model.md).

## Commands

| Command | Who | Output |
| --- | --- | --- |
| `verify init --brief <file> --target <origin> --profile <name> [--environment testing] [--output-dir <new-suite-dir>] [--json]` | agent within the requested app scope | **0.7.0-beta.1 preview, absent from stable 0.6.0**: draft workspace for the agent to turn into real app-specific tests; no authentication or account changes |
| `verify run --plan <file> [--output-dir <private-report-dir>] [--json]` | agent within the authorized app/test scope | **0.7.0-beta.1 preview, absent from stable 0.6.0**: executes trusted app-owned Playwright code and reports mapped case/cleanup outcomes; see [agent verification](agent-verification.md) |
| `verify report --report <file> --plan <file> [--json]` | agent | **0.7.0-beta.1 preview, absent from stable 0.6.0**: create-only local `summary.html` beside the JSON report; verifies the exact plan binding and screenshot hashes; private evidence stays local |
| `workflow smoke --manifest <file> [--output-dir <dir>] [--json]`, `workflow feature --manifest <file> --receipt <file> [--output-dir <dir>] [--json]` | agent with app-operation approval | fixed shipped workflow runner; app-local Playwright, sanitized evidence/report and strict pass verdict; see [project installation](project-install.md#run-the-shipped-workflows) |
| `doctor [--json] [--check <profile>]` | agent | setup diagnostics; passive by default. `--check` explicitly signs in, verifies identity and discards the session. See [diagnostics](doctor.md) for JSON and exit semantics |
| `profiles` | agent | table (or `--json`) of profiles; no secrets. An email from the account overrides file is shown as `<email> (override)` (`--json`: `"overridden": true`) |
| `session <profile> [--format cookie\|storage-state\|curl\|headers\|json] [--ttl m] [--target url] [--out file [--force]]` | agent | the artifact on stdout, or a one-line confirmation with `--out` (a new file; an existing one is refused unless `--force`). For an `app-handoff` profile that opted in with `options.mePath`, the broker consumes the one-time handoff URL itself and prints the cookies the app set (the URL is never printed); without `mePath` it is refused, exit 2 |
| `check <profile>` | agent | `ok <profile> <email> role=<role> (<source>) expires=<ts>`, or `FAIL ...` on stderr (an `app-handoff` profile needs `options.mePath`, otherwise it is refused, exit 2) |
| `handoff <profile>` | agent | `{ "url", "expiresAt", "profile" }` as pretty JSON on stdout, nothing else (same with `--json`); `app-handoff` profiles only |
| `status [--json] [--max-age-days n] [--alert]` | agent | per profile: `SECRET` (yes/no/refused), `STORED`, `AGE`, `LIMIT`, `PENDING`, `ALERTS` (`--json`: `{ generatedAt, alerting, profiles: [...] }`); never a value; production profiles are listed but never read; `--alert` exits 7 when a non-production profile has an alert |
| `audit [--tail n]` | agent | the last audit rows (default 20) |
| `account list` | agent | `<profile>  email=<email>  [identifier=<code>]  [(unused here)]` lines plus `file: <path>` (global `--json`: `{ file, overrides, unusedHere }`); `no account overrides` on stderr when empty |
| `mcp` | agent tool host | MCP server over stdio |
| `serve [--port <port>]` | agent tool host | localhost HTTP server (default port 4711; token file `http-token`, or `http-token-<port>` on another port) |
| `store set <profile>` | **human only** | reads the secret from a prompt or stdin, never argv; refuses production profiles |
| `store delete <profile>`, `store list` | **human only** | `store list` prints profile names that have a secret and hides internal entries (the encrypted-file data key and names not in the registry), which only `--json` lists, under `internal` |
| `account set <profile> --email <email> [--identifier <code>]` | **human only** | writes the user-level account override (mode 0600, atomic) for an existing non-production profile and prints `account override for <profile>: email=<email>`; unknown or production profile: exit 2; an invalid email: exit 1; secret-looking flags: exit 5 |
| `account clear <profile>` | **human only** | removes that override (`cleared account override for <profile>` or `no account override for <profile>`) |
| `rotate <profile>` | **human only** (or a human's scheduled task) | changes the password in the app and in the vault, two-phase; prints `rotated <profile> [via <profile>]: ... stored <ts>` (global `--json`: `{ profile, rotated, storedAt, via, status }`), never a secret; see [rotation.md](rotation.md) |

"Human only" means no MCP tool or HTTP endpoint exists for it. The example permission
rules deny mutations; `store list` is not allowlisted and requires human approval.

### Preview verification

Install the reviewed `0.7.0-beta.1` package tarball, or that exact npm version when available, then use `npx --no-install testlane verify ...` from the app repository. The intended npm preview tag is `next`; stable `latest` stays at 0.6.0, which has no `verify` subcommands. The package bundles the broker, skill, fixture and harness; a source build is optional. The coding agent designs the tests. `init` creates only a draft/skipped scaffold, `run` executes the authored cases, and `report` renders an existing run without executing app code.

`run --json` includes `reportPath`, relative to the chosen output root. Each passing case needs an observed Playwright `expect` step (`assertionsObserved`); an otherwise completed case with none is blocked as `NO_ASSERTIONS_OBSERVED`. Node-assert-only specs are unsupported in v1. Identity/cleanup assertions can contribute to the count, which does not prove business-oracle quality or coverage.

Retained run evidence is the JSON report and approved manual screenshots; an optional `summary.html` restores app descriptions from the exact plan. Ordinary Playwright output/attachments are temporary, not a recovery journal. See the [installed preview quickstart](agent-verification.md) for package/skill setup, a direct Node alternative for PowerShell, private output, interruption cleanup, screenshot limits and report interpretation. All three commands stay within existing task authorization; plan review is not an automatic extra approval gate.

### Global options

Global options go **before** the subcommand: `testlane [--profiles <file>] [--requester <name>]
[--json] <command> …`. Options that take a value may be written `--opt=value`.

- `--profiles` and `--requester` are accepted **only before the subcommand**:
  `testlane --profiles x session p` works, `testlane session p --profiles x` is an
  unknown-option error (exit 1) that does not echo the path. A command matching an allowlisted
  prefix such as `testlane session …` therefore cannot swap the registry.
- Global `--json` goes before the command. `doctor`, `status`, workflow and preview verify subcommands also accept it after the command.
- An unknown `--option=value` on any command is refused before parsing (exit 5) without echoing
  the value, and commander's own errors never echo an option's value (`--format`, `--port`,
  `--tail`, `--ttl`) or an unknown command name.
- After `store set` only the profile name is accepted. Any flag (global ones included),
  `--flag=value`, extra argument or secret-looking flag is refused (exit 5) before stdin is read.

The registry the commands use, and `TESTLANE_HOME`, are described in the
[README](../README.md#use-it-in-your-repo).

## Session formats

| `--format` | Artifact | Typical use |
| --- | --- | --- |
| `cookie` (default) | a `Cookie:` header value | `curl -H "Cookie: …"`, fetch |
| `storage-state` | Playwright `storageState` JSON | `browser.newContext({ storageState: "storage.json" })` |
| `curl` | Netscape cookie jar | `curl -b cookies.txt …` |
| `headers` | raw header lines (`Cookie: …` plus any extra headers, e.g. `x-device-access`) | strategies that return more than a cookie, read by a shell |
| `json` | the same headers as a JSON object | strategies that return more than a cookie, parsed by an agent/program |
| `handoff` (command, not a format) | a 60-second, single-use sign-in URL | a browser pane that can only navigate |

For complete curl/Playwright usage with fresh files and cleanup, use [session recipes](sessions.md).
Session files are live credentials: keep them out of git and delete them when done. `--out`
never overwrites an existing file unless `--force` is given.

### `headers` format, exactly

`--format headers` (and the HTTP `/session` endpoint with `"format": "headers"`) prints raw
`Name: value` lines, one per line, no blank lines, no trailing punctuation beyond the final
newline:

- **Line format**: `<Name>: <value>`, using the header's own casing (`Cookie`, or whatever
  casing a strategy's `tokenHeader`/`sessionCookieName` option uses, e.g. `x-device-access`).
- **Order**: a `Cookie:` line first, **only when the artifact has cookies**, followed by each
  entry of the artifact's extra headers in the order the strategy produced them (currently at
  most one: the `dependent-token` token header or cookie).
- **Which headers can appear**: `Cookie` for any strategy that yields cookies (all of them today
  except a pure token exchange); an extra header (e.g. `x-device-access`) only for a
  `dependent-token` profile whose `tokenField` is captured as a header rather than a
  cookie. Most artifacts are `Cookie` alone.
- **What "dropped headers" means**: the three cookie-only formats (`cookie`, `storage-state`,
  `curl`) can express cookies only, so an artifact's extra headers are left out of the printed
  artifact entirely when one of those formats is chosen; nothing about them appears in the
  artifact itself. Only `headers` and `json` can carry them.
- **Where the warning goes**: the CLI prints one line to **stderr** naming the dropped header(s)
  by name only, never their value (`warning: 1 header(s) (x-device-access) are not
  representable in format cookie; use --format headers`); stdout (or the `--out` file) still gets
  exactly the chosen format's artifact and nothing else. MCP reports the same names in
  `structuredContent.droppedHeaders`; HTTP reports them in the `X-Agent-Auth-Dropped-Headers`
  response header (comma-separated names).
- **Exit codes**: `headers` (and `json`) succeed or fail exactly like every other format — the
  dropped-header warning is informational, not a failure, and never changes the exit code (see
  [Exit codes](#exit-codes)). An invalid `--format` value itself is a commander usage error
  (exit 1) and never reaches sign-in.
- A header name or value that could not be written as a single, injection-safe line (a bad field
  name, or a value containing a control character) makes `session` fail instead of printing a
  malformed line; the error names the header, never its value.

### `json` format

`--format json` (CLI), `"format": "json"` (HTTP `POST /session`), and the MCP `session` tool's
`format: "json"` return the exact same header set as `headers` — same rules on what can appear,
same order, same "never a value in an error" guarantee (built from the same code) — as a single
JSON object instead of raw lines, so an agent that parses the artifact needs no out-of-band
knowledge of the line format:

```jsonc
{
  "profile": "acme:local:admin",
  "format": "json",
  "expiresAt": "2026-01-01T00:00:00.000Z",
  "headers": {
    "Cookie": "next-auth.session-token=<redacted>"
    // , "x-device-access": "<redacted>"   // only for a dependent-token profile
  },
  "droppedHeaders": []
}
```

- `headers` is exactly what `--format headers` would print, as name/value pairs instead of lines
  (a `Cookie` key only when the artifact has cookies).
- `droppedHeaders` is always `[]` for this format: like `headers`, `json` never drops an artifact
  header. The field is included for shape parity with the other surfaces (MCP's
  `structuredContent.droppedHeaders`), so a caller need not special-case the format.
- The CLI, HTTP and MCP surfaces all build this object with the same function
  (`src/session/json.ts`, reused by `src/session/format.ts`), so the three surfaces cannot drift.
- `--out <file>` works exactly like the other formats: create-only unless `--force`, mode `0600`
  on POSIX. The HTTP response is `Content-Type: application/json; charset=utf-8` (every other
  format is `text/plain`). The audit row for a `json` session is identical in shape to any other
  format's, with `format: "json"`.

## Agent surfaces

The core agent operations (list profiles, session, check, handoff, status) are offered on three
surfaces. MCP additionally offers managed local session files. All of them resolve the registry fresh on every call, run the same policy, vault and
audit path, and share one deps builder (`src/deps.ts`). Neither MCP nor HTTP can store, change, delete or
return a stored password, and none of them can edit account overrides or rotate a password: those are
CLI-only human actions.

**CLI**: the [commands table](#commands) above.

**MCP** (`testlane mcp`): stdio server named `testlane` with the tools `list_profiles`,
`session`, `session_file`, `release_session_file`, `check`, `handoff` and `status` (`{ maxAgeDays? }`; the same report as
`status --json`). The names are plain `[a-z_]` so every MCP client accepts them; registered
under the key `testlane`, Claude Code exposes them as `mcp__testlane__session` and so on. The
pre-rename dotted names (`agent_auth.session`, ...) are no longer served. There is no store,
account or rotate tool. When a session or check signs in while an unresolved pending rotation
exists, `structuredContent.warnings` carries the "pending rotation unresolved" note (the session
text stays the bare artifact). stdout is the protocol channel; every console method that would
write to stdout is routed to stderr. Errors are `isError` results with a safe message and a
`code` (the exit-code numbers below); invalid input is reported as `invalid input: <field names>`
without the received values. `format` accepts `cookie` (default), `storage-state`, `curl`,
`headers` or `json` (the `headers` object as structured JSON instead of raw lines; see
[JSON format](#json-format)). When a cookie-only format drops artifact headers,
`structuredContent.droppedHeaders` lists their names, never their values. Registration: see the
integration docs and [examples/claude-code/mcp.json](../examples/claude-code/mcp.json).

`session_file` accepts the same arguments as `session`, but defaults to `storage-state`.
It writes a broker-owned temporary file and returns only `id`, local `path`, `profile`,
`format`, `issuedAt`, `expiresAt` and optional warning/header-name metadata. It never accepts
an output path. `release_session_file` accepts `{ id }` and returns `{ released }` for files
owned by this MCP connection. See [MCP file delivery](sessions.md#mcp-managed-local-session-files)
for browser use, limits, permissions, expiry/disconnect cleanup and crash recovery.
Unlike inline `session`, file-delivery errors use fixed messages and omit raw app/OS error
text, while preserving error classes 1, 2, 3, 4 and 6. Local delivery failures may include
`reason`: `file-capacity`, `file-closed`, `file-cancelled`, `file-expired`, `file-too-large`, `file-write-failed`
or `file-cleanup-failed`. Release a held file before retrying capacity; never replay app mutations.

**HTTP** (`testlane serve [--port <port>]`): binds `127.0.0.1` only (default port 4711; `0` picks
a free port). Every request needs `Authorization: Bearer <token>`; the token is 32 random bytes
generated per boot and written to `<TESTLANE_HOME>/http-token` for port 4711, or
`<TESTLANE_HOME>/http-token-<port>` for any other port (removed on SIGINT/SIGTERM). The `Host`
header must be `127.0.0.1` or `localhost`, and any request carrying an `Origin` header is refused
(browsers must never call it). Routes: `GET /healthz`, `GET /profiles`, `POST /session` (JSON
`{ profile, format?, ttlMinutes?, target? }`, `format` one of `cookie` (default), `storage-state`,
`curl`, `headers` or `json`; the artifact comes back as `text/plain` for every format except
`json`, which comes back as `application/json` (see [JSON format](#json-format) for the body
shape), both with `X-Agent-Auth-Profile/-Format/-Expires` headers, plus
`X-Agent-Auth-Dropped-Headers: name1,name2` when a cookie-only format dropped artifact headers),
`POST /check` (200 with the identity, or 502
`{ error, code: 3 }` on an identity mismatch), `POST /handoff` (JSON `{ profile }`) and
`GET /status` (optional `?maxAgeDays=<n>`, the only query parameter the server accepts). A session
issued while an unresolved pending rotation exists carries
`X-Agent-Auth-Pending-Rotation: unresolved`. JSON bodies only, at most 64 KiB, unknown keys
refused. There are **no store endpoints** and **no rotate endpoint** (404). Errors are
`{ error, code }` (403 for policy, 409 for a missing or refused secret, 502 for sign-in failure).
One log line per request on stderr (method, pathname, status, time), never bodies, headers or
query strings.

## Permission rules for agents

The broker keeps secrets out of the agent's hands; the agent's permission rules keep the
human-only commands out of its reach. Ready-made files and the reasoning behind every rule:

- **Claude Code**: [INTEGRATION-CLAUDE-CODE.md](INTEGRATION-CLAUDE-CODE.md), with
  [examples/claude-code/settings.json](../examples/claude-code/settings.json) (allow `profiles`,
  `session`, `handoff`, `check`, `audit`, `account list`, `status`, `doctor` and the MCP server; deny
  `store set|delete`, `account set|clear`, `rotate`, `--profiles` in either position,
  registry/home environment overrides, `--force` and store reads, with shell rules twinned
  for `Bash(...)` and `PowerShell(...)`) and
  [examples/claude-code/mcp.json](../examples/claude-code/mcp.json).
- **Codex CLI**: [INTEGRATION-CODEX.md](INTEGRATION-CODEX.md), with
  [examples/codex/config.toml](../examples/codex/config.toml) (sandbox, network, MCP server) and
  [examples/codex/AGENTS.md.snippet.md](../examples/codex/AGENTS.md.snippet.md) (the rules as agent
  instructions).

Agents must never pass their own registry (`--profiles`, `TESTLANE_PROFILES`,
`TESTLANE_HOME`, or the pre-rename `AGENT_AUTH_*` names) or edit `testlane.profiles.json`
(or `agent-auth.profiles.json`): see [Trust boundaries](threat-model.md#4-trust-boundaries).

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | ok |
| 1 | other error: audit-log write failure, usage error (unknown command or option, a global option written after the subcommand, an invalid `--format`/`--port`/`--tail`/`--ttl` value), an existing `--out` file without `--force`, a `store set` handoff secret shorter than 32 characters |
| 2 | policy refusal (production, host, TTL, transport, invalid profile; `handoff` on a non-`app-handoff` profile; `session`/`check` on a strategy that is not implemented, `oauth-client-credentials` or `api-key`, or on an `app-handoff` profile without `options.mePath` (not opted in); `rotate` while another rotation of the same profile holds the lock, or with a `rotateVia` on another origin) |
| 3 | sign-in failure, including a `check` identity mismatch (signed in, but the app reports another account); for an `app-handoff` profile, an unreachable app, a handoff route that answered anything but a same-origin 3xx or set no host-only cookie, or a `mePath` identity mismatch; a `rotate` the app refused or whose outcome is unknown (no credential is lost either way) |
| 4 | no stored secret: a human must run `testlane store set <profile>` |
| 5 | secret passed on the command line, or an unknown `--option=value` on any command (refused before parsing and before stdin is read, value never echoed) |
| 6 | stored secret refused: bound to another origin, stored under another environment tag, or in an older format; a human must re-run `store set` |
| 7 | `status --alert` only: at least one non-production profile has an alert; the report is still printed |

The MCP server reports the same numbers as `code` in error results (invalid tool input is
`code: 1`); the HTTP server returns them as `code` in `{ error, code }` bodies. Exit 7 exists on
the CLI only; `status` and `GET /status` report `alerting: true` instead.
