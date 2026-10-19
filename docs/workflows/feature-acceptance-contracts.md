# Feature acceptance workflow contracts (two-role)

The feature-acceptance v1 contract is a small, secret-free boundary between a
reviewed two-role feature-acceptance runner and its report. It extends the
[authenticated smoke contract](contracts.md) to a run that exercises a writer
role and a reader role against one record-shaped feature: create as the
writer, read it back, confirm the reader cannot mutate it, and clean up after
itself. Like the smoke contract, it does not create accounts, read a vault,
type a password, or execute an arbitrary command string. A human prepares the
writer and reader profiles and reviews the manifest; the runner consumes two
broker sessions and writes a sanitized, versioned report.

The runtime authority is
[`src/workflows/feature-contracts.ts`](../../src/workflows/feature-contracts.ts).
It shares its origin, path, id, profile, text, reason-code and evidence
primitives with the smoke contract through the internal
[`src/workflows/primitives.ts`](../../src/workflows/primitives.ts) module, so
there is exactly one implementation of URL and path safety for both
contracts. The standalone editor and interchange schemas are
[`schema/feature-workflow.schema.json`](../../schema/feature-workflow.schema.json),
[`schema/feature-workflow-report.schema.json`](../../schema/feature-workflow-report.schema.json)
and
[`schema/test-environment-receipt.schema.json`](../../schema/test-environment-receipt.schema.json).

## Manifest

`parseFeatureWorkflow` accepts exactly this shape:

```json
{
  "schemaVersion": 1,
  "kind": "feature-acceptance",
  "id": "records-two-role",
  "target": { "origin": "http://127.0.0.1:4310", "environment": "testing", "buildId": "ref-build-1" },
  "roles": {
    "writer": { "profile": "reference:local:writer", "email": "writer@example.test", "role": "Writer" },
    "reader": { "profile": "reference:local:reader", "email": "reader@example.test", "role": "Reader" }
  },
  "checks": { "readinessPath": "/ready", "identityPath": "/api/me", "environmentPath": "/api/test-environment" },
  "record": {
    "collectionPath": "/api/records",
    "createPagePath": "/records/new",
    "form": { "idLabel": "Record ID", "titleLabel": "Title", "submitLabel": "Create record", "createdText": "Record created" }
  },
  "timeoutMs": 60000,
  "cleanupTimeoutMs": 10000
}
```

Unlike the smoke manifest, `target.buildId` is **required**: a two-role run
always cross-checks the build it actually reached against both the manifest
and the trusted receipt below. `timeoutMs` is bounded to 1,000 through
300,000 milliseconds; `cleanupTimeoutMs` to 1,000 through 60,000 milliseconds
(the run has more steps than the single-role smoke run, and its cleanup phase
is timed separately from the run itself). Origins, check paths and
`createPagePath` reuse the smoke contract's canonical-origin and
same-origin-path rules unchanged: loopback-only HTTP or canonical HTTPS,
production-labelled hosts refused with no override, no credentials, queries,
fragments, backslashes, URL-encoded escapes or path traversal.
`record.collectionPath` additionally must not end with a slash; the runner
addresses one record at `collectionPath + "/" + <recordId>`. `roles.writer`
and `roles.reader` must name different broker profiles and different email
addresses (compared case-insensitively). Role labels need not differ: these are
separate accounts, and the runtime checks must prove their different effective access.

## The trusted test-environment receipt

`parseTestEnvironmentReceipt` accepts exactly this shape:

```json
{
  "schemaVersion": 1,
  "kind": "test-environment-receipt",
  "runId": "run-1",
  "workflowId": "records-two-role",
  "environment": "testing",
  "origin": "http://127.0.0.1:4310",
  "buildId": "ref-build-1",
  "dataScope": "scope-run-1",
  "isolation": "dedicated-per-run",
  "issuedAt": "2026-09-24T12:00:00.000Z",
  "expiresAt": "2026-09-24T12:15:00.000Z"
}
```

The receipt is a contract with a **trusted setup adapter**: something the
operator already trusts to provision an isolated, dedicated-per-run backing
store for the app under test, and to say so in writing before the run starts.
It is explicitly **not cryptographic proof** of an application's backing
data. A loopback host or a `sandbox`/`testing` environment tag alone never
establishes isolated data on its own; those are just where the run happens to
point, not evidence about what lives behind it. The receipt's job is narrower
and more honest: it lets the runner refuse to touch a live environment that
does not match what the manifest and the adapter agree on, and it lets the
report record which `runId`/`dataScope` the run actually exercised.

`isolation` is the fixed literal `"dedicated-per-run"` (the only isolation
level v1 understands; a future contract may add others, but a runner must
never treat a receipt's silence on isolation as an "isolated" default). A
receipt's lifetime (`expiresAt - issuedAt`) must be more than zero and at
most 24 hours: it is meant to be issued immediately before one bounded run,
not as a long-lived credential. The schema is strict: an adapter cannot slip
an extra field&mdash;secret-looking or otherwise&mdash;past the parser.

`verifyReceiptForRun(receipt, manifest, options?)` checks a parsed receipt
against a parsed manifest, in this fixed order, and returns the first
mismatch it finds:

1. `receipt.workflowId === manifest.id`, else `"workflow-mismatch"`.
2. `receipt.origin === manifest.target.origin`, else `"origin-mismatch"`.
3. `receipt.environment === manifest.target.environment`, else
   `"environment-mismatch"`.
4. `receipt.buildId === manifest.target.buildId`, else `"build-mismatch"`.
5. `receipt.issuedAt <= now + clockSkewMs` (default 60,000 ms), else
   `"not-yet-valid"`.
6. `now < receipt.expiresAt`, else `"expired"`.

Anything else returns `{ ok: true }`. `now` and `clockSkewMs` are injectable
for tests; production callers should leave them at their defaults.

Runner convention (not enforced by the schema, since it depends on the
runner's own control flow): a missing receipt reports the
`environment-receipt` step as `blocked`/`blocked-prerequisite`; an invalid,
mismatched or expired receipt, or a live environment whose anonymous
`/api/test-environment`-style response disagrees with the receipt, reports
that step as `failed`/`target-refused`.

## The application adapter the runner expects

The runner (a separate package, not part of this module) expects the app
under test to behave like the reference app it is tested against:

- `checks.readinessPath` returns 2xx with no redirect, and (when
  `target.buildId` is set) an exact matching build identifier header before
  the report records `target.actualBuild`.
- `checks.identityPath` returns 200 JSON with top-level `email` and `role`
  fields for the session presented, and 401 for an anonymous request.
- `checks.environmentPath` is anonymous and returns the live `runId`,
  `dataScope`, `environment` and `buildId` the app itself believes it is
  running with, compared against the trusted receipt above.
- `record.createPagePath`, for the writer's session, renders a form whose
  labelled inputs match `record.form.idLabel` and `record.form.titleLabel`
  and whose submit control's visible text matches
  `record.form.submitLabel`; submitting it creates a record and shows
  `record.form.createdText`.
- `record.collectionPath + "/" + id` is a REST-shaped record resource: `GET`
  returns the record for the writer or the reader and 401 for anonymous;
  `PUT` updates it for the writer and returns 403 (with **no** state change)
  for the reader; `DELETE` removes it for the writer and 403 for the reader.

## Steps

`REQUIRED_FEATURE_STEPS` is the fixed, ordered set of 13 step ids a serial
runner uses:

1. `profile-policy`
2. `readiness`
3. `environment-receipt`
4. `writer-session`
5. `reader-session`
6. `writer-identity`
7. `reader-identity`
8. `record-absent`
9. `browser-create`
10. `api-readback`
11. `reader-read`
12. `reader-mutation-denied`
13. `unchanged-after-denial`

Each step reuses the smoke contract's step shape and status/reason-code
pairing rules unchanged, from the shared `primitives.ts` module: a fixed
status (`passed`, `failed`, `blocked`, `cancelled` or `skipped`), a reason
code from the same shared set, a nonnegative observed duration, an attempt
number, and optionally a process exit code and a pair of sanitized `.log`
and `.exit` evidence references. A `passed` step's reason code is always
`"ok"`; a `failed` step's reason code is `"assertion-failed"` or one of the
smoke contract's failure-mode codes (`environment`, `launch-failed`,
`process-failed`, `production-refused`, `target-refused`, `timeout`); the
other three statuses pair one-to-one with `blocked-prerequisite`,
`cancelled` and `skipped`.

## Cleanup

`cleanup.record` is one of `FEATURE_CLEANUP_RECORD_STATES`:

- `none` &mdash; no record was ever created (the `browser-create` step was
  never observed, whether or not the run reached it).
- `absent-verified` &mdash; the runner confirmed the attempted record is
  absent, without deleting it (for example, a navigation or form fill failed
  before submission, or the app silently skipped creation).
- `deleted-verified` &mdash; a record was created, the runner deleted it as
  the writer, and confirmed the delete by re-reading.
- `retained-unowned` &mdash; a record exists that the run cannot safely
  clean up (for example, the writer no longer owns it).
- `failed` &mdash; cleanup could not determine or achieve any of the above.

The runner owns each session temp directory from the moment it is created,
even if session issuance fails, is cancelled, or writes invalid state. It
removes every such directory during cleanup and marks cleanup failed if
removal fails. Every observed `browser-create` attempt also triggers the
record ownership/absence check, including failures during navigation or
either field fill.

Cleanup rules:

- `cleanup.status === "complete"` requires `record` to be one of `none`,
  `absent-verified` or `deleted-verified`, and `reasonCode` absent or `"ok"`.
- `record` of `retained-unowned` or `failed` requires
  `cleanup.status === "failed"`.
- `cleanup.status === "failed"` requires `reasonCode === "cleanup-failed"`.

Two cross-field rules tie `cleanup` and `environmentRun` to the observed
steps:

- Any **observed** `browser-create` step (any status, since even a failed
  attempt may have left data behind) requires `cleanup.record !== "none"`.
- `environmentRun` is non-null if and only if an `environment-receipt` step
  is observed with status `passed`.

## Verdict

`deriveFeatureReport` computes the verdict from the observed steps and
cleanup, in this precedence order:

1. Any step `cancelled` &rArr; `cancelled`.
2. Otherwise, cleanup failed or any step `failed` &rArr; `failed`.
3. Otherwise, an empty run, a missing required step, or any step `blocked`
   or `skipped` &rArr; `blocked`.
4. Otherwise &mdash; all 13 required steps observed and passed, and cleanup
   complete &mdash; `passed` **only if** `cleanup.record === "deleted-verified"`;
   any other complete-cleanup record state (`none` or `absent-verified`) at
   that point yields `failed`, not `passed`. A perfect run that never
   verifiably deletes what it created is not accepted as a pass.

`deriveFeatureReport` recomputes `verdict`, `counts`, `missingRequiredSteps`,
`skippedRequiredSteps` and `zeroChecks` from a draft, ignoring any supplied
values for those fields (mirroring the smoke contract's `deriveReport`).
`parseFeatureReport` applies the strict schema and rejects a report whose
supplied derived fields do not match what re-deriving them produces
(mirroring `parseReport`). `FeatureReportSchema` also applies the runtime
consistency refinement directly, so callers should use `parseFeatureReport`
as the public validation entry point; the standalone JSON Schema validates
the wire shape but, as with the smoke report, cannot express the
cross-field computed verdict and consistency rules, the receipt's lifetime
and ordering rule, or the manifest's distinct-writer/distinct-reader rule.
JSON Schema consumers must still call the runtime parser.

`sourceTree` and `target.actualBuild` remain nullable for the same reason as
the smoke contract: a local checkout hash never implies the identity of a
remote application build.

## Public-export hygiene

Every example in this document and in the test suite uses `example.test`
email addresses and loopback or `example.test`-family hosts. Nothing here
names a real company, product, host or person. In prose the project is
spelled "Testlane"; commands and identifiers use lowercase `testlane`.
