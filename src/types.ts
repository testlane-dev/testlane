/**
 * Shared types for Testlane.
 *
 * Nothing in this file may hold a secret value. Secrets live only inside the
 * secret store and inside a strategy's in-memory sign-in call.
 */

/**
 * Profile names: lowercase segments separated by ":", e.g. "acme:local:admin".
 * Single source of truth: the registry schema and the secret-store key check
 * both import it from here.
 */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$/;

/**
 * Profile names starting with this prefix are reserved for the store's own
 * entries (the encrypted-file data key is kept as "agent-auth/encrypted-file.key.v1",
 * i.e. the key a profile named "encrypted-file.key.v1" would use). The registry
 * schema rejects them.
 */
export const RESERVED_PROFILE_PREFIX = "encrypted-file.";

export function isReservedProfileName(name: string): boolean {
  return name.startsWith(RESERVED_PROFILE_PREFIX);
}

export const ENVIRONMENTS = ["sandbox", "testing", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const STRATEGIES = [
  "nextauth-credentials",
  "form-post",
  "dependent-token",
  "oauth-client-credentials",
  "api-key",
  "app-handoff",
] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export interface ProfileAccount {
  /** Account identifier shown to the agent. Not a secret. */
  email: string;
  /** Human-readable role the account is expected to have, e.g. "Sales". */
  role: string;
  /**
   * Optional non-secret identifier sent alongside the secret: dependent-token
   * substitutes it for {{identifier}} in `options.fields` when requested.
   */
  identifier?: string;
}

export interface ProfileSession {
  /** Session lifetime the broker requests / caps. 0 means "never issue". */
  ttlMinutes: number;
}

/** One entry of testlane.profiles.json. Committed to consuming repos; zero secrets. */
export interface Profile {
  /** Profile name, e.g. "acme:local:admin". Also the secret-store key suffix. */
  name: string;
  app: string;
  environment: Environment;
  baseUrl: string;
  strategy: StrategyName;
  account: ProfileAccount;
  session: ProfileSession;
  /** Extra hosts (hostname[:port]) that this profile may talk to besides baseUrl's host. */
  allowedHosts?: string[];
  /** Strategy-specific, non-secret options (form field names, login path, ...). */
  options?: Record<string, string>;
  notes?: string;
}

/** The registry after loading and validation. */
export interface ProfileRegistry {
  version: 1;
  profiles: Record<string, Profile>;
  /**
   * Files the registry was built from, for diagnostics: the repo and user
   * registry files, plus the account overrides file when an override applied.
   */
  sources: string[];
  /**
   * Names of profiles whose `account.email` / `account.identifier` came from
   * the user-level account overrides file (sorted). Set by loadProfiles;
   * absent on hand-built registries, which means "none".
   */
  overrides?: string[];
  /**
   * Names in the (machine-global) account overrides file that match no
   * profile in this registry; ignored, reported for diagnostics (sorted).
   */
  unusedOverrides?: string[];
}

/** A cookie captured from a sign-in. Mirrors Playwright's storageState cookie shape. */
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** What a login strategy returns. The value fields ARE sensitive session material. */
export interface SessionArtifact {
  profile: string;
  strategy: StrategyName;
  baseUrl: string;
  /** Cookies to present to the app. */
  cookies: SessionCookie[];
  /** Bearer / API-key style header, when the strategy yields one instead of cookies. */
  headers?: Record<string, string>;
  /** ISO timestamp when the broker issued the artifact. */
  issuedAt: string;
  /** ISO timestamp after which the artifact should be considered dead. */
  expiresAt: string;
}

/** Result of `testlane check <profile>`: proves sign-in worked, returns nothing reusable. */
export interface CheckResult {
  profile: string;
  ok: boolean;
  role?: string;
  email?: string;
  message?: string;
}

/** Row appended to ~/.testlane/audit.ndjson. Never contains secret or session values. */
export interface AuditRow {
  ts: string;
  event: "session" | "check" | "handoff" | "refused" | "store.set" | "store.delete" | "rotate";
  profile: string;
  host: string;
  environment: Environment;
  strategy: StrategyName;
  /** Who asked: CLI process name, MCP client, HTTP caller. Best effort. */
  requester: string;
  format?: string;
  ok: boolean;
  reason?: string;
}

/** Thrown when policy refuses an operation. Message is safe to print. */
export class PolicyError extends Error {
  override readonly name = "PolicyError";
  constructor(
    message: string,
    public readonly code:
      | "production-refused"
      | "host-not-allowed"
      | "ttl-exceeded"
      | "unknown-profile"
      | "insecure-transport"
      | "invalid-profile"
      | "rotation-in-progress",
  ) {
    super(message);
  }
}

/** Thrown when a sign-in fails. Message must never include the secret. */
export class SignInError extends Error {
  override readonly name = "SignInError";
  /**
   * True when the app answered and refused the credentials themselves (as
   * opposed to a network, configuration or protocol failure). The broker uses
   * it to decide whether a pending rotated secret is worth a second attempt.
   */
  readonly credentialsRejected: boolean;
  constructor(
    message: string,
    public readonly status?: number,
    options: { credentialsRejected?: boolean } = {},
  ) {
    super(message);
    this.credentialsRejected = options.credentialsRejected === true;
  }
}

/** True when `err` is a SignInError in which the app refused the credentials. */
export function isCredentialsRejected(err: unknown): err is SignInError {
  return err instanceof SignInError && err.credentialsRejected;
}
