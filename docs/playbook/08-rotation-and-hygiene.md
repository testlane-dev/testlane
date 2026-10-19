# 08 Rotation and hygiene

## The rule

Agent secrets rotate on a schedule, through the app's own password-change API, using **two-phase
rotation**, run by a **human-owned** scheduled task, never by an agent. A daily `status --alert`
task reports missing, old, refused and half-rotated secrets to a human. Ephemeral sandboxes that
create a fresh account per run get **per-run credentials** and **account overrides**, not edits to
the committed registry.

## Why

- **Test passwords live forever.** Without a schedule, the sandbox password from two years ago is
  still valid, and still in the old wiki page it was pasted into before the broker existed.
- **One-phase rotation loses the credential.** "Change the password in the app, then save it
  locally" fails between the two steps: the process crashes or the network drops after the app
  accepted the change, and nobody knows the new password. The account is locked out until an
  admin resets it.
- **Agents that rotate lock people out.** Rotation changes an account in the app. An agent that
  decides to rotate, or retries a failed rotation in a loop, can lock an account and burn through
  failed-login limits.
- **Alerts nobody reads.** A status report written to a file that nobody opens is the same as no
  report.
- **Registry churn.** A sandbox that issues a new operator email per run tempts people to edit the
  committed profiles file every run; each edit is a chance to change something policy-bearing.

## How

### Configure rotation on the profile

Rotation needs a same-origin endpoint that changes the password. Point the profile at it; use an
admin agent profile when the endpoint needs one:

```json
"acme:staging:sales": {
  "app": "acme",
  "environment": "testing",
  "baseUrl": "https://staging.acme.test",
  "strategy": "nextauth-credentials",
  "account": { "email": "agent.sales@acme.test", "role": "Sales" },
  "session": { "ttlMinutes": 120 },
  "options": {
    "rotatePath": "/api/admin/users/password",
    "rotateMethod": "PUT",
    "rotateBody": "{\"email\":\"{{email}}\",\"password\":\"{{newSecret}}\"}",
    "rotateVia": "acme:staging:admin",
    "rotateEveryDays": "30"
  }
}
```

The endpoint and body are whatever the app really offers. `{{secret}}` (the current value) is
available for "change my own password" endpoints that require it. `rotateVia` must be on the same
origin and non-production.

### What two-phase means

`testlane rotate <profile>`:

1. takes a per-profile lock;
2. settles any earlier interrupted rotation first;
3. generates a new 32-byte random value and stores it as **pending**, next to the unchanged
   current secret, before the app hears of it;
4. sends the change request;
5. decides by signing in: promote the new value if the app accepts it, drop it if the app still
   accepts the old one, and keep **both** when neither can be proven (network failure, app
   unreachable).

No outcome leaves the vault without a value the app accepts. When the outcome is unknown, the next
`session` or `check` tries the pending value if the current one is refused and promotes it on
success; the next `rotate` settles it for good. Every step is audited; no step prints a secret.

Costs to plan for: settling takes one sign-in (two if the first is refused), and a refused attempt
counts as a failed login in the app. Leave headroom in the app's lockout policy for agent accounts.

### Schedule it under a human account

Run rotation and status as the **same OS user** who stored the secrets (the stores are
per-user), from the consuming repository's directory, with a requester label for the audit log.

cron:

```cron
0 8 * * *  cd ~/src/acme && testlane --requester cron:status status --alert > ~/.testlane/status.txt || notify-team "testlane: secrets need attention (exit $?)"
0 3 1 * *  cd ~/src/acme && testlane --requester cron:rotate rotate acme:staging:sales
```

Windows Task Scheduler:

```bat
schtasks /Create /TN "testlane status" /SC DAILY /ST 08:00 /TR "cmd /c cd /d C:\src\acme && testlane --requester task:status status --alert > %USERPROFILE%\.testlane\status.txt"
schtasks /Create /TN "testlane rotate sales" /SC MONTHLY /D 1 /ST 03:00 /TR "cmd /c cd /d C:\src\acme && testlane --requester task:rotate rotate acme:staging:sales"
```

`status --alert` exits 7 when any non-production profile has an alert. Wire that exit code to
something a human sees (mail, chat webhook, a failing job). The alerts:

| Alert | Action |
| --- | --- |
| `no-secret` | human runs `testlane store set <profile>` |
| `rotation-overdue` | human runs, or schedules, `testlane rotate <profile>` |
| `pending-rotation` | an interrupted rotation older than an hour; run `testlane rotate <profile>` to settle it |
| `legacy-envelope` | re-store or rotate so the secret's age is known |
| `secret-refused` | the profile's origin or tag changed since storing; verify the change, then re-store |
| `store-error` | human runs `testlane check <profile>` to see the store error |

Agents may run `testlane status` and report alerts. They never run `rotate`
([04-harness-permissions.md](04-harness-permissions.md)).

### Handoff secrets rotate too

For `app-handoff` profiles the vault holds the deployment's handoff secret. Rotate it by
generating a new value, setting it in the deployment's environment, and piping the same value into
`testlane store set` for every profile that points at that deployment. One secret per deployment, so
rotating one never affects another.

### Per-run credentials for ephemeral sandboxes

Some sandboxes are provisioned per run and create a fresh test account each time (a new email, a
new password). Keep the committed profile stable and change only what is per-run:

```bash
# Human, or a script the human runs, after the sandbox is provisioned:
testlane account set acme:sandbox:operator --email "operator+run-481@acme.test"
sandbox-cli credentials --run 481 --field password | testlane store set acme:sandbox:operator

# The agent then works as usual:
testlane check acme:sandbox:operator

# After the run:
testlane store delete acme:sandbox:operator
testlane account clear acme:sandbox:operator
```

The override can change only the account email (and employee code) of an existing,
non-production profile; `baseUrl`, `environment`, `strategy`, `options` and `session` stay in the
committed registry. The override file is machine-wide: an override for a profile that is not in
the current registry is ignored with a warning, and `testlane account list` shows it as unused.

### Routine hygiene

- **Weekly:** skim `testlane audit --tail 200` for `store.set`, `store.delete` and `rotate` rows you
  did not initiate, and for refusals that point at a misconfigured profile.
- **When an environment is retired:** delete its profiles' secrets (`testlane store delete`), remove
  the profiles, disable the agent accounts in the app.
- **When someone leaves the team:** agent accounts are unaffected (that is the point of
  [01-accounts.md](01-accounts.md)); rotate any secret they could have seen.
- **After every run:** remove session files (`.agent/*`) and throwaway resources
  ([07-throwaway-infrastructure.md](07-throwaway-infrastructure.md)).

## Checklist

- [ ] Every password profile with a password-change API has `rotatePath`, `rotateBody` and `rotateEveryDays`.
- [ ] Rotation runs from a scheduled task under the human's account, with a `--requester` label.
- [ ] A daily `status --alert` task exists and its exit 7 reaches a human.
- [ ] The app's lockout policy leaves room for rotation's settling sign-ins.
- [ ] Handoff secrets are per deployment and have a documented rotation procedure.
- [ ] Ephemeral sandboxes use account overrides and piped per-run secrets; the committed registry does not change per run.
- [ ] Per-run secrets and overrides are removed when the run ends.
- [ ] Agents can run `status`, never `rotate`, `store set`, `store delete` or `account set/clear`.
