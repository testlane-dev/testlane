# 02 Environments

## The rule

Every profile carries an environment tag. Production is **declared explicitly**, with every
hostname it answers on, even when nothing ever signs in there. Any agent-only surface in the app
(a handoff route, a seed script, a test-data endpoint) refuses production **on its own**, using
several independent signals, one of which is an allowlist of branches or deployments rather than a
denylist.

## Why

Agents are fast and literal. The failures this rule prevents are all "the agent did exactly what
the configuration said":

- **A copied profile keeps the wrong tag.** Someone duplicates a `testing` profile, changes the
  `baseUrl` to the production domain to "just check something", and the agent now has a session
  on production.
- **Production answers on more than one name.** The custom domain is denylisted, but the hosting
  platform's default domain, the `www.` alias or a regional hostname is not.
- **Previews share a project with production.** On many hosting platforms, preview deployments
  live in the same project as production, see the same environment variables unless each variable
  is scoped carefully, and often talk to the same database. A preview of the release branch *is*
  production code on production data with a preview URL.
- **Platform flags describe the deployment, not the data.** A `VERCEL_ENV`-style variable says
  "this is a preview build". It does not say the build is harmless: a preview can point at the
  production database, a variable can be copied from the production scope, and the release
  branch can be deployed as a preview. A single `!== "production"` check fails open in all of
  these cases.
- **Denylists fail open.** "Enabled unless the branch is `main`" becomes "enabled on the hotfix
  branch that deploys to production" the day someone adds a hotfix branch.

## How

### Tags

Testlane knows three tags. Use them consistently:

| Tag | Meaning | Examples |
| --- | --- | --- |
| `sandbox` | Local or throwaway; data is disposable | `http://localhost:3000`, a per-run container |
| `testing` | Shared hosted test environment with synthetic data | `https://staging.acme.test`, preview deployments of feature branches |
| `production` | Real users or real data. **Always refused**, no override | `https://app.acme.example` |

The broker binds every stored secret to the profile's origin and tag at `store set` time; changing
either later makes the secret unusable until a human stores it again (exit 6). Re-tagging is
therefore never a shortcut.

### Declare production as a denylist entry

Add a `production` profile for every production application, listing every hostname it answers
on. Nothing signs into it; it exists so the broker can refuse its hosts:

```json
{
  "version": 1,
  "profiles": {
    "acme:production:deny": {
      "app": "acme",
      "environment": "production",
      "baseUrl": "https://app.acme.example",
      "allowedHosts": ["acme.example", "www.acme.example", "acme-prod.hosting.example"],
      "strategy": "nextauth-credentials",
      "account": { "email": "", "role": "none" },
      "session": { "ttlMinutes": 0 },
      "notes": "Production denylist. Never signed into. Keep every production hostname here."
    },
    "acme:staging:sales": {
      "app": "acme",
      "environment": "testing",
      "baseUrl": "https://staging.acme.test",
      "strategy": "nextauth-credentials",
      "account": { "email": "agent.sales@acme.test", "role": "Sales" },
      "session": { "ttlMinutes": 120 }
    }
  }
}
```

With that entry in place:

- a non-production profile whose `baseUrl` or `allowedHosts` shares a hostname with it (any port,
  trailing dot, any case) makes the registry fail to load;
- a `session --target` on any of those hostnames is refused (exit 2);
- `store set` refuses the production profile, so the vault never holds its secret.

Prove it in CI, with the packaged CLI, on every change to the registry:

```bash
set +e
testlane --profiles testlane.profiles.json session acme:production:deny >/dev/null 2>&1
code=$?
set -e
test "$code" -eq 2 || { echo "production profile was not refused (exit $code)"; exit 1; }
```

### Gate the app's agent-only surfaces with several signals

The broker refuses production by configuration. The app must refuse it by itself as well,
because the app is what actually holds the data. Require **all** of these before an agent-only
route or script does anything, and return a bare 404 otherwise:

1. An explicit opt-in flag set only in the sandbox scope (`AGENT_HANDOFF_ENABLED=true`), never in
   the production scope. Opt-in, so a missing variable means "off".
2. A **positive, allowlisted non-production marker**, also set only in the sandbox scope
   (`AGENT_HANDOFF_ENV` is exactly `local`, `sandbox`, `testing` or `preview`). A missing, empty,
   misspelled or unknown value, including `production` and `prod`, means "off". "Not marked
   production" is not enough: on a host that sets no platform variable (Fly, Render, Kubernetes, a
   VM) a gate written as "on unless marked production" is open.
3. The platform's environment flag is not production. This is an extra deny that can switch the
   surface off and never on.
4. The deployment's branch is on an **allowlist** (for example `staging` and `agent/*`), not
   merely "not the release branch".
5. Optionally, a data check: the database host or name is on an allowlist of test databases.

```ts
const ALLOWED_ENVS = ["local", "sandbox", "testing", "preview"];
const ALLOWED_BRANCHES = [/^staging$/, /^agent\/[a-z0-9._-]+$/];

export function agentSurfacesEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.AGENT_HANDOFF_ENABLED !== "true") return false;
  if (!ALLOWED_ENVS.includes(env.AGENT_HANDOFF_ENV ?? "")) return false;  // positive marker: unset, unknown or "production" is off
  if (env.PLATFORM_ENV === "production") return false;          // extra deny, e.g. a VERCEL_ENV-style flag
  const branch = env.PLATFORM_GIT_BRANCH ?? "";
  if (!ALLOWED_BRANCHES.some((re) => re.test(branch))) return false;
  const dbHost = safeHostOf(env.DATABASE_URL);
  return dbHost !== null && TEST_DATABASE_HOSTS.has(dbHost);
}
```

The demo app's `handoffEnabled` in [`lib/handoff-gate.js`](../../examples/demo-app/lib/handoff-gate.js)
is a pure function of the same shape, with unit tests (it denies the release branch instead of
allowlisting branches, and has no database check). Write tests for every refusal: flag off,
missing or unknown environment marker, production flag, release branch, unknown branch, a
production database host.

### Hostname hygiene

- Give test environments hostnames that cannot be confused with production (`*.test` locally, a
  separate domain or subdomain tree for hosted staging).
- When production gains an alias, add it to the denylist entry in the same change.
- Use `allowedHosts` on test profiles only for hosts that really belong to that environment
  (an API subdomain, an asset host), never for a shared host that also serves production.

## Checklist

- [ ] Every profile has an environment tag; `production` is used for anything with real users or real data.
- [ ] Each production application has a denylist profile listing every hostname it answers on.
- [ ] CI asserts the production profile is refused (exit 2) with the packaged CLI.
- [ ] App-side agent routes and scripts require an opt-in flag, a non-production platform flag, a branch allowlist and, ideally, a test-database check.
- [ ] Each refusal has a test that expects a 404 (or a refusal exit code for scripts).
- [ ] Preview deployments that can reach production data are tagged `production`, whatever their URL looks like.
- [ ] New production aliases are added to the denylist in the same change that creates them.
