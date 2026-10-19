/**
 * Guards examples/claude-code/settings.json: Bash and PowerShell rules stay in
 * lockstep (Claude Code's PowerShell tool ignores Bash(...) rules), the deny
 * list covers every human-only / registry-swapping / overwriting form on every
 * launcher, and no allow rule opens a human-only command.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsFile = path.resolve(here, "..", "examples", "claude-code", "settings.json");

interface Settings {
  permissions: { allow: string[]; deny: string[] };
}

const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Settings;
const { allow, deny } = settings.permissions;

const LAUNCHERS = [
  "npx --no-install testlane",
  "npx.cmd --no-install testlane",
  "node node_modules/@testlane/cli/dist/cli.js",
  "testlane",
  "testlane.cmd",
  "npx tsx src/cli.ts",
  "node dist/cli.js",
] as const;
/** Older checkouts can retain this launcher; keep its human-only commands denied. */
const LEGACY_LAUNCHER = "agent-auth";
const TOOLS = ["Bash", "PowerShell"] as const;
/** Human-only commands: never allowed, always denied. */
const HUMAN_ONLY = ["store set", "store delete", "account set", "account clear", "rotate"] as const;
/**
 * The catch-all deny rules per human-only command. `rotate` is a common word
 * (log rotation, image rotation), so its catch-alls are scoped to the broker's
 * launchers instead of `*rotate*`.
 */
const CATCH_ALLS: Record<(typeof HUMAN_ONLY)[number], readonly string[]> = {
  "store set": ["*store set*"],
  "store delete": ["*store delete*"],
  "account set": ["*account set*"],
  "account clear": ["*account clear*"],
  rotate: ["*testlane*rotate*", "*agent-auth*rotate*", "*cli.ts*rotate*", "*cli.js*rotate*"],
};

/** The pattern inside `Tool(...)`, or null for a rule of another tool. */
function patternOf(rule: string, tool: string): string | null {
  const prefix = `${tool}(`;
  return rule.startsWith(prefix) && rule.endsWith(")") ? rule.slice(prefix.length, -1) : null;
}

function patterns(rules: readonly string[], tool: string): string[] {
  return rules.map((r) => patternOf(r, tool)).filter((p): p is string => p !== null);
}

/** Static wildcard check only; this does not emulate Claude Code shell parsing or permissions. */
function matches(pattern: string, command: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(command);
}

function denied(tool: string, command: string): boolean {
  return patterns(deny, tool).some((p) => matches(p, command));
}

function allowed(tool: string, command: string): boolean {
  return patterns(allow, tool).some((p) => matches(p, command));
}

describe("examples/claude-code/settings.json", () => {
  it("has an identical PowerShell(...) twin for every Bash(...) rule, and vice versa", () => {
    for (const list of [allow, deny]) {
      expect(patterns(list, "PowerShell").sort()).toEqual(patterns(list, "Bash").sort());
      expect(patterns(list, "Bash").length).toBeGreaterThan(0);
    }
  });

  it("denies every human-only, --profiles and --force form on every launcher, for both tools", () => {
    for (const tool of TOOLS) {
      for (const launcher of LAUNCHERS) {
        const commands = [
          ...HUMAN_ONLY.map((c) => `${launcher} ${c} some:profile`),
          ...HUMAN_ONLY.map((c) => `${launcher} --requester x ${c} some:profile`),
          `${launcher} account set some:profile --email a@b.test`,
          `${launcher} --profiles evil.json session some:profile`,
          `${launcher} --profiles=evil.json session some:profile`,
          `${launcher} --requester x --profiles evil.json session some:profile`,
          `${launcher} session some:profile --profiles evil.json`,
          `${launcher} session some:profile --profiles=evil.json`,
          `${launcher} session some:profile --out .claude/settings.json --force`,
        ];
        for (const command of commands) expect(denied(tool, command), `${tool}: ${command}`).toBe(true);
      }
      // Catch-alls: other launchers and piped input.
      for (const c of HUMAN_ONLY) {
        expect(denied(tool, `npx testlane ${c} some:profile`), `${tool}: npx ${c}`).toBe(true);
        expect(denied(tool, `echo x | testlane ${c} some:profile`), `${tool}: piped ${c}`).toBe(true);
        expect(denied(tool, `npx -y @testlane/cli@latest ${c} some:profile`), `${tool}: versioned npx ${c}`).toBe(true);
        // Older `agent-auth` launchers: plain, with a global option first, and via npx.
        expect(denied(tool, `${LEGACY_LAUNCHER} ${c} some:profile`), `${tool}: legacy ${c}`).toBe(true);
        expect(denied(tool, `${LEGACY_LAUNCHER} --requester x ${c} some:profile`), `${tool}: legacy ${c}`).toBe(true);
        expect(denied(tool, `npx ${LEGACY_LAUNCHER} ${c} some:profile`), `${tool}: legacy npx ${c}`).toBe(true);
      }
      // rotate from a scheduled-task style wrapper or an absolute path is denied too.
      for (const command of [
        "TESTLANE_REQUESTER=x testlane rotate some:profile",
        "AGENT_AUTH_REQUESTER=x agent-auth rotate some:profile",
        "node C:/tools/testlane/dist/cli.js rotate some:profile",
        "npx tsx C:/src/testlane/src/cli.ts --requester x rotate some:profile",
      ]) {
        expect(denied(tool, command), `${tool}: ${command}`).toBe(true);
      }
    }
    for (const c of HUMAN_ONLY) {
      for (const tool of TOOLS) {
        for (const catchAll of CATCH_ALLS[c]) expect(deny).toContain(`${tool}(${catchAll})`);
      }
    }
    // The store, the overrides file and the registries, under the current and the pre-rename names.
    for (const rule of [
      "Read(~/.testlane/store/**)",
      "Read(~/.agent-auth/store/**)",
      "Edit(~/.testlane/*.overrides.json)",
      "Write(~/.testlane/*.overrides.json)",
      "Edit(~/.agent-auth/*.overrides.json)",
      "Write(~/.agent-auth/*.overrides.json)",
      "Edit(**/testlane.profiles.json)",
      "Write(**/testlane.profiles.json)",
      "Edit(**/agent-auth.profiles.json)",
      "Write(**/agent-auth.profiles.json)",
      "Edit(~/.testlane/*.profiles.json)",
      "Write(~/.testlane/*.profiles.json)",
      "Edit(~/.agent-auth/*.profiles.json)",
      "Write(~/.agent-auth/*.profiles.json)",
    ]) {
      expect(deny).toContain(rule);
    }
  });

  it("denies current and legacy registry/home environment overrides without allowing them", () => {
    for (const tool of TOOLS) {
      for (const launcher of LAUNCHERS) {
        for (const variable of ["TESTLANE_HOME", "TESTLANE_PROFILES", "AGENT_AUTH_HOME", "AGENT_AUTH_PROFILES"]) {
          for (const command of [
            `${variable}=other ${launcher} check some:profile`,
            `env ${variable}=other ${launcher} session some:profile`,
            `$env:${variable} = 'other'; ${launcher} check some:profile`,
            `Set-Item Env:${variable} other; ${launcher} profiles`,
          ]) {
            expect(denied(tool, command), `${tool}: ${command}`).toBe(true);
            expect(allowed(tool, command), `${tool}: ${command}`).toBe(false);
          }
        }
      }
    }
  });

  it("does not allow downloading an unpinned CLI or an unreviewed launcher", () => {
    for (const tool of TOOLS) {
      for (const command of [
        "npx testlane profiles",
        "npx -y @testlane/cli@latest session some:profile",
        "node /other/project/node_modules/@testlane/cli/dist/cli.js profiles",
        "npm run broker -- session some:profile",
      ]) expect(allowed(tool, command), `${tool}: ${command}`).toBe(false);
    }
  });

  it("never allows store set/delete, account set/clear or rotate, and does allow the agent commands", () => {
    for (const rule of allow) {
      for (const c of HUMAN_ONLY) expect(rule, rule).not.toContain(c);
    }
    for (const tool of TOOLS) {
      for (const launcher of LAUNCHERS) {
        for (const c of HUMAN_ONLY) expect(allowed(tool, `${launcher} ${c} some:profile`)).toBe(false);
        for (const command of [
          `${launcher} profiles`,
          `${launcher} session some:profile --format curl --out cookies.txt`,
          `${launcher} check some:profile`,
          `${launcher} doctor`,
          `${launcher} doctor --check some:profile`,
          `${launcher} handoff some:profile`,
          `${launcher} audit --tail 20`,
          `${launcher} account list`,
          `${launcher} status`,
          `${launcher} status --json --max-age-days 30`,
          `${launcher} status --alert`,
        ]) {
          expect(allowed(tool, command), `${tool}: ${command}`).toBe(true);
          expect(denied(tool, command), `${tool}: ${command}`).toBe(false);
        }
      }
    }
    expect(allow).toContain("mcp__testlane");
    // The public package installs only testlane; legacy launcher denials remain defensive.
    for (const rule of allow) expect(rule).not.toContain(LEGACY_LAUNCHER);
  });
});
