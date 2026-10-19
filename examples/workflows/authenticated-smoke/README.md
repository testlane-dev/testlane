# Authenticated smoke workflow

This optional template checks one already approved Testlane profile against a
loopback sandbox or testing application. It proves readiness, the broker's
declared identity, a newly issued browser session, the identity endpoint from
that same session, a visible protected heading, an API response, and anonymous
API denial. A page loading by itself cannot produce a pass.

For an installed package, use the [project setup](../../../docs/project-install.md#run-the-shipped-workflows)
and `testlane workflow smoke` from your app root. This resolves app-local Playwright without
installing dependencies inside Testlane. Direct runner instructions below also support
source/template development.

Install the optional browser package in this directory (or in the copied
workflow package), then install its Chromium browser:

```text
npm install
npx playwright install chromium
```

If Chromium is missing, the run fails with `launch-failed` and prints one hint
line on stderr (`workflow smoke hint: …`) naming the executable Playwright
expected and this install command; on Ubuntu use `npx playwright install
--with-deps chromium`. That line is for you at the terminal and never appears
in the report or the evidence files.

Run from the broker checkout after `npm run build`:

```text
node examples/workflows/authenticated-smoke/run.mjs --manifest examples/workflows/authenticated-smoke/workflow.json --json
```

### Try it against the bundled demo app

No app of your own handy? [`examples/demo-app`](../../demo-app/README.md) is a
throwaway Next.js + next-auth app the broker already knows how to sign into.
Start it in one terminal from the repo root:

```text
npm run demo
```

This seeds a `demo:admin` profile (sandbox, `nextauth-credentials`) among
others. In a second terminal, from the broker checkout after `npm run build`,
create the (already gitignored) `output/` directory so the manifest below
never gets committed by accident, and save this manifest as
`output/demo-app.workflow.json` — a relative path works from the repo root in
both bash and PowerShell:

```text
mkdir -p output                                # bash
New-Item -ItemType Directory -Force output     # PowerShell
```

```json
{
  "schemaVersion": 1,
  "kind": "authenticated-smoke",
  "id": "demo-admin-smoke",
  "profile": "demo:admin",
  "target": { "origin": "http://localhost:3000", "environment": "sandbox" },
  "identity": { "email": "admin@demo.test", "role": "Admin" },
  "checks": {
    "readinessPath": "/api/auth/csrf",
    "identityPath": "/api/me",
    "protectedPath": "/",
    "protectedHeading": "Testlane demo",
    "apiPath": "/api/me"
  },
  "timeoutMs": 30000
}
```

The runner launches the broker CLI as a child process and it inherits this
shell's environment, so that second terminal needs to point at the demo's
throwaway registry and vault first — a fresh terminal has neither set. `npm
run demo` prints the exact paths in its own "try this" block; from the repo
root they are:

```text
export TESTLANE_HOME="$PWD/examples/demo-app/.demo/home" TESTLANE_PROFILES="$PWD/examples/demo-app/.demo/testlane.profiles.json"
```

PowerShell:

```text
$env:TESTLANE_HOME="$PWD\examples\demo-app\.demo\home"; $env:TESTLANE_PROFILES="$PWD\examples\demo-app\.demo\testlane.profiles.json"
```

Then point the runner at the manifest (same command, both shells, since it's
a relative path):

```text
node examples/workflows/authenticated-smoke/run.mjs --manifest output/demo-app.workflow.json --json
```

On headless Linux, the vault above lives in a gnome-keyring unlocked inside a
`dbus-run-session` (see the throwaway-keyring recipe in
[`examples/demo-app/README.md`](../../demo-app/README.md#platform-notes)). A
second terminal does not see that keyring by default, but it can join the same
D-Bus session: whenever `DBUS_SESSION_BUS_ADDRESS` is set, `npm run demo`
prints an `export DBUS_SESSION_BUS_ADDRESS='…'` line in its "try this" block,
and running that line in the second terminal (alongside the
`TESTLANE_HOME`/`TESTLANE_PROFILES` exports above) points it at the same
session. The recipe below keeps everything in a single shell instead and still
works: the app, its readiness wait, and the smoke command all run inside that
one session. `npm run demo` blocks in the foreground, so it runs in the
background and the recipe polls for readiness rather than opening a second
terminal — that poll needs `curl`. Throwaway/headless only — never a
developer's real keyring:

```sh
(
  command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

  # A fresh, empty XDG_DATA_HOME per run, scoped to this subshell only: a
  # reused or shared path can leave a keyring file on disk from an earlier
  # run's daemon (unlocked with a different random password), which fails
  # this run's daemon with "Cannot create an item in a locked collection".
  # mktemp -d (honoring $TMPDIR, /tmp by default) is short enough for
  # gnome-keyring's socket. Wrapping the whole block in ( ... ) keeps this
  # export, and the `exit`s below, from leaking into the shell you paste
  # this into.
  demo_xdg_data_home="$(mktemp -d)"
  export XDG_DATA_HOME="$demo_xdg_data_home"

  dbus-run-session -- bash -c '
    echo -n "$(head -c 24 /dev/urandom | base64)" | gnome-keyring-daemon --unlock --components=secrets

    # setsid puts the demo in its own process group, separate from the shell
    # running this script, so it can be torn down without killing this script.
    setsid npm run demo &
    demo_pid=$!

    # Shared teardown for both the timeout path below and the normal exit
    # path: stop the whole demo process group, wait for npm (demo_pid)
    # itself to be reaped, then poll (bounded, ~10s) until no process
    # remains in that group -- the SIGTERM handler inside demo.mjs stops
    # the detached app.mjs it spawned shortly after, and both callers need
    # that to have actually finished before returning.
    stop_demo() {
      kill -TERM -- "-$demo_pid"
      wait "$demo_pid" 2>/dev/null
      tries=0
      while kill -0 -- "-$demo_pid" 2>/dev/null; do
        tries=$((tries + 1))
        if [ "$tries" -ge 50 ]; then
          break
        fi
        sleep 0.2
      done
    }

    tries=0
    until curl -fsS http://localhost:3000/api/auth/csrf >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "$tries" -ge 120 ]; then
        echo "demo app did not come up" >&2
        stop_demo
        exit 1
      fi
      sleep 1
    done

    export TESTLANE_HOME="$PWD/examples/demo-app/.demo/home" TESTLANE_PROFILES="$PWD/examples/demo-app/.demo/testlane.profiles.json"
    node examples/workflows/authenticated-smoke/run.mjs --manifest output/demo-app.workflow.json --json
    status=$?

    stop_demo
    exit $status
  '
  status=$?

  # Remove only the directory this subshell created above -- never on an
  # empty or unexpected path -- then report the smoke command's exit status,
  # not this cleanup's.
  if [ -n "$XDG_DATA_HOME" ] && [ "$XDG_DATA_HOME" = "$demo_xdg_data_home" ]; then
    rm -rf "$XDG_DATA_HOME"
  fi
  exit "$status"
)
```

A pass exits `0` and prints a report with `"verdict": "passed"` and
`"counts": {"passed": 8, ...}` covering all eight required steps. This is the
same unmodified `run.mjs` the real-broker proof below drives against this
same app; see [`examples/demo-app/README.md`](../../demo-app/README.md#real-broker-workflow-proof)
for that automated version.

The runner resolves the broker CLI to `dist/cli.js` relative to this package.
For an installed or copied template, retain the package's documented broker
layout, including built contracts at `dist/workflows/contracts.js`; providing
`--broker-cli` selects the trusted executable but does not replace those
contracts. The CLI is always launched as `process.execPath` plus an argument
array with `shell:false`. The broker home, profile registry, and approved
session remain the operator's configured ones. The workflow does not accept
profile or home rewrites, store/account/rotate operations, or command strings
from the manifest.

The manifest is deliberately small and contains no secrets. `profile` is the
approved broker profile name; `id` is the workflow identifier. The target must
be sandbox or testing. This first template accepts only loopback targets for
both schemes: `http://localhost`, `http://127.0.0.1`, or `http://[::1]`, and the
corresponding `https://` origins. Non-loopback targets are refused before app
contact, and HTTPS production-labelled hosts are refused. Before any app
request the runner asks `profiles --json`, requires the profile's environment,
exact origin, email, role and `nextauth-credentials` or `form-post` strategy,
and refuses production metadata. It then runs `check --json`, requests a
`storage-state` session to a fresh temporary path, parses it in memory, and
removes that path on every exit.

Browser routes abort requests outside the exact target origin, WebSockets and
event streams; service workers are disabled and page popups are closed.
Readiness and API/identity fetches use manual redirects. Document navigation also
validates the final page and every observed redirect hop before a step can pass,
including a hop that returns to the app. Playwright does not route every server
redirect, so an off-origin target may already have been contacted before rejection.
These checks do not provide network isolation. The identity endpoint must return top-level JSON
`{email, role}` matching the manifest from the issued browser session. The
protected page must show the configured heading, the representative API must
return 2xx, and the anonymous API request must return 401 or 403. It writes no
traces, screenshots, HAR files, page bodies, cookies, broker output, or browser
logs.

Each attempt gets a unique `output/workflow-smoke-<run>.log`, `.exit`, and
`.report.json`. Logs contain step IDs and fixed reason codes only. Exit 0 means
all eight required steps passed and cleanup completed; failed, blocked, and
cancelled runs exit 1 while preserving their evidence. There is no retry.
`sourceTree` is currently always null. `target.actualBuild` is recorded only
when the manifest configures `target.buildId` and the readiness response has an
exact matching `X-Build-Id` header; otherwise it remains null. A configured
build mismatch refuses the run and is never treated as proof of a remote build.

`--self-test` requires Chromium and starts a generated loopback app and an IPC
test-only broker double.
The cookie and account email are generated in memory at runtime, never placed
in argv, environment, fixtures, or logs. This exercises the workflow runner,
real HTTP app, child-process boundary, cleanup, and a real Chromium browser.
The fake broker is intentionally not evidence
that the production broker works; the broker's own tests remain separate.

```text
node examples/workflows/authenticated-smoke/run.mjs --self-test --json
node --test examples/workflows/authenticated-smoke/tests/*.test.mjs
```

The second command (and `tests/` itself) requires a source checkout; not
included in the npm package.

For real-broker evidence, see the smoke real-broker proof: it runs this same
`run.mjs` CLI, unmodified, as a child process against the actual built broker
CLI and an in-process reference app. Requires a source checkout; not
included in the npm package.

```text
npm run proof:smoke-real-broker -- --json
```

It needs a supported platform (Windows via the real DPAPI store, or an
isolated Linux keyring with `TESTLANE_REAL_KEYCHAIN=1`; never macOS) and
blocks (exit 2) rather than silently passing when one is not available.
`TESTLANE_REAL_KEYCHAIN` only gates this proof's own preflight check; it has
no effect on the broker CLI or the store it selects (`TESTLANE_STORE`
controls that). See [`../test-support/README.md`](../test-support/README.md)
for what it does and does not prove.
