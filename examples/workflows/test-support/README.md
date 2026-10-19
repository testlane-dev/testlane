# @testlane/workflow-test-support

Shared, dependency-free fixtures for the `examples/workflows/**` runners
(`authenticated-smoke` today, `feature-acceptance` next): an in-process
reference sandbox app with two roles, a test-only broker double, a harness
for the real built broker CLI, a receipt issuer, and a real-broker smoke
proof. Node built-ins only, `"type": "module"`, no dependencies.

## Files

- `reference-app.mjs` -- an in-process `node:http` sandbox app (`Writer` /
  `Reader` roles, session cookies, a small records API) with a `faults` knob
  that forces each failure mode the workflow runners are meant to catch. It
  binds `127.0.0.1` on an ephemeral port, never logs anything, and bounds
  request bodies and timeouts. Generated passwords and session tokens live
  only in memory.
- `broker-double.mjs` -- a test-only IPC child (`fork` + `{type:'config'}`)
  that stands in for the real `testlane` CLI's `profiles` / `check` /
  `session --format storage-state` commands, the same pattern as
  `authenticated-smoke/fake-broker.mjs`. Session cookies travel only over the
  private IPC channel. This is **not** evidence that the real broker works.
- `real-broker.mjs` -- the harness that drives the actual built broker CLI
  (`dist/cli.js`) inside a throwaway scratch `TESTLANE_HOME`, on the one or
  two platforms where that scratch home actually isolates the OS keychain
  (`realBrokerSupport()`).
- `receipt.mjs` -- issues a `test-environment-receipt` JSON file the way a
  trusted CI setup step would, create-only.
- `smoke-real-broker-proof.mjs` -- runs the **unmodified**
  `examples/workflows/authenticated-smoke/run.mjs` CLI against a real
  reference app and the real broker CLI, for three cases (`happy`,
  `wrong-secret`, `production-host`). See "Known interface discrepancy" below.
- `index.mjs` -- re-exports everything above.

## Running the tests

```text
node --test tests/*.test.mjs
```

Dependency-free: no browser, no real broker. Point `TESTLANE_HOME` /
`AGENT_AUTH_HOME` at a scratch directory first if your shell has either set
(none of these tests touch a real vault, but it costs nothing to be sure):

```text
TESTLANE_HOME=/tmp/testlane-test-support-scratch node --test tests/*.test.mjs
```

## Running the real-broker smoke proof

```text
npm --prefix ../authenticated-smoke install --no-audit --no-fund
npx --prefix ../authenticated-smoke playwright install chromium
node smoke-real-broker-proof.mjs --json
```

Requires: a supported platform (`realBrokerSupport()` -- Windows via DPAPI
always, Linux via secret-service only with `TESTLANE_REAL_KEYCHAIN=1` and
`secret-tool` on PATH, never macOS), the broker already built
(`dist/cli.js`, `dist/workflows/contracts.js`), and Playwright + Chromium
installed in `examples/workflows/authenticated-smoke` -- this package (`test-support`)
is dependency-free, but that sibling install is its own, separate step; only the
Chromium *browser download* is effectively shared once fetched. A missing
prerequisite makes the proof **block** (exit 2), never silently pass or skip.

Exit codes: `0` every case met its expectation, `1` any case failed, `2`
blocked. Evidence (a summary `.json`, a short `.log`, and the numeric
`.exit`) is written create-only to `--output-dir` (default `./output`), one
uniquely-named set per invocation. Each of the three cases also leaves behind
the smoke runner's own `workflow-smoke-<runId>.{log,exit,report.json}`
evidence inside that case's disposable scratch harness directory (not this
package's `output/`); the proof summary names those files and folds their
content into its own leak checks, but does not relocate them.

Nothing about a secret or a session token is ever printed or compared as a
string: every leak check in the proof and in the tests is a boolean
(`text.includes(needle) === false`), never an equality on a value that could
itself be secret.

## Known interface discrepancy: `production-host`

The `production-host` case is supposed to prove that the workflow runner's
own client-side production check (`PRODUCTION_REFUSED` in
`authenticated-smoke/runtime.mjs`) refuses a target whose loopback host is
also declared, elsewhere in the registry, as a `production` profile.

Against the **real** broker this is unreachable as specified. The registry
loader itself (`src/profiles.ts`'s `productionOverlapIssues`) refuses to load
*any* registry that mixes a `production`-tagged profile with a non-production
profile on the same hostname (compared by hostname only; the port is
ignored) -- and that is exactly the configuration this case needs. That
refusal fires at registry-load time, before `profiles --json` can return
anything, which is earlier than, and instead of, the workflow runner's own
check. Since the runner's check requires that identical hostname collision to
ever fire, and the registry loader always intercepts that same collision
first, there is no valid, loadable registry that reaches the runner's
`PRODUCTION_REFUSED` path with a loopback target.

The safety property the case cares about still holds end to end: the run
still exits `1` with a `failed` verdict, the `profile-policy` step still
fails, and the reference app still sees zero requests (seeding is skipped
too, since `store set` would fail against the same unloadable registry). The
proof asserts exactly that, real, observed behaviour -- a `profile-policy`
failure with reasonCode `process-failed` -- rather than asserting the
`production-refused` reasonCode, which is not reachable here. See the
module-level comment in `smoke-real-broker-proof.mjs` for the full
explanation, and `assertions.profilePolicyFailed` (not a specific reasonCode)
in that case's result.
