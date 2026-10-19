# Security policy

Testlane is a local credential broker: it holds sign-in secrets for sandbox and test applications in
the OS keychain, signs in on an agent's behalf, and hands the agent only a session artifact. A bug
here can leak a secret or hand an agent a session it should not have, so we treat security reports
as the highest-priority work on the project.

## Status

Testlane has not yet had an independent security audit. It is pre-1.0 software meant for sandbox
and test credentials, not for secrets that protect real users or real data. Read the
[threat model](docs/threat-model.md) before reporting: same-user access, advisory TTL for cookie
strategies and redaction of split writes are documented limits.

## Supported versions

Testlane is pre-1.0. Only the latest minor release line receives security fixes.

| Version | Supported |
| --- | --- |
| the latest `0.x` minor release line (the highest `0.N.x` published) | yes |
| any older minor | no; upgrade to the latest minor |

Once 1.0 ships, this table will list the supported major lines.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub private vulnerability reporting (the repository's Security
tab → Report a vulnerability). This is the preferred channel: it keeps the report visible to the
maintainers alone until a fix is published.

If you cannot use GitHub private vulnerability reporting, email supmaster10@gmail.com instead, with the
same details (see below).

Please include:

- the Testlane version (`npm ls -g @testlane/cli`, or `version` in the checkout's `package.json`), OS
  and Node version;
- the store kind (`dpapi`, `keychain-macos`, `secret-service`, `encrypted-file`) and the
  strategy involved (`nextauth-credentials`, `form-post`, `dependent-token`, `app-handoff`);
- the surface (CLI, MCP, localhost HTTP) and the exact command or request;
- a minimal profiles file using `*.test` / `*.example` hosts, and the steps to reproduce;
- what you expected and what happened (exit code, output with secrets removed).

**Never send a real secret, cookie, storage state or handoff URL**, even privately. Reproduce with
a throwaway value generated for the report (for example `openssl rand -base64 32`) and a local
fake server; the test helpers in `tests/helpers/` show how.

## What happens next

| Step | Target |
| --- | --- |
| Acknowledgement | within 3 business days |
| Initial assessment (valid, severity, affected versions) | within 7 days |
| Fix released for critical / high severity | within 30 days of the assessment |
| Fix released for medium / low severity | within 90 days, or the next minor release |

We will keep you informed, agree a disclosure date with you, publish a GitHub security advisory
with the fix, and credit you unless you ask us not to. These are targets for a volunteer project,
not contractual guarantees; if we are going to miss one we will tell you why.

## Scope

### In scope

- **Secret leakage** to argv, environment variables, shell history, logs, command output, error
  messages, MCP results, HTTP responses or server logs, the audit log, session files, or any file
  the broker writes. "Secret" means a stored password, PIN, handoff secret, the encrypted-file data
  key, or a pending rotated value.
- **Policy bypass** that lets any surface issue a session, handoff URL, check or rotation for a
  profile tagged `production`, or for a host that belongs to a production profile (any port,
  trailing dot, case or IDN trick); a TTL above the enforced limit; plain http to a non-loopback
  host; a strategy endpoint or redirect that leaves the profile origin.
- **Origin / environment binding bypass**: getting a stored secret sent to a different origin, or
  used under a different environment tag, without a human re-running `testlane store set`.
- **Handoff code forgery or replay**: minting a code the reference verifier accepts without the
  secret, accepting a code twice, accepting an expired code, or a flaw in the reference verifier
  (`verifyHandoffCode` in `src/handoff.ts`) or in the route contract
  ([docs/HANDOFF-ROUTE-CONTRACT.md](docs/HANDOFF-ROUTE-CONTRACT.md)) that a conforming app would
  inherit.
- **Rotation credential loss**: any sequence of app answers, crashes, network failures or
  concurrent processes after which `rotate` leaves the vault without a value the app accepts, or
  reports success when it did not succeed.
- **Redaction bypass** for a registered secret in a form the redactor claims to cover (raw, JSON
  string, URL-encoded, form-encoded, base64, base64url) written in a single write.
- **Agent surfaces** (MCP, localhost HTTP) exposing any store, account-override or rotate
  operation, or the HTTP server accepting a request without the bearer token, from a browser
  origin, or with a foreign `Host` header.
- **MCP managed-file escape**: arbitrary output paths, overwrites, deletion outside files owned
  by the connection, or live session values returned by `session_file`. Crash leftovers and
  same-user filesystem access remain documented limits.
- **Permission-rule gaps in the shipped examples** (`examples/`): a command form an agent can run
  unprompted that performs a human-only action (`store set`, `store delete`, `account set`,
  `account clear`, `rotate`, `--force`) or substitutes the registry/home through `--profiles`
  or environment variables.

### Out of scope

- **A compromised user account on the machine.** DPAPI, the macOS keychain and Secret Service are
  user-scoped: any process running as the same OS user can decrypt the store, read the HTTP token
  and read session files. This is documented, not a vulnerability.
- **A malicious profiles file, `TESTLANE_HOME` or `TESTLANE_PROFILES` value that the user
  chose to trust.** These are trusted configuration. Origin binding and validation limit the
  damage of a hostile edit, but same-origin edits (strategy, options, account email) are accepted
  by design. A way for an *agent* to swap them without a prompt under the shipped permission rules
  is in scope (see above).
- **Applications that mis-implement the handoff contract** (skip the signature check, keep nonces
  per instance, enable the route in production). Report those to the application. A flaw in the
  contract itself is in scope.
- Session artifacts behaving as designed: a cookie or storage state that the broker hands out is a
  live credential for its lifetime, and the app's own session lifetime can exceed `ttlMinutes`.
- Short all-digit secrets (PINs under 12 digits) not being redacted; this is deliberate, see
  `isRedactable` in `src/redact.ts`.
- Denial of service by a local user who can already edit the store or the audit log.
- Vulnerabilities in dependencies without a demonstrated impact on Testlane (report them upstream; we
  will still update).

## Design guarantees

These are the properties the code is built to hold. A way to break one of them is a vulnerability.

1. **No secret on the command line.** `testlane store set` reads the value from a prompt or stdin
   only; any extra argument, `--flag=value` or secret-looking flag is refused with exit 5 before
   stdin is read, without echoing the argument. `src/cli.ts`, `src/store/input.ts`
   (`assertNoSecretOnArgv`, `readSecret`).
2. **One place loads secrets.** `src/vault.ts` is the only module that reads a secret from the
   store, and it registers every loaded value (current and pending) with the output redactor
   before returning it.
3. **Secrets are origin- and environment-bound.** The stored envelope records the profile's
   `baseUrl` origin and environment tag; a mismatch is refused with exit 6.
   `src/vault.ts` (`loadEnvelope`).
4. **Production is refused, by tag and by host, with no override.** `src/policy.ts`
   (`assertAllowed`), `src/profiles.ts` (`productionHosts`, `productionOverlapIssues`: a
   non-production profile may not share a hostname with a production one). The vault never
   stores a production secret (`src/vault.ts`, `refuseProduction`).
5. **Nothing is handed out unrecorded.** The audit row is appended before a session or handoff
   URL leaves the broker; if the append fails, nothing is returned. A handoff code the broker
   consumes itself (`session` / `check` on an opted-in `app-handoff` profile) is minted only for
   an app that accepts a TCP connection, audited before it is sent to the app, and not sent if
   that append fails; a request that gets no answer, and any failure after the mint, add a
   failure row. `src/commands.ts` (`issueSession`, `recordHandoff`), `src/handoff.ts`
   (`issueHandoff`), `src/strategies/app-handoff.ts`. Audit
   rows are schema-checked, length-capped, and a free-text field that looks like `password=` /
   `token:` is refused. `src/audit.ts`.
6. **Output is scrubbed.** stdout and stderr are wrapped by the redactor on every surface
   (`src/cli.ts`, `src/mcp.ts`, `src/serve.ts`); errors go through `safeError`. `src/redact.ts`.
7. **Handoff codes are short-lived, single-use and signed.** HMAC-SHA256 over
   `profile.nonce.expiry` with a secret of at least 32 characters, 60-second lifetime, 16-byte
   random nonce, constant-time comparison before the payload is parsed, and a nonce store that
   must accept each nonce once. `src/handoff.ts`.
8. **Rotation never loses the live credential.** The new value is stored as pending before the
   app is asked to change it; it is promoted or dropped only after a sign-in proves which value
   the app accepts, and promotions compare the stored pending value first. `src/vault.ts`
   (`setPendingSecret`, `promotePendingSecret`, `dropPendingSecret`), `src/commands.ts`
   (`rotateProfile`), `src/lock.ts`.
9. **Agent surfaces cannot write.** The MCP server and the HTTP server expose no store, account
   or rotate operation. The HTTP server binds 127.0.0.1 only, requires a per-boot bearer token,
   checks the `Host` header and refuses any request with an `Origin` header. `src/mcp.ts`,
   `src/serve.ts`.
10. **Session files are created, not overwritten.** `session --out` uses create-only mode and
    mode 0600; replacing a file needs `--force`. `src/cli.ts`.
