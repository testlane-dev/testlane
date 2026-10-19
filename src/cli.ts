#!/usr/bin/env node
/**
 * testlane CLI: profiles | store set/delete/list | account set/clear/list |
 * session | check | handoff | rotate | status | doctor | workflow | audit | mcp | serve.
 *
 * Rules enforced here:
 * - Global options (--profiles, --requester, --json) are accepted ONLY before
 *   the subcommand (commander positional options): `session p --profiles x`
 *   is an unknown-option error (exit 1), so a command that matches an
 *   allowlisted prefix such as `testlane session ...` cannot swap the registry.
 *   (`status` also declares its own `--json`, which only changes the output.)
 * - `store set` reads the secret from the prompt or stdin only. After
 *   `store set` only the profile name is accepted; any extra argument or flag
 *   (global ones included), any `--flag=value`, or any secret-looking flag
 *   anywhere on the command line is refused (exit 5) before stdin is read and
 *   without echoing the argument. An unknown `--flag=value` on any other
 *   command is refused the same way (exit 5) with a generic message.
 * - Commander's own error messages never echo the `=value` part of a flag,
 *   an invalid option argument (--format, --port, --tail, --ttl) or an
 *   unknown command name.
 * - `account set|clear` (human only) edit the user-level account overrides
 *   file, which can change only account.email / account.identifier of an
 *   existing non-production profile. The values are not secrets, but the
 *   secret-flag scan still runs on every command line.
 * - `session --out` never overwrites an existing file unless --force is given.
 * - Everything written to stdout/stderr, and the `session --out` file, passes
 *   through the redactor.
 * - `session` without `--out` prints the session artifact and nothing else on
 *   stdout; `check` never prints session material; `handoff` prints only
 *   `{ url, expiresAt, profile }`.
 * - `rotate` (human command by default; a human's scheduled task may run it)
 *   changes the app password and updates the vault two-phase; it prints the
 *   outcome, never either secret. `status` prints secret metadata (age,
 *   pending rotation, alerts), never a value; `status --alert` exits 7 when
 *   any non-production profile has an alert.
 * - `mcp` writes nothing to stdout itself (stdout is the protocol channel).
 * - Deps (registry, store, requester) come from src/deps.ts, shared with the
 *   MCP and HTTP surfaces.
 *
 * Exit codes: see EXIT_CODES / EXIT_CODES_HELP.
 */
import { realpathSync } from "node:fs";
import { chmod, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option, type ParseOptions } from "commander";
import {
  accountClear,
  accountList,
  accountSet,
  assertStorable,
  auditTail,
  checkProfile,
  DEFAULT_MAX_AGE_DAYS,
  issueSession,
  listProfiles,
  MissingSecretError,
  profileStatus,
  rotateProfile,
  storeDelete,
  storeList,
  storeSet,
  type CheckOutcome,
  type CommandDeps,
  type StatusOptions,
} from "./commands.js";
import { formatAuditRow } from "./audit.js";
import { collectDoctor, formatDoctor, type DoctorOptions, type DoctorReport } from "./doctor.js";
import { LazyStore, resolveCommandDeps, type ResolveDepsOptions } from "./deps.js";
import { issueHandoff } from "./handoff.js";
import type { RunMcpStdioOptions } from "./mcp.js";
import { auditLogPath } from "./paths.js";
import {
  OVERRIDE_EMAIL_MAX_LENGTH,
  OVERRIDE_IDENTIFIER_MAX_LENGTH,
  overrideEmailSchema,
  overrideIdentifierSchema,
} from "./profiles.js";
import { redactor, safeError } from "./redact.js";
import { DEFAULT_PORT, runServe, type RunServeOptions } from "./serve.js";
import { COOKIE_ONLY_FORMATS, SESSION_FORMATS, type SessionFormat } from "./session/format.js";
import { extraHeaderNames } from "./session/headers.js";
import type { SecretStore } from "./store/index.js";
import {
  assertNoForbiddenSecretFlags,
  assertNoSecretOnArgv,
  readSecret,
  SECRET_ON_ARGV_MESSAGE,
} from "./store/input.js";
import { isReservedProfileName, PolicyError, PROFILE_NAME_RE, SignInError } from "./types.js";
import { OriginMismatchError } from "./vault.js";
import { runWorkflow, type WorkflowRunOptions } from "./workflow.js";
import { VERSION } from "./version.js";

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  policy: 2,
  signIn: 3,
  missingSecret: 4,
  secretOnArgv: 5,
  originMismatch: 6,
  alert: 7,
} as const;

/** Appended to --help. Keep in sync with EXIT_CODES. */
export const EXIT_CODES_HELP = [
  "Exit codes:",
  "  0  ok",
  "  1  other error (including an audit-log write failure, a usage error such as a global",
  "     option after the subcommand, or an existing --out file without --force)",
  "  2  policy refusal (production, host, TTL, transport, invalid profile, a strategy",
  "     that cannot sign in here, e.g. session/check on an api-key profile or on an",
  "     app-handoff profile without options.mePath, or a rotate while another rotate of",
  "     the same profile is in progress)",
  "  3  sign-in failure (including a check identity mismatch, an app-handoff route that",
  "     was unreachable, refused the code or set no host-only cookie, and a rotate the app",
  "     refused or whose outcome is unknown; no credential is lost either way)",
  "  4  no stored secret (a human must run: testlane store set <profile>)",
  "  5  secret passed on the command line, or an unknown --option=value (refused before",
  "     reading stdin)",
  "  6  stored secret refused (origin or environment mismatch, or older format);",
  "     a human must re-run: testlane store set <profile>",
  "  7  status --alert: a non-production profile has an alert (no secret, rotation overdue,",
  "     pending rotation older than 1 h, legacy envelope, stored secret refused, store error)",
].join("\n");

/** Refusal of an unknown `--flag=value` outside `store set`. Never includes the argument. */
export const UNKNOWN_INLINE_OPTION_MESSAGE =
  "unknown option with an inline value is refused; write options before the subcommand and never pass secrets on the command line";

/** Refusal of a secret passed on the command line. Message never includes the argument. */
export class SecretOnArgvError extends Error {
  override readonly name = "SecretOnArgvError";
  constructor(message: string = SECRET_ON_ARGV_MESSAGE) {
    super(message);
  }
}

export interface BuildProgramOptions {
  deps?: Partial<CommandDeps> & { cwd?: string };
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  isTTY?: boolean;
  exit?: (code: number) => never;
}

interface GlobalOptions {
  profiles?: string;
  requester?: string;
  json?: boolean;
}


function classify(err: unknown): { code: number; text: string } {
  if (err instanceof SecretOnArgvError) return { code: EXIT_CODES.secretOnArgv, text: safeError(err) };
  if (err instanceof OriginMismatchError) {
    return { code: EXIT_CODES.originMismatch, text: `refused (${err.reason}): ${safeError(err)}` };
  }
  if (err instanceof PolicyError) return { code: EXIT_CODES.policy, text: `refused: ${safeError(err)}` };
  if (err instanceof SignInError) return { code: EXIT_CODES.signIn, text: safeError(err) };
  if (err instanceof MissingSecretError) return { code: EXIT_CODES.missingSecret, text: safeError(err) };
  return { code: EXIT_CODES.error, text: safeError(err) };
}

/** Throw SecretOnArgvError when any secret-looking flag appears anywhere in `args`. */
function assertNoSecretFlags(args: readonly string[]): void {
  try {
    assertNoForbiddenSecretFlags(args);
  } catch {
    throw new SecretOnArgvError();
  }
}

/**
 * Commander quotes offending tokens in its errors. Never echo an `=value`
 * part, the received argument of an invalid option (e.g. a --format choice)
 * or command-argument, an environment value, or an unknown command name.
 */
export function scrubCommanderError(text: string): string {
  return text
    .replace(/ argument '[\s\S]*' is invalid\./g, " argument is invalid.")
    .replace(/ value '[\s\S]*' from env '([^']*)' is invalid\./g, " value from env '$1' is invalid.")
    .replace(/command-argument value '[\s\S]*' is invalid for argument/g, "command-argument value is invalid for argument")
    .replace(/unknown command '[^\n]*?'(?=\n|$| \(|\.)/g, "unknown command")
    .replace(/'(-{1,2}[^='\s]*)=.*'/g, "'$1=<value>'")
    .replace(/(-{1,2}[^\s='"]*)=[^\s'"]*/g, "$1=<value>");
}

/** Every option flag (long and short) declared anywhere in the command tree, plus help. */
function knownFlags(cmd: Command, acc: Set<string> = new Set(["-h", "--help"])): Set<string> {
  for (const o of cmd.options) {
    if (o.long !== undefined) acc.add(o.long);
    if (o.short !== undefined) acc.add(o.short);
  }
  for (const sub of cmd.commands) knownFlags(sub, acc);
  return acc;
}

/**
 * Refuse any "--flag=value" / "-f=value" token whose flag is not one this CLI
 * declares. Commander would otherwise echo the unknown token, value included,
 * in its error message. Runs before commander parses anything. After
 * `store set` the refusal names the secret rule; elsewhere it is generic.
 */
function assertNoUnknownInlineValues(args: readonly string[], known: ReadonlySet<string>): void {
  for (const a of args) {
    if (a === "--") break;
    const m = /^(-{1,2}[^=\s]+)=/.exec(a);
    if (m !== null && !known.has(m[1] ?? "")) {
      throw new SecretOnArgvError(argsAfterStoreSet(args) !== null ? SECRET_ON_ARGV_MESSAGE : UNKNOWN_INLINE_OPTION_MESSAGE);
    }
  }
}

/** Replace control characters and line separators so app-supplied strings cannot forge output. */
function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/** The raw arguments after `store set`, including any root options written there. */
function argsAfterStoreSet(rawArgs: readonly string[]): string[] | null {
  for (let i = 0; i + 1 < rawArgs.length; i++) {
    if (rawArgs[i] === "store" && rawArgs[i + 1] === "set") return rawArgs.slice(i + 2);
  }
  return null;
}

function rawArgsOf(cmd: Command): string[] {
  let root: Command = cmd;
  while (root.parent !== null) root = root.parent;
  const raw = (root as unknown as { rawArgs?: unknown }).rawArgs;
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
}

function pad(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

// Option parsers: their messages never include the received value (commander's
// own wrapper quotes it, and scrubCommanderError removes that).

function parseTail(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError("must be a whole number");
  return Number(value);
}

function parseTtl(value: string): number {
  if (!/^\d{1,6}$/.test(value)) throw new InvalidArgumentError("must be a whole number of minutes");
  return Number(value);
}

function parseMaxAgeDays(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value)) throw new InvalidArgumentError("must be a positive whole number of days");
  return Number(value);
}

function parsePort(value: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("must be an integer between 0 and 65535");
  }
  return port;
}

function parseEmail(value: string): string {
  if (!overrideEmailSchema.safeParse(value).success) {
    throw new InvalidArgumentError(
      `must be a non-empty string without whitespace, at most ${OVERRIDE_EMAIL_MAX_LENGTH} characters`,
    );
  }
  return value;
}

function parseIdentifier(value: string): string {
  if (!overrideIdentifierSchema.safeParse(value).success) {
    throw new InvalidArgumentError(
      `must be a non-empty string without whitespace, at most ${OVERRIDE_IDENTIFIER_MAX_LENGTH} characters`,
    );
  }
  return value;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if (isErrnoCode(e, "ENOENT")) return false;
    throw e;
  }
}

/** Names the path only (never file contents). */
function outExistsMessage(file: string): string {
  return `refusing to overwrite existing file ${file}; choose a new --out path or pass --force to replace it`;
}

/** A profile argument as it may be echoed: only a well-formed name is printed (same test as getProfile). */
function shownProfile(name: string): string {
  return PROFILE_NAME_RE.test(name) && name.length <= 128 ? name : "(not a valid profile name)";
}

export function buildProgram(opts: BuildProgramOptions = {}): Command {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  const injected = opts.deps ?? {};
  const cwd = injected.cwd ?? process.cwd();

  const out = (text: string): void => {
    stdout.write(redactor.redact(text));
  };
  const err = (text: string): void => {
    stderr.write(redactor.redact(text));
  };
  const fail = (e: unknown, prefix = ""): never => {
    const { code, text } = classify(e);
    err(`${prefix}${text}\n`);
    return exit(code);
  };

  // One store per program; the platform adapter is picked on first use.
  let store: SecretStore | undefined = injected.store;
  const getStore = (): SecretStore => (store ??= new LazyStore());

  /**
   * One stderr line per account override that matches no profile in this
   * registry (the overrides file is machine-global). Never fatal; printed at
   * most once per invocation.
   */
  let warnedUnused = false;
  const warnUnusedOverrides = (deps: CommandDeps): void => {
    if (warnedUnused) return;
    warnedUnused = true;
    for (const name of deps.registry.unusedOverrides ?? []) {
      err(`warning: account override for "${shownProfile(name)}" matches no profile in this registry\n`);
    }
  };

  /** Fresh deps via src/deps.ts; --profiles / --requester win over test injection. */
  function resolveDeps(cmd: Command): Promise<CommandDeps> {
    const g = cmd.optsWithGlobals<GlobalOptions>();
    const o: ResolveDepsOptions = { cwd, store: getStore() };
    if (g.profiles !== undefined) o.profilesFile = g.profiles;
    else if (injected.registry !== undefined) o.registry = injected.registry;
    const requester = g.requester ?? injected.requester;
    if (requester !== undefined) o.requester = requester;
    if (injected.fetchImpl !== undefined) o.fetchImpl = injected.fetchImpl;
    if (injected.now !== undefined) o.now = injected.now;
    return resolveCommandDeps(o);
  }

  const program = new Command();
  // Must precede every .command() call so subcommands inherit these settings.
  program.exitOverride();
  // Global options only before the subcommand; after it they are unknown options.
  program.enablePositionalOptions();
  program.configureOutput({
    writeOut: out,
    writeErr: err,
    outputError: (text, write) => write(scrubCommanderError(text)),
  });

  program
    .name("testlane")
    .version(VERSION, "-V, --version", "print the Testlane version")
    .description(
      "Testlane: a local credential broker that signs into sandbox apps without handling stored passwords in the agent.\n" +
        "Global options (--profiles, --requester, --json) go before the subcommand.\n" +
        "Options that take a value may be written as --opt=value.",
    )
    .option("--profiles <file>", "profile registry file (instead of testlane.profiles.json discovery)")
    .option("--requester <name>", "who is asking, recorded in the audit log")
    .option("--json", "machine-readable output where applicable")
    .addHelpText("after", `\n${EXIT_CODES_HELP}\n`);

  // Refuse secret-looking flags anywhere on the command line before commander
  // parses anything: commander would otherwise report (and echo) an unknown
  // `--password=...` in its error message.
  const preScan = (argv: readonly string[] | undefined): void => {
    try {
      const args = argv ?? process.argv;
      assertNoSecretFlags(args);
      assertNoUnknownInlineValues(args, knownFlags(program));
    } catch (e) {
      fail(e);
    }
  };
  const parseAsync = program.parseAsync.bind(program);
  const parseSync = program.parse.bind(program);
  program.parseAsync = ((argv?: readonly string[], parseOpts?: ParseOptions) => {
    preScan(argv);
    return parseAsync(argv, parseOpts);
  }) as Command["parseAsync"];
  program.parse = ((argv?: readonly string[], parseOpts?: ParseOptions) => {
    preScan(argv);
    return parseSync(argv, parseOpts);
  }) as Command["parse"];

  const workflows = program.command("workflow").description("run a shipped smoke or two-role feature workflow with a reviewed manifest");
  for (const kind of ["smoke", "feature"] as const) {
    const command = workflows.command(kind)
      .description(kind === "smoke" ? "verify one approved profile in a local app" : "verify writer/reader permissions and record cleanup in a local app")
      .requiredOption("--manifest <file>", "reviewed workflow manifest")
      .option("--output-dir <dir>", "sanitized evidence directory (default output under the app working directory)")
      .option("--json", "print the versioned workflow report as JSON");
    if (kind === "feature") command.requiredOption("--receipt <file>", "trusted test-environment receipt");
    command.action(async (o: { manifest: string; receipt?: string; outputDir?: string; json?: boolean }, cmd: Command) => {
      let code: number;
      try {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const options: WorkflowRunOptions = { kind, manifest: o.manifest, cwd, stdout, stderr, json: o.json === true || globals.json === true };
        if (o.receipt !== undefined) options.receipt = o.receipt;
        if (o.outputDir !== undefined) options.outputDir = o.outputDir;
        if (globals.profiles !== undefined) options.profilesFile = globals.profiles;
        if (globals.requester !== undefined) options.requester = globals.requester;
        code = await runWorkflow(options);
      } catch { err("Testlane workflow could not start; check the installation and reviewed inputs.\n"); return exit(1); }
      if (code !== 0) exit(code);
    });
  }

  program
    .command("doctor")
    .description("diagnose setup without reading credentials; --check explicitly signs in")
    .option("--json", "structured diagnostic report")
    .option("--check <profile>", "explicitly authenticate one approved profile and discard its session")
    .action(async (o: { json?: boolean; check?: string }, cmd: Command) => {
      let report: DoctorReport;
      try {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const options: DoctorOptions = { cwd };
        if (globals.profiles !== undefined) options.profilesFile = globals.profiles;
        else if (injected.registry !== undefined) options.registry = injected.registry;
        if (o.check !== undefined) {
          options.authenticationProfile = o.check;
          options.authenticate = async (profile) => checkProfile(await resolveDeps(cmd), profile);
        }
        report = await collectDoctor(options);
      } catch (e) { return fail(e); }
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      out(o.json || globals.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
      if (report.exitCode !== 0) exit(report.exitCode);
    });

  program
    .command("profiles")
    .description("list profiles (no secrets)")
    .action(async (_o: unknown, cmd: Command) => {
      try {
        const deps = await resolveDeps(cmd);
        warnUnusedOverrides(deps);
        const { profiles, sources } = listProfiles(deps);
        if (cmd.optsWithGlobals<GlobalOptions>().json === true) {
          out(`${JSON.stringify({ profiles, sources }, null, 2)}\n`);
          return;
        }
        const rows = [["NAME", "ENV", "STRATEGY", "EMAIL", "ROLE", "TTL", "BASEURL"]];
        for (const p of profiles) {
          // An email from the user-level account overrides file is marked "(override)".
          const email = p.overridden === true ? `${printable(p.email)} (override)` : p.email || "-";
          rows.push([p.name, p.environment, p.strategy, email, p.role || "-", `${p.ttlMinutes}m`, p.baseUrl]);
        }
        for (const line of pad(rows)) out(`${line}\n`);
        out(`sources: ${sources.length > 0 ? sources.join(", ") : "(none)"}\n`);
      } catch (e) {
        fail(e);
      }
    });

  const storeCmd = program.command("store").description("manage stored secrets (human only)");

  storeCmd
    .command("set")
    .description("store the secret for a profile; reads the prompt or stdin, never argv")
    .argument("<profile>", "profile name")
    // Parse permissively (and pass everything after the profile through untouched) so the
    // refusal below, not commander, handles extras, without echoing them.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .passThroughOptions()
    .action(async (profile: string, _o: unknown, cmd: Command) => {
      try {
        const after = argsAfterStoreSet(rawArgsOf(cmd)) ?? cmd.args;
        try {
          // Only the profile name: global flags belong before the subcommand.
          assertNoSecretOnArgv(after, { positionals: 1, allowedFlags: [] });
        } catch {
          throw new SecretOnArgvError();
        }
        if (cmd.args.length !== 1) throw new SecretOnArgvError();
      } catch (e) {
        fail(e);
      }
      try {
        const deps = await resolveDeps(cmd);
        // Validate the profile (and refuse production) before a single byte of secret is read.
        await assertStorable(deps, profile);
        // Reading `kind` selects the store adapter before anything is typed, without reading
        // any value, so only a store-SELECTION failure (e.g. `secret-tool` not on PATH:
        // "no keychain available") comes before the prompt. Problems that need the keychain
        // itself, such as no D-Bus session or a locked keyring, still surface when the store
        // is first used, after the secret was typed; the secret is then discarded.
        const storeKind = deps.store.kind;
        const readOpts: Parameters<typeof readSecret>[0] = {
          stdin,
          stdout,
          prompt: `Secret for ${profile} (input hidden): `,
        };
        if (opts.isTTY !== undefined) readOpts.isTTY = opts.isTTY;
        const secret = await readSecret(readOpts);
        await storeSet(deps, profile, secret);
        out(`stored secret for ${profile} in ${storeKind} store\n`);
      } catch (e) {
        fail(e);
      }
    });

  storeCmd
    .command("delete")
    .description("delete the stored secret for a profile")
    .argument("<profile>", "profile name")
    .action(async (profile: string, _o: unknown, cmd: Command) => {
      try {
        const deps = await resolveDeps(cmd);
        const { deleted } = await storeDelete(deps, profile);
        out(deleted ? `deleted secret for ${profile}\n` : `no secret stored for ${profile}\n`);
      } catch (e) {
        fail(e);
      }
    });

  storeCmd
    .command("list")
    .description("list profiles that have a stored secret (names only; --json also lists internal entries)")
    .action(async (_o: unknown, cmd: Command) => {
      try {
        const deps = await resolveDeps(cmd);
        const names = await storeList(deps);
        // Internal: the encrypted-file data key, and any entry that is not a profile in the registry.
        const isProfile = (n: string): boolean =>
          !isReservedProfileName(n) && Object.hasOwn(deps.registry.profiles, n);
        const profiles = names.filter(isProfile);
        const internal = names.filter((n) => !isProfile(n));
        if (cmd.optsWithGlobals<GlobalOptions>().json === true) {
          out(`${JSON.stringify({ profiles, internal })}\n`);
          return;
        }
        if (profiles.length === 0) err("no secrets stored\n");
        for (const n of profiles) out(`${n}\n`);
      } catch (e) {
        fail(e);
      }
    });

  const accountCmd = program
    .command("account")
    .description(
      "manage user-level account overrides (human only): change only the email / identifier of an existing non-production profile",
    );

  accountCmd
    .command("set")
    .description(
      "override account.email (and optionally account.identifier) of a profile in <TESTLANE_HOME>/testlane.overrides.json; no store set needed",
    )
    .argument("<profile>", "profile name")
    .addOption(
      new Option("--email <email>", "account email to sign in as (not a secret)").argParser(parseEmail).makeOptionMandatory(),
    )
    .addOption(
      new Option(
        "--identifier <value>",
        "account.identifier: the identifier dependent-token sends as {{identifier}} (not a secret)",
      ).argParser(parseIdentifier),
    )
    .action(async (profile: string, o: { email: string; identifier?: string }, cmd: Command) => {
      try {
        const deps = await resolveDeps(cmd);
        const input: Parameters<typeof accountSet>[2] = { email: o.email };
        if (o.identifier !== undefined) input.identifier = o.identifier;
        const { override } = await accountSet(deps, profile, input);
        const code = override.identifier !== undefined ? ` identifier=${printable(override.identifier)}` : "";
        out(`account override for ${profile}: email=${printable(override.email ?? "")}${code}\n`);
      } catch (e) {
        fail(e);
      }
    });

  accountCmd
    .command("clear")
    .description("remove the account override for a profile (works even if the profile no longer exists)")
    .argument("<profile>", "profile name")
    .action(async (profile: string) => {
      try {
        const { cleared } = await accountClear(profile);
        out(cleared ? `cleared account override for ${profile}\n` : `no account override for ${profile}\n`);
      } catch (e) {
        fail(e);
      }
    });

  accountCmd
    .command("list")
    .description(
      'list account overrides; entries matching no profile in the current registry are marked "(unused here)" (global --json before the subcommand for JSON)',
    )
    .action(async (_o: unknown, cmd: Command) => {
      try {
        const { file, overrides } = await accountList();
        // Best effort: without a loadable registry nothing is marked.
        let known: Set<string> | null = null;
        try {
          known = new Set(Object.keys((await resolveDeps(cmd)).registry.profiles));
        } catch {
          known = null;
        }
        const unusedHere = Object.keys(overrides)
          .sort()
          .filter((n) => known !== null && !known.has(n));
        if (cmd.optsWithGlobals<GlobalOptions>().json === true) {
          out(`${JSON.stringify({ file, overrides, unusedHere }, null, 2)}\n`);
          return;
        }
        const names = Object.keys(overrides).sort();
        if (names.length === 0) {
          err("no account overrides\n");
          return;
        }
        const rows: string[][] = [];
        for (const name of names) {
          const o = overrides[name] ?? {};
          const row = [name];
          if (o.email !== undefined) row.push(`email=${printable(o.email)}`);
          if (o.identifier !== undefined) row.push(`identifier=${printable(o.identifier)}`);
          if (unusedHere.includes(name)) row.push("(unused here)");
          rows.push(row);
        }
        for (const line of pad(rows)) out(`${line}\n`);
        out(`file: ${file}\n`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command("session")
    .description("sign in and print a session artifact (the deliverable) to stdout or --out")
    .argument("<profile>", "profile name")
    .addOption(
      new Option("--format <format>", "output format").choices(SESSION_FORMATS).default("cookie"),
    )
    .addOption(
      new Option("--ttl <minutes>", "requested lifetime; must not exceed the profile TTL").argParser(parseTtl),
    )
    .option("--target <url>", "URL the session will be used against (host allowlist check)")
    .option(
      "--out <file>",
      "write the artifact to a new file instead of stdout (never overwrites; mode 0600 on POSIX; inherits folder ACLs on Windows)",
    )
    .option("--force", "with --out: replace an existing file")
    .action(
      async (
        profile: string,
        o: { format: SessionFormat; ttl?: number; target?: string; out?: string; force?: boolean },
        cmd: Command,
      ) => {
        try {
          const outFile = o.out !== undefined ? path.resolve(cwd, o.out) : undefined;
          // Refuse before signing in, so no session is issued only to be discarded.
          if (outFile !== undefined && o.force !== true && (await pathExists(outFile))) {
            throw new Error(outExistsMessage(outFile));
          }
          const deps = await resolveDeps(cmd);
          warnUnusedOverrides(deps);
          const sessionOpts: Parameters<typeof issueSession>[2] = { format: o.format };
          if (o.ttl !== undefined) sessionOpts.ttlMinutes = o.ttl;
          if (o.target !== undefined) sessionOpts.targetUrl = o.target;
          const { output, artifact, warnings } = await issueSession(deps, profile, sessionOpts);
          for (const w of warnings) err(`warning: ${printable(w)}\n`);
          const extra = extraHeaderNames(artifact);
          if (extra.length > 0 && COOKIE_ONLY_FORMATS.includes(o.format)) {
            // Header names only, never values.
            err(
              `warning: ${extra.length} header(s) (${extra.map(printable).join(", ")}) are not representable in format ${o.format}; use --format headers\n`,
            );
          }
          // Redacted here, not only by out(): the --out file is an output path too, so a
          // stored secret the app echoed inside the session never reaches it either.
          const redacted = redactor.redact(output);
          const text = redacted.endsWith("\n") ? redacted : `${redacted}\n`;
          if (outFile !== undefined) {
            // "wx" = create only: an existing file (even one created since the check above) is never replaced.
            try {
              await writeFile(outFile, text, { encoding: "utf8", mode: 0o600, flag: o.force === true ? "w" : "wx" });
            } catch (e) {
              if (isErrnoCode(e, "EEXIST")) throw new Error(outExistsMessage(outFile));
              throw e;
            }
            if (process.platform !== "win32") await chmod(outFile, 0o600);
            out(`wrote ${o.format} session for ${profile} to ${outFile} (expires ${artifact.expiresAt})\n`);
          } else {
            out(text);
          }
        } catch (e) {
          fail(e);
        }
      },
    );

  program
    .command("check")
    .description("sign in, confirm the identity with the app, print only email/role")
    .argument("<profile>", "profile name")
    .action(async (profile: string, _o: unknown, cmd: Command) => {
      let result: CheckOutcome;
      try {
        const deps = await resolveDeps(cmd);
        warnUnusedOverrides(deps);
        result = await checkProfile(deps, profile);
      } catch (e) {
        return fail(e, `FAIL  ${shownProfile(profile)}  `);
      }
      for (const w of result.warnings ?? []) err(`warning: ${printable(w)}\n`);
      // An identity mismatch is a sign-in class failure (exit 3).
      if (cmd.optsWithGlobals<GlobalOptions>().json === true) {
        out(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) exit(EXIT_CODES.signIn);
        return;
      }
      if (!result.ok) {
        err(`FAIL  ${shownProfile(result.profile)}  ${printable(result.message ?? "identity mismatch")}\n`);
        exit(EXIT_CODES.signIn);
        return;
      }
      out(
        `ok  ${result.profile}  ${printable(result.email ?? "-")}  role=${printable(result.role ?? "-")} (${result.roleSource})  expires=${result.expiresAt}\n`,
      );
    });

  program
    .command("handoff")
    .description(
      "print a one-time sign-in URL for an app-handoff profile as JSON { url, expiresAt, profile } (60 s, single use)",
    )
    .argument("<profile>", "profile name")
    .action(async (profile: string, _o: unknown, cmd: Command) => {
      try {
        const deps = await resolveDeps(cmd);
        warnUnusedOverrides(deps);
        const h = await issueHandoff(deps, profile);
        // Identical with or without --json: the URL is the deliverable.
        out(`${JSON.stringify({ url: h.url, expiresAt: h.expiresAt, profile: h.profile }, null, 2)}\n`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command("rotate")
    .description(
      "human command: change the app password through the profile's rotate* options and update the vault " +
        "(two-phase: the new secret is stored as pending first, so no outcome loses the live credential); prints no secret",
    )
    .argument("<profile>", "profile name")
    .action(async (profile: string, _o: unknown, cmd: Command) => {
      try {
        const deps = await resolveDeps(cmd);
        warnUnusedOverrides(deps);
        const r = await rotateProfile(deps, profile);
        if (r.resolvedPending !== undefined) {
          err(
            r.resolvedPending === "promoted"
              ? `note: a pending secret from an earlier interrupted rotation was live and has been promoted first\n`
              : `note: a pending secret from an earlier interrupted rotation was not live and has been dropped first\n`,
          );
        }
        if (cmd.optsWithGlobals<GlobalOptions>().json === true) {
          out(`${JSON.stringify(r, null, 2)}\n`);
          return;
        }
        const via = r.via !== null ? ` via ${r.via}` : "";
        out(
          `rotated ${r.profile}${via}: the app answered HTTP ${r.status} and a sign-in with the new secret succeeded; ` +
            `stored ${r.storedAt}\n`,
        );
      } catch (e) {
        fail(e, `FAIL  ${shownProfile(profile)}  `);
      }
    });

  program
    .command("status")
    .description(
      "per-profile secret health (stored, age, pending rotation, override, alerts); never prints a value. " +
        "--alert exits 7 when any non-production profile has an alert",
    )
    .option("--json", "machine-readable output (same as the global --json)")
    .addOption(
      new Option(
        "--max-age-days <n>",
        `age limit for profiles without options.rotateEveryDays (default ${DEFAULT_MAX_AGE_DAYS})`,
      ).argParser(parseMaxAgeDays),
    )
    .option("--alert", "exit 7 when any non-production profile has an alert")
    .action(async (o: { json?: boolean; maxAgeDays?: number; alert?: boolean }, cmd: Command) => {
      let alerting: boolean;
      try {
        const deps = await resolveDeps(cmd);
        warnUnusedOverrides(deps);
        const statusOpts: StatusOptions = {};
        if (o.maxAgeDays !== undefined) statusOpts.maxAgeDays = o.maxAgeDays;
        const report = await profileStatus(deps, statusOpts);
        alerting = report.alerting;
        if (o.json === true || cmd.optsWithGlobals<GlobalOptions>().json === true) {
          out(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const rows = [["PROFILE", "ENV", "STRATEGY", "SECRET", "STORED", "AGE", "LIMIT", "PENDING", "ALERTS"]];
          for (const p of report.profiles) {
            const name = p.override ? `${p.profile} (override)` : p.profile;
            if (p.environment === "production") {
              rows.push([name, p.environment, p.strategy, "-", "-", "-", "-", "-", "(production: never read)"]);
              continue;
            }
            rows.push([
              name,
              p.environment,
              p.strategy,
              p.refused !== undefined
                ? `refused (${p.refused})`
                : p.alerts.includes("store-error")
                  ? "error"
                  : p.hasSecret
                    ? "yes"
                    : "no",
              p.hasSecret && p.refused === undefined ? (p.storedAt ?? "unknown") : "-",
              p.ageDays !== null ? `${p.ageDays}d` : "-",
              `${p.maxAgeDays}d${p.rotateEveryDays !== null ? " (rotateEveryDays)" : ""}`,
              p.pendingRotation ? `since ${p.pendingSince ?? "unknown"}` : "-",
              p.alerts.length > 0 ? p.alerts.join(",") : "ok",
            ]);
          }
          for (const line of pad(rows)) out(`${line}\n`);
          const n = report.profiles.filter((p) => p.alerts.length > 0).length;
          out(n > 0 ? `alerts: ${n} profile(s) need attention\n` : "no alerts\n");
        }
      } catch (e) {
        return fail(e);
      }
      if (o.alert === true && alerting) exit(EXIT_CODES.alert);
    });

  program
    .command("audit")
    .description("show the last audit rows")
    .addOption(new Option("--tail <n>", "number of rows").argParser(parseTail).default(20))
    .action(async (o: { tail: number }, cmd: Command) => {
      try {
        const tail = await auditTail(o.tail);
        if (cmd.optsWithGlobals<GlobalOptions>().json === true) {
          out(`${JSON.stringify(tail, null, 2)}\n`);
          return;
        }
        for (const row of tail.rows) out(`${formatAuditRow(row)}\n`);
        if (tail.malformed > 0) {
          out(`note: ${tail.malformed} malformed line(s) skipped in ${auditLogPath()}\n`);
        }
      } catch (e) {
        fail(e);
      }
    });

  program
    .command("mcp")
    .description(
      "MCP server over stdio, server name testlane (tools: list_profiles, session, session_file, release_session_file, check, handoff, status)",
    )
    .action(async (_o: unknown, cmd: Command) => {
      // stdout is the protocol channel: nothing here writes to it.
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const mcpOpts: RunMcpStdioOptions = { cwd };
      if (g.profiles !== undefined) mcpOpts.profilesFile = g.profiles;
      if (g.requester !== undefined) mcpOpts.requester = g.requester;
      try {
        // Loaded on demand so other commands do not pay for the MCP SDK.
        const { runMcpStdio } = await import("./mcp.js");
        await runMcpStdio(mcpOpts);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command("serve")
    .description(
      "localhost HTTP API on 127.0.0.1 (bearer token in <TESTLANE_HOME>/http-token, or http-token-<port> for a non-default port; no store endpoints)",
    )
    .addOption(
      new Option("--port <port>", "TCP port on 127.0.0.1 (0 picks a free port)")
        .argParser(parsePort)
        .default(DEFAULT_PORT),
    )
    .action(async (o: { port: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const serveOpts: RunServeOptions = { port: o.port, cwd };
      if (g.profiles !== undefined) serveOpts.profilesFile = g.profiles;
      if (g.requester !== undefined) serveOpts.requester = g.requester;
      try {
        await runServe(serveOpts);
      } catch (e) {
        fail(e);
      }
    });

  return program;
}

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run the CLI with user arguments (no node/script prefix) and resolve to the
 * exit code instead of exiting, so pending stdout writes can drain.
 */
export async function runCli(
  argv: readonly string[],
  opts: Omit<BuildProgramOptions, "exit"> = {},
): Promise<number> {
  const stderr = opts.stderr ?? process.stderr;
  const program = buildProgram({
    ...opts,
    exit: (code: number): never => {
      throw new ExitSignal(code);
    },
  });
  try {
    await program.parseAsync([...argv], { from: "user" });
    return EXIT_CODES.ok;
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    if (e instanceof CommanderError) return e.exitCode;
    stderr.write(`${safeError(e)}\n`);
    return EXIT_CODES.error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/**
 * A reader that closes the pipe early (`testlane profiles | head -1`) is not an
 * error: ignore EPIPE on the standard streams so it is neither an unhandled
 * 'error' event nor a stack trace, and the command keeps its own exit code.
 */
function ignoreBrokenPipe(...streams: NodeJS.WriteStream[]): void {
  for (const stream of streams) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") throw err;
    });
  }
}

async function main(): Promise<void> {
  ignoreBrokenPipe(process.stdout, process.stderr);
  redactor.install();
  process.exitCode = await runCli(process.argv.slice(2));
}

if (isMainModule()) {
  void main();
}
