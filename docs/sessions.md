# Use an issued session

After the [human setup](quickstart.md), choose the artifact your client can consume.
The broker signs in for each `session` request. `check` also signs in, but discards its
session and returns identity information only.

| Client | Use |
| --- | --- |
| Playwright on the same filesystem | `session <profile> --format storage-state --out <fresh-file>` |
| curl | `session <profile> --format curl --out <fresh-file>`, then `curl --cookie <file> ...` |
| A client needing cookies plus token headers | `--format headers` or `--format json` |
| A browser with URL navigation only | `handoff <profile>`; requires the [app-side route](HANDOFF-ROUTE-CONTRACT.md) |
| MCP on the same filesystem | `session_file` returns a private local path; release it after loading |
| MCP requiring inline values | `session` returns the artifact inline; it enters the conversation context |

The CLI supports `--out`; MCP provides broker-managed files with `session_file`.
Session files and sign-in URLs are live credentials: do not print, commit or paste them.

## MCP-managed local session files

When the browser and MCP server share a filesystem, request `session_file` instead of
reading session values into the conversation. These are ordinary MCP tool calls:

```json
{"profile":"shop:testing:qa","format":"storage-state","ttlMinutes":15}
```

The `session_file` result contains the same metadata as both JSON text and
`structuredContent`: `id`, absolute `path`, `profile`, `format`, `issuedAt`, `expiresAt`,
and optional `warnings` / `droppedHeaders`. It contains no cookie/header values. Inspect
warnings and expiry before use; a cookie-only format cannot carry extra token headers.
`format` defaults to `storage-state` and accepts every [session format](cli.md#session-formats).
`target` and `ttlMinutes` use the normal origin and policy checks.

Pass `path` directly to your local browser integration, for example:

```js
const context = await browser.newContext({ storageState: receipt.path });
```

After the browser has loaded the state, call `release_session_file` with
`{"id":"the opaque id returned by session_file"}`. The result is `{"released":true}`;
an unknown or already removed id returns `false`. Use `finally` to release the file
on setup failure and close the browser context when the check finishes. Never read,
print, attach, commit or upload the file, or enable traces/video that retain credentials.
For curl, choose `format: "curl"` and pass the path to `curl --cookie` instead.

The broker accepts no output path or overwrite option. Each connection owns its own
random temporary directory and up to 32 outstanding files, counting in-flight requests.
Files are create-only, with mode 0600 inside a mode 0700 directory on POSIX; Windows
inherits the user's temporary-directory ACL. Each file is limited to 2 MiB. File creation
happens only after normal policy, sign-in and successful audit append. Cleanup uses the
opaque id for this server; it cannot target another server's file or an arbitrary path.

Files are removed on broker expiry, explicit release and normal MCP disconnect. Expiry
cleanup is best effort: locked files or filesystem errors are reported on stderr. A forced
process kill, machine crash or power loss can leave a file. If that happens, remove the
recorded file and its empty `testlane-session-files-*` directory in the OS temporary
folder from a normal terminal. No startup process scans or deletes other sessions' files.
A `file-cleanup-failed` delivery can leave a partial file even when no receipt was returned;
inspect that same temporary-directory prefix in a normal terminal. The server retains
ownership for expiry/shutdown retries. Cancelling an MCP request stops broker fetches and
prevents late file delivery; a session already created at the app can still exist.
Removing a file does not invalidate a session already loaded into a browser or revoke it
at the app. See [lifetime and cleanup](#lifetime-and-cleanup).

A local path does not transfer state to a remote browser or a container with another
filesystem. Use the reviewed app-side handoff integration for a URL-only browser, or a
separately approved secure transport. The existing `session` tool returns live values
inline for clients that need that contract; avoid it when local file delivery works.

## Playwright

The [existing-app quickstart](quickstart.md#6-add-the-browser-check) provides the complete
browser check, expected results, and fresh-file cleanup for Bash and PowerShell.
For repeated tests and separate roles, use the [Playwright Test fixture](../examples/playwright/README.md).
The [compatibility matrix](compatibility.md) records tested mechanisms and unverified clients.
The essential step after issuance is:

```js
const context = await browser.newContext({ storageState: stateFile });
```

The state applies to this new context, not to another browser pane or an already open
tab. A path from a local MCP/CLI process may not be accessible to a remote browser worker.

Testlane's `storage-state` output contains cookies and an empty `origins` array.
It does not reconstruct local storage, session storage or IndexedDB authentication.
Cookie-only formats (`cookie`, `curl`, `storage-state`) also omit extra headers from a
`dependent-token` profile; the broker warns by header name. A valid API session does
not guarantee that the same artifact supplies everything a browser needs.

## curl without printing a response body

Choose a reviewed read-only API route on the profile's origin. This Bash example prints
only the HTTP status; the identity response may contain sensitive application data.

```bash
(
  set -e
  mkdir -p .testlane/sessions
  session_dir=$(mktemp -d .testlane/sessions/run-XXXXXX)
  jar="$session_dir/cookies.txt"
  trap 'rm -f -- "$jar"; rmdir -- "$session_dir"' EXIT
  testlane session shop:testing:qa --format curl --out "$jar"
  curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
    --cookie "$jar" http://localhost:3000/api/me
)
```

PowerShell uses `testlane.cmd` to avoid npm's PowerShell script-policy issue and
`curl.exe` to avoid the legacy shell alias:

```powershell
New-Item -ItemType Directory -Force .testlane/sessions | Out-Null
$sessionDir = Join-Path (Resolve-Path .testlane/sessions) ("run-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $sessionDir | Out-Null
$jar = Join-Path $sessionDir 'cookies.txt'
try {
  testlane.cmd session shop:testing:qa --format curl --out $jar
  if ($LASTEXITCODE -ne 0) { throw 'Testlane session issuance failed' }
  curl.exe --silent --show-error --output NUL --write-out "%{http_code}\n" --cookie $jar http://localhost:3000/api/me
  if ($LASTEXITCODE -ne 0) { throw 'API request failed' }
} finally {
  if (Test-Path -LiteralPath $jar) { Remove-Item -LiteralPath $jar }
  Remove-Item -LiteralPath $sessionDir
}
```

Expect HTTP 200 for this example route. Curl's process exit 0 alone does not assert the
status or identity. The browser example checks both. Do not add `-L` blindly: review
redirects and the destination. Use the [format reference](cli.md#session-formats) for
header-based clients; avoid copying header values into argv or the transcript.

## A URL-only browser

For a human-configured `app-handoff` profile:

```sh
testlane handoff shop:testing:handoff:qa
```

Navigate that browser to the returned URL once within 60 seconds. This requires the app
to implement and enable the [handoff contract](HANDOFF-ROUTE-CONTRACT.md); the broker
does not add the route. The URL grants sign-in and belongs only in the intended browser
navigation, not logs or screenshots. For browser/client configuration see the
[Claude Code](INTEGRATION-CLAUDE-CODE.md) or [Codex](INTEGRATION-CODEX.md) guide.

## Lifetime and cleanup

Use a new file for every run. An existing output file is refused; repeated instructions
should allocate a new path rather than request `--force`. Ignore `.testlane/sessions/`
in git and remove each run's files in a shell trap or `finally` block.

The broker caps the artifact lifetime, while the application controls server-side
validity. A copied cookie may remain usable beyond the broker's `expiresAt`, and the app
may invalidate it earlier. On expiry or rejection, stop the test and request a fresh
approved session for a new run; do not replay uncertain mutations automatically.

Deleting a local file does not log the account out server-side. Revoke sessions in the
application, disable the dedicated account if needed, and let the human remove its
stored password with `testlane store delete <profile>`. The broker has no generic
server-side logout/revocation command.

Use project-specific profile names and per-run files for concurrent agents. Separate
browser contexts isolate cookies, not application records. Tests that mutate shared
state need appropriate accounts and fixtures per worker. On macOS/Linux, a different
`TESTLANE_HOME` changes local metadata paths but does not isolate keychain entries.
