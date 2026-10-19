# 05 Evidence

## The rule

Every check an agent runs writes its complete output to `output/<label>-<n>.log` and its exit
code to `output/<label>-<n>.exit`. Labels and numbers are unique; a new attempt gets a new number
and **never overwrites** an earlier one, least of all a failed one. Reports quote the exact
command, the exit code and the counts. Live runs against a hosted environment also produce an
evidence JSON file that contains no secrets.

## Why

An unattended agent's report is only as good as what a human can check afterwards. Without this
rule:

- **"All tests pass" has nothing behind it.** The claim was true of some run, at some point, on
  some tree.
- **The failure disappears.** The agent re-runs a flaky check, the log is overwritten with the
  passing attempt, and the flake is never investigated.
- **The exit code is lost in a pipe.** `npm test | tail -20` exits with `tail`'s status, which is
  0; a failing suite looks green.
- **Scrollback truncates.** The interesting part of a 4,000-line log is gone by the time anyone
  looks.
- **Evidence becomes a leak.** A pasted response body contains a session cookie; a "helpful"
  screenshot shows a handoff URL in the address bar.

## How

### One log and one exit file per check

Use a small helper so the agent cannot get this wrong by hand. In bash:

```bash
# run_check <label> <command...>
# Writes output/<label>-<n>.log and output/<label>-<n>.exit, n = first unused number.
run_check() {
  local label="$1"; shift
  mkdir -p output
  local n=1
  while [ -e "output/${label}-${n}.log" ] || [ -e "output/${label}-${n}.exit" ]; do n=$((n + 1)); done
  local base="output/${label}-${n}"
  { printf '$'; printf ' %q' "$@"; printf '\n'; } > "${base}.log"
  "$@" >> "${base}.log" 2>&1
  local code=$?
  printf '%s\n' "$code" > "${base}.exit"
  printf '%s -> exit %s\n' "${base}.log" "$code"
  return "$code"
}

run_check typecheck npm run typecheck
run_check unit npx vitest run
run_check e2e-staging npx playwright test --project=staging
```

PowerShell equivalent:

```powershell
function Invoke-Check([string]$Label, [scriptblock]$Command) {
  New-Item -ItemType Directory -Force output | Out-Null
  $n = 1
  while ((Test-Path "output/$Label-$n.log") -or (Test-Path "output/$Label-$n.exit")) { $n++ }
  $base = "output/$Label-$n"
  "`$ $Command" | Out-File -Encoding utf8 "$base.log"
  & $Command *>> "$base.log"
  $code = $LASTEXITCODE
  "$code" | Out-File -Encoding utf8 "$base.exit"
  "$base.log -> exit $code"
}

Invoke-Check unit { npx vitest run }
```

Rules that go with the helper:

- The first line of the log is the exact command.
- Nothing is piped before the exit code is captured. If you must filter, filter the log file
  afterwards.
- A retry is a new number. `unit-1.exit` = 1 and `unit-2.exit` = 0 is a flaky test, and the report
  says so.
- `output/`, `*.log` and `*.exit` are gitignored. Evidence is for the run, not the repository.

### Report exact commands and counts

The agent's report quotes, for each check, the command, the exit code and the counts from the
tool's own summary line, with the log path:

```text
npx vitest run                 exit 0   Test Files 27 passed (27); Tests 612 passed (612)   output/unit-2.log
npx playwright test --project=staging
                               exit 1   14 passed, 1 failed (orders.spec.ts:88)              output/e2e-staging-1.log
```

Counts matter: "passed" with 12 tests when there used to be 612 means the suite did not load.

### Evidence JSON for live runs

When a run touches a hosted environment, write one JSON file that a reviewer can check without
access to the agent's session:

```json
{
  "run": "e2e-staging-2026-09-24T14-05Z",
  "tree": "3f5e1a0c9b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f",
  "base": "main@a1b2c3d",
  "environment": "testing",
  "host": "staging.acme.test",
  "profiles": ["acme:staging:sales", "acme:staging:viewer"],
  "checks": [
    { "label": "check-sales", "command": "testlane check acme:staging:sales", "exit": 0, "log": "output/check-sales-1.log" },
    { "label": "e2e-staging", "command": "npx playwright test --project=staging", "exit": 0,
      "counts": { "passed": 15, "failed": 0, "skipped": 0 }, "log": "output/e2e-staging-2.log" }
  ],
  "auditRows": { "from": "2026-09-24T14:05:11Z", "to": "2026-09-24T14:19:40Z", "sessions": 3, "refused": 0 }
}
```

It records **names, hosts, counts, hashes, timestamps and paths**. It never contains a cookie,
header value, storage state, handoff URL or code, response body with session data, or anything
read from the vault. Before a report is sent, scan the evidence:

```bash
if grep -rniE 'set-cookie|cookie:|session-token|"cookies"|[?&]code=|authorization:|bearer ' output/; then
  echo "evidence contains session material; fix before reporting"
fi
```

Screenshots count as evidence: take them after navigation settles, never of an address bar
holding a handoff URL, and never of browser devtools showing cookies.

### Keep the failed attempt

When a check fails, the agent investigates with the log it has, fixes the cause, and runs the check
again under a new number. It does not delete the failed log, and the final report lists both
attempts. A reviewer who sees `-1` failed and `-2` passed can ask what changed in between.

## Checklist

- [ ] Every check ran through the helper: one `.log` and one `.exit` per attempt, unique names.
- [ ] No log or exit file was overwritten or deleted; retries have new numbers.
- [ ] No exit code was captured through a pipe.
- [ ] The report lists command, exit code, counts and log path for every check, including failed attempts.
- [ ] Live runs have an evidence JSON with the code revision (commit or tree hash), environment, profiles, checks and audit window.
- [ ] The evidence scan found no cookies, tokens, storage states or handoff URLs.
- [ ] `output/` is gitignored.
