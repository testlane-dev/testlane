/**
 * Origin- and environment-bound profile secrets.
 *
 * A profile's secret is stored as a JSON envelope
 *
 *   { "v": 3, "origin": "<new URL(profile.baseUrl).origin>",
 *     "environment": "<profile.environment at store time>", "secret": "<value>",
 *     "storedAt": "<ISO time the secret was stored or promoted>" | null,
 *     "pendingSecret"?: "<rotated value not yet confirmed>", "pendingSince"?: "<ISO>" }
 *
 * which the store adapter encrypts as a whole. On load the envelope's origin
 * must equal the profile's current baseUrl origin and the envelope's
 * environment must equal the profile's current environment tag; otherwise the
 * secret is refused. This stops an edited (or hostile) profile registry from
 * pointing an existing profile name at a different server, or re-tagging a
 * profile, to harvest or misuse the password: moving a secret to a new origin
 * or environment requires a human to re-run `store set`.
 *
 * Version 2 envelopes ({ v, origin, environment, secret }) are still accepted;
 * their age is unknown (storedAt null, reported by `status` as
 * "legacy-envelope"). `storedAt` is null in a v3 envelope only when it was
 * carried over from a v2 envelope by a pending write.
 *
 * Rotation is two-phase: `rotate` first writes the new value as
 * `pendingSecret` next to the current `secret` (setPendingSecret), then asks
 * the app to change the password, then either promotes the pending value
 * (promotePendingSecret) or drops it (dropPendingSecret). A crash or network
 * failure between the phases therefore never loses the live credential: both
 * values stay stored until a sign-in proves which one the app accepts.
 *
 * Secrets for `environment: "production"` profiles are never stored at all.
 *
 * This module is the single place a secret is loaded from the store, and it
 * registers every loaded value (secret and pendingSecret) with the
 * process-wide redactor before returning it, except short all-digit values
 * (PINs; see isRedactable in src/redact.ts), which the broker never prints and
 * whose digits would otherwise be scrubbed out of unrelated cookies and
 * timestamps. No message produced here ever contains a secret.
 */
import { isRedactable, redactor } from "./redact.js";
import { secretKeyFor, type SecretStore } from "./store/index.js";
import { ENVIRONMENTS, PolicyError, type Environment, type Profile } from "./types.js";

export const ENVELOPE_VERSION = 3;
/** The previous envelope version, still accepted on read (storedAt unknown). */
export const LEGACY_ENVELOPE_VERSION = 2;

interface SecretEnvelope {
  v: typeof ENVELOPE_VERSION;
  origin: string;
  environment: Environment;
  secret: string;
  /** ISO timestamp; null when the age is unknown (carried over from a v2 envelope). */
  storedAt: string | null;
  pendingSecret?: string;
  pendingSince?: string;
}

/** What getProfileSecrets returns. Values are secrets: never print them. */
export interface ProfileSecrets {
  secret: string;
  /** A rotated value written before the app confirmed it; absent when no rotation is in flight. */
  pendingSecret?: string;
  /** When the pending value was written (ISO); present exactly when pendingSecret is. */
  pendingSince?: string;
  /** When `secret` was stored or promoted (ISO); null for a v2 envelope (age unknown). */
  storedAt: string | null;
  /** Envelope version read from the store (2 or 3). */
  version: 2 | 3;
}

/**
 * Thrown when a stored secret may not be used for a profile: either it is bound
 * to a different origin ("origin-mismatch") or it predates origin binding / is
 * not a valid envelope ("origin-unknown"). The message names the profile and
 * the origins involved, never the secret.
 */
export class OriginMismatchError extends Error {
  override readonly name = "OriginMismatchError";
  constructor(
    message: string,
    public readonly profile: string,
    public readonly reason: "origin-mismatch" | "origin-unknown" | "environment-mismatch",
  ) {
    super(message);
  }
}

/** The origin a profile's secret is bound to. Throws for a non-http(s) baseUrl. */
export function profileOrigin(profile: Pick<Profile, "name" | "baseUrl">): string {
  let url: URL;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    throw new Error(`Profile "${profile.name}" has an invalid baseUrl.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
    throw new Error(`Profile "${profile.name}" baseUrl must be an http(s) URL.`);
  }
  return url.origin;
}

function refuseProduction(profile: Profile): void {
  if (profile.environment === "production") {
    throw new PolicyError(
      `Profile "${profile.name}" is tagged environment "production"; Testlane never stores or uses production secrets. ` +
        "There is no override flag, environment variable or interactive bypass, by design.",
      "production-refused",
    );
  }
}

function register(value: string | undefined): void {
  if (isRedactable(value)) redactor.register(value);
}

async function writeEnvelope(store: SecretStore, profile: Profile, envelope: SecretEnvelope): Promise<void> {
  await store.set(secretKeyFor(profile), JSON.stringify(envelope));
}

/**
 * Store `secret` for `profile`, bound to the profile's current baseUrl origin
 * and environment tag, with storedAt = now. Any pending rotation is discarded
 * (a human re-seeding the vault decides the live value). Refuses production
 * profiles outright: the broker never uses a production secret, so it must
 * never hold one.
 */
export async function putProfileSecret(
  store: SecretStore,
  profile: Profile,
  secret: string,
  now: Date = new Date(),
): Promise<void> {
  refuseProduction(profile);
  if (typeof secret !== "string" || secret === "") throw new Error("empty secret");
  register(secret);
  await writeEnvelope(store, profile, {
    v: ENVELOPE_VERSION,
    origin: profileOrigin(profile),
    environment: profile.environment,
    secret,
    storedAt: now.toISOString(),
  });
}

/**
 * Load the secret for `profile`, or null when none is stored.
 *
 * @throws OriginMismatchError when the stored envelope is bound to another
 *   origin, or when the stored value is not an envelope (a pre-envelope value
 *   has an unknown origin and is refused).
 */
export async function getProfileSecret(store: SecretStore, profile: Profile): Promise<string | null> {
  const secrets = await getProfileSecrets(store, profile);
  return secrets === null ? null : secrets.secret;
}

/**
 * Load the secret, any pending rotated secret and the storage metadata for
 * `profile`, or null when nothing is stored. Both values are registered with
 * the redactor before this returns.
 *
 * @throws OriginMismatchError as getProfileSecret.
 */
export async function getProfileSecrets(store: SecretStore, profile: Profile): Promise<ProfileSecrets | null> {
  const loaded = await loadEnvelope(store, profile);
  if (loaded === null) return null;
  const { envelope, version } = loaded;
  const out: ProfileSecrets = { secret: envelope.secret, storedAt: envelope.storedAt, version };
  if (envelope.pendingSecret !== undefined && envelope.pendingSince !== undefined) {
    out.pendingSecret = envelope.pendingSecret;
    out.pendingSince = envelope.pendingSince;
  }
  return out;
}

/**
 * Phase 1 of a rotation: store `pending` next to the current secret (which is
 * kept unchanged, with its storedAt). Replaces any earlier pending value.
 *
 * @throws Error when nothing is stored for the profile (there is nothing to
 *   rotate), OriginMismatchError as getProfileSecret, PolicyError for production.
 */
export async function setPendingSecret(
  store: SecretStore,
  profile: Profile,
  pending: string,
  now: Date = new Date(),
): Promise<void> {
  refuseProduction(profile);
  if (typeof pending !== "string" || pending === "") throw new Error("empty secret");
  register(pending);
  const loaded = await loadEnvelope(store, profile);
  if (loaded === null) throw new Error(`No secret stored for "${profile.name}"; nothing to rotate.`);
  await writeEnvelope(store, profile, {
    ...loaded.envelope,
    pendingSecret: pending,
    pendingSince: now.toISOString(),
  });
}

/**
 * Phase 2 (success): make the pending value the secret, storedAt = now, and
 * clear the pending fields. When `expected` is given, promotes only if the
 * stored pending value is exactly that one (another process may have changed
 * the envelope since it was read).
 *
 * @returns true when promoted, or when `expected` is already the secret (a
 *   concurrent promote won); false when there is no matching pending value.
 */
export async function promotePendingSecret(
  store: SecretStore,
  profile: Profile,
  expected?: string,
  now: Date = new Date(),
): Promise<boolean> {
  refuseProduction(profile);
  const loaded = await loadEnvelope(store, profile);
  if (loaded === null) return false;
  const env = loaded.envelope;
  if (env.pendingSecret === undefined) return expected !== undefined && env.secret === expected;
  if (expected !== undefined && env.pendingSecret !== expected) return false;
  await writeEnvelope(store, profile, {
    v: ENVELOPE_VERSION,
    origin: env.origin,
    environment: env.environment,
    secret: env.pendingSecret,
    storedAt: now.toISOString(),
  });
  return true;
}

/**
 * Phase 2 (failure): forget the pending value and keep the current secret
 * (and its storedAt) unchanged. When `expected` is given, drops only if the
 * stored pending value is exactly that one.
 *
 * @returns true when a pending value was removed.
 */
export async function dropPendingSecret(store: SecretStore, profile: Profile, expected?: string): Promise<boolean> {
  refuseProduction(profile);
  const loaded = await loadEnvelope(store, profile);
  if (loaded === null) return false;
  const env = loaded.envelope;
  if (env.pendingSecret === undefined) return false;
  if (expected !== undefined && env.pendingSecret !== expected) return false;
  await writeEnvelope(store, profile, {
    v: ENVELOPE_VERSION,
    origin: env.origin,
    environment: env.environment,
    secret: env.secret,
    storedAt: env.storedAt,
  });
  return true;
}

/** Read, parse and bind-check the stored envelope. Registers every value it finds. */
async function loadEnvelope(
  store: SecretStore,
  profile: Profile,
): Promise<{ envelope: SecretEnvelope; version: 2 | 3 } | null> {
  const expected = profileOrigin(profile);
  const raw = await store.get(secretKeyFor(profile));
  if (raw === null) return null;

  const parsed = parseEnvelope(raw);
  if (parsed === null) {
    // A legacy value is the bare secret itself: scrub it from output too.
    register(raw);
    throw new OriginMismatchError(
      `Stored secret for "${profile.name}" is not bound to an origin (stored before origin binding, or unreadable); ` +
        `refusing to use it. A human must re-run: testlane store set ${profile.name}`,
      profile.name,
      "origin-unknown",
    );
  }
  const { envelope } = parsed;
  register(envelope.secret);
  register(envelope.pendingSecret);

  if (envelope.origin !== expected) {
    throw new OriginMismatchError(
      `Stored secret for "${profile.name}" is bound to origin ${printableOrigin(envelope.origin)}, ` +
        `but the profile's baseUrl origin is ${expected}; refusing to send it. ` +
        `If the move is intended, a human must re-run: testlane store set ${profile.name}`,
      profile.name,
      "origin-mismatch",
    );
  }
  if (envelope.environment !== profile.environment) {
    throw new OriginMismatchError(
      `Stored secret for "${profile.name}" was stored while the profile was tagged environment "${envelope.environment}", ` +
        `but the profile is now tagged "${profile.environment}"; refusing to use it. ` +
        `If the change is intended, a human must re-run: testlane store set ${profile.name}`,
      profile.name,
      "environment-mismatch",
    );
  }
  return parsed;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function parseEnvelope(raw: string): { envelope: SecretEnvelope; version: 2 | 3 } | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  const keys = Object.keys(rec).sort().join(",");
  const origin = rec["origin"];
  const environment = rec["environment"];
  const secret = rec["secret"];
  if (typeof origin !== "string" || typeof secret !== "string" || secret === "") return null;
  if (typeof environment !== "string" || !(ENVIRONMENTS as readonly string[]).includes(environment)) return null;
  const base = { v: ENVELOPE_VERSION, origin, environment: environment as Environment, secret } as const;

  if (rec["v"] === LEGACY_ENVELOPE_VERSION) {
    if (keys !== "environment,origin,secret,v") return null;
    return { envelope: { ...base, storedAt: null }, version: 2 };
  }
  if (rec["v"] !== ENVELOPE_VERSION) return null;
  const storedAt = rec["storedAt"];
  if (storedAt !== null && !isIsoTimestamp(storedAt)) return null;
  if (keys === "environment,origin,secret,storedAt,v") {
    return { envelope: { ...base, storedAt }, version: 3 };
  }
  if (keys === "environment,origin,pendingSecret,pendingSince,secret,storedAt,v") {
    const pendingSecret = rec["pendingSecret"];
    const pendingSince = rec["pendingSince"];
    if (typeof pendingSecret !== "string" || pendingSecret === "" || !isIsoTimestamp(pendingSince)) return null;
    return { envelope: { ...base, storedAt, pendingSecret, pendingSince }, version: 3 };
  }
  return null;
}

/** Origins come from our own envelope, but never print anything that is not origin-shaped. */
function printableOrigin(origin: string): string {
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]{1,300}$/.test(origin) ? origin : "(unprintable origin)";
}
