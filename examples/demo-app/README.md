# Testlane: five-minute demo

A tiny Next.js app (App Router, next-auth v4 credentials provider, JWT
sessions, no database) plus a script that wires it to the broker with
throwaway secrets. Nothing external: no database, no cloud. The demo keeps its
own `TESTLANE_HOME` under `.demo/`, so your real `~/.testlane` registry and
audit log are not used. **The stored secrets are only isolated on Windows:** on
macOS and Linux the demo's two throwaway passwords go into your real login
Keychain / Secret Service, and `npm run clean` deletes them (see
[Where the secrets go](#where-the-secrets-go-and-cleaning-up)).

It shows the three things the broker does:

| | Command | What you see |
|---|---|---|
| Sign in for a tool | `testlane session demo:admin` | a live session cookie for `admin@demo.test`; the password stays in the vault |
| Sign in a browser pane | `testlane handoff demo:handoff:qa` | a one-time URL (60 s, single use); opening it signs the browser in as `qa@demo.test` |
| Refuse production | `testlane session demo:production` | refused, exit code 2, no override |

## Run it

From the repo root (Node 22+):

```sh
npm run demo
```

First run installs the demo app's dependencies (and the broker's, if missing).
Then the script:

1. generates throwaway `NEXTAUTH_SECRET`, `AGENT_HANDOFF_SECRET` and two user
   passwords in memory (never printed, written to a file, or placed in an
   environment variable; step 3 stores two of them in the vault);
2. writes `.demo/testlane.profiles.json` with three profiles:
   `demo:admin` (sandbox, `nextauth-credentials`, admin@demo.test, Admin),
   `demo:handoff:qa` (sandbox, `app-handoff`, qa@demo.test, QA) and
   `demo:production` (production, https://demo.example, listed only to be refused);
3. seeds the vault by piping the admin password and the handoff secret into
   `testlane store set` over stdin, with `TESTLANE_HOME=.demo/home`. On Windows
   that is also where the vault is; on macOS and Linux the two secrets go
   into your own Keychain / Secret Service
   ([details](#where-the-secrets-go-and-cleaning-up));
4. starts the app on http://localhost:3000 using a custom Next bootstrap that
   receives the generated configuration once over stdin. It sets
   `AGENT_HANDOFF_ENABLED=true` and `AGENT_HANDOFF_ENV=local` for the app it
   starts: the handoff route is off without both (see
   [the route gate](#the-handoff-route-is-off-unless-marked-non-production));
5. prints a "try this" block with a one-line PowerShell and bash setup
   (`TESTLANE_HOME`, `TESTLANE_PROFILES` and a `testlane` alias for the
   repo's CLI, plus `DBUS_SESSION_BUS_ADDRESS` whenever it is set, so a second
   terminal can use the same keyring session) followed by the commands below.

Ctrl+C stops the app. On macOS and Linux the demo's secrets stay in your
keychain until you run `npm run clean`.

Port 3000 busy? The script refuses to start and says so. Pick another port:

```sh
DEMO_PORT=3020 npm run demo              # bash
$env:DEMO_PORT='3020'; npm run demo      # PowerShell
```

## Try this

In a second terminal, paste the setup line the script printed (including its
`export DBUS_SESSION_BUS_ADDRESS=...` line, when there is one), then:

```sh
testlane check demo:admin
testlane session demo:admin --format curl --out .demo/jar.txt
curl -b .demo/jar.txt http://localhost:3000/api/me     # PowerShell: curl.exe
testlane handoff demo:handoff:qa                     # open the url in any browser; open it twice: 404
testlane session demo:production                     # refused, exit 2
testlane status
testlane audit
```

The app itself: `/` shows "Signed in as &lt;email&gt; (&lt;role&gt;)" or redirects to
`/login`; `/api/me` returns `{ email, role }`. Humans can sign in at `/login`
with the generated passwords retained only by the running app and broker.

## Where the secrets go, and cleaning up

`TESTLANE_HOME=.demo/home` isolates the broker's own files (audit log,
overrides). It does **not** move the secret store, which is chosen by platform:

| Platform | Where `store set` puts `demo:admin` and `demo:handoff:qa` |
|---|---|
| Windows | DPAPI files under `.demo/home/store`: isolated from your real vault |
| macOS | your **login Keychain**: generic passwords, service `agent-auth`, accounts `agent-auth/demo:admin` and `agent-auth/demo:handoff:qa` |
| Linux | your **Secret Service keyring** (through `secret-tool`): attributes `service=agent-auth`, `key=agent-auth/demo:admin` and `key=agent-auth/demo:handoff:qa` |

So on macOS and Linux the demo writes to the same store, under the same service
name, as your real Testlane secrets. The values are random passwords generated
at run time, and the app that knows them is gone after Ctrl+C, so a leftover
entry is useless but still a real item in your keychain. If you have real
profiles named `demo:admin` or `demo:handoff:qa`, do not run the demo or the
clean-up: both would overwrite or delete their secrets.

Clean up when you are done (macOS, Linux and Windows alike):

```sh
npm --prefix examples/demo-app run clean     # from the repo root; or `npm run clean` here
```

It runs the built CLI's `store delete` for `demo:admin` and `demo:handoff:qa`
(even when `.demo/` is already gone), then removes `.demo/`. It exits 1, and
says so, if an entry could not be deleted, for example because the keyring is
locked: unlock it and run it again. `npm run smoke` and the workflow proof
delete the entries they seed when they finish; after an interrupted run, use
`npm run clean`.

## The handoff route is off unless marked non-production

People copy `app/api/auth/agent-handoff/route.js` into their own apps, so its
gate fails closed (`lib/handoff-gate.js`, unit-tested in
`tests/demo-handoff-gate.test.ts`). The route answers 404 unless **all** hold:

- `AGENT_HANDOFF_ENABLED=true`;
- `AGENT_HANDOFF_ENV` is exactly one of `local`, `sandbox`, `testing`,
  `preview`. An unset, empty or unknown value (including `production` and
  `prod`) keeps it off, so a host that sets no platform variable at all (Fly,
  Render, Kubernetes, a VM) cannot open it by accident;
- `VERCEL_ENV` is not `production` and the deployment branch is not the
  release branch (extra denies, never allows);
- `AGENT_HANDOFF_SECRET` is 32+ characters.

`npm run demo` sets the first two itself (`AGENT_HANDOFF_ENV=local`). In your own
app, set `AGENT_HANDOFF_ENABLED=true` and `AGENT_HANDOFF_ENV=sandbox` (or
another allowed value) only in the sandbox deployment's environment, and never
in production. See [docs/HANDOFF-ROUTE-CONTRACT.md](../../docs/HANDOFF-ROUTE-CONTRACT.md).

## Point a Claude Code session at it

1. Start the demo (`npm run demo`).
2. Start Claude Code with the demo's vault and registry in its environment, for
   example from `examples/demo-app` (bash):

   ```sh
   TESTLANE_HOME="$PWD/.demo/home" TESTLANE_PROFILES="$PWD/.demo/testlane.profiles.json" claude
   ```

   PowerShell: set `$env:TESTLANE_HOME` and `$env:TESTLANE_PROFILES` as in
   the printed setup line, then run `claude`.
3. Give it the broker: copy [`../claude-code/settings.json`](../claude-code/settings.json)
   to `.claude/settings.json` (it allows `session`, `check`, `handoff`, `status`,
   `audit`; it denies `store set`, `rotate`, `--profiles` and `--force`, so the
   agent can use sessions but never write secrets) and, for the MCP tools,
   [`../claude-code/mcp.json`](../claude-code/mcp.json) as `.mcp.json`. Both
   assume `testlane` is on PATH (`npm link` at the repo root, or the published
   package); otherwise swap in `node <repo>/dist/cli.js`.
4. Ask: "Sign in as demo:admin and fetch http://localhost:3000/api/me", or
   "Open the app in your browser as demo:handoff:qa". The agent never sees a
   password; `testlane audit` shows every request it made.

## Checking a real coding agent against this demo

Ran a real Claude Code (or Codex) session against this app and want to know if it actually
worked, not just whether it exited 0? See
[the agent acceptance procedure](../../docs/verification/agent-acceptance.md)
for the task prompt, the deny probes, and `npm run agent-check` (`scripts/agent-check.mjs`), the
read-only verifier that judges the run by its Playwright evidence and audit log, not its exit code.

## What is in here

| Path | What |
|---|---|
| `app/api/auth/[...nextauth]/route.js`, `lib/auth.js` | next-auth v4: credentials provider, JWT sessions, role claim; the shape the `nextauth-credentials` strategy expects |
| `lib/users.js` | two in-memory users, scrypt hashes computed at startup from the generated passwords |
| `app/api/auth/agent-handoff/route.js` | the handoff route from [docs/HANDOFF-ROUTE-CONTRACT.md](../../docs/HANDOFF-ROUTE-CONTRACT.md): fail-closed env gate (`AGENT_HANDOFF_ENABLED=true` and `AGENT_HANDOFF_ENV` one of `local`, `sandbox`, `testing`, `preview`; not `VERCEL_ENV=production`; not the release branch; secret of 32+ chars), verify, burn the nonce, mint the next-auth JWT with `encode` and the same claims as a password login, set the (secure-prefixed on https) session cookie, `302 /`; a bare 404 for every failure and for HEAD |
| `lib/handoff-gate.js` | `handoffEnabled(env)`: the pure environment gate the route calls (see [the route gate](#the-handoff-route-is-off-unless-marked-non-production)) |
| `lib/handoff-verify.js` | a copy of the broker's reference `verifyHandoffCode` and `MemoryNonceStore` (the demo does not import the broker's `src/`) |
| `lib/profiles.js` | resolves a handoff profile to its account email (must be `app-handoff`, not production) |
| `scripts/demo.mjs` | `npm run demo` |
| `scripts/smoke.mjs` | `npm run smoke`: the whole flow headless, exit 0 only if every step passes |
| `scripts/clean.mjs` | `npm run clean`: `store delete` the demo's two stored secrets (your keychain on macOS and Linux), then remove `.demo/` |
| `scripts/agent-check.mjs` | `npm run agent-check`: read-only PASS/FAIL verifier for a real-agent run against this app; see [the real-agent acceptance check](../../docs/verification/agent-acceptance.md) |

## Demo shortcuts a real app must not take

- **Nonces are in memory.** A replay is refused only while this process lives.
  A real app persists them (an `AgentHandoffNonce` table, nonce as primary key,
  the insert is the burn) so every instance and every restart agrees.
- **The audit row is a console line.** A real app writes an `ActivityLog` row
  (`auth.agent_handoff`) in the same transaction as the nonce insert.
- **Users are in memory**, and the profile registry is read from
  `DEMO_PROFILES_FILE` because the demo generates it per run. A real app reads
  its committed `testlane.profiles.json` and its own user table.
- **Session lifetime.** The handoff JWT is minted with the profile's
  `ttlMinutes`, but next-auth v4 re-issues the JWT with its own `maxAge` when
  `/api/auth/session` is read; add a hard cap in the `jwt` callback if you
  need one.

## Smoke test

```sh
npm --prefix examples/demo-app run smoke     # from the repo root
```

It starts its own copy of the app (state in `.demo/smoke/`, build in
`.next-smoke/`), seeds a vault, and checks: `check` ok; `session --format
cookie` works against `/api/me`; `handoff` gives 302 + `Set-Cookie`, that cookie
is `qa@demo.test (QA)`, a replay, a tampered code, a missing code and HEAD all
get 404; `session demo:production` exits 2; `status` exits 0; and no generated
secret appears in any CLI output or app log. When it ends it deletes the two
secrets it stored. On Windows use `DEMO_PORT` to run it next to a live demo; on
macOS and Linux it uses the same two keychain items as `npm run demo`, so do not
run both at once.

## Real-broker workflow proof

Prerequisites (from the repo root):

```sh
npm run build                                                     # built broker CLI + workflow contracts
npm --prefix examples/demo-app ci                                 # demo app dependencies
npm --prefix examples/workflows/authenticated-smoke ci            # playwright
npx --prefix examples/workflows/authenticated-smoke playwright install chromium
```

Linux also needs an unlocked keychain (`TESTLANE_REAL_KEYCHAIN=1`; see
[Platform notes](#platform-notes) below). Any prerequisite that is missing
makes the proof itself fail closed — verdict `blocked`, exit 2, reasons
naming exactly which command to run — never a silently green skip. The
`verdict` field in its JSON report is authoritative; `npm run` may report its
own non-zero exit code for the wrapper invocation.

```sh
npm run proof:demo-real-broker -- --json     # from the repo root
```

Runs the UNMODIFIED `examples/workflows/authenticated-smoke` template against
this app: a real Chromium session, signed in through the real built broker CLI
with the `nextauth-credentials` strategy (CSRF token, credentials callback,
`next-auth.session-token` cookie) instead of the `form-post` strategy the
template's other real-broker proof exercises against a dependency-free
fixture. It starts its own copy of the app in a unique `.demo/workflow-proof-*`
state dir (removed afterwards, together with the two keyring entries it seeded
on Linux) and runs two cases against it: `happy`
(`demo:admin`, all 8 required smoke steps pass) and `wrong-role` (same
profile, but the manifest claims role `QA` where the registry says `Admin`;
the broker's `profile-policy` step refuses before any sign-in is attempted).
Evidence lands in `output/demo-real-broker-proof-*.json/.log/.exit` at the
repo root. Windows uses the DPAPI store; Linux needs `TESTLANE_REAL_KEYCHAIN=1`
inside an isolated `dbus-run-session` + throwaway `gnome-keyring` (see the
`demo-smoke` CI job); macOS is refused (exit 2, blocked, never a false pass).
`TESTLANE_REAL_KEYCHAIN` only gates this proof's own preflight check; it has
no effect on `npm run demo`, the CLI, or the store it selects
(`TESTLANE_STORE`).

## Platform notes

- **Windows:** the vault uses DPAPI files under `.demo/home/store`. Secret
  values are sent once over stdin to the custom Next bootstrap and retained
  only by the app process's in-memory runtime provider.
- **macOS:** the vault uses your login Keychain, which is per user, not per
  folder: `store set` writes items named `agent-auth/demo:admin` and
  `agent-auth/demo:handoff:qa` there. `npm run clean` removes them. The smoke
  test and the workflow proof use the same two items (and delete them when
  they finish), so do not run them while a demo is up; rerun `npm run demo`
  afterwards.
- **Linux:** the vault needs `secret-tool` with an unlocked Secret Service
  keyring, which is also per user (the same Keychain caveat applies); without
  one, seeding fails with the broker's "no keychain available" message.
  [docs/platforms.md](../../docs/platforms.md) covers installing the packages,
  starting a keyring on a headless machine, WSL or devcontainer, and what each
  error message means.

  For a throwaway/headless environment only — never a developer's real
  keyring — run everything on a private D-Bus session with its own throwaway
  keyring. The keyring is reachable only on that session's bus, so the
  agent-side commands must run from a shell that shares the bus; the demo
  prints the line that gives a second terminal access.

  Terminal 1. Give the keyring a fresh, empty `XDG_DATA_HOME` (a keyring file
  left on disk under an earlier run's password stays locked: "Cannot create
  an item in a locked collection"), then open an interactive shell on a
  private session:

  ```sh
  export XDG_DATA_HOME="$(mktemp -d)"
  dbus-run-session -- bash
  ```

  Inside that shell, unlock the keyring with a password you type at the prompt.
  It is read without echo and piped to the daemon on stdin (`printf` is a shell
  builtin), so it never appears in an argument list or in the process table.
  Pick any throwaway password; it protects an empty keyring that is deleted below:

  ```sh
  read -r -s -p "Throwaway keyring password: " KEYRING_PW; echo
  printf '%s' "$KEYRING_PW" | gnome-keyring-daemon --unlock --components=secrets
  unset KEYRING_PW
  npm run demo        # from the repo root; or: npm --prefix examples/demo-app run smoke
  ```

  Terminal 2. Paste the bash / zsh lines `npm run demo` printed: an
  `export DBUS_SESSION_BUS_ADDRESS=...` line (a socket path, not a secret; the
  demo prints it whenever the variable is set), then the `TESTLANE_HOME` /
  `TESTLANE_PROFILES` / alias line. Then run the agent-side commands from
  [Try this](#try-this). Without that export, a shell on your normal session
  cannot see this keyring and fails with "no keychain available" or a
  `secret-tool` D-Bus error.

  When you are done, press Ctrl+C in terminal 1 and, in that same shell, run
  `npm --prefix examples/demo-app run clean` (the entries live only in this
  throwaway keyring), then `exit` the session and `rm -rf "$XDG_DATA_HOME"`.

  CI's `demo-smoke` job does the same non-interactively, with a random
  password piped from `/dev/urandom` and a step-private `XDG_DATA_HOME`.
