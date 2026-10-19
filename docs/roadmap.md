# Testlane development priorities

Testlane focuses on developers who use coding agents to build applications with
roles, approvals and persistent business data. The goal is to turn a feature brief
into tests the team can inspect, rerun and keep with its application. The existing
coding agent authors the tests; Testlane supplies authentication, execution and
evidence tied to the reviewed inputs.

The public verification preview is **0.7.0-beta.2**. The work below describes the
development direction; it does not add capabilities to that published package.
Current platform evidence is recorded in [compatibility.md](compatibility.md).

## What we are building around

- **Ordinary test code.** Keep business checks in the application's Playwright
  suite. A developer should be able to review how a total is calculated, which
  fields must remain unchanged after a denial, and how test records are removed.
- **A complete workflow.** Check identity, browser behavior, saved state,
  authorization, repeated actions and cleanup together. A visible success message
  alone is insufficient for an approval or payment workflow.
- **Explicit execution evidence.** Reconcile every reviewed case with its actual
  outcome. Missing cases, skips, expected failures, retries and unconfirmed cleanup
  must not turn into passing acceptance. Source hashes identify the inputs; they
  do not establish that arbitrary reports are authentic or that assertions are good.
- **Local control.** Run the broker and tests on infrastructure the developer
  controls, with dedicated test accounts. No additional Testlane account or hosted
  execution service is required. The coding agent and application still have their
  own costs and data policies.

These are architectural choices, not a claim that other testing tools lack local
execution, MCP support or definitions stored in Git. For example, Autosana documents
[local testing](https://docs.autosana.ai/local-testing),
[MCP integration](https://docs.autosana.ai/mcp-setup) and
[code-managed flows](https://docs.autosana.ai/code-managed-flows).

## First milestone in development

| Work | Completion criteria |
| --- | --- |
| A reproducible approval example | A fresh consumer runs the installed package against a public, generic app. The same reviewed tests pass, detect an injected one-cent defect, then pass after correction. Every run leaves zero owned records. |
| Actionable failure diagnostics | Fixed failure categories and next steps identify the failed phase without retaining raw error messages, session values, response bodies or console output. Existing reports remain readable. |
| An installed-package acceptance gate | Release preparation exercises `verify init`, draft refusal, `verify run` and `verify report` against the exact candidate tarball, a real browser and a native credential store. A failed or omitted case prevents release. |

The example is a repeatable test of the packaged workflow, not evidence that an
agent can design correct tests for every unfamiliar application. Independent
agent-authoring trials remain a separate acceptance requirement.

## Native mobile track

Experimental Android emulator and iOS Simulator proofs are in development; general
Android and iOS support remain planned. Mobile web viewports and native app execution
are different capabilities; the current verification runner uses Playwright and
does not drive native applications. See the [mobile support proposal](mobile-testing.md)
for the first proof, runner evaluation and release requirements. The
[Android recipe](../examples/android-verification/README.md) describes the synthetic
Expo build, native cases, credential path and limits separately from published support.
The [iOS recipe](../examples/ios-verification/README.md) adds a separate Simulator
Release build without Apple signing credentials and an opt-in ephemeral hosted
macOS proof. The linker may add an ad-hoc signature without a Developer identity
or team; this is not a device or App Store build. Its actual build, native
case outcomes and cleanup must be verified before recording iOS acceptance.

The first mobile milestone targets React Native/Expo and should complete the same
approval workflow in an Android emulator and independently in an iOS Simulator on a Mac.
Tests must include backend state, role denial and verified cleanup.

## Following priorities

1. **Reduce time to a useful first run.** Add verification readiness checks for the
   project, browser, reviewed target, approved profiles and cleanup prerequisites.
   Report what a human must fix without editing accounts, profiles or permissions.
2. **Make CI adoption repeatable.** Publish a complete trusted-branch recipe with
   native-store setup, app readiness, job cancellation and private artifact retention.
   Untrusted fork code must never receive credentials from a privileged job.
3. **Expand reusable business checks.** Add app-neutral patterns for role changes,
   money and quantity calculations, duplicate submissions, cancellation and recovery
   of test-owned records after a failed creation assertion.
4. **Compare runs without weakening tests.** Identify changes to the plan, specs,
   application build and case outcomes. Repairs must be reviewed; changing an
   expected result to make a failure disappear is not acceptance.
5. **Improve evidence deliberately.** Keep private screenshots opt-in and make
   artifact review and retention explicit. Raw trace, video, device logs and network
   payload capture need a separate privacy design before becoming defaults.

Hosted execution, team dashboards and device fleets follow demonstrated demand for
the underlying workflow. They should preserve the ability to run the same tests
locally and export the team's own source and evidence.

## How we will assess usefulness

Use small real-app trials before widening support claims. Measure time from completed
human account setup to the first useful run, defects detected by unchanged tests,
cleanup failures, setup interventions and repeatability from a fresh installation.
Record incomplete and failed trials alongside successful ones. A target for onboarding
is a useful first run within 15 minutes after account setup; this is a goal, not a
measured result.

Feedback is most useful when it names the application framework, authentication
strategy, intended workflow and first blocked step. Share a minimal synthetic
reproduction through [GitHub issues](https://github.com/testlane-dev/testlane/issues);
report credentials or security findings through [SECURITY.md](../SECURITY.md).
