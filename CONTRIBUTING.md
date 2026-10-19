# Contributing to Testlane

Thanks for helping. Testlane holds other people's secrets, so the bar for changes is "provably does
not leak and does not widen access". This page tells you how to get a working setup, what the
tests must and must not do, and what review a change needs.

Security problems are not issues: report them privately as described in
[SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node 22 or newer, npm, git. No native toolchain is needed.

```bash
git clone <your fork>
cd testlane
npm install
npm run check        # typecheck (src, then src + tests) and the full vitest suite
npm run release:check  # the same plus the public-export hygiene scan (scripts/export-public.mjs --check)
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc` over `src/`, then over `src/` + `tests/` |
| `npm test` | `vitest run` |
| `npm run test:watch` | vitest in watch mode |
| `npm run build` | compiles to `dist/` |
| `npm run dev -- <args>` | runs the CLI from source with `tsx` |

`npm run check` must pass on your machine before you open a pull request. CI runs it on Windows
(which exercises the real DPAPI store end to end) and on Ubuntu.

### Optional workflow template commands

These exercise the two optional [workflow templates](docs/workflows/README.md)
under `examples/workflows/`. They are not part of `npm run check`. Each
template's browser-backed tests and self-test need its Chromium install:
`npm --prefix examples/workflows/authenticated-smoke install && npx --prefix
examples/workflows/authenticated-smoke playwright install chromium` (Ubuntu:
add `--with-deps`), and likewise for `examples/workflows/feature-acceptance`.

| Script | What it does |
| --- | --- |
| `npm run test:playwright` | packs the package and checks the copied Playwright fixture in a consumer project; first install `examples/playwright` dependencies and Chromium |
| `npm run proof:playwright-real-broker` | the packed fixture against the real CLI/native scratch store on Windows or isolated Linux; never macOS |
| `npm run test:workflow` | authenticated-smoke template's own tests (`node --test`) |
| `npm run test:workflow-support` | shared `test-support` fixture tests (dependency-free, no browser) |
| `npm run test:workflow-feature` | feature-acceptance template's own tests (reference app, broker double, real Chromium) |
| `npm run proof:smoke-real-broker -- --json` | drives the actual built broker CLI (not a test double) through the authenticated-smoke runner |
| `npm run proof:feature-real-broker -- --json` | drives the actual built broker CLI (not a test double) through the feature-acceptance runner |
| `npm run check:clean-room -- --json` | packs the repo, installs the tarball globally into a throwaway prefix, and drives the installed CLI and workflow templates as a stranger who only has the published package would (`scripts/clean-room.mjs`); needs `npm run build` first |

The two `proof:*` commands need a supported platform (Windows via the real
DPAPI store, always; Linux only inside an isolated `dbus-run-session` with a
throwaway `gnome-keyring` and `TESTLANE_REAL_KEYCHAIN=1`; never macOS) and
`npm run build` first. A missing build, missing Chromium, or unsupported
platform makes them block (exit 2), never silently pass.

By default `npm run check:clean-room` writes its `.json`, `.log` and `.exit` report into `output/`
in your checkout and downloads Chromium for the installed smoke template. To keep the report out
of the repository and skip that download, build first, then pass `--output-dir=<dir>` (the `=` is
required; a space-separated value is rejected) and `--skip-browser-install`:

```bash
npm run build
npm run check:clean-room -- --skip-browser-install --output-dir="$(mktemp -d)"
```

`--skip-browser-install` only skips the `playwright install chromium` step. The template's
self-test still launches Chromium, so without one already installed (for example in your
Playwright cache) the `smoke-self-test` check fails with `identity:launch-failed` and the run
reports FAILED; every other check is unaffected.

Try the CLI against a scratch home, never your real one:

```bash
export TESTLANE_HOME="$(mktemp -d)"
npx tsx src/cli.ts --profiles tests/fixtures/profiles/valid.json profiles
```

In PowerShell, set `$env:TESTLANE_HOME` to a new directory under `$env:TEMP` instead.

## Repository layout

```
src/
  cli.ts            CLI (profiles | store | account | session | check | handoff | rotate | status | audit | mcp | serve)
  env.ts            TESTLANE_* environment variables with their AGENT_AUTH_* fallbacks
  paths.ts          state directory (~/.testlane, or an existing ~/.agent-auth) and file names
  version.ts        the package version, read from package.json (--version, MCP server info, User-Agent)
  types.ts          shared types and the profile-name rules
  requester.ts      the audit-log label for who is asking (sanitised; not authentication)
  index.ts          library entry: the package's JavaScript exports (not a stable API in 0.x)
  commands.ts       command implementations shared by every surface (policy + vault + audit), rotate and status
  deps.ts           one CommandDeps builder (registry, lazy store, requester) for CLI, MCP, HTTP
  handoff.ts        one-time handoff codes: mint, reference verifier, `handoff` command
  mcp.ts            MCP server over stdio (list_profiles, session, check, handoff, status tools; no store tool)
  serve.ts          localhost HTTP server (127.0.0.1, bearer token file, no store endpoints)
  profiles.ts       load + validate testlane.profiles.json (zod), merge repo + user files, apply account overrides
  policy.ts         environment / host / TTL rules; production refusal
  vault.ts          origin-bound secret envelope (v3: storedAt, pending rotation); the single place secrets are loaded
  lock.ts           per-profile rotate lock files (<TESTLANE_HOME>/locks)
  store/            SecretStore interface, platform selection and adapters
  strategies/       login strategies + per-strategy option schemas (options.ts)
  session/          output formats: cookie header, Playwright storageState, curl jar, header lines, JSON
  http/             cookie jar used by the strategies
  audit.ts          <TESTLANE_HOME>/audit.ndjson
  redact.ts         output scrubbing
  workflows/        contracts.ts (smoke), feature-contracts.ts (two-role),
                    primitives.ts (shared internal zod primitives, not exported)
schema/             profiles.schema.json (testlane.profiles.json); workflow.schema.json,
                    workflow-report.schema.json (smoke); feature-workflow.schema.json,
                    feature-workflow-report.schema.json, test-environment-receipt.schema.json
                    (feature-acceptance)
examples/           testlane.profiles.json, claude-code/, codex/, demo-app/,
                    workflows/authenticated-smoke/, workflows/feature-acceptance/,
                    workflows/test-support/ (shared fixtures for the two templates' own
                    tests and real-broker proofs; not shipped in the published package)
scripts/            export-public.mjs (public export + hygiene scanner; `npm run release:check` runs it),
                    clean-room.mjs (installs the packed tarball and drives it), ci-matrix.mjs (CI runner selection)
tests/              vitest; no network; strategies run against local fake servers.
                    TESTLANE_HOME defaults to a per-run temp dir, so no test can touch the
                    real ~/.testlane or ~/.agent-auth.
docs/               reference documentation; the README lists every page
```

## Rules for tests

1. **Tests never touch a real vault.** `vitest.config.ts` points `TESTLANE_HOME` (and the legacy
   `AGENT_AUTH_HOME`) at a per-run
   temporary directory, so the audit log, store files, locks and token files of a test run can
   never land in `~/.testlane`. Tests that need isolation from each other set their own
   `TESTLANE_HOME` to a fresh temp directory and remove it afterwards. Never write a test that
   reads `os.homedir()` state, the real keychain, or a real profiles file.
2. **Use the in-memory store** (`tests/helpers/memory-store.ts`) unless the test is specifically
   about a store adapter. Store adapter tests inject a fake `spawn`; the DPAPI end-to-end test is
   the only one that calls the real OS, and it is guarded to Windows.
3. **No secrets in fixtures.** Nothing that looks like a password, token, cookie value or handoff
   secret is committed, not even a fake one. Generate values at test time:

   ```ts
   import { randomBytes } from "node:crypto";
   const secret = randomBytes(24).toString("base64url");
   ```

   Fixture profiles use `*.test` / `*.example` hosts and `@example.test` emails.
4. **No network.** Strategies run against a local fake server started by the test
   (`tests/helpers/fake-nextauth.ts`, `fake-form-app.ts`, `fake-device-exchange.ts`) on `127.0.0.1` with
   a free port.
5. **Assert the leak, not just the result.** Any test that exercises a path where a secret is
   loaded must also assert that the secret (and, where relevant, its encoded forms) is absent
   from stdout, stderr, error messages, audit rows and written files. The existing tests in
   `tests/cli.test.ts` and `tests/rotate.test.ts` show the pattern.
6. **Show what you ran.** Put the commands you ran and their results (exit codes and pass/fail
   counts) in the pull request description. Never paste output that contains a secret or a
   session.

## Adding a strategy

A new login strategy is the most common contribution and the most likely to leak. It needs:

- an option schema in `src/strategies/options.ts`: only documented keys; every endpoint option is a
  same-origin path starting with `/`, validated at load and again inside the strategy before any
  request;
- manual redirect handling that refuses off-origin redirects;
- a fake server in `tests/helpers/` that implements the app's sign-in closely enough to test
  success, rejected credentials, malformed responses and redirects;
- tests that assert the secret never appears in the artifact, the output, the error message of a
  failed sign-in, or the audit row;
- a row in the README strategy table and, if it changes what an agent can reach, an update to
  [docs/threat-model.md](docs/threat-model.md).

The strategy receives the secret from the caller; it must never load one from the store itself
and never register anything with the redactor (`src/vault.ts` does that).

## Changes that need a security review

Every change is reviewed before it merges. Changes to any of the following are
security-sensitive and get a second, careful look, with the security review written down in the
pull request:

- `src/vault.ts` (envelope format, origin and environment binding, pending values)
- `src/handoff.ts` (code format, verifier, URL building)
- `src/policy.ts` (production refusal, host rules, TTL)
- rotation and pending-secret handling in `src/commands.ts` (`rotateProfile`, the sign-in
  fallback to a pending value) and `src/lock.ts`
- `src/redact.ts`, `src/audit.ts`, `src/store/**`
- the agent surfaces `src/mcp.ts`, `src/serve.ts`, and argv handling in `src/cli.ts`
- the permission examples under `examples/`

For these, the pull request description must say which guarantee in
[SECURITY.md](SECURITY.md#design-guarantees) the change touches, why it still holds, and which
test proves it. A change that weakens a guarantee needs a threat-model update in the same pull
request.

Things we will not merge: an override for production refusal (flag, environment variable or
prompt); reading a secret from argv or the environment; a store, account or rotate operation on
MCP or HTTP; a plaintext store fallback.

## Commits and pull requests

- **Commit messages** follow Conventional Commits: `feat(scope): …`, `fix(scope): …`,
  `docs: …`, `test: …`, `ci: …`, `chore: …`, `deps: …`. Scope is the module (`vault`, `policy`,
  `handoff`, `form-post`, `serve`, …). Say what changed and why in the body; mention a version bump
  in the subject when there is one.
- **One concern per pull request.** Keep refactors out of behaviour changes.
- **Update the docs in the same pull request**: the README, [docs/cli.md](docs/cli.md) (commands,
  exit codes), the integration guides, [docs/threat-model.md](docs/threat-model.md) (rules, known
  limits) when a boundary moves, and a line in [CHANGELOG.md](CHANGELOG.md) under the unreleased
  version.
- **Fill in the pull request template**, including the exact commands you ran and their results.
- **Never paste secrets, cookies, storage states or handoff URLs** into an issue, a pull request,
  a commit, a log or a screenshot. Use generated values.

## Licensing and sign-off

Testlane is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree
that it is licensed under the same terms (section 5 of the license).

There is **no CLA**. A `Signed-off-by:` line ([Developer Certificate of Origin](https://developercertificate.org/))
is welcome but **optional**; `git commit -s` adds it.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
