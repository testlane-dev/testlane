/**
 * Profile registry: parsing, validation, discovery and merging of
 * `testlane.profiles.json` files (and the pre-rename `agent-auth.profiles.json`).
 *
 * Registry files are committed to consuming repos and hold zero secrets. They
 * name an account (email/role) and where/how to sign in; the password lives
 * only in the secret store under `agent-auth/<profile name>` (a stable storage
 * key kept from before the rename).
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { lookupEnv } from "./env.js";
import { accountOverridesPath, LEGACY_PROFILES_FILE_NAME, PROFILES_FILE_NAME, userProfilesPath } from "./paths.js";
import { canonicalHostEntry, hostOf, hostnameOf } from "./policy.js";
import { validateStrategyOptions } from "./strategies/options.js";
import {
  ENVIRONMENTS,
  PROFILE_NAME_RE,
  PolicyError,
  RESERVED_PROFILE_PREFIX,
  STRATEGIES,
  isReservedProfileName,
  type Environment,
  type Profile,
  type ProfileRegistry,
  type StrategyName,
} from "./types.js";

/**
 * File names searched for when walking up from the working directory:
 * `testlane.profiles.json`, then the pre-rename `agent-auth.profiles.json`
 * (both checked in each directory; the current name wins).
 */
export { LEGACY_PROFILES_FILE_NAME, PROFILES_FILE_NAME };

/** Env var naming an explicit registry file; wins over directory discovery. */
export const PROFILES_ENV_VAR = "TESTLANE_PROFILES";
/** Pre-rename name of PROFILES_ENV_VAR, read when TESTLANE_PROFILES is unset. */
export const LEGACY_PROFILES_ENV_VAR = "AGENT_AUTH_PROFILES";

/**
 * An allowedHosts entry: lowercase DNS name, IPv4 literal or bracketed IPv6
 * literal, optionally followed by ":port". A loose shape check only: the entry
 * must also parse as a host (canonicalHostEntry), and is stored in that
 * canonical spelling (`[2001:db8:0:0::1]` -> `[2001:db8::1]`, `127.1` -> `127.0.0.1`).
 */
export const ALLOWED_HOST_RE =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:[0-9]{1,5})?$/;

function baseUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must use http: or https:";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain a username or password";
  }
  if (url.search !== "" || value.includes("?")) return "must not contain a query string";
  if (url.hash !== "" || value.includes("#")) return "must not contain a fragment";
  return null;
}

const allowedHostSchema = z
  .string()
  .regex(ALLOWED_HOST_RE, 'must be a lowercase "host" or "host:port"')
  .refine(
    (h) => {
      const m = /:([0-9]{1,5})$/.exec(h);
      if (!m || h.endsWith("]")) return true;
      const port = Number(m[1]);
      return port >= 1 && port <= 65535;
    },
    { message: "port must be between 1 and 65535" },
  )
  .refine((h) => !ALLOWED_HOST_RE.test(h) || canonicalHostEntry(h) !== null, {
    message: "must be a host name or IP address that the URL parser accepts",
  });

const accountSchema = z
  .object({
    email: z.string(),
    role: z.string(),
    identifier: z.string().min(1, "must not be empty").optional(),
  })
  .strict();

const sessionSchema = z
  .object({
    ttlMinutes: z
      .number()
      .int("must be an integer")
      .min(0, "must be >= 0")
      .max(1440, "must be <= 1440"),
  })
  .strict();

/** One registry entry: `Profile` minus `name` (the record key supplies it). */
export const profileEntrySchema = z
  .object({
    app: z.string().min(1, "must not be empty"),
    environment: z.enum(ENVIRONMENTS),
    baseUrl: z.string().superRefine((value, ctx) => {
      const problem = baseUrlProblem(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    strategy: z.enum(STRATEGIES),
    account: accountSchema,
    session: sessionSchema,
    allowedHosts: z.array(allowedHostSchema).optional(),
    options: z.record(z.string(), z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.account.email === "" && entry.environment !== "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["account", "email"],
        message:
          'must not be empty (an empty email is only allowed on "production" entries, which exist only to be refused)',
      });
    }
    // Strategy options: only documented keys; endpoint options must be same-origin paths.
    if (entry.options !== undefined) {
      const result = validateStrategyOptions(entry.strategy, entry.options);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", ...issue.path],
            message: `${issue.message} (strategy "${entry.strategy}")`,
          });
        }
      }
    }
  });

/** The whole registry file. A top-level "$schema" string is tolerated for editor support. */
export const registryFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    profiles: z.record(
      z
        .string()
        .regex(PROFILE_NAME_RE, `profile name must match ${PROFILE_NAME_RE.source}`)
        .refine((name) => !isReservedProfileName(name), {
          message: `reserved: profile names starting with "${RESERVED_PROFILE_PREFIX}" belong to the secret store itself`,
        }),
      profileEntrySchema,
    ),
  })
  .strict();

type ProfileEntry = z.infer<typeof profileEntrySchema>;

function formatPath(p: ReadonlyArray<string | number>): string {
  if (p.length === 0) return "(root)";
  let out = "";
  for (const seg of p) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

function formatIssues(source: string, error: z.ZodError, what = "profile registry"): string {
  const lines = error.issues.map((i) => `  - ${formatPath(i.path)}: ${i.message}`);
  return `Invalid ${what} ${source}:\n${lines.join("\n")}`;
}

function toProfile(name: string, e: ProfileEntry): Profile {
  const account: Profile["account"] = { email: e.account.email, role: e.account.role };
  if (e.account.identifier !== undefined) account.identifier = e.account.identifier;
  const profile: Profile = {
    name,
    app: e.app,
    environment: e.environment as Environment,
    baseUrl: e.baseUrl,
    strategy: e.strategy as StrategyName,
    account,
    session: { ttlMinutes: e.session.ttlMinutes },
  };
  // Canonical spelling, so every later comparison (overlap, denylist, allowlist) sees one form per host.
  if (e.allowedHosts !== undefined) profile.allowedHosts = e.allowedHosts.map((h) => canonicalHostEntry(h) ?? h);
  if (e.options !== undefined) profile.options = { ...e.options };
  if (e.notes !== undefined) profile.notes = e.notes;
  return profile;
}

/**
 * Validate parsed JSON as a registry file. `source` is used in error messages
 * and recorded in `sources`.
 *
 * @throws PolicyError("invalid-profile") listing every zod issue, path-qualified.
 */
export function parseRegistry(json: unknown, source: string): ProfileRegistry {
  const result = registryFileSchema.safeParse(json);
  if (!result.success) {
    throw new PolicyError(formatIssues(source, result.error), "invalid-profile");
  }
  const profiles: Record<string, Profile> = {};
  for (const [name, entry] of Object.entries(result.data.profiles)) {
    profiles[name] = toProfile(name, entry);
  }
  const overlap = productionOverlapIssues(profiles);
  if (overlap.length > 0) {
    throw new PolicyError(
      `Invalid profile registry ${source}:\n${overlap.map((l) => `  - ${l}`).join("\n")}`,
      "invalid-profile",
    );
  }
  return { version: 1, profiles, sources: [source] };
}

/** hostOf(baseUrl) plus allowedHosts (lowercased), each with the profile field it came from. */
/** Hostnames (no port, no trailing dot) a profile may talk to, with the field each came from. */
function hostsOf(p: Profile): { host: string; field: string }[] {
  const out: { host: string; field: string }[] = [];
  try {
    out.push({ host: hostnameOf(hostOf(p.baseUrl)), field: "baseUrl" });
  } catch {
    // baseUrl already validated by the schema; an unparsable one contributes no host.
  }
  (p.allowedHosts ?? []).forEach((h, i) => out.push({ host: hostnameOf(h), field: `allowedHosts[${i}]` }));
  return out;
}

/**
 * Hostnames (hostnameOf form: no port, no trailing dot; from baseUrl and
 * allowedHosts) of every `environment: "production"` profile in `reg`. The
 * policy engine refuses any session whose base or target hostname is in this
 * set, whatever port it uses.
 */
export function productionHosts(reg: Pick<ProfileRegistry, "profiles">): Set<string> {
  const hosts = new Set<string>();
  for (const p of Object.values(reg.profiles)) {
    if (p.environment !== "production") continue;
    for (const { host } of hostsOf(p)) hosts.add(host);
  }
  return hosts;
}

/** A hostname of a non-production profile that a production profile also uses. */
export interface ProductionOverlap {
  /** The non-production profile. */
  profile: string;
  /** Which of its fields holds the host: "baseUrl" or "allowedHosts[<i>]". */
  field: string;
  /** The shared hostname (hostnameOf form). */
  host: string;
  /** The production profile that owns it. */
  owner: string;
}

/**
 * Every host that a non-production profile in `profiles` shares with a
 * production profile (compared as canonical hostnames, any port).
 */
export function productionOverlaps(profiles: Record<string, Profile>): ProductionOverlap[] {
  const owners = new Map<string, string>();
  for (const [name, p] of Object.entries(profiles)) {
    if (p.environment !== "production") continue;
    for (const { host } of hostsOf(p)) if (!owners.has(host)) owners.set(host, name);
  }
  if (owners.size === 0) return [];
  const overlaps: ProductionOverlap[] = [];
  for (const [name, p] of Object.entries(profiles)) {
    if (p.environment === "production") continue;
    for (const { host, field } of hostsOf(p)) {
      const owner = owners.get(host);
      if (owner !== undefined) overlaps.push({ profile: name, field, host, owner });
    }
  }
  return overlaps;
}

/**
 * A non-production profile must not share a host with any production profile:
 * otherwise re-tagging (or copy-pasting) an entry would be enough to send an
 * agent session to production. Returns path-qualified issue lines.
 */
function productionOverlapIssues(profiles: Record<string, Profile>): string[] {
  return productionOverlaps(profiles).map(
    ({ profile, field, host, owner }) =>
      `${formatPath(["profiles", profile])}.${field}: host "${host}" belongs to production profile "${owner}"; ` +
      `non-production profile "${profile}" may not use a production host`,
  );
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Read and JSON-parse `file`; errors name the file (and a position), never its contents. */
async function readJsonFile(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    throw new PolicyError(`Cannot read ${what} ${file}: ${code}`, "invalid-profile");
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch (err) {
    // V8's message quotes a snippet of the file; report only the position.
    const detail = err instanceof Error ? err.message : "";
    const pos = /\bposition (\d+)/.exec(detail);
    const where = pos ? `: Unexpected token at position ${pos[1]}` : "";
    throw new PolicyError(`invalid JSON in ${file}${where}`, "invalid-profile");
  }
}

async function readRegistryFile(file: string): Promise<ProfileRegistry> {
  return parseRegistry(await readJsonFile(file, "profile registry"), file);
}

/** Directories already reported for holding both registry names (one notice per directory per process). */
const reportedBothNames = new Set<string>();

/**
 * Nearest registry walking up from `startDir`. In each directory
 * `testlane.profiles.json` wins over `agent-auth.profiles.json`; when both
 * exist, one notice (per directory, per process) goes to stderr, which is
 * never the MCP protocol channel.
 */
async function findUp(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const current = path.join(dir, PROFILES_FILE_NAME);
    const legacy = path.join(dir, LEGACY_PROFILES_FILE_NAME);
    const [hasCurrent, hasLegacy] = await Promise.all([isFile(current), isFile(legacy)]);
    if (hasCurrent) {
      if (hasLegacy && !reportedBothNames.has(dir)) {
        reportedBothNames.add(dir);
        process.stderr.write(
          `notice: both ${PROFILES_FILE_NAME} and ${LEGACY_PROFILES_FILE_NAME} exist in ${dir}; ` +
            `using ${PROFILES_FILE_NAME} (remove or merge the other file)\n`,
        );
      }
      return current;
    }
    if (hasLegacy) return legacy;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account overrides (user-level; `testlane account set|clear|list`)
// ---------------------------------------------------------------------------

/** Maximum length of an override email (RFC 5321 path limit). */
export const OVERRIDE_EMAIL_MAX_LENGTH = 254;
/** Maximum length of an override identifier. */
export const OVERRIDE_IDENTIFIER_MAX_LENGTH = 128;

/** No whitespace (including U+2028/U+2029) and no C0/C1 control characters. */
// eslint-disable-next-line no-control-regex
const NO_SPACE_OR_CONTROL_RE = /^[^\s\u0000-\u001f\u007f-\u009f]+$/;

/** An override email: a non-empty string without whitespace or control characters, at most 254 characters. */
export const overrideEmailSchema = z
  .string()
  .min(1, "must not be empty")
  .max(OVERRIDE_EMAIL_MAX_LENGTH, `must be at most ${OVERRIDE_EMAIL_MAX_LENGTH} characters`)
  .regex(NO_SPACE_OR_CONTROL_RE, "must not contain whitespace or control characters");

/** An override identifier: same shape rules, at most 128 characters. */
export const overrideIdentifierSchema = z
  .string()
  .min(1, "must not be empty")
  .max(OVERRIDE_IDENTIFIER_MAX_LENGTH, `must be at most ${OVERRIDE_IDENTIFIER_MAX_LENGTH} characters`)
  .regex(NO_SPACE_OR_CONTROL_RE, "must not contain whitespace or control characters");

const overrideAccountSchema = z
  .object({
    email: overrideEmailSchema.optional(),
    identifier: overrideIdentifierSchema.optional(),
  })
  .strict()
  .refine((a) => a.email !== undefined || a.identifier !== undefined, {
    message: "must set email or identifier",
  });

/**
 * The account overrides file. Strict everywhere: an override can carry only
 * `account.email` and `account.identifier`; any other key (baseUrl,
 * environment, strategy, options, allowedHosts, session, ...) is invalid.
 */
export const accountOverridesFileSchema = z
  .object({
    version: z.literal(1),
    overrides: z.record(
      z
        .string()
        .regex(PROFILE_NAME_RE, `profile name must match ${PROFILE_NAME_RE.source}`)
        .refine((name) => !isReservedProfileName(name), {
          message: `reserved: profile names starting with "${RESERVED_PROFILE_PREFIX}" belong to the secret store itself`,
        }),
      z.object({ account: overrideAccountSchema }).strict(),
    ),
  })
  .strict();

/** The identity fields an override may replace. Nothing else is overridable. */
export interface AccountOverride {
  email?: string;
  identifier?: string;
}

/** Parsed overrides file: profile name -> account override. */
export type AccountOverrides = Record<string, AccountOverride>;

/**
 * Validate parsed JSON as an account overrides file.
 *
 * @throws PolicyError("invalid-profile") naming `source` and every issue, path-qualified.
 */
export function parseAccountOverrides(json: unknown, source: string): AccountOverrides {
  const result = accountOverridesFileSchema.safeParse(json);
  if (!result.success) {
    throw new PolicyError(formatIssues(source, result.error, "account overrides file"), "invalid-profile");
  }
  const out: AccountOverrides = {};
  for (const [name, entry] of Object.entries(result.data.overrides)) {
    const o: AccountOverride = {};
    if (entry.account.email !== undefined) o.email = entry.account.email;
    if (entry.account.identifier !== undefined) o.identifier = entry.account.identifier;
    out[name] = o;
  }
  return out;
}

/**
 * Read the account overrides file. A missing file means no overrides (`{}`);
 * an unreadable or invalid one is a PolicyError("invalid-profile") naming the file.
 */
export async function readAccountOverrides(file: string = accountOverridesPath()): Promise<AccountOverrides> {
  try {
    await fs.lstat(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
  }
  return parseAccountOverrides(await readJsonFile(file, "account overrides file"), file);
}

/**
 * Write the account overrides file atomically (temp file + rename), mode 0600
 * on POSIX (on Windows the file inherits the folder's ACLs). The content is
 * validated first, so a file loadProfiles would refuse is never written, and
 * entries are sorted by profile name.
 */
export async function writeAccountOverrides(
  overrides: AccountOverrides,
  file: string = accountOverridesPath(),
): Promise<void> {
  const sorted: Record<string, { account: AccountOverride }> = {};
  for (const name of Object.keys(overrides).sort()) {
    const o = overrides[name];
    if (o === undefined) continue;
    const account: AccountOverride = {};
    if (o.email !== undefined) account.email = o.email;
    if (o.identifier !== undefined) account.identifier = o.identifier;
    sorted[name] = { account };
  }
  const body = { version: 1 as const, overrides: sorted };
  parseAccountOverrides(body, file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Apply `overrides` to `reg` in place: only `account.email` and
 * `account.identifier` are replaced. The overrides file is machine-global,
 * so an override naming a profile this registry does not define is skipped
 * and reported in `unused`. An override on a production profile is an error.
 *
 * @returns the applied and the unused override names, each sorted.
 * @throws PolicyError("invalid-profile") naming the override and `source`.
 */
export function applyAccountOverrides(
  reg: ProfileRegistry,
  overrides: AccountOverrides,
  source: string,
): { applied: string[]; unused: string[] } {
  const applied: string[] = [];
  const unused: string[] = [];
  for (const name of Object.keys(overrides).sort()) {
    const o = overrides[name];
    if (o === undefined) continue;
    const profile = Object.hasOwn(reg.profiles, name) ? reg.profiles[name] : undefined;
    if (profile === undefined) {
      unused.push(name);
      continue;
    }
    if (profile.environment === "production") {
      throw new PolicyError(
        `Account override "${name}" in ${source} targets a profile tagged environment "production"; ` +
          `account overrides never apply to production profiles. Remove it with: testlane account clear ${name}`,
        "invalid-profile",
      );
    }
    const account: Profile["account"] = { ...profile.account };
    if (o.email !== undefined) account.email = o.email;
    if (o.identifier !== undefined) account.identifier = o.identifier;
    reg.profiles[name] = { ...profile, account };
    applied.push(name);
  }
  return { applied, unused };
}

export interface LoadProfilesOptions {
  /** Directory to start the upward search from. Default: process.cwd(). */
  cwd?: string;
  /** Explicit repo-level registry file; skips env and discovery. Must exist. */
  repoFile?: string;
  /** User-level registry file. Default: userProfilesPath(). Ignored when absent. */
  userFile?: string;
  /** Account overrides file. Default: accountOverridesPath(). Ignored when absent. */
  overridesFile?: string;
}

/**
 * Load and merge the registry.
 *
 * Repo-level file, first match wins: `opts.repoFile`, then `$TESTLANE_PROFILES`
 * (else the legacy `$AGENT_AUTH_PROFILES`; resolved against `cwd`), then the
 * nearest `testlane.profiles.json` or `agent-auth.profiles.json` walking up
 * from `cwd` to the filesystem root (in one directory the former wins). An
 * explicit file (option or env) that does not exist is an error; failing
 * discovery is not.
 *
 * The user-level file (`userProfilesPath()` unless overridden) is merged in when
 * it exists. A profile name defined in more than one source is an error: a
 * user file must never be able to shadow (e.g. downgrade the environment of) a
 * repo profile. The merged registry is checked for production host overlap
 * again (after the overrides), because each file only sees its own profiles.
 *
 * Account overrides (`accountOverridesPath()` unless overridden) are applied
 * last. They may replace only `account.email` / `account.identifier`; an
 * override on a production profile is an error, and one naming a profile this
 * registry does not define is ignored and listed in `unusedOverrides` (the
 * file is machine-global, shared by every repo). The overrides file is added
 * to `sources` when it applied at least one override, and `overrides` lists
 * the overridden profile names.
 *
 * No file at all yields an empty registry with `sources: []`, `overrides: []`
 * and `unusedOverrides: []`.
 */
export async function loadProfiles(opts: LoadProfilesOptions = {}): Promise<ProfileRegistry> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  let repoFile: string | null = null;
  const envFile = lookupEnv("TESTLANE_PROFILES");
  const explicit = opts.repoFile !== undefined ? opts.repoFile : envFile?.value;
  if (explicit !== undefined) {
    repoFile = path.resolve(cwd, explicit);
    if (!(await isFile(repoFile))) {
      const origin = opts.repoFile !== undefined ? "repoFile option" : (envFile?.source ?? PROFILES_ENV_VAR);
      throw new PolicyError(
        `Profile registry named by ${origin} does not exist: ${repoFile}`,
        "invalid-profile",
      );
    }
  } else {
    repoFile = await findUp(cwd);
  }

  const userFile = path.resolve(cwd, opts.userFile ?? userProfilesPath());
  const files: string[] = [];
  if (repoFile !== null) files.push(repoFile);
  if (await isFile(userFile)) {
    if (repoFile === null || !(await sameFile(repoFile, userFile))) files.push(userFile);
  }

  const merged: ProfileRegistry = { version: 1, profiles: {}, sources: [], overrides: [], unusedOverrides: [] };
  const origin: Record<string, string> = {};
  for (const file of files) {
    const reg = await readRegistryFile(file);
    for (const [name, profile] of Object.entries(reg.profiles)) {
      const previous = Object.hasOwn(origin, name) ? origin[name] : undefined;
      if (previous !== undefined) {
        throw new PolicyError(
          `Profile "${name}" is defined in both ${previous} and ${file}. ` +
            "Profile names must be unique across registry files; nothing is overridden silently.",
          "invalid-profile",
        );
      }
      origin[name] = file;
      merged.profiles[name] = profile;
    }
    merged.sources.push(file);
  }

  const overridesFile = path.resolve(cwd, opts.overridesFile ?? accountOverridesPath());
  const overrides = await readAccountOverrides(overridesFile);
  const { applied, unused } = applyAccountOverrides(merged, overrides, overridesFile);
  if (applied.length > 0) merged.sources.push(overridesFile);
  merged.overrides = applied;
  merged.unusedOverrides = unused;

  // Each file was checked on its own (parseRegistry); the repo and user-level
  // files can still disagree, e.g. a production entry in one and a sandbox entry
  // on the same host in the other. Check the registry the broker will actually use.
  const overlap = productionOverlapIssues(merged.profiles);
  if (overlap.length > 0) {
    throw new PolicyError(
      `Invalid profile registry (${merged.sources.join(" + ")}):\n${overlap.map((l) => `  - ${l}`).join("\n")}`,
      "invalid-profile",
    );
  }
  return merged;
}

/** @throws PolicyError("unknown-profile") listing the available names, sorted. */
export function getProfile(reg: ProfileRegistry, name: string): Profile {
  const profile = Object.hasOwn(reg.profiles, name) ? reg.profiles[name] : undefined;
  if (profile === undefined) {
    const names = Object.keys(reg.profiles).sort();
    const available = names.length > 0 ? names.join(", ") : "(none)";
    // Never echo an arbitrary string back: only a well-formed profile name is printed.
    const shown = PROFILE_NAME_RE.test(name) && name.length <= 128 ? `"${name}"` : "(not a valid profile name)";
    throw new PolicyError(
      `Unknown profile ${shown}. Available profiles: ${available}`,
      "unknown-profile",
    );
  }
  return profile;
}

export interface ProfileSummary {
  name: string;
  app: string;
  environment: Environment;
  baseUrl: string;
  strategy: StrategyName;
  email: string;
  role: string;
  ttlMinutes: number;
  /** Present (true) only when the account identity comes from the user-level overrides file. */
  overridden?: true;
}

/** Fields that are safe to print (profiles hold no secrets, but keep output narrow). */
export function summarizeProfile(p: Profile): ProfileSummary {
  return {
    name: p.name,
    app: p.app,
    environment: p.environment,
    baseUrl: p.baseUrl,
    strategy: p.strategy,
    email: p.account.email,
    role: p.account.role,
    ttlMinutes: p.session.ttlMinutes,
  };
}
