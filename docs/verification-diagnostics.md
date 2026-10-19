# Verification failure diagnostics

Development builds after 0.7.0-beta.2 add fixed diagnostics to verification JSON and
HTML reports. The published beta.2 package retains its existing reason codes and
failed-expect coordinates; it does not contain these new fields.

A failed or blocked case can include `diagnostic` with `code`, `summary` and `remedy`.
The run can include a `diagnostics` array. These are fixed product messages derived
from observed lifecycle events and statuses, rather than copied exceptions. Reports
continue to omit raw browser errors, request or response bodies, console output,
stack traces and session values.

## Reading a failed case

Start with its `status`, `reason` and cleanup outcome. Then use the diagnosis to find
the relevant part of the unchanged test source:

| Diagnostic | What to inspect |
| --- | --- |
| `ASSERTION_FAILED` | A Playwright `expect` failed. Use the spec ID, source hash and available line/column to inspect the assertion. A caught failed expectation still prevents a pass. |
| `CASE_BODY_FAILED` | The `runCase.run` callback threw without an observed failed expectation. Inspect navigation, requests, imported helpers and explicit throws. |
| `CASE_SETUP_OR_CONTRACT_FAILED` | The case failed before a valid helper body result. Check hooks, fixtures, role/profile setup and the copied helper. This category does not identify a missing browser specifically. |
| `CASE_AFTER_BODY_FAILED` | Body and declared cleanup completed, but test execution failed elsewhere. Inspect fixture teardown and code following `runCase`. |
| `CASE_TIMED_OUT` | Inspect awaited work and the per-test time budget. Check owned records before retrying. |
| `CLEANUP_FAILED` or `CLEANUP_UNCONFIRMED` | Read the private ownership journal, clean up only the owned records and verify their absence. Treat the feature as unverified. |

A failed-expect location contains only coordinates within a hash-bound planned spec.
It is not a general error stack or a location for an arbitrary thrown exception.
Imported assertion helpers can fail without yielding a location in the planned spec.
The diagnostic describes available evidence; it does not establish the application's
root cause or the quality of the test's expected result.

## Reading a blocked run

`PLAYWRIGHT_UNAVAILABLE` identifies failure to resolve the app-local Playwright test
runner. `RUNNER_START_FAILED` identifies child-process startup failure.
`GLOBAL_TEST_ERROR` identifies a run-level Playwright error, without guessing whether
an import, browser, hook or dependency caused it. `RUNNER_REPORT_UNAVAILABLE` means
the parent did not receive a complete valid journal. The accompanying fixed remedy
lists the next checks.

Resolve configuration and installation problems in a normal terminal using the
[prerequisites and runner limits](agent-verification.md#runner-limits). Do not bypass
credential or environment policy, change expected values to silence a failure, or
remove a required case from the plan.

## Compatibility and sharing

The new renderer accepts older schema-v1 reports without diagnostic fields and
provides conservative guidance from their reason codes. If diagnostic fields are
present, it validates the exact catalogue text and rejects unknown or modified values.
Existing verdict and cleanup rules still apply.

Plan descriptions and manually enabled screenshots remain private application data.
Fixed diagnostic copy does not make an entire report safe to publish. Review all
evidence before sharing and inspect unknown cleanup after cancellation or forced stop.
