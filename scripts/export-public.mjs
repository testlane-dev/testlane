#!/usr/bin/env node
/**
 * Public export + hygiene scanner.
 *
 *   node scripts/export-public.mjs <targetDir>   copy the public file set to <targetDir>
 *                                                (must not exist or be empty), then scan
 *                                                the copy; exit 1 on any finding
 *   node scripts/export-public.mjs --check       scan the same file set in place, copy
 *                                                nothing; exit 1 on any finding
 *   add --release to either form                 also fail on leftover placeholder tokens
 *                                                (a stray repository-owner placeholder, the
 *                                                pre-rename name/scope/contact placeholders),
 *                                                so they cannot ship by accident; `--release`
 *                                                alone means `--check --release`
 *
 * The public file set is every file git would track (`git ls-files --cached --others
 * --exclude-standard`, so .gitignore is respected and files deleted from the working
 * tree are skipped), minus the built-in exclusions below and every pattern in the
 * root `.publicignore`.
 *
 * Findings are printed one per line as `path:line:match` (line 0 = the path itself).
 *
 * Private names (organisation, app, host, personal and branch names) are NOT listed in
 * this file, because this file is public. They live as data in
 * `docs/private/hygiene-terms.json`, which the built-in `docs/private/` exclusion keeps
 * out of every export. The scanner loads that file when it exists and applies its rules
 * next to the public ones below; when it is absent (the public repository, a ZIP
 * download) those rules are skipped and the CLI prints one notice to stderr. The one
 * exception is the private repository itself: when the file is missing but git tracks
 * other files under `docs/private/`, the list was lost, and the CLI exits 2 instead of
 * silently scanning without it. Neither the loader nor any error message ever prints a
 * term or a pattern from that file.
 *
 * The module is importable (tests/public-hygiene.test.ts uses the same logic); the CLI
 * runs only when this file is the entry point. Callers that want private-name rules pass
 * them in (`scanText(rel, text, { privateRules })`, `scanFiles(.., { privateRules })`),
 * usually from `loadPrivateRules()`; the default is no private rules.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: the parent of scripts/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The private folder (never exported). Only the private repository tracks files here. */
const PRIVATE_DIR = "docs/private/";

/** Always excluded from the export (directory prefixes, forward slashes). */
export const BUILTIN_EXCLUDES = [PRIVATE_DIR, "output/", ".claude/"];

/** Name of the root file listing extra exclusions (one glob per line, `#` comments). */
export const PUBLIC_IGNORE_FILE = ".publicignore";

/**
 * Repo-relative path of the private term list (see the header). It sits under
 * `docs/private/`, so BUILTIN_EXCLUDES keeps it out of the export.
 */
export const PRIVATE_TERMS_FILE = "docs/private/hygiene-terms.json";

/**
 * Public forbidden content, matched as written (the bracketed letter keeps this file's own
 * text from matching, as in the placeholder rules below). The private-name rules are not
 * here: they come from PRIVATE_TERMS_FILE (see loadPrivateRules).
 */
export const FORBIDDEN_PATTERNS = [
  // Brand spelling: the project is "Testlane" in prose (capital T only). Case-sensitive.
  { rule: "brand-spelling", re: /Test[L]ane/g },
];

/**
 * Placeholder tokens that must be gone before a release (checked only with --release).
 * Plain --check ignores them, so a stray leftover placeholder in a work-in-progress file
 * does not block ordinary hygiene checks. `NAME` is checked only in prose/config files, because the
 * CLI's own table header (and tests) legitimately print a NAME column.
 */
export const PLACEHOLDER_PATTERNS = [
  { rule: "placeholder-owner", re: /(?<![A-Za-z0-9_])O[W]NER\//g },
  { rule: "placeholder-scope", re: /@S[C]OPE(?![A-Za-z0-9_])/g },
  { rule: "placeholder-contact", re: /(?<![A-Za-z0-9_])(?:S[E]CURITY|C[O]NDUCT)_CONTACT(?![A-Za-z0-9_])/g },
  { rule: "placeholder-name", re: /(?<![A-Za-z0-9_])N[A]ME(?![A-Za-z0-9_])/g, proseOnly: true },
];

/** Files where `proseOnly` placeholder rules apply: documentation and configuration, not code. */
export const PROSE_FILE_RE = /(^|\/)(LICENSE|[^/]*\.(md|markdown|txt|yml|yaml|toml)|package\.json)$/i;

/** Any absolute URL on a common public TLD; allowed only when on URL_ALLOWLIST. */
export const URL_PATTERN = /https?:\/\/[a-z0-9.-]+\.(?:com|net|org|io|dev|app)\b[^\s"'`<>)\]]*/gi;

/**
 * Allowed URL targets. A bare host allows that host and its subdomains; an entry with a
 * path (`host/prefix`) allows only URLs on exactly that host whose path starts with it.
 * example.com/.net/.org are RFC 2606 reserved names and never resolve to a real party.
 */
export const URL_ALLOWLIST = [
  "github.com/actions",
  "docs.github.com",
  "npmjs.com",
  "npmjs.org",
  "nodejs.org",
  "claude.com",
  "anthropic.com",
  // Official Codex MCP configuration reference used by the integration guide.
  "learn.chatgpt.com/docs/extend/mcp",
  "learn.chatgpt.com/guides/best-practices",
  "json.schemastore.org",
  "json-schema.org",
  "apache.org",
  // Canonical attribution links in CODE_OF_CONDUCT.md / CONTRIBUTING.md.
  "contributor-covenant.org",
  "github.com/mozilla/diversity",
  "developercertificate.org",
  // SVG XML namespace declared by every exported logo (never fetched).
  "www.w3.org/2000/svg",
  // Font attribution required by the SIL OFL for the wordmark (assets/brand/licenses).
  "scripts.sil.org/OFL",
  "github.com/Outfitio/Outfit-Fonts",
  "github.com/google/fonts",
  "raw.githubusercontent.com/google/fonts",
  // The public repository, under the testlane-dev organisation.
  "github.com/testlane-dev/testlane",
  "github.com/testlane-dev/testlane.git",
  // Public upstream HTML authentication example used in installed-package acceptance.
  "github.com/expressjs/express",
  // Reviewed public upstream references in the product roadmap and mobile proposal.
  "docs.autosana.ai/local-testing",
  "docs.autosana.ai/mcp-setup",
  "docs.autosana.ai/code-managed-flows",
  "appium.io/docs/en/latest/intro",
  "appium.io/docs/en/latest/ecosystem",
  "docs.maestro.dev/",
  "docs.maestro.dev/reference/commands-available/asserttrue.md",
  "docs.expo.dev/develop/development-builds/introduction",
  "docs.expo.dev/versions/v58.0.0/",
  "example.com",
  "example.net",
  "example.org",
];

/**
 * File names (at any depth) exempt from the URL rule only (forbidden words are still
 * checked): generated dependency metadata whose registry, funding and sponsor URLs name
 * third parties.
 */
export const URL_RULE_EXEMPT_FILES = ["package-lock.json"];

/** Lines skipped entirely: lockfile integrity hashes are opaque base64. */
const SKIP_LINE = /^\s*"integrity":\s*"sha\d+-[A-Za-z0-9+/=]+",?\s*$/;

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * Convert one .publicignore line to a RegExp over repo-relative posix paths.
 * Supports `*` (within a segment), `**` (any depth), a trailing `/` (directory and
 * everything under it) and a leading `/` (anchored at the root). A pattern without a
 * slash matches that name at any depth, like .gitignore.
 * @param {string} line
 * @returns {RegExp | null}
 */
export function globToRegExp(line) {
  let pat = line.trim();
  if (pat === "" || pat.startsWith("#")) return null;
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith("/") || pat.includes("/");
  if (pat.startsWith("/")) pat = pat.slice(1);
  let body = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*" && pat[i + 1] === "*") {
      body += ".*";
      i++;
      if (pat[i + 1] === "/") i++;
    } else if (c === "*") {
      body += "[^/]*";
    } else if (c === "?") {
      body += "[^/]";
    } else {
      body += /[.+^${}()|[\]\\]/.test(c ?? "") ? `\\${c}` : c;
    }
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}(?:/.*)?$`);
}

/**
 * @param {string} root
 * @returns {RegExp[]}
 */
export function loadPublicIgnore(root = REPO_ROOT) {
  const file = path.join(root, PUBLIC_IGNORE_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(globToRegExp)
    .filter((re) => re !== null);
}

/**
 * @typedef {{ rule: string, re: RegExp }} Rule  a compiled rule; `re` always carries the `g` flag
 */

/**
 * Compile the parsed contents of a private term list:
 * `{ "version": 1, "rules": [{ "rule": "<name>", "pattern": "<regex source>", "flags": "gi" }] }`.
 * `flags` is optional and `g` is always added. Word-like patterns should be bounded by
 * non-alphanumerics (lookarounds) so that base64 blobs (lockfile integrity hashes) do not
 * trip them. Errors name the rule's position and name only: they never include the pattern
 * (a RegExp or JSON SyntaxError message would).
 * @param {unknown} data
 * @returns {Rule[]}
 */
export function compilePrivateRules(data) {
  if (typeof data !== "object" || data === null || /** @type {{ version?: unknown }} */ (data).version !== 1) {
    throw new UsageError("private term list: expected an object with version 1");
  }
  const list = /** @type {{ rules?: unknown }} */ (data).rules;
  if (!Array.isArray(list)) throw new UsageError("private term list: `rules` must be an array");
  return list.map((entry, i) => {
    const n = i + 1;
    const rule = typeof entry === "object" && entry !== null ? entry.rule : undefined;
    const pattern = typeof entry === "object" && entry !== null ? entry.pattern : undefined;
    const flags = typeof entry === "object" && entry !== null ? entry.flags : undefined;
    if (typeof rule !== "string" || rule === "" || typeof pattern !== "string" || pattern === "") {
      throw new UsageError(`private term list: rule #${n} needs a non-empty "rule" and "pattern" string`);
    }
    if (flags !== undefined && (typeof flags !== "string" || !/^[gimsuv]*$/.test(flags))) {
      throw new UsageError(`private term list: rule #${n} (${rule}) has invalid "flags"`);
    }
    try {
      const withG = flags === undefined || flags.includes("g") ? (flags ?? "g") : `${flags}g`;
      return { rule, re: new RegExp(pattern, withG) };
    } catch {
      throw new UsageError(`private term list: rule #${n} (${rule}) has a pattern that does not compile`);
    }
  });
}

/**
 * Load and compile the private term list.
 * @param {string} [file] defaults to `<REPO_ROOT>/docs/private/hygiene-terms.json`
 * @returns {Rule[] | null} null when the file does not exist (private rules are then skipped)
 */
export function loadPrivateRules(file = path.join(REPO_ROOT, ...PRIVATE_TERMS_FILE.split("/"))) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw new UsageError(`private term list: cannot read ${PRIVATE_TERMS_FILE}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new UsageError(`private term list: ${PRIVATE_TERMS_FILE} is not valid JSON`);
  }
  return compilePrivateRules(data);
}

/**
 * True when `root` is itself the top of a git work tree (so `git ls-files` describes
 * exactly the files under `root`). False for a ZIP download, a fresh export before
 * `git init`, a directory nested in some other repository, or when git is not installed.
 * @param {string} [root]
 */
export function isGitWorkTree(root = REPO_ROOT) {
  try {
    // Ask git rather than compare paths: `--show-prefix` is empty exactly at the top of a work
    // tree. Comparing realpaths broke on Windows, where a temp folder can be an 8.3 short path
    // (RUNNER~1) that fs.realpathSync keeps but git's --show-toplevel expands.
    const [inside, prefix = ""] = execFileSync("git", ["rev-parse", "--is-inside-work-tree", "--show-prefix"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/);
    return inside === "true" && prefix === "";
  } catch {
    return false;
  }
}

/**
 * True when git tracks at least one file under `docs/private/` in `root`: the mark of the
 * private repository (the public repository has no such folder). False outside a git work
 * tree (a ZIP download, a fresh export before `git init`), where there is nothing to ask.
 * @param {string} [root]
 */
export function hasTrackedPrivateFiles(root = REPO_ROOT) {
  if (!isGitWorkTree(root)) return false;
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--", PRIVATE_DIR], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").some((f) => f !== "");
}

/**
 * Files git would track (tracked plus untracked-but-not-ignored), existing on disk.
 * @param {string} root
 * @returns {string[]} repo-relative posix paths, sorted
 */
export function listGitFiles(root = REPO_ROOT) {
  if (!isGitWorkTree(root)) {
    throw new UsageError(
      "not inside a git work tree (or git is not installed): the public file set is defined by git, so run this from a git checkout",
    );
  }
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set(out.split("\0").filter((f) => f !== ""));
  return [...files].filter((f) => fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile()).sort();
}

/**
 * @param {string} rel repo-relative posix path
 * @param {RegExp[]} ignore
 */
export function isExcluded(rel, ignore = []) {
  if (BUILTIN_EXCLUDES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) return true;
  return ignore.some((re) => re.test(rel));
}

/**
 * The public file set.
 * @param {string} root
 * @returns {string[]}
 */
export function exportListing(root = REPO_ROOT) {
  const ignore = loadPublicIgnore(root);
  return listGitFiles(root).filter((rel) => !isExcluded(rel, ignore));
}

/** @param {string} url */
export function isAllowedUrl(url) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return false;
  const host = (m[1] ?? "").toLowerCase();
  const pathname = m[2] ?? "";
  return URL_ALLOWLIST.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return host === entry || host.endsWith(`.${entry}`);
    const entryHost = entry.slice(0, slash);
    const entryPath = entry.slice(slash);
    return host === entryHost && (pathname === entryPath || pathname.startsWith(`${entryPath}/`));
  });
}

/**
 * @typedef {{ file: string, line: number, match: string, rule: string }} Finding
 */

/**
 * A fresh, global copy of a rule's RegExp (own `lastIndex`; `matchAll` needs `g`).
 * @param {RegExp} re
 */
function freshGlobal(re) {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * Scan one file's text. Line numbers are 1-based; the path itself is reported as line 0.
 * Applies the public FORBIDDEN_PATTERNS plus `opts.privateRules` (default: none).
 * @param {string} rel repo-relative posix path
 * @param {string} text
 * @param {{ privateRules?: readonly Rule[] | null }} [opts]
 * @returns {Finding[]}
 */
export function scanText(rel, text, opts = {}) {
  const rules = [...FORBIDDEN_PATTERNS, ...(opts.privateRules ?? [])];
  /** @type {Finding[]} */
  const findings = [];
  for (const { rule, re } of rules) {
    for (const m of rel.matchAll(freshGlobal(re))) {
      findings.push({ file: rel, line: 0, match: m[0], rule });
    }
  }
  const checkUrls = !URL_RULE_EXEMPT_FILES.includes(rel.slice(rel.lastIndexOf("/") + 1));
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    if (SKIP_LINE.test(lineText)) return;
    for (const { rule, re } of rules) {
      for (const m of lineText.matchAll(freshGlobal(re))) {
        findings.push({ file: rel, line: i + 1, match: m[0], rule });
      }
    }
    if (!checkUrls) return;
    for (const m of lineText.matchAll(new RegExp(URL_PATTERN.source, URL_PATTERN.flags))) {
      if (!isAllowedUrl(m[0])) findings.push({ file: rel, line: i + 1, match: m[0], rule: "url-not-allowlisted" });
    }
  });
  return findings;
}

/** @param {Buffer} buf */
function looksBinary(buf) {
  return buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
}

/**
 * Release-only scan: leftover placeholder tokens. Line numbers are 1-based.
 * @param {string} rel repo-relative posix path
 * @param {string} text
 * @returns {Finding[]}
 */
export function scanPlaceholders(rel, text) {
  /** @type {Finding[]} */
  const findings = [];
  const prose = PROSE_FILE_RE.test(rel);
  text.split(/\r?\n/).forEach((lineText, i) => {
    if (SKIP_LINE.test(lineText)) return;
    for (const { rule, re, proseOnly } of PLACEHOLDER_PATTERNS) {
      if (proseOnly === true && !prose) continue;
      for (const m of lineText.matchAll(new RegExp(re.source, re.flags))) {
        findings.push({ file: rel, line: i + 1, match: m[0], rule });
      }
    }
  });
  return findings;
}

/**
 * Scan files under `root` (text files only; binaries are skipped, their paths still checked).
 * With `release`, leftover placeholder tokens are findings too.
 * @param {string} root
 * @param {string[]} files repo-relative posix paths
 * @param {{ release?: boolean, privateRules?: readonly Rule[] | null }} [opts]
 * @returns {Finding[]}
 */
export function scanFiles(root, files, opts = {}) {
  const { privateRules } = opts;
  /** @type {Finding[]} */
  const findings = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf.length > MAX_SCAN_BYTES || looksBinary(buf)) {
      findings.push(...scanText(rel, "", { privateRules }));
      continue;
    }
    const text = buf.toString("utf8");
    findings.push(...scanText(rel, text, { privateRules }));
    if (opts.release === true) findings.push(...scanPlaceholders(rel, text));
  }
  return findings;
}

/** @param {Finding} f */
export function formatFinding(f) {
  return `${f.file}:${f.line}:${f.match}`;
}

/**
 * Copy the public file set to `target` (which must not exist, or be an empty directory).
 * @param {string} target
 * @param {string} root
 * @returns {string[]} the copied repo-relative paths
 */
export function exportTo(target, root = REPO_ROOT) {
  const dest = path.resolve(target);
  const rootAbs = path.resolve(root);
  const relToRoot = path.relative(rootAbs, dest);
  if (relToRoot === "" || (!relToRoot.startsWith("..") && !path.isAbsolute(relToRoot))) {
    throw new UsageError(`target must be outside the repository: ${dest}`);
  }
  if (fs.existsSync(dest)) {
    if (!fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length > 0) {
      throw new UsageError(`target exists and is not an empty directory: ${dest}`);
    }
  }
  const files = exportListing(rootAbs);
  for (const rel of files) {
    const to = path.join(dest, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(rootAbs, ...rel.split("/")), to);
  }
  return files;
}

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @param {{ root?: string, termsFile?: string }} [opts] `root`: the repository to export or check
 *   (default REPO_ROOT); `termsFile`: the private term list (default `<root>/docs/private/hygiene-terms.json`)
 * @returns {number} exit code
 */
export function main(argv, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const termsFile = opts.termsFile ?? path.join(root, ...PRIVATE_TERMS_FILE.split("/"));
  const release = argv.includes("--release");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const check = argv.includes("--check") || (release && positional.length === 0);
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--check" && a !== "--release");
  const usage = "usage: node scripts/export-public.mjs (<targetDir> | --check) [--release]";
  if (unknown.length > 0 || positional.length > 1 || (check && positional.length > 0) || (!check && positional.length === 0)) {
    console.error(usage);
    return 2;
  }
  try {
    const privateRules = loadPrivateRules(termsFile);
    if (privateRules === null) {
      // Missing is fine for the public repository and a ZIP download, but not for the private
      // repository, which tracks other files under docs/private/: there the list was lost.
      if (hasTrackedPrivateFiles(root)) {
        throw new UsageError(
          `private term list: ${PRIVATE_TERMS_FILE} is missing, but git tracks other files under ${PRIVATE_DIR}; ` +
            "restore it (this looks like the private repository), so the private-name scan is not silently skipped",
        );
      }
      console.error(`note: no private term list (${PRIVATE_TERMS_FILE}); private-name rules skipped`);
    }
    let findings;
    if (check) {
      const files = exportListing(root);
      findings = scanFiles(root, files, { release, privateRules });
      console.error(`scanned ${files.length} files in place (no copy)${release ? ", release mode" : ""}`);
    } else {
      const target = path.resolve(positional[0] ?? "");
      const files = exportTo(target, root);
      findings = scanFiles(target, files, { release, privateRules });
      console.error(`exported ${files.length} files to ${target}${release ? " (release mode)" : ""}`);
    }
    for (const f of findings) console.log(formatFinding(f));
    if (findings.length > 0) {
      const what = release ? "forbidden content or leftover placeholders" : "forbidden content";
      console.error(`${findings.length} finding(s): ${what} in the public file set`);
      return 1;
    }
    console.error(release ? "clean: no forbidden content and no placeholders" : "clean: no forbidden content");
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`export-public: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): on macOS the OS tmpdir is itself a symlink (/var ->
// /private/var), so a script invoked as `node /var/.../export-public.mjs`
// gets process.argv[1] === '/var/.../export-public.mjs' while
// import.meta.url resolves to the realpath '/private/var/...' -- a plain
// path.resolve()-based compare never matches, main() silently never runs,
// and the process exits 0 with no output.
function isEntryPoint(metaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = fs.realpathSync(entry);
    const b = fs.realpathSync(fileURLToPath(metaUrl));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
