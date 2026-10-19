# Authenticated smoke workflow contracts

The v1 workflow contract is a small, secret-free boundary between a reviewed
authenticated-smoke runner and its report. It does not create accounts, read a
vault, type passwords, or execute arbitrary command strings. A human prepares a
`sandbox` or `testing` profile; the runner consumes a broker session and writes
sanitized evidence.

The runtime authority is [`src/workflows/contracts.ts`](../../src/workflows/contracts.ts).
The standalone editor and interchange schemas are
[`schema/workflow.schema.json`](../../schema/workflow.schema.json) and
[`schema/workflow-report.schema.json`](../../schema/workflow-report.schema.json).

## Manifest

`parseWorkflow` accepts exactly this shape:

```json
{
  "schemaVersion": 1,
  "kind": "authenticated-smoke",
  "id": "checkout-smoke",
  "profile": "shop:sandbox:admin",
  "target": {
    "origin": "http://127.0.0.1:3020",
    "environment": "sandbox",
    "buildId": "local-build-1"
  },
  "identity": {"email": "admin@example.test", "role": "Admin"},
  "checks": {
    "readinessPath": "/api/health",
    "identityPath": "/api/me",
    "protectedPath": "/account",
    "protectedHeading": "Account",
    "apiPath": "/api/account"
  },
  "timeoutMs": 30000
}
```

The timeout is explicit and bounded to 1,000 through 120,000 milliseconds.
Profile names follow the broker's lowercase colon-separated profile syntax.
Origins are canonical HTTPS origins, or HTTP loopback origins for the first
local template. Credentials, queries, fragments, origin paths, production host
labels (`prod`, `production`, and `live`), and a `production` environment are
refused. A permitted trailing slash is normalized to the slashless `URL.origin`
by the runtime parser. Check paths start with one slash and contain no URL encoding,
backslashes, query, fragment, or authority. These restrictions prevent a
manifest from becoming a cross-origin or arbitrary request channel.

## Steps and report verdicts

The runner records one attempt for each observed step. v1 has these required
step IDs, in the order a serial runner normally uses them:

`profile-policy`, `readiness`, `broker-check`, `session`, `identity`,
`protected-page`, `api`, `anonymous-denied`.

Each step has a fixed status (`passed`, `failed`, `blocked`, `cancelled`, or
`skipped`), a fixed reason code, observed nonnegative integer duration, attempt
number, and optionally a
native process exit code plus a pair of sanitized `.log` and `.exit` evidence
references. Evidence references are relative paths with no root, drive, UNC,
dot, empty, or parent components. There are no response bodies, error dumps, command strings,
cookies, headers, handoff URLs, or secret fields. Attempt numbers are retained
for future, human-reviewed retries; v1 performs no automatic retry.

Duration is measured output, so it is not capped at the manifest deadline;
the manifest `timeoutMs` remains bounded independently.

`deriveReport` takes run metadata, the profile, the observed steps, and cleanup
status, then computes the verdict, counts, missing required IDs, and skipped
IDs. `parseReport` applies the strict schema and recomputes those fields,
rejecting forged or inconsistent results. `WorkflowReportSchema` also applies
the runtime consistency refinement; callers should use `parseReport` as the
public validation entry point. The standalone JSON Schema validates the wire
shape and safe field formats, but cannot express the cross-field computed
verdict rules. The runtime parser is also mandatory for canonical URL
semantics because JSON Schema cannot fully model URL parsing and normalization
across every consumer. JSON Schema consumers must call the runtime parser too. The
verdict rules are:

- `passed` requires all eight required steps observed and passed, and complete
  cleanup.
- `failed` records an assertion/process failure or failed cleanup.
- `blocked` records an empty run, missing or skipped required steps, or a
  blocked prerequisite.
- `cancelled` records a cancelled step and preserves that cancellation in the
  final report.

`sourceTree` identifies the reviewed checkout and may be null. `target.actualBuild`
identifies the application build actually reached and may be null. A checkout
hash never implies the identity of a remote application build.

Every attempt preserves a unique evidence log and exit-code file. Tests set a
fresh `TESTLANE_HOME` (and legacy `AGENT_AUTH_HOME`) scratch directory and
generate values at runtime. Humans seed profiles and secrets; agents never type
passwords or read `.env*`, `.local/`, credential, secret, or operator files.
