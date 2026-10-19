# 07 Throwaway infrastructure

## The rule

Every verification that writes state gets **its own** throwaway database, container or broker
home, created for that run and destroyed when it ends. The shared development database is never a
test fixture, and no verification script may run against it.

## Why

- **Leftover state makes tests pass.** A check succeeds because a row from yesterday's run is
  still there; on a clean database it fails.
- **Migrations land on the shared database.** An agent applies an unreviewed migration to the
  team's dev database; everyone else's branch breaks.
- **Destructive checks destroy someone's work.** A "reset and seed" step wipes data a colleague
  was using.
- **Parallel agents collide.** Two agents seed the same database at the same time and each sees
  the other's rows.
- **Test runs pollute the real vault.** A broker test that forgets its home writes audit rows,
  lock files or store entries into the user's real `~/.testlane`.

## How

### A database per run

A Postgres container bound to loopback, with trust authentication so there is no password to
handle, labelled so leftovers can be found:

```bash
run="verify-$(date +%Y%m%d-%H%M%S)-$$"
docker run -d --rm --name "$run" --label verify.run="$run" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:16 >/dev/null
trap 'docker rm -f "$run" >/dev/null 2>&1' EXIT

port=$(docker port "$run" 5432/tcp | head -n1 | sed 's/.*://')
export DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/postgres"
until docker exec "$run" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

run_check migrate npx prisma migrate deploy      # or your migration tool
run_check seed    npm run seed -- --synthetic
run_check e2e     npx playwright test --project=local
```

(`run_check` is the helper from [05-evidence.md](05-evidence.md).) The `trap` removes the
container however the script ends. `-p 127.0.0.1::5432` picks a free host port, so parallel runs
never collide.

Without containers, a database per run on a local server works too:

```bash
db="verify_$(date +%s)_$$"
createdb "$db" && trap 'dropdb --if-exists "$db"' EXIT
export DATABASE_URL="postgresql://localhost/${db}"
```

### Guard scripts against the shared database

Seeding, migration and reset scripts that agents run should refuse anything that is not
obviously throwaway:

```ts
export function assertThrowawayDatabase(url: string): void {
  const u = new URL(url);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
  const dbName = u.pathname.replace(/^\//, "");
  const throwaway = dbName === "postgres" || dbName.startsWith("verify_");
  if (!loopback || !throwaway) {
    throw new Error(`refusing to modify database ${u.hostname}/${dbName}: not a throwaway database`);
  }
}
```

Adjust the rule to your naming, but keep it an allowlist. Log the refusal without the URL's
credentials.

### App servers and broker profiles

A local app server for the run points at the run's database. The broker's local profile has a
fixed `baseUrl` (for example `http://localhost:3000`), and stored secrets are bound to that exact
origin, port included: start the app on the profile's port, or add a second profile for a second
port and store its secret once. Do not edit the profile's port per run; the broker would refuse
the stored secret (exit 6), correctly.

Seed agent accounts into each run's database with the same seed script as hosted environments
([01-accounts.md](01-accounts.md)), and give them the same secret the vault holds for the local
profile, piped, never printed.

### Scratch broker homes

Anything that tests the broker itself, or exercises its commands in a throwaway way, uses a scratch
home:

```bash
export TESTLANE_HOME="$(mktemp -d)"
trap 'rm -rf "$TESTLANE_HOME"' EXIT
```

What that isolates depends on the store:

| Store | Isolated by a scratch home? |
| --- | --- |
| `dpapi` (Windows) | Yes: store files live under the home |
| `encrypted-file` | Store files yes; its data key is in the user's OS keychain, shared |
| `keychain-macos`, `secret-service` | No: entries live in the user's keychain, keyed by profile name |

On macOS and Linux, use profile names unique to the run and delete them at the end
(`testlane store delete <profile>`, a human-run step), or test against an in-memory store as
Testlane's own test suite does. The audit log, lock files, overrides file and HTTP token always
follow the home.

### Clean up, and find what cleanup missed

- Use `trap … EXIT` (or `try/finally` in scripts) for every resource the run creates.
- Label everything with the run id, so leftovers can be listed:
  `docker ps -a --filter label=verify.run`.
- Remove session files the run wrote (`.agent/*`).
- Never use machine-wide cleanup (`docker system prune`, dropping every `verify_*` database) on a
  machine where other runs may be active; remove by run id.
- Record in the evidence JSON which throwaway resources the run used and that they were removed.

## Checklist

- [ ] Each verification created its own database or container, bound to loopback, labelled with a run id.
- [ ] Scripts that write data refuse any database that is not on the throwaway allowlist.
- [ ] No verification step ran against the shared dev database.
- [ ] The local app ran on the port its broker profile names; no profile was edited per run.
- [ ] Broker tests and experiments used a scratch `TESTLANE_HOME`, and the store-specific limits above were respected.
- [ ] Every resource was removed by a trap or finally block; leftovers were checked by label.
