/**
 * One-time handoff codes for the `app-handoff` strategy (architecture doc 3.4).
 *
 * A browser without a cookie-import API (Claude's built-in pane) can only
 * navigate to a URL. The broker therefore mints a short-lived, single-use,
 * HMAC-signed code and hands the agent
 *
 *   <baseUrl origin><handoffPath>?code=<code>
 *
 * The consuming app's sandbox-only route verifies the code, burns the nonce,
 * mints its own session and redirects (see docs/HANDOFF-ROUTE-CONTRACT.md).
 *
 * Code format (exactly):
 *
 *   payload = `${profileName}.${nonce}.${expiresAtUnixSeconds}`
 *             nonce = 16 random bytes, base64url (22 chars, no padding)
 *   code    = base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload))
 *
 * Profile names may contain "." (PROFILE_NAME_RE), so the payload is parsed
 * from the right: the last segment is the expiry, the one before it the nonce,
 * everything before that the profile name.
 *
 * `verifyHandoffCode` is the reference verifier that the Phase-2 app route
 * mirrors. It depends only on node:crypto (no zod, no store, no audit) so it
 * can be copied verbatim. The secret is the shared AGENT_HANDOFF_SECRET (at
 * least HANDOFF_SECRET_MIN_LENGTH characters; one secret per deployment, since
 * a code carries no audience and verifies on every deployment sharing it); it is
 * loaded only through src/vault.ts (which registers it with the redactor) and
 * never appears in a code, URL, return value or error message. The code itself
 * is a one-time credential and IS the deliverable, so it is returned (and
 * deliberately not registered with the redactor).
 *
 * `session` / `check` on an app-handoff profile mint the same code with the
 * same functions but consume the URL inside the broker instead of returning it
 * (src/strategies/app-handoff.ts); there the code and URL are never output.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendAudit, type AuditInput } from "./audit.js";
import { MissingSecretError, type CommandDeps } from "./commands.js";
import { assertAllowed, hostOf } from "./policy.js";
import { getProfile, productionHosts } from "./profiles.js";
import { isSafeOptionPath } from "./strategies/options.js";
import { PROFILE_NAME_RE, PolicyError, type AuditRow, type Profile } from "./types.js";
import { getProfileSecret, OriginMismatchError } from "./vault.js";

/** Lifetime of a handoff code. */
export const HANDOFF_TTL_SECONDS = 60;

/**
 * Tolerated clock difference between the broker and the app. A code whose
 * expiry lies further in the future than TTL + skew was not minted by a
 * conforming broker and is rejected as malformed.
 */
export const HANDOFF_MAX_CLOCK_SKEW_SECONDS = 30;

/**
 * Minimum length of the shared handoff secret. Shorter secrets are refused by
 * mint, verify and `store set` (generate one with `openssl rand -base64 32`).
 */
export const HANDOFF_SECRET_MIN_LENGTH = 32;

/** Route path used when a profile sets no `options.handoffPath`. */
export const DEFAULT_HANDOFF_PATH = "/api/auth/agent-handoff";

const NONCE_BYTES = 16;
const SIGNATURE_BYTES = 32;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const EXPIRY_RE = /^[1-9][0-9]{0,11}$/;
/** Upper bound on an accepted code, well above any real one; cheap DoS guard. */
const MAX_CODE_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Mint / verify
// ---------------------------------------------------------------------------

export interface MintHandoffInput {
  profileName: string;
  secret: string;
  now?: Date;
}

export interface MintedHandoff {
  code: string;
  nonce: string;
  expiresAt: Date;
}

/** Misconfiguration guard; the message never includes the secret or its length. */
function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < HANDOFF_SECRET_MIN_LENGTH) {
    throw new Error(
      `handoff secret must be a non-empty string of at least ${HANDOFF_SECRET_MIN_LENGTH} characters (misconfigured AGENT_HANDOFF_SECRET)`,
    );
  }
}

function sign(secret: string, payload: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Mint a single-use code for `profileName`, valid for HANDOFF_TTL_SECONDS from `now`. */
export function mintHandoffCode({ profileName, secret, now }: MintHandoffInput): MintedHandoff {
  assertSecret(secret);
  if (!PROFILE_NAME_RE.test(profileName)) throw new Error("handoff code needs a valid profile name");
  const issuedAt = now ?? new Date();
  const exp = Math.floor(issuedAt.getTime() / 1000) + HANDOFF_TTL_SECONDS;
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const payload = Buffer.from(`${profileName}.${nonce}.${exp}`, "utf8");
  const code = `${payload.toString("base64url")}.${sign(secret, payload).toString("base64url")}`;
  return { code, nonce, expiresAt: new Date(exp * 1000) };
}

/**
 * Burns nonces. `consume` must resolve true exactly once per nonce and false
 * for every later call, across every instance that verifies codes (the app
 * route backs this with a unique-keyed `AgentHandoffNonce` table).
 * `expiresAt` tells the store when the entry may be forgotten.
 */
export interface NonceStore {
  consume(nonce: string, expiresAt: Date): Promise<boolean>;
}

/**
 * Process-local NonceStore (tests, single-process servers). Entries are pruned
 * once their code has expired by this store's clock; pass the same clock the
 * verifier uses when a test fakes time.
 */
export class MemoryNonceStore implements NonceStore {
  readonly #seen = new Map<string, number>();
  readonly #now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.#now = opts.now ?? (() => new Date());
  }

  async consume(nonce: string, expiresAt: Date): Promise<boolean> {
    const nowMs = this.#now().getTime();
    for (const [n, exp] of this.#seen) if (exp <= nowMs) this.#seen.delete(n);
    if (this.#seen.has(nonce)) return false;
    // Keep the entry at least until the code expires, so it cannot be replayed within its life.
    this.#seen.set(nonce, Math.max(expiresAt.getTime(), nowMs + 1));
    return true;
  }

  /** Entries currently remembered (after the last prune). */
  get size(): number {
    return this.#seen.size;
  }
}

export interface VerifyHandoffInput {
  code: string;
  secret: string;
  now?: Date;
  nonceStore: NonceStore;
}

export type HandoffFailureReason = "malformed" | "bad-signature" | "expired" | "replayed";

export type VerifyHandoffResult =
  | { ok: true; profileName: string; nonce: string; expiresAt: Date }
  | { ok: false; reason: HandoffFailureReason };

/** Strict base64url: alphabet only, no padding, and canonical (re-encodes to itself). */
function decodeB64url(s: string): Buffer | null {
  if (!B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

/**
 * Verify a handoff code. Order: shape → signature (constant time, before the
 * payload is interpreted) → payload fields → expiry → single-use nonce.
 * Never throws for a bad code; throws only for a missing or too-short secret
 * (misconfiguration: shorter than HANDOFF_SECRET_MIN_LENGTH).
 */
export async function verifyHandoffCode({ code, secret, now, nonceStore }: VerifyHandoffInput): Promise<VerifyHandoffResult> {
  assertSecret(secret);
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = code.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const payload = decodeB64url(parts[0] ?? "");
  const signature = decodeB64url(parts[1] ?? "");
  if (payload === null || signature === null || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "malformed" };
  }

  // (1) Signature, constant time on equal-length buffers.
  const expected = sign(secret, payload);
  if (!timingSafeEqual(expected, signature)) return { ok: false, reason: "bad-signature" };

  // (2) Payload fields (only reached for a code the secret holder signed).
  const text = payload.toString("utf8");
  const lastDot = text.lastIndexOf(".");
  const midDot = lastDot > 0 ? text.lastIndexOf(".", lastDot - 1) : -1;
  if (midDot <= 0) return { ok: false, reason: "malformed" };
  const profileName = text.slice(0, midDot);
  const nonce = text.slice(midDot + 1, lastDot);
  const expText = text.slice(lastDot + 1);
  if (!PROFILE_NAME_RE.test(profileName) || !NONCE_RE.test(nonce) || !EXPIRY_RE.test(expText)) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = new Date(Number(expText) * 1000);

  // (3) Expiry.
  const nowMs = (now ?? new Date()).getTime();
  if (nowMs >= expiresAt.getTime()) return { ok: false, reason: "expired" };
  if (expiresAt.getTime() - nowMs > (HANDOFF_TTL_SECONDS + HANDOFF_MAX_CLOCK_SKEW_SECONDS) * 1000) {
    return { ok: false, reason: "malformed" };
  }

  // (4) Single use.
  if (!(await nonceStore.consume(nonce, expiresAt))) return { ok: false, reason: "replayed" };
  return { ok: true, profileName, nonce, expiresAt };
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * `<baseUrl origin><handoffPath>?code=<code>`. The path must be a plain
 * same-origin path: starts with "/", contains no "//", backslash, whitespace,
 * "?" or "#".
 *
 * @throws PolicyError("invalid-profile") for an unsafe path or non-http(s) baseUrl.
 */
export function buildHandoffUrl(profile: Pick<Profile, "name" | "baseUrl" | "options">, code: string): string {
  const handoffPath = profile.options?.["handoffPath"] ?? DEFAULT_HANDOFF_PATH;
  if (!isSafeOptionPath(handoffPath) || handoffPath.includes("//")) {
    throw new PolicyError(
      `Profile "${profile.name}" options.handoffPath must be a same-origin path starting with "/" ` +
        '(no scheme, host, "//", "\\", whitespace, query or fragment).',
      "invalid-profile",
    );
  }
  let base: URL;
  try {
    base = new URL(profile.baseUrl);
  } catch {
    throw new PolicyError(`Profile "${profile.name}" has an invalid baseUrl.`, "invalid-profile");
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.origin === "null") {
    throw new PolicyError(`Profile "${profile.name}" baseUrl must be an http(s) URL.`, "invalid-profile");
  }
  const url = `${base.origin}${handoffPath}?code=${encodeURIComponent(code)}`;
  // Belt and braces: the assembled URL must still be on the profile's origin.
  if (new URL(url).origin !== base.origin) {
    throw new PolicyError(`Profile "${profile.name}" handoff URL left the profile origin.`, "invalid-profile");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Command: handoff
// ---------------------------------------------------------------------------

export interface IssueHandoffOptions {
  /** Overrides deps.requester in the audit row (e.g. the MCP client name). */
  requester?: string;
}

export interface IssuedHandoff {
  /** One-time URL; the embedded code is a single-use credential valid for HANDOFF_TTL_SECONDS. */
  url: string;
  /** ISO timestamp after which the code is rejected. */
  expiresAt: string;
  profile: string;
}

/**
 * The refusal for a stored handoff secret shorter than HANDOFF_SECRET_MIN_LENGTH
 * (stored before the minimum was enforced). Shared by `handoff` and by the
 * `session` / `check` path for app-handoff profiles; names neither the value
 * nor its length.
 */
export function handoffSecretTooShortError(profileName: string): PolicyError {
  return new PolicyError(
    `Stored handoff secret for "${profileName}" is shorter than ${HANDOFF_SECRET_MIN_LENGTH} characters; ` +
      `a human must generate a new one (\`openssl rand -base64 32\`), set it as AGENT_HANDOFF_SECRET in the app ` +
      `and re-run: testlane store set ${profileName}`,
    "invalid-profile",
  );
}

async function auditHandoff(
  deps: Pick<CommandDeps, "now">,
  requester: string,
  profile: Profile,
  event: AuditRow["event"],
  ok: boolean,
  reason?: string,
): Promise<void> {
  const row: AuditInput = {
    event,
    profile: profile.name,
    host: hostOf(profile.baseUrl),
    environment: profile.environment,
    strategy: profile.strategy,
    requester,
    ok,
  };
  if (reason !== undefined) row.reason = reason;
  if (deps.now !== undefined) row.ts = deps.now().toISOString();
  await appendAudit(row);
}

/**
 * Mint a one-time handoff URL for an `app-handoff` profile. Same shape as the
 * session path in commands.ts: policy (refusals audited) → vault → mint →
 * audit "handoff" before anything is returned (an audit failure propagates,
 * so no code is ever handed out unrecorded).
 */
export async function issueHandoff(
  deps: CommandDeps,
  profileName: string,
  opts: IssueHandoffOptions = {},
): Promise<IssuedHandoff> {
  const requester = opts.requester ?? deps.requester;
  const profile = getProfile(deps.registry, profileName);

  try {
    assertAllowed(profile, { interactive: false, productionHosts: productionHosts(deps.registry) });
  } catch (err) {
    if (err instanceof PolicyError) await auditHandoff(deps, requester, profile, "refused", false, err.code);
    throw err;
  }

  if (profile.strategy !== "app-handoff") {
    await auditHandoff(deps, requester, profile, "refused", false, "invalid-profile");
    throw new PolicyError(
      `profile ${profile.name} uses strategy ${profile.strategy}; handoff needs strategy app-handoff`,
      "invalid-profile",
    );
  }

  // Validate the URL shape before touching the store (throws invalid-profile).
  try {
    buildHandoffUrl(profile, "probe");
  } catch (err) {
    if (err instanceof PolicyError) await auditHandoff(deps, requester, profile, "refused", false, err.code);
    throw err;
  }

  let secret: string | null;
  try {
    secret = await getProfileSecret(deps.store, profile);
  } catch (err) {
    if (err instanceof OriginMismatchError) {
      await auditHandoff(deps, requester, profile, "refused", false, err.reason);
    }
    throw err;
  }
  if (secret === null) {
    await auditHandoff(deps, requester, profile, "refused", false, "missing-secret");
    throw new MissingSecretError(profile.name);
  }
  if (secret.length < HANDOFF_SECRET_MIN_LENGTH) {
    // Stored before the minimum was enforced: refuse instead of minting weakly signed codes.
    await auditHandoff(deps, requester, profile, "refused", false, "handoff-secret-too-short");
    throw handoffSecretTooShortError(profile.name);
  }

  const minted = mintHandoffCode({ profileName: profile.name, secret, now: deps.now?.() ?? new Date() });
  const url = buildHandoffUrl(profile, minted.code);
  await auditHandoff(deps, requester, profile, "handoff", true);
  return { url, expiresAt: minted.expiresAt.toISOString(), profile: profile.name };
}
