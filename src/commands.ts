/**
 * Command implementations shared by every agent surface (CLI now; MCP server
 * and localhost HTTP later). Pure functions over injected dependencies: they
 * print nothing, and every error they let escape carries a message that is
 * already safe to show (no secret, no session value).
 *
 * Secret handling: secrets are loaded only through src/vault.ts
 * (getProfileSecrets), which checks the stored origin binding and registers
 * every value with the process-wide redactor before returning it. Secrets
 * exist here only in local variables between that call and `strategy.signIn`
 * (or the rotation request body); they are never returned.
 *
 * Rotation (`rotateProfile`) is two-phase and never loses a credential: the
 * new value is stored as a pending secret next to the current one before the
 * app is asked to change the password, and a pending value is promoted or
 * dropped only once a sign-in has shown which value the app accepts.
 */
import { randomBytes } from "node:crypto";
import {
  AuditRefusedError,
  appendAudit,
  looksLikeSecretAssignment,
  readAuditTail,
  type AuditInput,
  type AuditTail,
} from "./audit.js";
import { assertAllowed, hostOf, type PolicyContext, type PolicyDecision } from "./policy.js";
import { accountOverridesPath } from "./paths.js";
import {
  getProfile,
  overrideEmailSchema,
  overrideIdentifierSchema,
  productionHosts,
  productionOverlaps,
  readAccountOverrides,
  summarizeProfile,
  writeAccountOverrides,
  type AccountOverride,
  type AccountOverrides,
  type ProfileSummary,
} from "./profiles.js";
import { CookieJar } from "./http/cookie-jar.js";
import { acquireLock, LockHeldError, ROTATE_LOCK_STALE_MS, rotateLockPath, type HeldLock } from "./lock.js";
import { Redactor, redactor, safeError } from "./redact.js";
import { formatSession, type SessionFormat } from "./session/format.js";
import { KEY_PREFIX, secretKeyFor, type SecretStore } from "./store/index.js";
import { buildHandoffUrl, HANDOFF_SECRET_MIN_LENGTH, handoffSecretTooShortError } from "./handoff.js";
import { getStrategy, isSignInStrategy, type SignInContext, type WhoAmI } from "./strategies/index.js";
import { optionValue, resolveOptionUrl } from "./strategies/form-post.js";
import { USER_AGENT } from "./strategies/nextauth-credentials.js";
import {
  MAX_ROTATE_EVERY_DAYS,
  parseRotateBody,
  ROTATE_BODY_FORMATS,
  ROTATE_EVERY_DAYS_RE,
  ROTATE_METHODS,
  type RotateBodyFormat,
  type RotateMethod,
} from "./strategies/options.js";
import {
  dropPendingSecret,
  getProfileSecrets,
  OriginMismatchError,
  promotePendingSecret,
  putProfileSecret,
  setPendingSecret,
  type ProfileSecrets,
} from "./vault.js";
import {
  isCredentialsRejected,
  PolicyError,
  PROFILE_NAME_RE,
  SignInError,
  type AuditRow,
  type CheckResult,
  type Environment,
  type Profile,
  type ProfileRegistry,
  type SessionArtifact,
  type StrategyName,
} from "./types.js";

export interface CommandDeps {
  store: SecretStore;
  registry: ProfileRegistry;
  /** Injectable fetch (tests); defaults to the global fetch inside the strategy. */
  fetchImpl?: typeof fetch;
  /** Who asked (audit only; best effort, not authentication). */
  requester: string;
  /** Clock for audit timestamps (tests). */
  now?: () => Date;
}

/** Thrown when a profile has no secret in the store. Message is safe to print. */
export class MissingSecretError extends Error {
  override readonly name = "MissingSecretError";
  constructor(public readonly profile: string) {
    super(`No secret stored for "${profile}". A human must run: testlane store set ${profile}`);
  }
}

/** How a failed rotation ended. Every outcome keeps at least one working credential stored. */
export type RotationFailure =
  /** The app answered a non-2xx status; the pending value was dropped (the current secret still signs in). */
  | "app-rejected"
  /**
   * Network failure, no sign-in could decide, or a 2xx whose new secret does not
   * sign in yet; the pending value is KEPT for the next sign-in to resolve.
   */
  | "unknown-outcome"
  /** An earlier pending value could not be verified; nothing was changed. */
  | "pending-unverified"
  /** The stored pending value changed underneath this rotation (another rotate or a store set). */
  | "pending-changed";

/**
 * A rotation that did not complete. A sign-in class failure (exit 3) whose
 * message is safe to print and never contains either secret.
 */
export class RotationError extends SignInError {
  constructor(
    message: string,
    public readonly outcome: RotationFailure,
    status?: number,
  ) {
    super(message, status);
  }
}

function nowOf(deps: Pick<CommandDeps, "now">): Date {
  return deps.now !== undefined ? deps.now() : new Date();
}


// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

interface AuditFields {
  ok: boolean;
  reason?: string;
  format?: string;
}

async function audit(
  deps: Pick<CommandDeps, "requester" | "now">,
  profile: Profile,
  event: AuditRow["event"],
  fields: AuditFields,
): Promise<void> {
  const row: AuditInput = {
    event,
    profile: profile.name,
    host: hostOf(profile.baseUrl),
    environment: profile.environment,
    strategy: profile.strategy,
    requester: deps.requester,
    ok: fields.ok,
  };
  if (fields.reason !== undefined) row.reason = fields.reason;
  if (fields.format !== undefined) row.format = fields.format;
  if (deps.now !== undefined) row.ts = deps.now().toISOString();
  await appendAudit(row);
}

/**
 * Audit a failure whose reason is free text (an error message). If the audit
 * guard refuses that text (too long, looks like an assignment), the row is
 * still written with the fallback code so the failure is never unrecorded.
 */
async function auditFailure(
  deps: Pick<CommandDeps, "requester" | "now">,
  profile: Profile,
  event: AuditRow["event"],
  reason: string,
  fallback: string,
  format?: string,
): Promise<void> {
  const base: AuditFields = format === undefined ? { ok: false } : { ok: false, format };
  try {
    await audit(deps, profile, event, { ...base, reason });
  } catch (err) {
    if (!(err instanceof AuditRefusedError)) throw err;
    await audit(deps, profile, event, { ...base, reason: fallback });
  }
}

// ---------------------------------------------------------------------------
// Profiles and store
// ---------------------------------------------------------------------------

export function listProfiles(deps: Pick<CommandDeps, "registry">): {
  profiles: ProfileSummary[];
  sources: string[];
} {
  const overridden = new Set(deps.registry.overrides ?? []);
  const profiles = Object.values(deps.registry.profiles)
    .map((p): ProfileSummary => {
      const summary = summarizeProfile(p);
      if (overridden.has(p.name)) summary.overridden = true;
      return summary;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { profiles, sources: [...deps.registry.sources] };
}

// ---------------------------------------------------------------------------
// Account overrides (human only; see README "Trust model")
// ---------------------------------------------------------------------------

export interface AccountSetInput {
  email: string;
  identifier?: string;
}

/**
 * Record a user-level account override for an existing non-production
 * profile: only `account.email` (and optionally `account.identifier`) are
 * replaced, and the whole previous override for that profile is replaced.
 * The values are not secrets. The stored secret stays bound to origin +
 * environment only, so no `store set` is needed afterwards.
 *
 * @throws PolicyError "unknown-profile" / "production-refused" (exit 2), or
 *   an Error naming the invalid field (never its value).
 */
export async function accountSet(
  deps: Pick<CommandDeps, "registry">,
  profileName: string,
  input: AccountSetInput,
  file: string = accountOverridesPath(),
): Promise<{ profile: string; override: AccountOverride; file: string }> {
  const profile = getProfile(deps.registry, profileName);
  if (profile.environment === "production") {
    throw new PolicyError(
      `Profile "${profile.name}" is tagged environment "production"; account overrides never apply to production profiles.`,
      "production-refused",
    );
  }
  if (!overrideEmailSchema.safeParse(input.email).success) {
    throw new Error(`invalid --email: must be a non-empty string without whitespace, at most 254 characters`);
  }
  const override: AccountOverride = { email: input.email };
  if (input.identifier !== undefined) {
    if (!overrideIdentifierSchema.safeParse(input.identifier).success) {
      throw new Error(`invalid --identifier: must be a non-empty string without whitespace, at most 128 characters`);
    }
    override.identifier = input.identifier;
  }
  const overrides = await readAccountOverrides(file);
  overrides[profile.name] = override;
  await writeAccountOverrides(overrides, file);
  return { profile: profile.name, override, file };
}

/**
 * Remove the account override for `profileName`. Works on the overrides file
 * alone (no registry needed), so an override for a profile the current
 * registry lacks (or a refused production override) can always be cleared.
 */
export async function accountClear(
  profileName: string,
  file: string = accountOverridesPath(),
): Promise<{ cleared: boolean; file: string }> {
  if (!PROFILE_NAME_RE.test(profileName) || profileName.length > 128) {
    throw new PolicyError("Not a valid profile name.", "invalid-profile");
  }
  const overrides = await readAccountOverrides(file);
  if (!Object.hasOwn(overrides, profileName)) return { cleared: false, file };
  delete overrides[profileName];
  await writeAccountOverrides(overrides, file);
  return { cleared: true, file };
}

/** The account overrides file's content (profile name -> override). No registry needed. */
export async function accountList(
  file: string = accountOverridesPath(),
): Promise<{ file: string; overrides: AccountOverrides }> {
  return { file, overrides: await readAccountOverrides(file) };
}

/**
 * Resolve `profileName` and refuse (with an audit row) when it is tagged
 * production, or when its base or an allowed hostname belongs to any
 * production profile in the registry: the broker never stores a production
 * secret, nor one bound to a production origin. The CLI calls this before
 * reading a single byte of the secret.
 */
export async function assertStorable(deps: CommandDeps, profileName: string): Promise<Profile> {
  const profile = getProfile(deps.registry, profileName);
  if (profile.environment === "production") {
    await audit(deps, profile, "refused", { ok: false, reason: "production-refused" });
    throw new PolicyError(
      `Profile "${profile.name}" is tagged environment "production"; Testlane never stores or uses production secrets. ` +
        "There is no override flag, environment variable or interactive bypass, by design.",
      "production-refused",
    );
  }
  const overlap = productionOverlaps(deps.registry.profiles).find((o) => o.profile === profile.name);
  if (overlap !== undefined) {
    await audit(deps, profile, "refused", { ok: false, reason: "production-refused" });
    throw new PolicyError(
      `Profile "${profile.name}" ${overlap.field} host "${overlap.host}" belongs to production profile "${overlap.owner}"; ` +
        "Testlane never stores or uses production secrets. " +
        "There is no override flag, environment variable or interactive bypass, by design.",
      "production-refused",
    );
  }
  return profile;
}

export async function storeSet(
  deps: CommandDeps,
  profileName: string,
  secret: string,
): Promise<{ key: string }> {
  const profile = await assertStorable(deps, profileName);
  const key = secretKeyFor(profile);
  if (profile.strategy === "app-handoff" && (typeof secret !== "string" || secret.length < HANDOFF_SECRET_MIN_LENGTH)) {
    // Never echo the value (or its length): name the rule and how to make a good one.
    await audit(deps, profile, "refused", { ok: false, reason: "handoff-secret-too-short" });
    throw new Error(
      `refusing to store the handoff secret for ${profile.name}: app-handoff secrets must be at least ` +
        `${HANDOFF_SECRET_MIN_LENGTH} characters. Generate one with \`openssl rand -base64 32\`, set the same value as ` +
        "AGENT_HANDOFF_SECRET in the app deployment, and store it here.",
    );
  }
  // Bound to the profile's current baseUrl origin and environment (see src/vault.ts).
  await putProfileSecret(deps.store, profile, secret, nowOf(deps));
  await audit(deps, profile, "store.set", { ok: true });
  return { key };
}

export async function storeDelete(
  deps: CommandDeps,
  profileName: string,
): Promise<{ deleted: boolean }> {
  const profile = getProfile(deps.registry, profileName);
  const deleted = await deps.store.delete(secretKeyFor(profile));
  await audit(deps, profile, "store.delete", deleted ? { ok: true } : { ok: true, reason: "not-found" });
  return { deleted };
}

/** Profile names that currently have a secret. Never returns values. */
export async function storeList(deps: Pick<CommandDeps, "store">): Promise<string[]> {
  const keys = await deps.store.list();
  return keys
    .filter((k) => k.startsWith(KEY_PREFIX))
    .map((k) => k.slice(KEY_PREFIX.length))
    .sort();
}

// ---------------------------------------------------------------------------
// Sign-in path shared by session and check
// ---------------------------------------------------------------------------

interface SignInOutcome {
  profile: Profile;
  decision: PolicyDecision;
  artifact: SessionArtifact;
  /** Safe-to-print notes for the human (e.g. an unresolved pending rotation). Never values. */
  warnings: string[];
}

/** Warning text when the current secret signed in while a pending rotated value exists. */
export function pendingUnresolvedWarning(profileName: string, pendingSince: string | undefined): string {
  const since = pendingSince !== undefined ? ` (pending since ${pendingSince})` : "";
  return (
    `pending rotation unresolved for ${profileName}${since}: the current secret still signs in, so the app ` +
    `probably never applied the new one; both values are kept. A human (or their scheduled task) resolves it ` +
    `with: testlane rotate ${profileName}`
  );
}

/**
 * Maximum nesting of profile dependencies (SignInContext.sessionFor). The
 * dependency session behind a dependent sign-in is depth 1.
 */
export const MAX_DEPENDENCY_DEPTH = 2;

/**
 * Audit `format` for rows written while signing in a dependency of
 * `requesting`: "internal:<requesting strategy>:for=<requesting profile>", so
 * the dependency row names the profile that pulled the dependency session. A profile
 * name that the audit guard would take for a secret assignment (e.g. one with
 * a "token:" segment) is withheld rather than letting the audit append fail.
 */
export function dependencyAuditFormat(
  requesting: Pick<Profile, "name" | "strategy">,
  label: string = requesting.strategy,
): string {
  // "dependent-token:" would itself trip the guard's "token:" rule, so that strategy is labelled "dependent".
  const shown = label === "dependent-token" ? "dependent" : label;
  const format = `internal:${shown}:for=${requesting.name}`;
  return looksLikeSecretAssignment(format) ? `internal:${shown}:for=(withheld)` : format;
}

/**
 * SignInContext.sessionFor for `requesting`: sign in `dependencyName` through
 * the same policy + vault + audit path (audit event "session", format
 * dependencyAuditFormat(requesting), same requester) and return its artifact.
 *
 * Refuses (before touching the store or the network):
 * - cycles (the dependency is already being signed in up the chain) and
 *   nesting deeper than MAX_DEPENDENCY_DEPTH -> SignInError;
 * - a dependency on a different host than the requesting profile ->
 *   PolicyError "host-not-allowed" (audited as a "refused" row on the requesting profile).
 * Production dependencies are refused by assertAllowed inside the recursive call.
 *
 * `chain` lists the profiles being signed in, outermost first, ending with `requesting`.
 * `label` replaces the strategy in the audit format (rotate uses "rotate").
 *
 * A dependency whose credentials are rejected surfaces as a plain SignInError
 * (credentialsRejected false), so the requesting profile never mistakes it for
 * a rejection of its own secret and falls back to its own pending value.
 */
async function sessionForDependency(
  deps: CommandDeps,
  requesting: Profile,
  dependencyName: string,
  chain: readonly string[],
  label?: string,
  sameOrigin = false,
): Promise<SessionArtifact> {
  const format = dependencyAuditFormat(requesting, label);
  if (chain.includes(dependencyName)) {
    throw new SignInError(`profile dependency cycle: ${[...chain, dependencyName].join(" -> ")}`);
  }
  if (chain.length > MAX_DEPENDENCY_DEPTH) {
    throw new SignInError(
      `profile dependencies nest deeper than ${MAX_DEPENDENCY_DEPTH} levels: ${[...chain, dependencyName].join(" -> ")}`,
    );
  }

  let dependency: Profile;
  try {
    dependency = getProfile(deps.registry, dependencyName);
  } catch (err) {
    if (err instanceof PolicyError) {
      await audit(deps, requesting, "refused", { ok: false, reason: err.code, format });
    }
    throw err;
  }
  // A production dependency is left to assertAllowed (production-refused wins over host checks).
  if (dependency.environment !== "production") {
    const want = hostOf(requesting.baseUrl);
    const got = hostOf(dependency.baseUrl);
    if (got !== want) {
      await audit(deps, requesting, "refused", { ok: false, reason: "host-not-allowed", format });
      throw new PolicyError(
        `Profile "${requesting.name}" depends on "${dependency.name}", which is on host "${got}", not "${want}"; ` +
          "a dependency session must be on the same host.",
        "host-not-allowed",
      );
    }
    // rotateVia: the authenticating session is sent to the requesting profile's
    // endpoint, so scheme and port must match too (same origin, not just host).
    if (sameOrigin) {
      const wantOrigin = new URL(requesting.baseUrl).origin;
      const gotOrigin = new URL(dependency.baseUrl).origin;
      if (gotOrigin !== wantOrigin) {
        await audit(deps, requesting, "refused", { ok: false, reason: "origin-not-allowed", format });
        throw new PolicyError(
          `Profile "${requesting.name}" depends on "${dependency.name}", which is on origin ${gotOrigin}, not ${wantOrigin}; ` +
            "a rotateVia session must be on the same origin.",
          "host-not-allowed",
        );
      }
    }
  }

  let outcome: SignInOutcome;
  try {
    outcome = await signInForProfile(deps, dependency.name, "session", { format }, chain);
  } catch (err) {
    if (isCredentialsRejected(err)) throw new SignInError(err.message, err.status);
    throw err;
  }
  // Recorded before the dependency's artifact leaves this function, like issueSession.
  await audit(deps, outcome.profile, "session", { ok: true, format });
  return outcome.artifact;
}

interface SignInCtx {
  ttlMinutes?: number;
  targetUrl?: string;
  format?: string;
}

function withFormat(fields: AuditFields, ctx: SignInCtx): AuditFields {
  return ctx.format !== undefined ? { ...fields, format: ctx.format } : fields;
}

/**
 * Policy (audited refusal) and strategy support for `profile`, before a
 * single byte of its secret is read.
 */
async function authorizeSignIn(deps: CommandDeps, profile: Profile, ctx: SignInCtx): Promise<PolicyDecision> {
  const policyCtx: PolicyContext = { interactive: false, productionHosts: productionHosts(deps.registry) };
  if (ctx.ttlMinutes !== undefined) policyCtx.requestedTtlMinutes = ctx.ttlMinutes;
  if (ctx.targetUrl !== undefined) policyCtx.targetUrl = ctx.targetUrl;
  let decision: PolicyDecision;
  try {
    decision = assertAllowed(profile, policyCtx);
  } catch (err) {
    if (err instanceof PolicyError) {
      await audit(deps, profile, "refused", withFormat({ ok: false, reason: err.code }, ctx));
    }
    throw err;
  }

  // Refuse strategies that cannot sign in here before a single byte of the secret is read.
  if (!isSignInStrategy(profile.strategy)) {
    await audit(deps, profile, "refused", withFormat({ ok: false, reason: "strategy-not-supported" }, ctx));
    throw new PolicyError(`strategy ${profile.strategy} is not implemented yet`, "invalid-profile");
  }

  if (profile.strategy === "app-handoff") {
    // Broker sessions are a per-profile opt-in: without options.mePath an app-handoff profile
    // is refused exactly as before 0.4 (exit 2, before the store), so an existing profile never
    // silently starts handing out the session cookie a navigate-only browser never exposed.
    if (optionValue(profile, "mePath") === undefined) {
      await audit(deps, profile, "refused", withFormat({ ok: false, reason: "strategy-not-supported" }, ctx));
      throw new PolicyError(
        `profile ${profile.name} uses strategy app-handoff without options.mePath, so session and check are off ` +
          `for it: use \`testlane handoff ${profile.name}\`, or opt the profile in by adding options.mePath (and ` +
          "emailField) so the broker can confirm the account before handing out its session",
        "invalid-profile",
      );
    }
    // The handoff URL shape is checked before the store, as `handoff` does.
    try {
      buildHandoffUrl(profile, "probe");
    } catch (err) {
      if (err instanceof PolicyError) {
        await audit(deps, profile, "refused", withFormat({ ok: false, reason: err.code }, ctx));
      }
      throw err;
    }
  }
  return decision;
}

/**
 * Audit `reason` of the "handoff" row written when `session` / `check` (or a
 * dependency sign-in) mints a code that the broker consumes itself, which
 * tells it apart from a `testlane handoff` row whose URL went to the caller.
 */
export const BROKER_CONSUMED_HANDOFF_REASON = "consumed-by-broker";

/** The stored secrets for `profile`; a refused or missing secret is audited and thrown. */
async function loadSecrets(deps: CommandDeps, profile: Profile, ctx: SignInCtx): Promise<ProfileSecrets> {
  let secrets: ProfileSecrets | null;
  try {
    secrets = await getProfileSecrets(deps.store, profile);
  } catch (err) {
    if (err instanceof OriginMismatchError) {
      await audit(deps, profile, "refused", withFormat({ ok: false, reason: err.reason }, ctx));
    }
    throw err;
  }
  if (secrets === null) {
    await audit(deps, profile, "refused", withFormat({ ok: false, reason: "missing-secret" }, ctx));
    throw new MissingSecretError(profile.name);
  }
  if (profile.strategy === "app-handoff" && secrets.secret.length < HANDOFF_SECRET_MIN_LENGTH) {
    // Same refusal as `handoff`: never mint weakly signed codes from a secret stored before the minimum.
    await audit(deps, profile, "refused", withFormat({ ok: false, reason: "handoff-secret-too-short" }, ctx));
    throw handoffSecretTooShortError(profile.name);
  }
  return secrets;
}

/** Whether an attempt wrote a broker-consumed "handoff" row (so its failure must be recorded too). */
interface MintState {
  recorded: boolean;
}

/**
 * One sign-in attempt with an explicit secret. Audits nothing itself; the
 * caller decides. The one exception is the app-handoff mint: the strategy
 * calls recordHandoff, which writes the "handoff" row (reason
 * BROKER_CONSUMED_HANDOFF_REASON, format of the surrounding sign-in) before
 * the code leaves the process and marks `mint.recorded`, and calls it again
 * with a failure when the request got no answer (ok false, reason
 * "consumed-by-broker:no-answer").
 */
function attemptSignIn(
  deps: CommandDeps,
  profile: Profile,
  decision: PolicyDecision,
  secret: string,
  chain: readonly string[],
  ctx: SignInCtx = {},
  mint: MintState = { recorded: false },
): Promise<SessionArtifact> {
  const signInCtx: SignInContext = {
    profile,
    secret,
    ttlMinutes: decision.ttlMinutes,
    sessionFor: (dependencyName: string) =>
      sessionForDependency(deps, profile, dependencyName, [...chain, profile.name]),
    recordHandoff: async (failure) => {
      const fields: AuditFields =
        failure === undefined
          ? { ok: true, reason: BROKER_CONSUMED_HANDOFF_REASON }
          : { ok: false, reason: `${BROKER_CONSUMED_HANDOFF_REASON}:${failure.reason}` };
      await audit(deps, profile, "handoff", withFormat(fields, ctx));
      if (failure === undefined) mint.recorded = true;
    },
  };
  if (deps.fetchImpl !== undefined) signInCtx.fetchImpl = deps.fetchImpl;
  return getStrategy(profile.strategy).signIn(signInCtx);
}

/**
 * Policy + vault + sign-in for `profileName`.
 *
 * With a pending rotated secret stored (see src/vault.ts): the current secret
 * is tried first. If the app rejects it, the pending value is tried once (never
 * more than two attempts); when that succeeds it is promoted to the current
 * secret (audit "rotate", reason "promoted-pending"). When the current secret
 * succeeds the pending value is left in place (the app probably never applied
 * it, but only `rotate` decides) and a warning is returned.
 */
async function signInForProfile(
  deps: CommandDeps,
  profileName: string,
  event: "session" | "check",
  ctx: SignInCtx,
  chain: readonly string[] = [],
): Promise<SignInOutcome> {
  const profile = getProfile(deps.registry, profileName);
  const decision = await authorizeSignIn(deps, profile, ctx);
  const secrets = await loadSecrets(deps, profile, ctx);
  const warnings: string[] = [];

  // A SignInError is audited with its (safe) message. Any other error after a
  // broker-consumed handoff mint is audited with a fixed reason, so a
  // "handoff ... consumed-by-broker" row never stands without an outcome.
  const mint: MintState = { recorded: false };
  const auditAttemptFailure = async (err: unknown): Promise<void> => {
    if (err instanceof SignInError) {
      await auditFailure(deps, profile, event, safeError(err), "sign-in-failed", ctx.format);
    } else if (mint.recorded) {
      await audit(deps, profile, event, withFormat({ ok: false, reason: "sign-in-error" }, ctx));
    }
  };

  let artifact: SessionArtifact;
  try {
    artifact = await attemptSignIn(deps, profile, decision, secrets.secret, chain, ctx, mint);
  } catch (err) {
    const pending = secrets.pendingSecret;
    if (pending === undefined || !isCredentialsRejected(err)) {
      await auditAttemptFailure(err);
      throw err;
    }
    // Second and last attempt: the pending value from an interrupted rotation.
    try {
      artifact = await attemptSignIn(deps, profile, decision, pending, chain, ctx, mint);
    } catch (err2) {
      await auditAttemptFailure(err2);
      throw err2;
    }
    // false only when another process already changed the envelope meanwhile.
    const promoted = await promotePendingSecret(deps.store, profile, pending, nowOf(deps));
    await audit(
      deps,
      profile,
      "rotate",
      withFormat({ ok: true, reason: promoted ? "promoted-pending" : "pending-changed-concurrently" }, ctx),
    );
    return { profile, decision, artifact, warnings };
  }

  if (secrets.pendingSecret !== undefined) {
    warnings.push(pendingUnresolvedWarning(profile.name, secrets.pendingSince));
    await audit(deps, profile, "rotate", withFormat({ ok: false, reason: "pending-unresolved" }, ctx));
  }
  return { profile, decision, artifact, warnings };
}

// ---------------------------------------------------------------------------
// session / check / audit
// ---------------------------------------------------------------------------

export interface IssueSessionOptions {
  format: SessionFormat;
  ttlMinutes?: number;
  targetUrl?: string;
}

export async function issueSession(
  deps: CommandDeps,
  profileName: string,
  opts: IssueSessionOptions,
): Promise<{ output: string; artifact: SessionArtifact; decision: PolicyDecision; warnings: string[] }> {
  const ctx: { ttlMinutes?: number; targetUrl?: string; format: string } = { format: opts.format };
  if (opts.ttlMinutes !== undefined) ctx.ttlMinutes = opts.ttlMinutes;
  if (opts.targetUrl !== undefined) ctx.targetUrl = opts.targetUrl;

  const { profile, decision, artifact, warnings } = await signInForProfile(deps, profileName, "session", ctx);
  let output: string;
  try {
    output = formatSession(artifact, opts.format);
  } catch (err) {
    // Signed in (for app-handoff: a code was consumed) but nothing can be handed out: record it.
    await audit(deps, profile, "session", { ok: false, reason: "format-failed", format: opts.format });
    throw err;
  }
  // The "session" row is written before any output leaves this function, and
  // an audit failure propagates: no session is ever handed out unrecorded.
  await audit(deps, profile, "session", { ok: true, format: opts.format });
  return { output, artifact, decision, warnings };
}

export type CheckOutcome = CheckResult & {
  roleSource: "app" | "declared";
  /** When the proving session would have expired (it is discarded, never returned). */
  expiresAt: string;
  /** Safe-to-print notes (e.g. "pending rotation unresolved ..."); present only when non-empty. */
  warnings?: string[];
};

/**
 * Shortest session cookie / header value that checkProfile treats as reflectable
 * material: shorter values (a locale, a flag) are not credentials, and scrubbing
 * them would only corrupt the reported role.
 */
const REFLECTABLE_MIN_LENGTH = 16;

/**
 * Sign in, ask the app who we are, and report only identity facts. The
 * session artifact is discarded; no cookie or header value is returned.
 */
export async function checkProfile(deps: CommandDeps, profileName: string): Promise<CheckOutcome> {
  const { profile, artifact, warnings } = await signInForProfile(deps, profileName, "check", {});
  // Session material that the identity answer might reflect back (a role or email
  // equal to the session cookie, a bearer token). Held in a local redactor and used
  // only on the app-reported identity fields below: registering these values on the
  // process-wide redactor would, for the rest of a long-lived `mcp` / `serve`
  // process, scrub ordinary cookie values (a callback URL, a locale) from every
  // later output and grow its set on every check.
  const reflected = new Redactor();
  const trackReflectable = (value: string): void => {
    if (value.length >= REFLECTABLE_MIN_LENGTH) reflected.register(value);
  };
  const trackHeader = (value: string): void => {
    trackReflectable(value);
    const bearer = /^Bearer\s+(.+)$/iu.exec(value.trim())?.[1];
    if (bearer !== undefined) trackReflectable(bearer);
  };
  for (const cookie of artifact.cookies) trackReflectable(cookie.value);
  for (const value of Object.values(artifact.headers ?? {})) trackHeader(value);

  const strategy = getStrategy(profile.strategy);
  if (strategy.whoami === undefined) {
    const message = `Strategy "${profile.strategy}" cannot verify identity (no whoami).`;
    await auditFailure(deps, profile, "check", message, "whoami-unsupported");
    throw new Error(message);
  }
  let who: WhoAmI;
  try {
    const observeIdentityFetch: typeof fetch = async (input, init) => {
      const response = await (deps.fetchImpl ?? fetch)(input, init);
      const cookies = new CookieJar();
      cookies.addFromResponse(response, new URL(input instanceof Request ? input.url : String(input)));
      for (const cookie of cookies.all()) trackReflectable(cookie.value);
      for (const name of Object.keys(artifact.headers ?? {})) {
        const value = response.headers.get(name);
        if (value) trackHeader(value);
      }
      return response;
    };
    who = await strategy.whoami(artifact, observeIdentityFetch, profile);
  } catch (err) {
    if (err instanceof SignInError) {
      await auditFailure(deps, profile, "check", safeError(err), "whoami-failed");
    } else {
      // Signed in, but no answer about the identity: the check still ends in a row.
      await audit(deps, profile, "check", { ok: false, reason: "whoami-error" });
    }
    throw err;
  }

  const expected = profile.account.email.toLowerCase();
  const actual = who.email?.toLowerCase();
  const ok = actual !== undefined && actual === expected;
  // The app's role is trusted only when the identity matched, and is scrubbed of any session material it reflects.
  const appRole = ok ? who.role : undefined;
  const roleSource: "app" | "declared" = appRole !== undefined ? "app" : "declared";
  const result: CheckOutcome = {
    profile: profile.name,
    ok,
    role: appRole !== undefined ? reflected.redact(redactor.redact(appRole)) : profile.account.role,
    roleSource,
    expiresAt: artifact.expiresAt,
  };
  // A mismatching identity is untrusted text, and can contain reflected session material.
  if (ok && who.email !== undefined) result.email = who.email;
  if (warnings.length > 0) result.warnings = warnings;
  if (!ok) {
    result.message =
      who.email === undefined
        ? `signed in, but the app did not report an email (expected ${profile.account.email})`
        : `signed in, but the app reported a different identity (expected ${profile.account.email})`;
    await audit(deps, profile, "check", { ok: false, reason: "identity-mismatch" });
  } else {
    await audit(deps, profile, "check", { ok: true });
  }
  return result;
}

export function auditTail(n: number): Promise<AuditTail> {
  return readAuditTail(n);
}

// ---------------------------------------------------------------------------
// rotate (human command; see README "Rotation and expiry")
// ---------------------------------------------------------------------------

/** Strategies whose profiles may carry rotate* options (password strategies). */
export const ROTATABLE_STRATEGIES: readonly StrategyName[] = ["nextauth-credentials", "form-post"];

/** Bytes of randomness in a generated secret (base64url: 43 characters). */
export const ROTATED_SECRET_BYTES = 32;

interface RotationPlan {
  url: URL;
  method: RotateMethod;
  bodyFormat: RotateBodyFormat;
  entries: [string, string][];
  via?: string;
}

/**
 * The rotation request described by the profile's rotate* options, or the
 * audit reason + safe message explaining why there is none. Checked again
 * here (profiles.ts validates at load) so a hand-built profile cannot steer
 * the new secret off the profile origin. Messages name option keys, never values.
 */
function rotationPlan(profile: Profile): { plan: RotationPlan } | { reason: string; message: string } {
  const opts = profile.options ?? {};
  const rotatePath = opts["rotatePath"];
  if (rotatePath === undefined || rotatePath.trim() === "") {
    return {
      reason: "rotate-not-configured",
      message: `profile ${profile.name} has no options.rotatePath; rotation is not configured for it`,
    };
  }
  const invalid = (what: string): { reason: string; message: string } => ({
    reason: "rotate-options-invalid",
    message: `profile ${profile.name}: ${what}; refusing to rotate`,
  });
  if (!ROTATABLE_STRATEGIES.includes(profile.strategy)) {
    return invalid(`strategy ${profile.strategy} does not support rotation`);
  }
  let url: URL;
  try {
    url = resolveOptionUrl(profile.baseUrl, rotatePath, "rotatePath");
  } catch {
    return invalid('option rotatePath must be a path starting with "/" on the profile origin');
  }
  const method = opts["rotateMethod"] ?? "POST";
  if (!(ROTATE_METHODS as readonly string[]).includes(method)) {
    return invalid(`option rotateMethod must be one of ${ROTATE_METHODS.join(", ")}`);
  }
  const bodyFormat = opts["rotateBodyFormat"] ?? "json";
  if (!(ROTATE_BODY_FORMATS as readonly string[]).includes(bodyFormat)) {
    return invalid(`option rotateBodyFormat must be one of ${ROTATE_BODY_FORMATS.join(", ")}`);
  }
  const rawBody = opts["rotateBody"];
  if (rawBody === undefined) return invalid("option rotateBody is required with rotatePath");
  const body = parseRotateBody(rawBody);
  if ("error" in body) return invalid(`option rotateBody ${body.error}`);
  const plan: RotationPlan = {
    url,
    method: method as RotateMethod,
    bodyFormat: bodyFormat as RotateBodyFormat,
    entries: body.entries,
  };
  const via = opts["rotateVia"];
  if (via !== undefined) {
    if (!PROFILE_NAME_RE.test(via) || via.length > 128) return invalid("option rotateVia must be a profile name");
    if (via !== profile.name) plan.via = via;
  }
  return { plan };
}

/**
 * Fill {{email}}, {{secret}} and {{newSecret}} without String.replace (whose
 * "$&" patterns would mangle a value containing "$") and without re-scanning
 * an inserted value for placeholders.
 */
function fillRotateTemplate(template: string, values: Record<"email" | "secret" | "newSecret", string>): string {
  return template
    .split(/\{\{(email|secret|newSecret)\}\}/)
    .map((part, i) => (i % 2 === 1 ? values[part as "email" | "secret" | "newSecret"] : part))
    .join("");
}

/** Header names never copied from the authenticating artifact onto the rotation request. */
const RESERVED_ROTATE_HEADERS = /^(cookie|host|content-length|content-type|origin|transfer-encoding|connection)$/i;

function rotateRequestInit(
  plan: RotationPlan,
  auth: SessionArtifact,
  values: Record<"email" | "secret" | "newSecret", string>,
): RequestInit {
  const headers: Record<string, string> = {};
  // Session headers (e.g. a bearer or x-device-access) of the authenticating profile.
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (!RESERVED_ROTATE_HEADERS.test(name)) headers[name] = value;
  }
  headers["User-Agent"] = USER_AGENT;
  headers["Accept"] = "application/json";
  headers["Origin"] = plan.url.origin;
  const jar = new CookieJar();
  for (const c of auth.cookies) jar.add(c);
  const cookie = jar.headerFor(plan.url);
  if (cookie !== undefined) headers["Cookie"] = cookie;

  let body: string;
  if (plan.bodyFormat === "json") {
    // Object.fromEntries defines own properties, so no field name can hit a prototype setter.
    body = JSON.stringify(Object.fromEntries(plan.entries.map(([k, t]) => [k, fillRotateTemplate(t, values)])));
    headers["Content-Type"] = "application/json";
  } else {
    const form = new URLSearchParams();
    for (const [k, t] of plan.entries) form.append(k, fillRotateTemplate(t, values));
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return { method: plan.method, headers, body, redirect: "manual" };
}

/**
 * Decide by sign-in which of `current` and `pending` the app accepts. Nothing
 * is written here. `order` picks which value is tried first (the other only
 * when the app rejects the first), so at most two sign-in attempts. Anything
 * else (network failure, both rejected) throws; the caller keeps both values.
 */
async function decideLive(
  deps: CommandDeps,
  profile: Profile,
  decision: PolicyDecision,
  current: string,
  pending: string,
  order: "pending-first" | "current-first",
): Promise<"pending" | "current"> {
  const [first, second]: ["pending" | "current", "pending" | "current"] =
    order === "pending-first" ? ["pending", "current"] : ["current", "pending"];
  const value = (which: "pending" | "current"): string => (which === "pending" ? pending : current);
  try {
    await attemptSignIn(deps, profile, decision, value(first), []);
    return first;
  } catch (err) {
    if (!isCredentialsRejected(err)) throw err;
  }
  try {
    await attemptSignIn(deps, profile, decision, value(second), []);
    return second;
  } catch (err) {
    if (isCredentialsRejected(err)) {
      throw new SignInError(
        `the app rejected both the current and the pending secret for ${profile.name}; both are kept. ` +
          `Retry \`testlane rotate ${profile.name}\` later first (the app may apply a change late); only if it ` +
          `keeps failing must a human check the account and re-run: testlane store set ${profile.name}`,
      );
    }
    throw err;
  }
}

/**
 * The stored pending value changed underneath a rotation (another rotate or a
 * human `store set`): never report success, never overwrite what is stored.
 * With `park`, a new secret the app may already use is put back in the empty
 * pending slot next to whatever is stored, so the next sign-in can resolve it.
 */
async function pendingChanged(
  deps: CommandDeps,
  profile: Profile,
  newSecret: string | null,
  status?: number,
): Promise<never> {
  let parked = false;
  if (newSecret !== null) {
    try {
      const stored = await getProfileSecrets(deps.store, profile);
      if (stored !== null && stored.pendingSecret === undefined && stored.secret !== newSecret) {
        await setPendingSecret(deps.store, profile, newSecret, nowOf(deps));
        parked = true;
      }
    } catch {
      parked = false;
    }
  }
  await audit(deps, profile, "rotate", { ok: false, reason: "pending-changed" });
  throw new RotationError(
    `the stored pending value for ${profile.name} changed underneath this rotation (another rotate or a store set); ` +
      "the vault was not switched to the new secret and nothing stored was overwritten" +
      (parked ? "; the new secret was kept as pending next to the stored one, so the next sign-in resolves which is live" : ""),
    "pending-changed",
    status,
  );
}

export interface RotateOutcome {
  profile: string;
  rotated: true;
  /** When the new secret was promoted (ISO). */
  storedAt: string;
  /** Profile whose session authenticated the change, or null for the profile's own session. */
  via: string | null;
  /** HTTP status the app answered. */
  status: number;
  /** How a pending value left by an earlier, interrupted rotation was settled first. */
  resolvedPending?: "promoted" | "dropped";
}

function unknownOutcomeMessage(profile: Profile, detail: string): string {
  return (
    `rotation outcome for ${profile.name} is unknown (${detail}). The new secret is kept as a pending value next ` +
    "to the current one, so no credential is lost: the next session or check signs in with whichever value the " +
    `app accepts (promoting the new one if it was applied), and the next \`testlane rotate ${profile.name}\` ` +
    "settles it for good."
  );
}

function networkCode(err: unknown): string {
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? ` (${code})` : "";
}

/**
 * `testlane rotate <profile>` (a HUMAN command by default; see README):
 * change the app password through the app's own API and update the vault,
 * two-phase so that no outcome loses the live credential.
 *
 *  1. policy (production refused), rotate* options;
 *  2. an exclusive per-profile lock (src/lock.ts) for the rest of the call:
 *     a second rotate of the same profile is refused ("rotation-in-progress");
 *  3. stored secrets; a pending value left by an interrupted rotation is
 *     settled first (new value tried first); if that cannot be decided,
 *     nothing changes;
 *  4. a session authenticates the change: rotateVia's (same origin, audited
 *     `internal:rotate:for=<profile>`) or the profile's own;
 *  5. newSecret = 32 random bytes (base64url) is stored as pending;
 *  6. the request is sent:
 *     - 2xx: a sign-in with the new secret promotes it (exit 0). If it does not
 *       sign in (yet), it is KEPT as pending ("unknown-outcome-after-2xx",
 *       exit 3): a 2xx never drops it.
 *     - any other status: the current secret is tried first; if it signs in
 *       the pending value is dropped ("app-rejected-<status>", exit 3); if the
 *       app refuses it, the new secret is tried and promoted when it signs in
 *       ("applied-despite-<status>").
 *     - network failure, or no sign-in can decide: both values are kept
 *       ("unknown-outcome", exit 3) for the next sign-in to resolve.
 *  A promote or drop that finds the stored pending value changed underneath
 *  (another rotate or a store set) never reports success (pendingChanged).
 *
 * Neither secret is ever returned, printed or put in an error.
 */
export async function rotateProfile(deps: CommandDeps, profileName: string): Promise<RotateOutcome> {
  const profile = getProfile(deps.registry, profileName);
  const ctx: SignInCtx = {};
  const decision = await authorizeSignIn(deps, profile, ctx);

  const planned = rotationPlan(profile);
  if ("reason" in planned) {
    await audit(deps, profile, "refused", { ok: false, reason: planned.reason });
    throw new PolicyError(planned.message, "invalid-profile");
  }
  const { plan } = planned;

  let lock: HeldLock;
  try {
    lock = await acquireLock(rotateLockPath(profile.name), nowOf(deps));
  } catch (err) {
    if (!(err instanceof LockHeldError)) throw err;
    await audit(deps, profile, "refused", { ok: false, reason: "rotation-in-progress" });
    throw new PolicyError(
      `a rotation for ${profile.name} is already in progress (lock taken ${err.since ?? "at an unknown time"}, ` +
        `file ${err.file}); if no rotate is running, the lock is replaced once it is ` +
        `${ROTATE_LOCK_STALE_MS / 60_000} minutes old`,
      "rotation-in-progress",
    );
  }
  try {
    return await rotateLocked(deps, profile, decision, plan);
  } finally {
    await lock.release();
  }
}

async function rotateLocked(
  deps: CommandDeps,
  profile: Profile,
  decision: PolicyDecision,
  plan: RotationPlan,
): Promise<RotateOutcome> {
  const ctx: SignInCtx = {};
  const host = plan.url.host;
  let secrets = await loadSecrets(deps, profile, ctx);

  // (3) An earlier rotation left a pending value: settle it before starting another.
  let resolvedPending: "promoted" | "dropped" | undefined;
  if (secrets.pendingSecret !== undefined) {
    const pending = secrets.pendingSecret;
    const since = secrets.pendingSince ?? "an unknown time";
    let live: "pending" | "current";
    try {
      live = await decideLive(deps, profile, decision, secrets.secret, pending, "pending-first");
    } catch (err) {
      await audit(deps, profile, "rotate", { ok: false, reason: "pending-unverified" });
      throw new RotationError(
        `a pending rotation for ${profile.name} (since ${since}) could not be settled: ${safeError(err)}. ` +
          "Nothing was changed; both values are kept.",
        "pending-unverified",
      );
    }
    const written =
      live === "pending"
        ? await promotePendingSecret(deps.store, profile, pending, nowOf(deps))
        : await dropPendingSecret(deps.store, profile, pending);
    if (!written) return pendingChanged(deps, profile, null);
    resolvedPending = live === "pending" ? "promoted" : "dropped";
    await audit(deps, profile, "rotate", {
      ok: true,
      reason: resolvedPending === "promoted" ? "promoted-pending" : "dropped-pending",
    });
    secrets = await loadSecrets(deps, profile, ctx);
    if (secrets.pendingSecret !== undefined) return pendingChanged(deps, profile, null);
  }

  // (4) The session that authenticates the change.
  let auth: SessionArtifact;
  try {
    if (plan.via !== undefined) {
      auth = await sessionForDependency(deps, profile, plan.via, [profile.name], "rotate", true);
    } else {
      auth = await attemptSignIn(deps, profile, decision, secrets.secret, []);
      await audit(deps, profile, "session", { ok: true, format: dependencyAuditFormat(profile, "rotate") });
    }
  } catch (err) {
    if (err instanceof SignInError) await audit(deps, profile, "rotate", { ok: false, reason: "auth-failed" });
    throw err;
  }

  // (5) Phase 1: the new value is stored before the app hears of it.
  const newSecret = randomBytes(ROTATED_SECRET_BYTES).toString("base64url");
  redactor.register(newSecret);
  await setPendingSecret(deps.store, profile, newSecret, nowOf(deps));

  // (6) The change request. The secrets exist only inside this body.
  const init = rotateRequestInit(plan, auth, {
    email: profile.account.email,
    secret: secrets.secret,
    newSecret,
  });
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let status: number;
  try {
    const res = await fetchImpl(plan.url, init);
    status = res.status;
    try {
      await res.body?.cancel();
    } catch {
      // The body is never read; a cancel failure changes nothing.
    }
  } catch (err) {
    await audit(deps, profile, "rotate", { ok: false, reason: "unknown-outcome" });
    throw new RotationError(
      unknownOutcomeMessage(profile, `could not reach the rotation endpoint at ${host}${networkCode(err)}`),
      "unknown-outcome",
    );
  }

  const promote = async (reason?: string): Promise<RotateOutcome> => {
    const at = nowOf(deps);
    if (!(await promotePendingSecret(deps.store, profile, newSecret, at))) {
      return pendingChanged(deps, profile, newSecret, status);
    }
    const fields: AuditFields = { ok: true };
    if (reason !== undefined) fields.reason = reason;
    await audit(deps, profile, "rotate", fields);
    const outcome: RotateOutcome = {
      profile: profile.name,
      rotated: true,
      storedAt: at.toISOString(),
      via: plan.via ?? null,
      status,
    };
    if (resolvedPending !== undefined) outcome.resolvedPending = resolvedPending;
    return outcome;
  };

  if (status >= 200 && status < 300) {
    // The app says it applied the change: the new value is never dropped now.
    try {
      await attemptSignIn(deps, profile, decision, newSecret, []);
    } catch (err) {
      await audit(deps, profile, "rotate", { ok: false, reason: "unknown-outcome-after-2xx" });
      throw new RotationError(
        `${host} answered HTTP ${status} to the rotation for ${profile.name}, but the new secret does not sign in ` +
          `(yet): ${safeError(err)}. It is kept as pending next to the current one; nothing was dropped. ` +
          pendingUnresolvedWarning(profile.name, undefined),
        "unknown-outcome",
        status,
      );
    }
    return promote();
  }

  // Any other answer: the current secret first (no needless failed login with
  // the new value); the new one only if the app refuses the current one.
  let live: "pending" | "current";
  try {
    live = await decideLive(deps, profile, decision, secrets.secret, newSecret, "current-first");
  } catch (err) {
    await audit(deps, profile, "rotate", { ok: false, reason: "unknown-outcome" });
    throw new RotationError(
      unknownOutcomeMessage(profile, `the app answered HTTP ${status}, but no sign-in confirmed either value: ${safeError(err)}`),
      "unknown-outcome",
      status,
    );
  }
  if (live === "pending") return promote(`applied-despite-${status}`);
  if (!(await dropPendingSecret(deps.store, profile, newSecret))) return pendingChanged(deps, profile, null, status);
  await audit(deps, profile, "rotate", { ok: false, reason: `app-rejected-${status}` });
  throw new RotationError(
    `rotation for ${profile.name} was refused by ${host} (HTTP ${status}); the new secret was discarded and the ` +
      "current secret (which still signs in) is unchanged",
    "app-rejected",
    status,
  );
}

// ---------------------------------------------------------------------------
// status (expiry alerts; never prints a value)
// ---------------------------------------------------------------------------

export const STATUS_ALERTS = [
  "no-secret",
  "rotation-overdue",
  "pending-rotation",
  "legacy-envelope",
  "secret-refused",
  "store-error",
] as const;
export type StatusAlert = (typeof STATUS_ALERTS)[number];

/** Default maximum secret age when neither rotateEveryDays nor --max-age-days is given. */
export const DEFAULT_MAX_AGE_DAYS = 90;
/** A pending rotation older than this is reported as "pending-rotation". */
export const PENDING_ALERT_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProfileStatus {
  profile: string;
  environment: Environment;
  strategy: StrategyName;
  hasSecret: boolean;
  /** When the current secret was stored or promoted (ISO); null when unknown or absent. */
  storedAt: string | null;
  /** Whole days since storedAt; null when unknown or absent. */
  ageDays: number | null;
  pendingRotation: boolean;
  pendingSince: string | null;
  /** The account identity comes from the user-level overrides file. */
  override: boolean;
  /** options.rotateEveryDays, when set. */
  rotateEveryDays: number | null;
  /** The age limit applied: rotateEveryDays ?? --max-age-days ?? 90. */
  maxAgeDays: number;
  /** Why the stored value cannot be used (vault refusal reason), when it cannot. */
  refused?: OriginMismatchError["reason"];
  alerts: StatusAlert[];
}

export interface StatusReport {
  generatedAt: string;
  profiles: ProfileStatus[];
  /** True when any non-production profile has at least one alert. */
  alerting: boolean;
}

export interface StatusOptions {
  /** Default age limit in days for profiles without rotateEveryDays. */
  maxAgeDays?: number;
}

function rotateEveryDaysOf(profile: Profile): number | null {
  const raw = profile.options?.["rotateEveryDays"];
  if (raw === undefined || !ROTATE_EVERY_DAYS_RE.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_ROTATE_EVERY_DAYS ? n : null;
}

/**
 * Per-profile secret health for every profile in the registry: storage age,
 * pending rotations, overrides and alerts. Reads the store (metadata only
 * leaves this function; values are registered with the redactor by the vault
 * and dropped). Production profiles are never read: they are listed with
 * hasSecret false and no alerts. No network, no audit rows.
 */
export async function profileStatus(
  deps: Pick<CommandDeps, "store" | "registry" | "now">,
  opts: StatusOptions = {},
): Promise<StatusReport> {
  const now = nowOf(deps);
  const defaultMax = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (!Number.isInteger(defaultMax) || defaultMax < 1) throw new Error("maxAgeDays must be a positive whole number");
  const overridden = new Set(deps.registry.overrides ?? []);
  const names = Object.keys(deps.registry.profiles).sort();
  const profiles: ProfileStatus[] = [];

  for (const name of names) {
    const profile = deps.registry.profiles[name];
    if (profile === undefined) continue;
    const rotateEveryDays = rotateEveryDaysOf(profile);
    const entry: ProfileStatus = {
      profile: profile.name,
      environment: profile.environment,
      strategy: profile.strategy,
      hasSecret: false,
      storedAt: null,
      ageDays: null,
      pendingRotation: false,
      pendingSince: null,
      override: overridden.has(profile.name),
      rotateEveryDays,
      maxAgeDays: rotateEveryDays ?? defaultMax,
      alerts: [],
    };
    profiles.push(entry);
    // Production secrets are never stored or read; nothing to report.
    if (profile.environment === "production") continue;

    let secrets: ProfileSecrets | null;
    try {
      secrets = await getProfileSecrets(deps.store, profile);
    } catch (err) {
      if (err instanceof OriginMismatchError) {
        entry.hasSecret = true;
        entry.refused = err.reason;
        entry.alerts.push("secret-refused");
      } else {
        // One unreadable entry must not hide the others. No detail: store
        // errors can carry paths or tool output.
        entry.alerts.push("store-error");
      }
      continue;
    }
    if (secrets === null) {
      entry.alerts.push("no-secret");
      continue;
    }
    entry.hasSecret = true;
    entry.storedAt = secrets.storedAt;
    if (secrets.storedAt === null) {
      entry.alerts.push("legacy-envelope");
    } else {
      const ageMs = now.getTime() - Date.parse(secrets.storedAt);
      entry.ageDays = Math.max(0, Math.floor(ageMs / DAY_MS));
      if (ageMs > entry.maxAgeDays * DAY_MS) entry.alerts.push("rotation-overdue");
    }
    if (secrets.pendingSecret !== undefined) {
      entry.pendingRotation = true;
      entry.pendingSince = secrets.pendingSince ?? null;
      const pendingMs = secrets.pendingSince !== undefined ? now.getTime() - Date.parse(secrets.pendingSince) : Infinity;
      if (pendingMs > PENDING_ALERT_MS) entry.alerts.push("pending-rotation");
    }
  }

  return {
    generatedAt: now.toISOString(),
    profiles,
    alerting: profiles.some((p) => p.environment !== "production" && p.alerts.length > 0),
  };
}
