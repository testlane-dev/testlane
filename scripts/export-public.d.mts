/** Type declarations for scripts/export-public.mjs (imported by tests/public-hygiene.test.ts). */

export interface Finding {
  file: string;
  line: number;
  match: string;
  rule: string;
}

/** A compiled scanner rule; `re` always carries the `g` flag when produced by `compilePrivateRules`. */
export interface Rule {
  rule: string;
  re: RegExp;
}

export interface ScanOptions {
  /** Extra rules (normally from `loadPrivateRules()`); default none. */
  privateRules?: readonly Rule[] | null;
}

export const REPO_ROOT: string;
export const BUILTIN_EXCLUDES: readonly string[];
export const PUBLIC_IGNORE_FILE: string;
export const PRIVATE_TERMS_FILE: string;
export const FORBIDDEN_PATTERNS: readonly Rule[];
export const PLACEHOLDER_PATTERNS: readonly { rule: string; re: RegExp; proseOnly?: boolean }[];
export const PROSE_FILE_RE: RegExp;
export const URL_PATTERN: RegExp;
export const URL_ALLOWLIST: readonly string[];
export const URL_RULE_EXEMPT_FILES: readonly string[];

export function globToRegExp(line: string): RegExp | null;
export function loadPublicIgnore(root?: string): RegExp[];
export function compilePrivateRules(data: unknown): Rule[];
/** Returns null when the term file does not exist (private rules are then skipped). */
export function loadPrivateRules(file?: string): Rule[] | null;
export function isGitWorkTree(root?: string): boolean;
/** True when git tracks a file under docs/private/ in `root` (the private repository); false outside a git work tree. */
export function hasTrackedPrivateFiles(root?: string): boolean;
export function listGitFiles(root?: string): string[];
export function isExcluded(rel: string, ignore?: RegExp[]): boolean;
export function exportListing(root?: string): string[];
export function isAllowedUrl(url: string): boolean;
export function scanText(rel: string, text: string, opts?: ScanOptions): Finding[];
export function scanPlaceholders(rel: string, text: string): Finding[];
export function scanFiles(root: string, files: string[], opts?: ScanOptions & { release?: boolean }): Finding[];
export function formatFinding(f: Finding): string;
export function exportTo(target: string, root?: string): string[];
export class UsageError extends Error {}
export function main(argv: string[], opts?: { root?: string; termsFile?: string }): number;
