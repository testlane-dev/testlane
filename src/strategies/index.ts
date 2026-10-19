/**
 * Login strategy contract and registry.
 *
 * A strategy receives the secret in memory only (SignInContext.secret) and
 * returns a SessionArtifact. It must never log the secret, place it in an
 * Error message, or copy it into the artifact.
 */
import type { Profile, SessionArtifact, StrategyName } from "../types.js";
import { dependentTokenStrategy } from "./dependent-token.js";
import { formPostStrategy } from "./form-post.js";
import { nextAuthCredentialsStrategy } from "./nextauth-credentials.js";
// Last on purpose: app-handoff imports ../handoff.js, which imports ../commands.js,
// which imports this module; by then every other strategy module is evaluated.
import { appHandoffStrategy } from "./app-handoff.js";

export { sanitizeIdentity } from "./nextauth-credentials.js";
export { dependentTokenStrategy, DEFAULT_TOKEN_HEADER } from "./dependent-token.js";
export { appHandoffStrategy } from "./app-handoff.js";

export interface SignInContext {
  profile: Profile;
  /** The password / PIN / key. In memory only; never log or echo it. */
  secret: string;
  /** Session lifetime to request; the artifact never outlives it. */
  ttlMinutes: number;
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Obtain another profile's session (dependent-token signs in its
   * `dependsOn` profile first, e.g. a bootstrap or service account). Supplied by the broker commands, which run the
   * dependency through the same policy + vault + audit path and refuse
   * cycles, deep nesting, production and cross-host dependencies.
   */
  sessionFor?: (profileName: string) => Promise<SessionArtifact>;
  /**
   * Record a one-time handoff code the strategy minted (app-handoff), before
   * the code leaves the process: the broker writes the "handoff" audit row,
   * like `testlane handoff` does. Supplied by the broker commands; app-handoff
   * refuses to mint without it, and an audit failure propagates, so no code
   * is ever sent unrecorded. Called again with `{ reason: "no-answer" }` when
   * the request carrying the code got no answer, so that row never stands as
   * a delivered code on its own.
   */
  recordHandoff?: (failure?: { reason: "no-answer" }) => Promise<void>;
  /**
   * Check that the profile origin's host and port accept a TCP connection,
   * sending nothing (app-handoff runs it before minting a code, so no code is
   * minted for an unreachable app). Defaults to a real TCP connect; tests that
   * answer with a synthetic fetchImpl inject their own.
   */
  probeOrigin?: (origin: URL) => Promise<void>;
}

export interface WhoAmI {
  email?: string;
  name?: string;
  role?: string;
  /** Sanitized identity object from the app; never contains token/secret/password/cookie keys. */
  raw?: Record<string, unknown>;
}

export interface Strategy {
  readonly name: StrategyName;
  signIn(ctx: SignInContext): Promise<SessionArtifact>;
  /**
   * Ask the app who the artifact belongs to. `profile` is optional; when given,
   * strategy options such as a custom session path or role field are honoured.
   */
  whoami?(artifact: SessionArtifact, fetchImpl?: typeof fetch, profile?: Profile): Promise<WhoAmI>;
}

/**
 * Strategies that can sign in for `session` / `check` (and as a dependent-token
 * `dependsOn`). app-handoff signs in by consuming its own one-time handoff URL;
 * `handoff` still returns that URL instead for navigate-only browsers.
 */
export const SIGN_IN_STRATEGIES: readonly StrategyName[] = [
  "nextauth-credentials",
  "form-post",
  "dependent-token",
  "app-handoff",
];

export function isSignInStrategy(name: StrategyName): boolean {
  return SIGN_IN_STRATEGIES.includes(name);
}

export function getStrategy(name: StrategyName): Strategy {
  if (name === "nextauth-credentials") return nextAuthCredentialsStrategy;
  if (name === "form-post") return formPostStrategy;
  if (name === "dependent-token") return dependentTokenStrategy;
  if (name === "app-handoff") return appHandoffStrategy;
  throw new Error(`Strategy "${name}" is not implemented yet (Phase 1).`);
}
