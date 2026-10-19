# 04 Harness permissions

## The rule

Split every broker command into **agent** (runs without a prompt), **human-only** (denied to the
agent) and **ask** (prompts). Write allow and deny rules for every launcher of the broker and a
twin for **every shell tool the harness exposes**. Accept that rules are text patterns: design the
setup so that the broker is still safe when a rule is bypassed.

## Why

Failures seen when this is done loosely:

- **A second shell ignores the first shell's rules.** A harness that offers both a Bash tool and a
  PowerShell tool evaluates each against its own rule list. A deny written only as `Bash(...)`
  does nothing when the agent picks PowerShell; the denied command prompts, or runs under a broad
  PowerShell allow.
- **Global options dodge prefix rules.** `testlane --profiles other.json store set …` does not match
  `testlane store set*`.
- **An allowed command overwrites a file it should not.** An allowlisted `session --out` with
  `--force` can overwrite the harness's own settings file.
- **Stdin is an input.** An agent that may run `store set` can pipe a value into it. Refusing
  secrets on argv does not help; only denying the command does.
- **Catch-alls block the innocent.** `*store set*` also blocks `grep -r "store set" docs/`.
- **Rules are not a sandbox.** `x="store"; testlane $x set p`, `sh -c "…"`, `eval`, a script the agent
  wrote a minute ago, or a launcher nobody listed will not match any pattern.

## How

### Classify the commands

| Class | Commands | Why |
| --- | --- | --- |
| Agent | `profiles`, `check`, `session`, `handoff`, `status`, `audit`, `account list`, `doctor`, all MCP tools | Read metadata or mint a sandbox session; session artifacts are live credentials, not stored passwords |
| Human-only | `store set`, `store delete`, `account set`, `account clear`, `rotate`, `--force`, registry/home overrides (`--profiles`, `TESTLANE_HOME`, `TESTLANE_PROFILES`, legacy names) | Seed or change credentials, overwrite files, or change trusted configuration |
| Ask | `store list`, unlisted launchers and other global options/environment prefixes | A human reviews operations outside the allowlist |

The broker's MCP server and HTTP server already contain only agent-class operations. The rules
matter for the CLI.

### Write the rules per launcher

Cover the documented [project-local launchers](../project-install.md):
`npx --no-install testlane` (or `npx.cmd`) and `node node_modules/@testlane/cli/dist/cli.js`.
Also cover the installed bin, `npx tsx src/cli.ts` in a checkout and `node dist/cli.js`
after a build. For each, allow the agent commands and deny both the plain and the
"something before it" form of each human-only command:

```json
{
  "permissions": {
    "allow": [
      "Bash(testlane profiles*)", "Bash(testlane session *)", "Bash(testlane handoff *)",
      "Bash(testlane check *)", "Bash(testlane audit*)", "Bash(testlane status*)", "Bash(testlane account list*)",
      "mcp__testlane"
    ],
    "deny": [
      "Bash(testlane store set*)", "Bash(testlane * store set*)",
      "Bash(testlane account set*)", "Bash(testlane * account set*)",
      "Bash(testlane account clear*)", "Bash(testlane * account clear*)",
      "Bash(testlane rotate*)", "Bash(testlane * rotate*)",
      "Bash(testlane --profiles*)", "Bash(testlane * --profiles*)", "Bash(testlane * --force*)",
      "Bash(*TESTLANE_HOME*)", "Bash(*TESTLANE_PROFILES*)",
      "Bash(*AGENT_AUTH_HOME*)", "Bash(*AGENT_AUTH_PROFILES*)",
      "Bash(*store set*)", "Bash(*store delete*)", "Bash(*account set*)", "Bash(*account clear*)",
      "Bash(*testlane*rotate*)", "Bash(*agent-auth*rotate*)",
      "Read(~/.testlane/store/**)",
      "Edit(~/.testlane/*.overrides.json)", "Write(~/.testlane/*.overrides.json)",
      "Edit(**/testlane.profiles.json)", "Write(**/testlane.profiles.json)",
      "Edit(**/agent-auth.profiles.json)", "Write(**/agent-auth.profiles.json)"
    ]
  }
}
```

The complete, tested file for one harness is in `examples/claude-code/settings.json`, with a
guide in [INTEGRATION-CLAUDE-CODE.md](../INTEGRATION-CLAUDE-CODE.md).

Design notes:

- **Deny wins.** In harnesses where deny rules take precedence, a broad allow can never re-enable
  a human-only command. Check that your harness behaves this way before relying on it.
- **Catch-alls for rare phrases, scoped catch-alls for common words.** `store set` is rare enough
  for `*store set*`. `rotate` is a common word, so scope it to the broker: `*testlane*rotate*`, and
  the same for the other launchers (`*cli.ts*rotate*`, `*cli.js*rotate*`).
- **Deny the files as well as the commands.** The encrypted store directory, the overrides file
  and the profiles file are off limits to reads or writes by the agent.
- **Keep legacy deny rules.** The public package installs only `testlane`, but older
  checkouts and legacy registry/home names can remain. Keep `*agent-auth*rotate*` and
  the legacy file/environment rules; the `store` and `account` catch-alls cover any launcher.

### Twin every rule for every shell tool

If the harness exposes more than one shell tool, each allow and deny rule needs an identical twin
for each tool (`Bash(...)` and `PowerShell(...)`, for example). Keep them in lockstep with a test,
so nobody adds a rule to one list and forgets the other:

```ts
const TOOLS = ["Bash", "PowerShell"];
const patterns = (list: string[], tool: string) =>
  list.filter((r) => r.startsWith(`${tool}(`)).map((r) => r.slice(tool.length + 1, -1)).sort();

for (const list of [settings.permissions.allow, settings.permissions.deny]) {
  expect(patterns(list, "PowerShell")).toEqual(patterns(list, "Bash"));
}
```

When a harness adds a new shell tool, the twin set grows; treat that as a security change.

### Live with the false positives

The catch-alls will block harmless commands (`grep` for the phrase, `testlane audit | grep rotate`).
The registry/home environment-name rules also block searches mentioning those names. Keep the
human-only protections; inspect configuration as the human or phrase an unrelated search more
narrowly. Do not add broad allow rules or remove denials to work around them.

### Never rely on the rules alone

Assume an agent (especially one steered by prompt injection) can eventually run any command it
can construct. What must still hold, and does, because the broker enforces it:

- production-tagged profiles and hosts declared production are refused on every surface;
- normal broker paths do not deliberately return stored passwords. Raw values and registered
  encoded forms are redacted, with [documented transformation and output limits](../threat-model.md#9-known-limits).
  Stored credentials are sent only to their approved origin under their own profile tag;
- MCP and HTTP have no store, account or rotate operation at all.

What the rules protect is the human-only commands. If an agent reaches them anyway it can deny
service (`store delete`, `store set` with a wrong value), lock accounts (`rotate`), or make the
broker send a stored password with a different email on the same origin (`account set`). Reduce
that exposure where you can: run the agent under a separate OS user or in a container without the
broker's store, and review `testlane audit` for `store.set`, `store.delete` and `rotate` rows you did not
initiate.

### Harnesses without rule lists

Some harnesses offer a sandbox and an instructions file instead of per-command rules. Put the
human-only list in the instructions, restrict writes to the working tree, and keep the broker's
state directory outside it. Instructions steer; they do not enforce.

## Checklist

- [ ] Every broker command is classified agent, human-only or ask.
- [ ] Allow and deny rules cover the project-local, installed-bin and source-checkout launchers.
- [ ] Each human-only command is denied in its plain form and its "global option first" form.
- [ ] `--force`, `--profiles` in either position and registry/home environment overrides are denied.
- [ ] Every rule has a twin for each shell tool, and a test keeps the twins in lockstep.
- [ ] The store directory, the overrides file and the profiles file are denied to the agent's file tools.
- [ ] Catch-alls are scoped for common words; their false positives are documented.
- [ ] The team has checked what an agent could do if it bypassed every rule, and accepted or reduced it.
