# From a feature brief to authenticated verification

Give your coding agent the feature description and the app repository. The `testlane-verify` skill helps it inspect the app, design concrete acceptance cases, write app-specific Playwright tests and run them with Testlane sessions. The report links each planned case to execution and cleanup evidence.

This guide targets the opt-in **`@testlane/cli@0.7.0-beta.1` verification preview**. Install a reviewed beta tarball below, or the exact npm version when available. Its intended npm dist-tag is `next`; stable `latest` remains `0.6.0`, whose CLI has no `verify` commands. The preview package bundles the broker, skill, fixture and harness; no source clone is needed. No embedded model, API service or new API key is involved: your coding agent does the design and test authoring.

## Start with the app and existing authentication

The app needs Node 22+, its own installed Playwright Test, a running non-production target, and reviewed, human-seeded Testlane profiles bound to that exact origin. Complete the human account/profile/store setup in the [existing-app quickstart](quickstart.md) first. The [project-local installation guide](project-install.md) explains the broker configuration; its stable package pin does not include verification. Use the project's package manager and lockfile.

Use the versioned artifact and manifest from the [0.7.0-beta.1 preview release](https://github.com/testlane-dev/testlane/releases/tag/v0.7.0-beta.1) when available. From the **app repository**, install the reviewed tarball by its actual absolute path:

```sh
npm install --save-dev --save-exact /absolute/artifacts/testlane-cli-0.7.0-beta.1.tgz @playwright/test@1.64.0
npx --no-install playwright install chromium
npx --no-install testlane --version
npx --no-install testlane doctor
```

When that exact preview version is available on npm, its equivalent package install is:

```sh
npm install --save-dev --save-exact @testlane/cli@0.7.0-beta.1 @playwright/test@1.64.0
```

Use the exact version rather than a moving dist-tag. For Windows tarballs use a quoted forward-slash path, such as `'C:/artifacts/testlane-cli-0.7.0-beta.1.tgz'`. If PowerShell blocks `npm.ps1`/`npx.ps1`, use `npm.cmd`/`npx.cmd`; the direct Node commands below need no script-policy change.

Preserve an existing Playwright installation/configuration; inspect version differences rather than silently replacing it. Linux may need reviewed OS dependencies. Store access must be available in the same machine/session. The workflow does not create accounts, provision a test database or seed passwords. Do not send credentials through the feature brief.

The installed `verify init` command below copies its bundled fixture/helper into a new app-owned suite. For an existing suite, copy `node_modules/@testlane/cli/examples/playwright/fixtures.mjs` into an app-owned test folder, such as `e2e/testlane/`, or reuse your reviewed copy. It exports `createTestlaneTest` and `expect`. Configure it with the absolute project-local `node_modules/@testlane/cli/dist/cli.js` path, exact origin and distinct profile arrays. The [fixture guide](../examples/playwright/README.md) covers cookie flow support and lifecycle limits. Use its `testlane.open(role)` page/context, not Playwright's unrelated default fixtures.

## Install the skill in the app repository

Copy the complete installed folder `node_modules/@testlane/cli/skills/testlane-verify/`, including `references/`, into one of these project locations. The examples refuse an existing destination; inspect and deliberately merge an existing skill instead of replacing it.

| Agent | Project location | Explicit invocation |
| --- | --- | --- |
| Codex | `.agents/skills/testlane-verify/SKILL.md` | `$testlane-verify` |
| Claude Code | `.claude/skills/testlane-verify/SKILL.md` | `/testlane-verify` |

For example, from the app repository in Bash, choosing Codex:

```sh
(
  set -eu
  skill_source=node_modules/@testlane/cli/skills/testlane-verify
  skill_destination=.agents/skills/testlane-verify
  if [ -e "$skill_destination" ] || [ -L "$skill_destination" ]; then
    printf '%s\n' 'Skill destination already exists; inspect it before updating.' >&2
    exit 1
  fi
  mkdir -p .agents/skills
  cp -R "$skill_source" "$skill_destination"
)
```

Or in PowerShell:

```powershell
$skillSource = 'node_modules/@testlane/cli/skills/testlane-verify'
$skillDestination = '.agents/skills/testlane-verify'
if (Get-Item -LiteralPath $skillDestination -Force -ErrorAction SilentlyContinue) {
    throw 'Skill destination already exists; inspect it before updating.'
}
New-Item -ItemType Directory -Force .agents/skills -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skillDestination -Recurse -ErrorAction Stop
```

For Claude Code use `.claude/skills` in place of `.agents/skills`. The skill keeps the standard `name` and `description` frontmatter; it does not preapprove tools or change the client's permissions. See current [Codex guidance](https://learn.chatgpt.com/guides/best-practices#turn-repeatable-work-into-skills) and [Claude Code skill documentation](https://code.claude.com/docs/en/skills) for discovery/reloading in your client. These installation mechanics are not a claim of completed end-to-end client certification.

## Give the agent a useful brief

Describe expected behavior, not an already-selected list of canned checks. Include the target and existing profile mapping if the agent cannot discover them from reviewed project instructions. State what disposable changes are allowed and whether local screenshots are wanted.

> Use `$testlane-verify` for the feature I just changed in this repository. Writers can publish a draft note. Readers can view published notes but cannot edit or publish them. Anonymous users cannot read the notes API. Use our running local app, existing writer/reader profiles and project-local Testlane preview. You may create and delete notes owned by this run in the sandbox. Check browser behavior and API state, clean up even on failure, and return the plan and report. Do not retain screenshots.

Replace the sample behavior with your feature. The agent should inspect the actual app's code, tests and launch guidance to find routes and selectors, then propose case IDs with concrete oracles and cleanup obligations. A natural-language brief does not grant permission to change a production database, create accounts or alter the credential registry.

The agent records a reviewable plan and writes real tests. A plan marked `reviewed` means the agent checked coverage against the brief within existing authorization; it is not an extra mandatory human approval step. It asks for missing scope only when the expected behavior, target, role mapping or permitted mutation cannot be determined. Independent read-only work can continue meanwhile.

## Scaffold, design, then run

From the **app repository**, save the requested feature brief as a nonempty UTF-8 file in an ignored local location. This example assumes `output/` is already ignored; choose a reviewed private location if it is not. Use the installed CLI to initialize a new suite:

```sh
npx --no-install testlane verify init --brief output/feature-brief.md --target http://127.0.0.1:3000 --profile notes:testing:writer --environment testing --output-dir e2e/testlane-verification --json
```

`--brief`, `--target` and `--profile` are required. `--environment` defaults to `testing` and accepts `local`, `testing`, `sandbox` or `preview`. Init's `--output-dir` chooses a **new app-local suite directory**; the default is `e2e/testlane-verification`. It refuses existing directories and does not replace your suite. It performs no network/authentication, account, registry or vault changes.

Init writes `plan.json` with status `draft`, a private ignored `brief.md`, the copied fixture/helper, `test.mjs`, and an **intentionally skipped** `feature.spec.mjs`. Its suite-local `.gitattributes` pins `testlane-authoring.mjs text eol=lf`; preserve that rule so Windows Git checkout does not change the bound helper bytes. It maps the selected existing profile to the initial role alias `qa`. Your agent inspects the app, replaces that scaffold with actual assertions, and adapts role aliases to the existing profiles when the brief needs more than one role. Changing app test configuration does not create or seed those profiles.

The skipped scaffold is not a passing example. The harness refuses draft/incomplete coverage; changing only `status` or removing the skip does not design the feature checks. Review case IDs, actual expected behavior and cleanup together, then have the agent mark the plan `reviewed` within the task's existing scope.

Run from the app repository:

```sh
npx --no-install testlane verify run --plan e2e/testlane-verification/plan.json --output-dir output/testlane-verification --json
```

Run's `--output-dir` chooses a **private report destination**, not a suite location. Keep it ignored. Approved global `--profiles` and `--requester` options go before `verify` when needed.

`verify run` invokes the package's bundled harness. It does not contain a model or translate the brief into tests by itself. The coding agent supplies that work through the skill.

For a readable local result, use the reported `reportPath` under your chosen output directory:

```sh
npx --no-install testlane verify report --report output/testlane-verification/run-<id>/report.json --plan e2e/testlane-verification/plan.json --json
```

This creates `summary.html` beside the JSON without replacing an existing file. It checks the exact plan hash and retained screenshot hashes, then shows case expectations, outcomes, cleanup and evidence links. Keep the HTML with its report and artifact directory. The summary restores titles and expected behavior from the exact plan, so it contains private app context even though the machine report omits those freeform values. It does not rerun tests or execute app code. These local files are not signed attestations or automatically publishable evidence.

For a portable direct invocation in Bash or PowerShell, replace `npx --no-install testlane` in any command above with `node ./node_modules/@testlane/cli/dist/cli.js`. For example:

```sh
node ./node_modules/@testlane/cli/dist/cli.js verify run --plan e2e/testlane-verification/plan.json --output-dir output/testlane-verification --json
```

## Optional: build from source

For harness development, use a reviewed checkout containing this guide. From that checkout run:

```sh
npm ci
npm run build
```

Then, from the app repository, substitute `node /absolute/testlane-source/dist/cli.js` for `npx --no-install testlane` in the init/run/report commands. Copy the skill from that checkout's `skills/testlane-verify/` instead of the installed folder. Use a forward-slash Windows path in PowerShell. The source CLI uses the same plan/helper/report contract; initialized `test.mjs` still resolves the app's installed `@testlane/cli` broker. Keep that app dependency pinned and refresh copied helpers verbatim from the runner version you use.

## What a useful result establishes

Feature verification needs an assertion about the changed business behavior, beyond successful sign-in or a rendered heading. Depending on the brief, the agent should connect UI actions to API/persistence readback, exercise the relevant anonymous/alternate-role denial, and prove that rejected mutations leave state unchanged. The tests own those assertions; the broker and report cannot determine whether they are sufficient.

Use a run-owned record identifier and a narrowly scoped cleanup operation. Verify absence after deletion. Authentication files are removed by the fixture after context load, and contexts close in teardown; application records still need their own cleanup. File deletion does not revoke the application's session. If cancellation, expiry or a failed setup may have left a record, inspect it before replaying a mutation.

The harness runs only the planned specs, with one worker, no retries and recording off. Planned cases must have matching test annotations and complete helper results. Skipped, missing, duplicated, expected-failure or retried cases cannot produce a passing acceptance report. Preserve a failed run when fixing an app or test and produce a separate new run; do not relabel it after a later pass.

Read the [harness contract](../skills/testlane-verify/references/harness.md) for the exact plan, annotation, helper and runner commands. The [case-design reference](../skills/testlane-verify/references/case-design.md) explains how to map a brief to app-specific assertions. These are local trusted-code workflows: a generated test is executable project code and needs normal review; the harness is not a security sandbox or proof of a safe environment.

## Evidence and limits

Reports use static case IDs, statuses, reason codes, cleanup outcomes and file hashes rather than raw Playwright errors, stdout, response bodies, headers or session values. Read the final report and process exit status, including fixture teardown, before calling the feature verified. Report shape and completeness are checkable; assertion quality remains the agent's and reviewer's responsibility.

When available, a failed case's `failureLocation` gives only the line/column of its first failed Playwright `expect` in the exact planned spec. Match its `specId` and SHA-256 to the unchanged source before investigating. A missing/null location provides no error detail; raw messages, paths and app values are not included. An observed failed expect still prevents a pass if the test catches its exception.

The retained run output is `report.json` plus any approved manual screenshots under `artifacts/`; `verify report` can additionally create `summary.html`. Playwright's ordinary `testInfo.outputPath()` files and attachments are temporary, configured with `preserveOutput: "never"`. They are not a retained evidence channel. A forced termination can leave private temporary files or live sessions; stop the run and inspect them before reuse rather than assuming cleanup completed.

For interruption recovery, write a minimal create-only journal in a **separate ignored app-owned directory** as soon as a mutation returns its owned record ID. Include only the case/run marker and identifier needed for scoped cleanup, not credentials, cookies or response dumps. Do not place it in Playwright's temporary output or the harness artifact directory. Keep it private, list its path in the handoff, and record verified deletion separately. The harness does not ingest, validate or retain that app journal for you.

Every passing case needs at least one observed Playwright `expect` step, recorded as `assertionsObserved`. An otherwise completed case with none is blocked as `NO_ASSERTIONS_OBSERVED`; Node-assert-only specs are unsupported in v1. Identity and cleanup assertions can contribute to the count. The count proves neither business-oracle quality nor coverage; the agent must still implement the brief's meaningful feature assertions.

Trace, video and automatic screenshots remain off. Set manual screenshots only when the user's evidence scope permits them, using `captureScreenshot(testInfo, page, label)` inside `runCase`. Labels use lowercase letters, digits and hyphens, start with an alphanumeric character and have at most 48 characters; generated filenames remain random. Screenshots can contain app data and live credential material; they are not redacted by this workflow. Keep output local and ignored, review it before sharing, and do not upload or commit it automatically. A report listing an artifact does not make it safe to publish.

The fixture supports approved cookie profiles and requires the browser to share the broker filesystem. It does not add generic SSO/MFA, token-header, browser-storage or remote-browser support. Profile environment labels and declared production-host refusal cannot discover an undeclared production app. Contexts separate cookies, not shared records or concurrent invocations. See [compatibility](compatibility.md), [session lifetime](sessions.md#lifetime-and-cleanup) and the [threat model](threat-model.md).

A pass is evidence for the cases you designed and ran. It is not an independent security audit, a general authorization proof or certification of every coding-agent client.
