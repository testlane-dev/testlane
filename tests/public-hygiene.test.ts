/**
 * Public-release hygiene: the files that `node scripts/export-public.mjs` would export
 * contain no private names and no non-allowlisted URLs, and the private folder never
 * reaches the export. Uses the script's own scanner.
 *
 * The private names themselves are not in this file (it is public). The scanner reads them
 * from `docs/private/hygiene-terms.json`, which exists only in the private repository, so
 * the cases below inject made-up terms (globex, initech) through the scanner's API, and the
 * one case that uses the real list is skipped when the file is absent and never prints a
 * term: failures show `path:line:rule`.
 *
 * Cases that need `git ls-files` (the public file set is defined by git) are skipped when
 * the suite runs outside a git work tree, e.g. from a ZIP download or a fresh export before
 * `git init`. Their titles say so. The words of the public placeholder and brand rules are
 * assembled at runtime so the scanner does not flag the test itself.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PRIVATE_TERMS_FILE,
  REPO_ROOT,
  UsageError,
  compilePrivateRules,
  exportListing,
  formatFinding,
  globToRegExp,
  hasTrackedPrivateFiles,
  isAllowedUrl,
  isExcluded,
  isGitWorkTree,
  loadPrivateRules,
  main,
  scanFiles,
  scanPlaceholders,
  scanText,
} from "../scripts/export-public.mjs";

const IN_GIT_WORK_TREE = isGitWorkTree(REPO_ROOT);
const NEEDS_GIT = "(runs only inside a git work tree; skipped in a ZIP download or an export before git init)";

const GIT_BINARY = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const NEEDS_GIT_BINARY = "(runs only when git is installed)";

const REAL_TERMS_FILE = path.join(REPO_ROOT, ...PRIVATE_TERMS_FILE.split("/"));
const HAS_REAL_TERMS = fs.existsSync(REAL_TERMS_FILE);

/** Made-up private terms, injected through the API. */
const MADE_UP_TERMS = {
  version: 1,
  rules: [
    { rule: "private-org", pattern: "(?<![a-z0-9])globex(?![a-z0-9])", flags: "gi" },
    { rule: "private-app", pattern: "initech[ _.-]?portal", flags: "gi" },
    { rule: "private-app", pattern: "initech-mvp" },
    { rule: "personal", pattern: "(?<![a-z0-9])hank(?![a-z0-9])", flags: "i" },
    { rule: "private-host", pattern: "globex-demo\\.app", flags: "gi" },
  ],
};

/** The parent environment without GIT_* variables, so fixture repositories never inherit this checkout's git state. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testlane-hygiene-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let cachedListing: string[] | undefined;
/** The public file set of this checkout (computed on first use; needs a git work tree). */
const listing = (): string[] => (cachedListing ??= exportListing(REPO_ROOT));

describe("public export listing", () => {
  it(`is non-empty and includes the core public files ${NEEDS_GIT}`, { skip: !IN_GIT_WORK_TREE }, () => {
    expect(listing().length).toBeGreaterThan(10);
    for (const f of [
      "README.md",
      "package.json",
      "src/cli.ts",
      "examples/testlane.profiles.json",
      // The demo app is part of the public repository (only the npm package leaves it out).
      "examples/demo-app/package.json",
      "examples/demo-app/scripts/smoke.mjs",
    ]) {
      expect(listing()).toContain(f);
    }
    expect(listing().filter((f) => f.includes("/node_modules/") || f.includes("/.next/"))).toEqual([]);
  });

  it(`keeps docs/private/, output/ and .claude/ out of the listing ${NEEDS_GIT}`, { skip: !IN_GIT_WORK_TREE }, () => {
    expect(listing().filter((f) => f.startsWith("docs/private/"))).toEqual([]);
    expect(listing().filter((f) => f.startsWith("output/") || f.startsWith(".claude/"))).toEqual([]);
    expect(listing()).not.toContain(PRIVATE_TERMS_FILE);
  });

  it("excludes docs/private/ (including the private term list), output/ and .claude/", () => {
    expect(isExcluded("docs/private/README.md")).toBe(true);
    expect(isExcluded("docs/private/examples/x.json")).toBe(true);
    expect(isExcluded(PRIVATE_TERMS_FILE)).toBe(true);
    expect(isExcluded("docs/privateer.md")).toBe(false);
    expect(isExcluded("output/run-1.log")).toBe(true);
    expect(isExcluded(".claude/settings.local.json")).toBe(true);
  });

  it("applies .publicignore-style patterns", () => {
    const dir = globToRegExp("coverage/");
    const ext = globToRegExp("*.log");
    const anchored = globToRegExp("/notes/**/draft.md");
    expect(globToRegExp("# comment")).toBeNull();
    expect(globToRegExp("   ")).toBeNull();
    expect(dir?.test("coverage/index.html")).toBe(true);
    expect(dir?.test("pkg/coverage/x")).toBe(true);
    expect(ext?.test("a/b/run.log")).toBe(true);
    expect(ext?.test("a/b/run.logx")).toBe(false);
    expect(anchored?.test("notes/a/b/draft.md")).toBe(true);
    expect(anchored?.test("x/notes/a/draft.md")).toBe(false);
  });

  it("reports a missing git work tree as a usage error, not a raw git failure", () => {
    const plain = tmpDir();
    expect(isGitWorkTree(plain)).toBe(false);
    expect(() => exportListing(plain)).toThrow(UsageError);
    expect(() => exportListing(plain)).toThrow(/not inside a git work tree/);
  });

  it(`is true only at the top of a work tree, not in a folder nested inside it ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
    const top = tmpDir();
    execFileSync("git", ["init", "-q"], { cwd: top, env: cleanGitEnv(), stdio: "ignore" });
    const nested = path.join(top, "nested");
    fs.mkdirSync(nested);
    expect(isGitWorkTree(top)).toBe(true);
    expect(isGitWorkTree(nested)).toBe(false);
    expect(isGitWorkTree(path.join(top, ".git"))).toBe(false);
  });
});

describe("scanner rules", () => {
  const word = (...parts: string[]) => parts.join("");
  const privateRules = compilePrivateRules(MADE_UP_TERMS);

  it("flags injected private names case-insensitively, with file:line:match", () => {
    const text = [
      "clean line",
      `account agent@${word("Glo", "BEX")}.test`,
      `${word("Initech", " Portal")} and ${word("initech", "portal")} and ${word("INITECH", ".", "Portal")}`,
      `${word("initech", "-mvp")} ${word("Gl", "obex")} ${word("HA", "NK")}`,
      `see https://x.${word("globex", "-demo.app")}/y`,
    ].join("\n");
    const findings = scanText("doc.md", text, { privateRules });
    expect(findings.map((f) => f.line)).not.toContain(1);
    expect(findings.map(formatFinding)).toContain(`doc.md:2:${word("Glo", "BEX")}`);
    expect(findings.filter((f) => f.line === 3).map((f) => f.rule)).toEqual(["private-app", "private-app", "private-app"]);
    expect(findings.filter((f) => f.line === 4).map((f) => f.rule)).toEqual(["private-org", "private-app", "personal"]);
    expect(findings.some((f) => f.line === 5 && f.rule === "private-host")).toBe(true);
    expect(findings.some((f) => f.line === 5 && f.rule === "url-not-allowlisted")).toBe(true);
  });

  it("applies no private rules unless they are injected", () => {
    const text = `${word("glo", "bex")} ${word("initech", "-mvp")} ${word("ha", "nk")}`;
    expect(scanText("doc.md", text)).toEqual([]);
    expect(scanText("doc.md", text, { privateRules: null })).toEqual([]);
    expect(scanText("doc.md", text, { privateRules: [] })).toEqual([]);
    expect(scanText("doc.md", text, { privateRules }).length).toBe(3);
  });

  it("accepts injected rules without the g flag", () => {
    const rules = [{ rule: "private-org", re: /globex/i }];
    expect(scanText("doc.md", "Globex and globex", { privateRules: rules })).toHaveLength(2);
  });

  it("flags the old brand spelling, case-sensitively", () => {
    const old = word("Test", "Lane");
    expect(scanText("README.md", `# ${old}`).map((f) => f.rule)).toEqual(["brand-spelling"]);
    expect(scanText("README.md", "# Testlane, the `testlane` CLI, TESTLANE_HOME")).toEqual([]);
  });

  it("flags leftover placeholders only in release mode", () => {
    const owner = word("OW", "NER");
    const text = [
      `repo: ${owner}/testlane still needs renaming`,
      `npm i -g ${word("@SC", "OPE")}/x`,
      `contact ${word("SECURITY", "_CONTACT")} or ${word("CONDUCT", "_CONTACT")}`,
      `Welcome to ${word("NA", "ME")}`,
    ].join("\n");
    expect(scanText("doc.md", text)).toEqual([]);
    const rules = scanPlaceholders("doc.md", text).map((f) => `${f.line}:${f.rule}`);
    expect(rules).toEqual([
      "1:placeholder-owner",
      "2:placeholder-scope",
      "3:placeholder-contact",
      "3:placeholder-contact",
      "4:placeholder-name",
    ]);
    // A NAME column header in code is not a placeholder; the other tokens still are.
    expect(scanPlaceholders("src/cli.ts", `const rows = [["${word("NA", "ME")}", "ENV"]];`)).toEqual([]);
    expect(scanPlaceholders("src/x.ts", `// ${word("SECURITY", "_CONTACT")}`)).toHaveLength(1);
  });

  it("rejects unknown flags and a target directory combined with --check", () => {
    expect(main(["--bogus"])).toBe(2);
    expect(main(["--check", "somewhere"])).toBe(2);
  });

  it("flags injected private names in the path itself as line 0", () => {
    const findings = scanText(`examples/profiles.${word("initech", "-portal")}.json`, "{}", { privateRules });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(0);
  });

  it("checks the path of binary files against injected rules too", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, `${word("glo", "bex")}.bin`), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(dir, "clean.bin"), Buffer.from([0, 1, 2, 3]));
    const findings = scanFiles(dir, [`${word("glo", "bex")}.bin`, "clean.bin"], { privateRules });
    expect(findings.map((f) => `${f.line}:${f.rule}`)).toEqual(["0:private-org"]);
  });

  it("does not trip on base64 lockfile hashes or embedded letters", () => {
    const hash = `      "integrity": "sha512-ab${word("Glo", "bexE")}8hpqLolJ9Rl+SkIRDpyw==",`;
    expect(scanText("package-lock.json", hash, { privateRules })).toEqual([]);
    expect(scanText("a.md", `x${word("glo", "bex")}y`, { privateRules })).toEqual([]);
  });

  it("allows only allowlisted public URLs and reserved example domains", () => {
    const u = (hostAndPath: string) => `https:/${"/"}${hostAndPath}`;
    expect(isAllowedUrl(u("github.com/actions/checkout"))).toBe(true);
    expect(isAllowedUrl(u("github.com/someone/repo"))).toBe(false);
    expect(isAllowedUrl(u("github.com/actionsx"))).toBe(false);
    expect(isAllowedUrl(u("github.com/expressjs/express/tree/0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8/examples/auth"))).toBe(true);
    expect(isAllowedUrl(u("github.com/expressjs/express-lookalike"))).toBe(false);
    expect(isAllowedUrl(u("docs.github.com/en"))).toBe(true);
    expect(isAllowedUrl(u("www.npmjs.com/package/x"))).toBe(true);
    expect(isAllowedUrl(u("nodejs.org/en"))).toBe(true);
    expect(isAllowedUrl(u("docs.anthropic.com/"))).toBe(true);
    expect(isAllowedUrl(u("attacker.example.net/login"))).toBe(true);
    expect(isAllowedUrl(u("notexample.com/"))).toBe(false);
    expect(isAllowedUrl(u("evil.dev/"))).toBe(false);
    expect(scanText("a.md", "see https://staging.acme.test and http://localhost:3000")).toEqual([]);
    expect(scanText("a.md", `see ${u("tracker.io/x")}`)).toHaveLength(1);
    // Generated lockfiles (at any depth) are exempt from the URL rule, not from the word rules.
    expect(scanText("examples/app/package-lock.json", `"funding": "${u("tracker.io/x")}"`)).toEqual([]);
    expect(scanText("examples/app/package-lock.json", `"name": "@${word("glo", "bex")}/x"`, { privateRules })).toHaveLength(1);
  });
});

describe("private term list", () => {
  it("compiles rules, adds the g flag and keeps the rule names", () => {
    const rules = compilePrivateRules(MADE_UP_TERMS);
    expect(rules.map((r) => r.rule)).toEqual(["private-org", "private-app", "private-app", "personal", "private-host"]);
    for (const r of rules) expect(r.re.flags).toContain("g");
    expect(rules[1]?.re.flags).toBe("gi");
    expect(rules[2]?.re.flags).toBe("g");
    expect(rules[3]?.re.flags).toBe("gi");
  });

  it("rejects malformed lists without echoing a pattern", () => {
    const secretish = "never-print-this-pattern";
    const bad: unknown[] = [
      null,
      "x",
      { version: 2, rules: [] },
      { version: 1 },
      { version: 1, rules: [null] },
      { version: 1, rules: [{ rule: "r" }] },
      { version: 1, rules: [{ rule: "", pattern: secretish }] },
      { version: 1, rules: [{ rule: "r", pattern: secretish, flags: "x" }] },
      { version: 1, rules: [{ rule: "r", pattern: secretish, flags: 7 }] },
      { version: 1, rules: [{ rule: "r", pattern: `(${secretish}` }] },
    ];
    for (const data of bad) {
      let message = "";
      try {
        compilePrivateRules(data);
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(data)).not.toBe("");
      expect(message).not.toContain(secretish);
    }
    expect(() => compilePrivateRules({ version: 1, rules: [{ rule: "r", pattern: `(${secretish}` }] })).toThrow(
      /rule #1 \(r\).*does not compile/,
    );
  });

  it("loads a terms file and scans with it", () => {
    const file = path.join(tmpDir(), "terms.json");
    fs.writeFileSync(file, JSON.stringify(MADE_UP_TERMS));
    const rules = loadPrivateRules(file);
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(MADE_UP_TERMS.rules.length);
    const findings = scanText("doc.md", `a ${"glo"}${"bex"} b`, { privateRules: rules });
    expect(findings.map((f) => `${f.line}:${f.rule}`)).toEqual(["1:private-org"]);
  });

  it("treats a missing terms file as 'no private rules', not an error", () => {
    expect(loadPrivateRules(path.join(tmpDir(), "absent.json"))).toBeNull();
  });

  it("fails closed on an unreadable or malformed terms file, without echoing its content", () => {
    const dir = tmpDir();
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, '{"version": 1, "rules": [never-print-this-content');
    expect(() => loadPrivateRules(broken)).toThrow(UsageError);
    expect(() => loadPrivateRules(broken)).toThrow(/is not valid JSON/);
    try {
      loadPrivateRules(broken);
    } catch (err) {
      expect((err as Error).message).not.toContain("never-print-this-content");
    }
    // A directory in place of the file: unreadable, still a usage error.
    expect(() => loadPrivateRules(dir)).toThrow(UsageError);
  });
});

describe("CLI in a fixture repository", () => {
  const MISSING_NOTICE = `note: no private term list (${PRIVATE_TERMS_FILE}); private-name rules skipped`;

  /** A fresh git repo with a copy of the script, the given files and optionally a terms file. */
  function fixtureRepo(files: Record<string, string>, terms?: string): string {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "export-public.mjs"), path.join(dir, "scripts", "export-public.mjs"));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    if (terms !== undefined) {
      fs.mkdirSync(path.join(dir, "docs", "private"), { recursive: true });
      fs.writeFileSync(path.join(dir, ...PRIVATE_TERMS_FILE.split("/")), terms);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir, env: cleanGitEnv(), stdio: "ignore" });
    return dir;
  }

  function cli(dir: string, ...args: string[]) {
    const r = spawnSync(process.execPath, [path.join(dir, "scripts", "export-public.mjs"), ...args], {
      cwd: dir,
      env: cleanGitEnv(),
      encoding: "utf8",
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  const notices = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("note:"));

  it(`prints one notice and skips private rules when there is no term list ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
    const dir = fixtureRepo({ "README.md": `# Demo\n\n${"glo"}${"bex"} is only a word here.\n` });
    const r = cli(dir, "--check");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(notices(r.stderr)).toEqual([MISSING_NOTICE]);
    expect(r.stderr).toContain("clean: no forbidden content");
  });

  it(`prints the single notice in release and export mode too ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
    const dir = fixtureRepo({ "README.md": "# Demo\n" });
    expect(notices(cli(dir, "--release").stderr)).toEqual([MISSING_NOTICE]);
    const dest = path.join(tmpDir(), "out");
    const r = cli(dir, dest);
    expect(r.code).toBe(0);
    expect(notices(r.stderr)).toEqual([MISSING_NOTICE]);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  it(`applies the term list when present, prints no notice, and never scans or exports it ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
    const terms = JSON.stringify(MADE_UP_TERMS);
    const clean = fixtureRepo({ "README.md": "# Demo\n" }, terms);
    const ok = cli(clean, "--check");
    // The term list itself spells the made-up terms, but docs/private/ is not scanned.
    expect(ok.code).toBe(0);
    expect(notices(ok.stderr)).toEqual([]);

    const dirty = fixtureRepo({ "README.md": `# Demo\n\nPowered by ${"Glo"}${"bex"}.\n` }, terms);
    const bad = cli(dirty, "--check");
    expect(bad.code).toBe(1);
    expect(bad.stdout.trim().split("\n")).toEqual([`README.md:3:${"Glo"}${"bex"}`]);
    expect(notices(bad.stderr)).toEqual([]);

    const dest = path.join(tmpDir(), "out");
    const exported = cli(clean, dest);
    expect(exported.code).toBe(0);
    expect(fs.existsSync(path.join(dest, "docs", "private"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  it(`exits 2 on a malformed term list without printing its content ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
    const secretish = "never-print-this-pattern";
    const dir = fixtureRepo(
      { "README.md": "# Demo\n" },
      JSON.stringify({ version: 1, rules: [{ rule: "private-org", pattern: `(${secretish}`, flags: "gi" }] }),
    );
    const r = cli(dir, "--check");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("rule #1 (private-org)");
    expect(r.stderr).not.toContain(secretish);
  });

  describe("a missing term list", () => {
    /** Make git track `rel` (the fixture repo starts with nothing staged). */
    function track(dir: string, rel: string): void {
      execFileSync("git", ["add", "--", rel], { cwd: dir, env: cleanGitEnv(), stdio: "ignore" });
    }

    const PRIVATE_NOTE = `${"glo"}${"bex"} is a made-up private term that must never be echoed.\n`;

    it(`is an error where git tracks other files under docs/private/ (the private repo lost its list) ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
      const dir = fixtureRepo({ "README.md": "# Demo\n", "docs/private/README.md": PRIVATE_NOTE });
      track(dir, "docs/private/README.md");
      expect(hasTrackedPrivateFiles(dir)).toBe(true);

      const r = cli(dir, "--check");
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`export-public: private term list: ${PRIVATE_TERMS_FILE} is missing`);
      expect(r.stderr).not.toContain("clean:");
      expect(notices(r.stderr)).toEqual([]);
      // The file is named, no term is ever printed.
      expect(r.stderr.toLowerCase()).not.toContain("glo" + "bex");

      // Release and export mode fail the same way, and nothing is exported.
      expect(cli(dir, "--release").code).toBe(2);
      const dest = path.join(tmpDir(), "out");
      const exported = cli(dir, dest);
      expect(exported.code).toBe(2);
      expect(fs.existsSync(dest)).toBe(false);
    });

    it(`is only a note in the public repo, which has no docs/private/ at all ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
      const dir = fixtureRepo({ "README.md": "# Demo\n" });
      track(dir, "README.md");
      expect(hasTrackedPrivateFiles(dir)).toBe(false);
      const r = cli(dir, "--check");
      expect(r.code).toBe(0);
      expect(notices(r.stderr)).toEqual([MISSING_NOTICE]);
      expect(r.stderr).toContain("clean: no forbidden content");
    });

    it(`is fine when the list is there, even with other tracked files under docs/private/ ${NEEDS_GIT_BINARY}`, { skip: !GIT_BINARY }, () => {
      const dir = fixtureRepo(
        { "README.md": "# Demo\n", "docs/private/README.md": PRIVATE_NOTE },
        JSON.stringify(MADE_UP_TERMS),
      );
      track(dir, "docs/private/README.md");
      track(dir, PRIVATE_TERMS_FILE);
      const r = cli(dir, "--check");
      expect(r.code).toBe(0);
      expect(notices(r.stderr)).toEqual([]);
    });

    it("asks nothing outside a git work tree (a ZIP download keeps today's skip)", () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "docs", "private"), { recursive: true });
      fs.writeFileSync(path.join(dir, "docs", "private", "README.md"), PRIVATE_NOTE);
      expect(hasTrackedPrivateFiles(dir)).toBe(false);
    });
  });

  it("exits 2 with a plain message when run outside a git work tree", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "export-public.mjs"), path.join(dir, "scripts", "export-public.mjs"));
    const r = cli(dir, "--check");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not inside a git work tree");
    expect(r.stderr).not.toContain("fatal:");
  });
});

describe("public file set", () => {
  it(`has zero hygiene findings under the public rules ${NEEDS_GIT}`, { skip: !IN_GIT_WORK_TREE }, () => {
    const findings = scanFiles(REPO_ROOT, listing()).map(formatFinding);
    expect(findings, `forbidden content in exported files:\n${findings.join("\n")}`).toEqual([]);
  });
});

/**
 * Uses the real private term list, so it runs only in the private repository. A failure
 * prints `path:line:rule`, never the matched text or a pattern.
 */
describe("the real private term list (runs only where docs/private/hygiene-terms.json exists)", () => {
  const KNOWN_RULES = ["private-org", "private-app", "personal", "private-host", "private-branch", "private-env"];

  it("parses, and every pattern compiles", { skip: !HAS_REAL_TERMS }, () => {
    const data = JSON.parse(fs.readFileSync(REAL_TERMS_FILE, "utf8")) as { version: unknown; rules: { rule: string }[] };
    expect(data.version).toBe(1);
    const rules = loadPrivateRules();
    expect(rules).not.toBeNull();
    expect(rules?.length).toBe(data.rules.length);
    const names = (rules ?? []).map((r) => r.rule);
    for (const name of names) {
      const safeLabel = KNOWN_RULES.includes(name) || /^private-integration-contract-[0-9]{2}$/.test(name);
      expect(safeLabel, `unknown rule name ${name}`).toBe(true);
    }
    for (const name of KNOWN_RULES) expect(names, `no rule named ${name}`).toContain(name);
  });

  it(`finds nothing in the public file set ${NEEDS_GIT}`, { skip: !HAS_REAL_TERMS || !IN_GIT_WORK_TREE }, () => {
    const privateRules = loadPrivateRules();
    const findings = scanFiles(REPO_ROOT, listing(), { privateRules }).map((f) => `${f.file}:${f.line}:${f.rule}`);
    expect(findings, "private names in the public file set (path:line:rule)").toEqual([]);
  });
});
