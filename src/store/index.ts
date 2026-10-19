/**
 * Secret store interface. Values pass through this boundary exactly once per
 * sign-in and must never be logged, printed, or placed on a command line.
 */
import { PROFILE_NAME_RE, type Profile } from "../types.js";

export interface SecretStore {
  /** Short adapter id, e.g. "dpapi", "keychain-macos", "secret-service", "encrypted-file". */
  readonly kind: string;
  /** Return the secret for `key`, or null when absent. */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key`, replacing any previous value. */
  set(key: string, value: string): Promise<void>;
  /** Remove `key`. Resolves true when something was deleted. */
  delete(key: string): Promise<boolean>;
  /** Keys currently stored (never values). */
  list(): Promise<string[]>;
}

/**
 * Namespace prefix for every key. Stable storage identifier: kept as
 * "agent-auth/" after the rename to Testlane for compatibility, because every
 * adapter stores (and finds) secrets under it; changing it would orphan every
 * stored secret.
 */
export const KEY_PREFIX = "agent-auth/";

/** The keychain key for a profile's primary secret (password, PIN, client secret, API key). */
export function secretKeyFor(profile: Pick<Profile, "name"> | string): string {
  const name = typeof profile === "string" ? profile : profile.name;
  return `${KEY_PREFIX}${name}`;
}

/**
 * True when `key` is exactly `agent-auth/<valid profile name>`. Adapters refuse
 * every other key, so a caller-supplied string can never address (or, for
 * file-backed adapters, name a file for) anything outside the namespace.
 */
export function isValidStoreKey(key: string): boolean {
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return false;
  return PROFILE_NAME_RE.test(key.slice(KEY_PREFIX.length));
}

/** Throw (without echoing the key) unless isValidStoreKey(key). */
export function assertValidStoreKey(key: string): void {
  if (!isValidStoreKey(key)) {
    throw new Error(`invalid secret store key: expected "${KEY_PREFIX}<profile name>"`);
  }
}

/** Filesystem-safe encoding of a key for file-backed adapters. */
export function encodeKeyForFile(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

export function decodeKeyFromFile(fileStem: string): string {
  return Buffer.from(fileStem, "base64url").toString("utf8");
}
