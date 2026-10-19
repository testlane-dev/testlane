# Source verification harness contract

Use a reviewed `0.7.0-dev.0` source-preview checkout containing `examples/agent-verification/`. The harness is a local runner for app-owned Playwright specs, not an LLM service, browser agent or test generator. The published `@testlane/cli@0.6.0` broker remains usable for fixture authentication, but does not contain this skill or harness.

## Start from a new source scaffold, or preserve an existing suite

If the source checkout has been built, initialize from the app directory with:

```sh
node /absolute/testlane-source/dist/cli.js verify init --brief output/feature-brief.md --target http://127.0.0.1:3000 --profile notes:testing:writer --environment testing --output-dir e2e/testlane-verification --json
```

Use a local ignored UTF-8 brief file and actual approved values. Init refuses an existing suite directory; it writes `plan.json`, ignored `brief.md`, fixture/helper copies, `test.mjs` with an initial `qa` role alias, and a deliberately skipped spec. It does no authentication or account/registry/vault changes. Replace the scaffold with app-specific cases and assertions, adapt only the app test configuration to existing role mappings, and mark the plan `reviewed` after coverage/scope review. The scaffold alone must not pass. If a reviewed suite already exists, adapt it rather than running init over it.

## App-owned files

Keep the app's Playwright dependency and normal credential setup. Copy the existing `examples/playwright/fixtures.mjs` from the installed package or reviewed source. Copy source `examples/agent-verification/authoring.mjs` **verbatim** alongside it as `testlane-authoring.mjs`. The helper is self-contained and uses Node built-ins. The report binds its version and source hash; do not alter it to turn failed cleanup or assertions into success.

A useful layout is:

```text
e2e/testlane/
  fixtures.mjs             # reviewed existing fixture
  testlane-authoring.mjs    # verbatim source helper
  test.mjs                 # app-owned fixture configuration/exports
  feature.spec.mjs         # agent-written assertions for this brief
  verification.plan.json   # reviewed case inventory
```

`test.mjs` configures `createTestlaneTest` with an absolute project-local `node_modules/@testlane/cli/dist/cli.js` path, the exact approved app origin and distinct profile arrays for the required roles. Re-export its `test` and `expect`; specs import those instead of the ordinary Playwright fixtures. Testlane profile/registry/store configuration stays under existing human control.

## Plan

The runner takes a JSON plan with this shape. Example values describe a fictional app; the agent must resolve the real app's requirements and write the named specs before running. `projectDir` is resolved relative to the plan file, and each `spec` is relative to that app project. Do not put credentials, response bodies or session values in this file.

```json
{
  "schemaVersion": 1,
  "status": "reviewed",
  "title": "Reader cannot change a published note",
  "projectDir": "../..",
  "target": {
    "baseUrl": "http://127.0.0.1:3000",
    "environment": "testing"
  },
  "cases": [
    {
      "id": "reader-cannot-edit",
      "title": "Reader edit is denied without changing the note",
      "spec": "e2e/testlane/feature.spec.mjs",
      "expected": [
        "Writer and reader contexts identify the intended distinct accounts",
        "Writer creates a run-owned published note that the reader can view",
        "The reader edit receives the app contract's denial status",
        "Fresh API readback proves the note unchanged after the rejected edit"
      ],
      "cleanup": {
        "required": true,
        "description": "Writer deletes only the run-owned note; verify absence"
      }
    }
  ],
  "evidence": { "screenshots": "off" }
}
```

Allowed environments are `local`, `testing`, `sandbox` and `preview`; use an HTTPS origin or loopback HTTP origin with no credentials, path, query or fragment. Host labels `prod`, `production` and `live` are refused. This remains declared scope, not proof that another host/data set is safe. The app fixture must use the same reviewed origin.

Use `status: "draft"` while requirements/specs remain unresolved. Set `reviewed` after checking actual assertions and cleanup against the authorized brief. This is agent coverage review, not a mandatory new human approval gate. Every case needs a unique lowercase kebab-case ID, title, project-relative spec, nonempty expected-observation array and cleanup declaration. Set `cleanup.required: false` only when no app-owned mutation/data needs cleanup, and explain why. Keep any richer requirement/role/data-ownership notes next to the plan rather than adding unsupported JSON fields.

## Annotations and cleanup helper

Each planned case maps to one Playwright test with a static declaration annotation:

```js
{ annotation: { type: 'testlane-case', description: 'reader-cannot-edit' } }
```

Inside that test, import `runCase` from `./testlane-authoring.mjs` and await:

```text
runCase(testInfo, 'reader-cannot-edit', {
  run: async function containing the real app actions and assertions,
  cleanup: async function deleting only owned data and verifying absence
})
```

The text above describes the helper signature, not an executable passing test. Author real app-specific checks. The `run` callback must throw on a failed expectation; do not return a boolean and assume it is asserted. The optional `cleanup` callback runs through `finally`, including when `run` fails. A required cleanup needs that callback and a verified result. Keep partial-setup ownership information in scope so cleanup can inspect what was created. No callback, unexecuted code, or a static annotation alone establishes the feature.

Every passing case needs at least one observed Playwright `expect` step. Otherwise completed cases with none are blocked with `NO_ASSERTIONS_OBSERVED`; Node-assert-only specs are unsupported in v1. The report records `assertionsObserved`; identity and cleanup assertions may contribute. This count does not prove business-oracle quality or coverage. Implement real feature assertions rather than adding a dummy check for the counter.

Do not use skips, expected-failure declarations, retries or duplicate/missing IDs to obtain a pass. Keep trace, video and automatic screenshots off. The runner fixes workers to one and retries to zero, and checks the case inventory/results; it cannot judge the correctness of the assertions in trusted test code. App-specific exceptions must be replaced with fixed-stage messages before they reach Playwright reporters. Do not attach raw responses, browser/network errors or exported authentication state.

`captureScreenshot(testInfo, page, label)` is available from the same helper only when the plan sets `evidence.screenshots` to `manual` and the user's evidence scope permits it. Use a static label of at most 48 lowercase letters/digits/hyphens, starting with a letter or digit; do not put account/record contents into it. Filenames are random, not derived from the label. Capture only inside an active `runCase`, with at most five screenshots per case. Default is `off`. Screenshots are private, unreviewed binary output, can contain app data or credentials and are not redacted by the harness. No trace/video recording is added by this option.

## Run from source

For the initialized layout, use the source-built CLI from the app directory:

```sh
node /absolute/testlane-source/dist/cli.js verify run --plan e2e/testlane-verification/plan.json --output-dir output/testlane-verification --json
```

Approved global `--profiles`/`--requester` options precede `verify` if needed. Init's `--output-dir` creates a suite; run's option chooses private report output. Both source CLI commands require a source build and are absent from published 0.6.0.

The direct harness is equivalent. For the manual layout above, from the app working directory:

```sh
node /absolute/testlane-source/examples/agent-verification/run.mjs --plan e2e/testlane/verification.plan.json --output-dir output/testlane-verification --json
```

The same Node argv works in PowerShell with a forward-slash Windows source path. Use the existing installed broker; this command does not fetch a CLI, start an embedded model, edit profiles or seed passwords. Start the approved app using its normal project instructions before the run.

Reports use a unique `run-<id>/` output directory. The printed `reportPath` is relative to the selected output root, for example `run-<id>/report.json`. They record static case IDs/status/reason codes, attempts, `assertionsObserved`, cleanup outcomes, plan/spec hashes, helper/harness versions and a relative artifact inventory. Freeform titles/expectations, target URLs, raw test errors and stdout are excluded from the machine report. Keep the plan and authored tests for interpreting those IDs. The artifacts and app-controlled code remain trusted local material; report sanitization is not a security boundary for a hostile test.

## Retained evidence and recovery

`report.json` and the declared manual screenshot inventory under `artifacts/` are retained. Ordinary Playwright output files (`testInfo.outputPath()`) and attachments are temporary with `preserveOutput: "never"`, not a retained evidence channel. Forced termination can leave private temporary/session files; inspect a stopped run before reuse.

If a partial mutation might need manual cleanup, immediately create a minimal journal in a separate ignored app-owned directory with the case/run marker and owned record identifier. Do not use Playwright's temporary output or the harness artifact directory. Keep credentials/raw responses out, keep the journal private, and list it in the handoff. The harness does not ingest or retain arbitrary observation/recovery files.

An optional source-built command renders a readable local summary:

```sh
node /absolute/testlane-source/dist/cli.js verify report --report output/testlane-verification/run-<id>/report.json --plan e2e/testlane-verification/plan.json --json
```

Use the exact unchanged plan. Rendering checks plan/report consistency and retained screenshot hashes, creates `summary.html` beside the JSON without overwriting it, and does not rerun tests/app code. It restores freeform app descriptions from the plan, so keep the summary private with its report/artifacts. Hashes bind these local inputs; they are not signed provenance or proof that the report was never edited.

Check the process status and complete report, including fixture teardown and cleanup. Missing/duplicate/unrun/skipped/expected-failure/retried results cannot be called acceptance. Treat cancellation, failed cleanup or environment/authentication failure as incomplete verification and inspect owned state before another mutating run. Preserve failed runs and report a later run separately if a task-authorized fix changes the outcome.
