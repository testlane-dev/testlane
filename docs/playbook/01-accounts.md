# 01 Accounts

## The rule

Agents sign in only as **dedicated agent accounts**: one per role, per environment, owned by the
team rather than a person, with no password any human knows. No agent ever signs in as a person,
and no person ever signs in as an agent account.

## Why

Signing an agent in as a real person fails in predictable ways:

- **Lockouts.** An agent that retries a sign-in, or a rotation that settles with a refused
  attempt, counts as failed logins. With a person's account, the person is the one locked out.
- **MFA and step-up prompts** stall the agent at exactly the moment nobody is watching.
- **Actions under a person's name.** Orders, comments, emails and notifications the agent
  triggers are attributed to that person, in the app's audit trail and in their colleagues'
  inboxes.
- **Drift.** A person's role changes, their account is deactivated when they leave, or they
  change their password; every agent workflow breaks at once, or silently gains access.
- **Secrets in transit.** A person's password was typed by a person, so it exists in a password
  manager, a chat message or a sticky note. The broker can protect its copy, not the others.
- **Blurred review.** "Was that the agent or me?" has no answer in the app's own logs.

A dedicated account with a password nobody knows removes all six: lockouts hit only the agent,
there is no MFA to satisfy, every action is visibly the agent's, the role is fixed, and the only
copy of the secret is in the vault.

## How

### Name and scope the accounts

Use one account per role the agent needs to exercise, with exactly the permissions a real user in
that role has. Do not create an "agent admin that can do everything" for convenience: a check
that passes as a superuser proves nothing about the role you meant to test.

| Profile | Account | Role | Notes |
| --- | --- | --- | --- |
| `acme:staging:admin` | `agent.admin@acme.test` | Administrator | Only for admin flows and for `rotateVia` |
| `acme:staging:sales` | `agent.sales@acme.test` | Sales | Default for most UI checks |
| `acme:staging:viewer` | `agent.viewer@acme.test` | Read-only | Proves permission denials |
| `acme:staging:service` | `agent.service@acme.test` | Dedicated service identity | Only the scoped exchange permission |

Use an email domain you control or a reserved one (`.test`), so nothing the app sends reaches a
real mailbox. Record the purpose in the profile's `notes`:

```json
"acme:staging:sales": {
  "app": "acme",
  "environment": "testing",
  "baseUrl": "https://staging.acme.test",
  "strategy": "form-post",
  "account": { "email": "agent.sales@acme.test", "role": "Sales" },
  "session": { "ttlMinutes": 120 },
  "notes": "Agent-only. Sales scope, synthetic data only. Owner: web team."
}
```

### Seed them with a script, not by hand

Agent accounts are infrastructure. Create them with an idempotent script that lives in the app's
repository, so every environment gets the same set and a new environment gets them in one step.
A good seeding script:

- defaults to a **dry run** and prints what it would create or change; `--apply` does it;
- takes the tenant and email domain as parameters (`--tenant acme-staging --domain acme.test`);
- **refuses production** by the same signals the app uses elsewhere (see
  [02-environments.md](02-environments.md)), and refuses any domain that is not on an allowlist;
- creates missing accounts, fixes their role if it drifted, and never touches other users;
- creates accounts **without a usable password** (password sign-in disabled, or a random value
  the script discards), so the first real secret is set through the vault (below);
- is safe to re-run.

```bash
npm run agents:seed -- --tenant acme-staging --domain acme.test           # dry run
npm run agents:seed -- --tenant acme-staging --domain acme.test --apply   # human runs this
```

### Password-less, two ways

**Handoff-only accounts** have no password at all. The app's handoff route
([HANDOFF-ROUTE-CONTRACT.md](../HANDOFF-ROUTE-CONTRACT.md)) mints their session from a one-time
code, and the only secret is the per-deployment handoff secret in the vault. Use this for
browser-pane verification (strategy `app-handoff`, `testlane handoff`), and for curl or
Playwright sessions of the same account: `testlane session` consumes the one-time URL inside the
broker. A handoff-only account can also be the device or service session a `dependent-token`
profile depends on (a service identity can then operate without a password). Both need the
profile to opt in with `options.mePath` (the broker confirms the account there before it hands
out the session). Opting in lets agents hold that account's session cookie, so review the
account's privileges first.

**Password accounts whose password nobody reads.** For HTTP and Playwright checks the broker needs
a password it can post. Generate it, give it to the app and the vault in one pipeline, and never
display it:

```bash
# bash: printf is a builtin, so the value never appears in a process list.
secret="$(openssl rand -base64 32)"
printf '%s' "$secret" | ./scripts/set-agent-password --email agent.sales@acme.test   # app side, reads stdin
printf '%s' "$secret" | testlane store set acme:staging:sales                            # vault side, reads stdin
unset secret
```

If the app has a password-change API, configure rotation for the profile
([08-rotation-and-hygiene.md](08-rotation-and-hygiene.md)) and run `testlane rotate` once right
after seeding. From then on the only copy of the password is one the broker generated and nobody
has seen.

### Treat them as service accounts

The service-account pattern applies unchanged:

- **Owned by a team**, listed in the registry, reviewed like code.
- **Least privilege**, one role each; a separate account for every elevated operation (for
  example, a dedicated admin profile used only as `rotateVia`).
- **Exist only where agents work.** Agent accounts are never created in production; if the
  production database is ever copied into a test environment, the seed script re-creates them
  there rather than someone reusing a real account.
- **Observable.** The broker's audit log (`testlane audit`) says which profile was used when, by which
  requester; the app's own activity log should mark agent accounts so reviewers can filter them.
- **Revocable in one step**: disable the account in the app and `testlane store delete <profile>`.

### Kiosk and device accounts

Some roles are service identities, such as a build runner or automation worker. The session an
agent receives for them often contains a full web session of the device's parent account. That
parent must itself be a dedicated agent account with only the device permission, never a shared
service login shared with people.

## Checklist

- [ ] Every profile names an account whose email starts with `agent.` (or your equivalent) on a domain you control.
- [ ] No profile names a person's account. No person has the password of an agent account.
- [ ] One account per role; no catch-all superuser for convenience.
- [ ] Accounts are created by an idempotent, dry-run-by-default seed script that refuses production.
- [ ] Browser-pane profiles use handoff-only accounts; password profiles got their password through a pipe, never a screen.
- [ ] Each profile's `notes` states purpose, scope and owning team.
- [ ] Revocation is documented: disable in the app, `testlane store delete <profile>`.
- [ ] Dependency parents are dedicated agent accounts with only the required exchange permission.
