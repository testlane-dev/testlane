# Install Testlane in an app project

The npm package is `@testlane/cli`; its executable remains `testlane`.
A project installation pins the broker in your app's lockfile and gives MCP an explicit
local entry point. It requires Node 22 or newer and does not create accounts or seed passwords.
Run these commands as the human from the app repository:

```sh
npm install --save-dev --save-exact @testlane/cli@0.6.0
npx --no-install testlane --version
npx --no-install testlane doctor
```

To try a reviewed release candidate, replace `@testlane/cli@0.6.0` with its absolute tarball path.
Commit `package.json` and the lockfile. Use `npm ci` on another machine. Do not use `npx -y`
or an unpinned downloaded executable in an agent's MCP configuration.

The CLI reference spells commands as `testlane ...`. With this installation, use
`npx --no-install testlane ...`, an approved npm script, or
`node node_modules/@testlane/cli/dist/cli.js ...` from the app root. In PowerShell use `npm.cmd`
and `npx.cmd` if execution policy blocks `.ps1` shims; no policy change is needed.

Create and review the profile using the [existing-app quickstart](quickstart.md), then seed
it in a normal human terminal:

```sh
npx --no-install testlane profiles
npx --no-install testlane store set shop:testing:qa
npx --no-install testlane doctor --check shop:testing:qa
```

Enter the password only at the hidden prompt or over stdin. Do not put it in the registry,
command arguments, environment, package scripts or MCP configuration. Store permissions
and [platform prerequisites](platforms.md) still apply to each machine.

## Point MCP at the pinned installation

Configure `command` as Node and `args` as the **absolute** path to the project's
`node_modules/@testlane/cli/dist/cli.js`, followed by `mcp`. Set the approved absolute registry
path explicitly. On Windows use forward slashes in JSON/TOML paths. If Node is not on the
client's PATH, use its absolute executable path too.

The [Claude Code](INTEGRATION-CLAUDE-CODE.md) and [Codex](INTEGRATION-CODEX.md) guides provide
complete merge examples. Reconnect after changing the lockfile or server configuration.
A local server can deliver a [session file](sessions.md#mcp-managed-local-session-files)
only to consumers sharing its filesystem; a remote browser cannot open that local path.
Shell command approvals remain separate from MCP permissions.

## Run the shipped workflows

Install the tested browser tooling in the **app project**:

```sh
npm install --save-dev --save-exact @playwright/test@1.64.0
npx --no-install playwright install chromium
```

On Ubuntu use `playwright install --with-deps chromium`. Review those OS dependency
changes as the human. The [compatibility matrix](compatibility.md) records tested scope.

Copy a shipped manifest into a reviewed project file, then adapt its profile, identity,
origin and routes to your app. The templates are examples, not working app configuration:

```sh
npx --no-install testlane workflow smoke --manifest ./testing/smoke.json --json
npx --no-install testlane workflow feature --manifest ./testing/feature.json --receipt ./testing/environment.json --json
```

Start from `node_modules/@testlane/cli/examples/workflows/authenticated-smoke/workflow.json`
or `feature-acceptance/workflow.json`. Both runners currently accept loopback targets only.
Feature acceptance requires a trusted, fresh environment receipt and permission to create,
update and delete a disposable record. Read the [workflow contracts](workflows/README.md)
before running it. Do not invent a receipt for a shared or production data set.

The commands invoke only the shipped runner and its installed broker CLI. They resolve
`playwright` or `@playwright/test` from the app's dependencies, without running npm or
changing the installed Testlane package. Source/template invocation can still fall back
to the template's own optional dependency. If both packages are installed in the app,
`playwright` takes precedence; keep their versions aligned. A resolved dependency does
not prove its Chromium build is installed.

Reports/evidence go to `output/` under the app working directory, or `--output-dir`.
`--json` prints the versioned report and exit 0 requires a passed verdict. Manifest/receipt
paths are data arguments, never shell command strings; no `--broker-cli` override is
exposed by these commands. Known browser debug environment hooks are cleared by this
wrapper. Registry, origin, production, TTL and report-verdict checks still apply.

Ctrl+C/SIGTERM requests cooperative runner cleanup over a fixed IPC channel, including
on Windows. If a runner becomes unresponsive, the wrapper allows up to 75 seconds for
feature cleanup or 135 seconds for smoke cleanup before an emergency stop. A forced
stop can leave disposable app records or session files; inspect the app before retrying.
