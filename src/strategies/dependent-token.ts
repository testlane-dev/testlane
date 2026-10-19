/**
 * `dependent-token` strategy: sign in as another profile first, then exchange
 * this profile's secret for a token or cookie using that session.
 *
 * Typical shapes: a service account that mints per-user tokens or a
 * bootstrap session that unlocks a scoped sign-in.
 *
 * Flow:
 *   1. ctx.sessionFor(dependsOn): the broker signs the dependency profile in
 *      through its own policy + vault + audit path (same host, non-production,
 *      no cycles, nesting <= 2; see sessionForDependency in src/commands.ts).
 *      Its origin must equal this profile's origin.
 *   2. POST <tokenPath> with the dependency's cookies (and forwardable
 *      headers), redirect "manual" (a redirect is a failure, never followed).
 *      Body: `fields` with {{secret}}, {{email}}, {{identifier}} substituted,
 *      as JSON (bodyFormat "json", default) or urlencoded (bodyFormat "form").
 *   3. Capture exactly one of:
 *        tokenField         dot path into the JSON response; the value becomes
 *                           header `tokenHeader` (default "Authorization" with
 *                           a "Bearer " prefix; an explicit name gets the raw value)
 *        sessionCookieName  a cookie the response must set
 *   4. Expiry: min(ttlMinutes, expiresAtField (ISO, unix seconds or unix ms,
 *      autodetected), the captured cookie's expiry, the dependency's expiresAt).
 *
 * The artifact carries the dependency session's cookies and headers plus what
 * step 3 captured: whoever receives the artifact also holds the dependency
 * session (documented in docs/strategies.md).
 *
 * Security: the secret is shape-checked (secretPattern) before any request,
 * appears only in the POST body, and is never logged, placed in an Error or
 * copied into the artifact. The captured token is session material: it is
 * returned in the artifact only, never logged or put in an Error. Error
 * messages name option keys, never option values.
 */
import { CookieJar } from "../http/cookie-jar.js";
import {
  PROFILE_NAME_RE,
  SignInError,
  type Profile,
  type SessionArtifact,
  type SessionCookie,
} from "../types.js";
import {
  assertTtl,
  capCookies,
  getPath,
  isRecord,
  readJson,
  resolveOptionUrl,
  send,
} from "./form-post.js";
import type { SignInContext, Strategy, WhoAmI } from "./index.js";
import { sanitizeIdentity, USER_AGENT } from "./nextauth-credentials.js";
import { compileSecretPattern, parseTemplateFields, RESERVED_HEADER_RE } from "./options.js";

/** Header used when tokenField is set and tokenHeader is not (value "Bearer <token>"). */
export const DEFAULT_TOKEN_HEADER = "Authorization";

/** Printable ASCII without spaces: the token goes into an HTTP header. */
const TOKEN_VALUE_RE = /^[\x21-\x7e]{1,4096}$/;
const DOT_PATH_RE = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,7}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{0,8192}$/;
/** Headers the strategy sets itself; a dependency's copies are not forwarded. */
const OWN_HEADER_RE = /^(user-agent|accept)$/i;
const PLACEHOLDER_SPLIT_RE = /\{\{(secret|email|identifier)\}\}/;
/** Unix timestamps below this are seconds (1e11 s is year 5138; 1e11 ms is 1973). */
const SECONDS_CUTOFF = 1e11;

type Capture =
  | { kind: "header"; tokenField: string; headerName: string; bearer: boolean }
  | { kind: "cookie"; cookieName: string };

interface Config {
  /** How the profile spells the dependency / endpoint option keys (for messages). */
  keys: { dependsOn: string; tokenPath: string };
  dependsOn: string | undefined;
  tokenPath: string | undefined;
  bodyFormat: "json" | "form";
  /** Raw `fields` template (parsed at sign-in). */
  fields: string | undefined;
  secretPattern: RegExp | undefined;
  secretMessage: string;
  capture: Capture | undefined;
  expiresAtField: string | undefined;
  mePath: string | undefined;
  emailField: string;
  nameFields: string[];
  roleField: string;
  /** Wording for messages. */
  what: string;
  identityWhat: string;
  rejectHint: string;
  dependencyWhat: string;
}

function val(options: Record<string, string> | undefined, key: string): string | undefined {
  const v = options?.[key];
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

function dotPath(options: Record<string, string> | undefined, key: string, fallback: string): string;
function dotPath(options: Record<string, string> | undefined, key: string): string | undefined;
function dotPath(options: Record<string, string> | undefined, key: string, fallback?: string): string | undefined {
  const v = val(options, key) ?? fallback;
  if (v !== undefined && !DOT_PATH_RE.test(v)) {
    throw new SignInError(`profile option ${key} must be a dot path`);
  }
  return v;
}

function dependentTokenConfig(options: Record<string, string> | undefined): Config {
  const bodyFormat = val(options, "bodyFormat") ?? "json";
  if (bodyFormat !== "json" && bodyFormat !== "form") {
    throw new SignInError('profile option bodyFormat must be "json" or "form"');
  }
  const rawPattern = val(options, "secretPattern");
  let secretPattern: RegExp | undefined;
  if (rawPattern !== undefined) {
    secretPattern = compileSecretPattern(rawPattern);
    if (secretPattern === undefined) {
      throw new SignInError("profile option secretPattern must be a valid regular expression");
    }
  }
  const tokenField = dotPath(options, "tokenField");
  const tokenHeader = val(options, "tokenHeader");
  const cookieName = val(options, "sessionCookieName");
  if (tokenField !== undefined && cookieName !== undefined) {
    throw new SignInError("profile options tokenField and sessionCookieName are mutually exclusive; set exactly one");
  }
  if (tokenHeader !== undefined) {
    if (tokenField === undefined) throw new SignInError("profile option tokenHeader requires tokenField");
    if (!HEADER_NAME_RE.test(tokenHeader) || RESERVED_HEADER_RE.test(tokenHeader)) {
      throw new SignInError("profile option tokenHeader must be a valid, non-reserved HTTP header name");
    }
  }
  if (cookieName !== undefined && !HEADER_NAME_RE.test(cookieName)) {
    throw new SignInError("profile option sessionCookieName must be a valid cookie name");
  }
  let capture: Capture | undefined;
  if (tokenField !== undefined) {
    capture = {
      kind: "header",
      tokenField,
      headerName: tokenHeader ?? DEFAULT_TOKEN_HEADER,
      bearer: tokenHeader === undefined,
    };
  } else if (cookieName !== undefined) {
    capture = { kind: "cookie", cookieName };
  }
  const dependsOn = val(options, "dependsOn");
  return {
    keys: { dependsOn: "dependsOn", tokenPath: "tokenPath" },
    dependsOn,
    tokenPath: val(options, "tokenPath"),
    bodyFormat,
    fields: val(options, "fields"),
    secretPattern,
    secretMessage: "secret does not match profile option secretPattern",
    capture,
    expiresAtField: dotPath(options, "expiresAtField"),
    mePath: val(options, "mePath"),
    emailField: dotPath(options, "emailField", "email"),
    nameFields: ["name", "user.name"],
    roleField: dotPath(options, "roleField", "role"),
    what: "token sign-in",
    identityWhat: "identity endpoint",
    rejectHint: "secret, account or dependency session",
    dependencyWhat: "dependency session",
  };
}

/**
 * Substitute {{secret}}, {{email}} and {{identifier}} in one pass (no
 * String.replace "$&" patterns; substituted values are never re-scanned).
 */
function fill(template: string, values: Record<"secret" | "email" | "identifier", string>): string {
  return template
    .split(PLACEHOLDER_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? values[part as "secret" | "email" | "identifier"] : part))
    .join("");
}

/**
 * Headers of a session artifact that may be forwarded: valid names and
 * printable values, never transport/cookie headers or ones the strategy sets
 * itself. Values are session material; they are only copied, never logged.
 */
function forwardableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADER_RE.test(name) || OWN_HEADER_RE.test(name)) continue;
    if (typeof value !== "string" || !HEADER_VALUE_RE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Milliseconds since the epoch from an ISO string or unix seconds / ms (number or digit string). */
export function parseExpiry(value: unknown): number | undefined {
  let n: number | undefined;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const s = value.trim();
    if (/^[0-9]{1,16}(\.[0-9]+)?$/.test(s)) n = Number(s);
    else {
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? ms : undefined;
    }
  }
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return n < SECONDS_CUTOFF ? n * 1000 : n;
}

function isLive(c: SessionCookie): boolean {
  return c.value !== "" && (c.expires === -1 || c.expires > Date.now() / 1000);
}

async function signIn(ctx: SignInContext): Promise<SessionArtifact> {
  const strategy = "dependent-token";
  const { profile, ttlMinutes } = ctx;
  const cfg = dependentTokenConfig(profile.options);

  // The secret's shape first; the message never includes the value.
  if (typeof ctx.secret !== "string") throw new SignInError("secret is missing; refusing to sign in");
  if (cfg.secretPattern !== undefined) {
    if (!cfg.secretPattern.test(ctx.secret)) throw new SignInError(cfg.secretMessage);
  } else if (ctx.secret === "") {
    throw new SignInError("secret is empty; refusing to sign in");
  }
  assertTtl(ttlMinutes);

  // Every option before any request (or the dependency sign-in).
  const { dependsOn } = cfg;
  if (dependsOn === undefined) {
    throw new SignInError(
      `profile option ${cfg.keys.dependsOn} is required for strategy ${strategy}; refusing to sign in`,
    );
  }
  if (!PROFILE_NAME_RE.test(dependsOn)) {
    throw new SignInError(`profile option ${cfg.keys.dependsOn} must be a profile name`);
  }
  if (dependsOn === profile.name) {
    throw new SignInError(`profile option ${cfg.keys.dependsOn} must name a different profile`);
  }
  if (cfg.tokenPath === undefined) {
    throw new SignInError(
      `profile option ${cfg.keys.tokenPath} is required for strategy ${strategy}; refusing to sign in`,
    );
  }
  if (cfg.fields === undefined) {
    throw new SignInError(`profile option fields is required for strategy ${strategy}; refusing to sign in`);
  }
  const parsed = parseTemplateFields(cfg.fields);
  if ("error" in parsed) throw new SignInError(`profile option fields ${parsed.error}`);
  const fields = parsed.entries;
  const { capture } = cfg;
  if (capture === undefined) {
    throw new SignInError(
      `strategy ${strategy} needs exactly one of the profile options tokenField / sessionCookieName; refusing to sign in`,
    );
  }
  const identifier = profile.account.identifier;
  if (fields.some(([, t]) => t.includes("{{identifier}}")) && (identifier === undefined || identifier.trim() === "")) {
    throw new SignInError(`profile ${profile.name} has no account.identifier; refusing to sign in`);
  }
  const tokenUrl = resolveOptionUrl(profile.baseUrl, cfg.tokenPath, cfg.keys.tokenPath);
  if (cfg.mePath !== undefined) resolveOptionUrl(profile.baseUrl, cfg.mePath, "mePath");
  if (ctx.sessionFor === undefined) {
    throw new SignInError(`${strategy} needs the ${cfg.dependencyWhat} from the broker (no sessionFor provided)`);
  }
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  const base = new URL(profile.baseUrl);
  const host = base.host;

  // 1. Dependency session, through the broker's own policy / vault / audit path.
  const dependency = await ctx.sessionFor(dependsOn);
  let depOrigin: string;
  try {
    depOrigin = new URL(dependency.baseUrl).origin;
  } catch {
    depOrigin = "";
  }
  if (depOrigin !== base.origin) {
    throw new SignInError(
      `${cfg.dependencyWhat} for ${dependsOn} is not on the profile origin; refusing to send the secret`,
    );
  }
  const jar = new CookieJar();
  for (const c of dependency.cookies) jar.add(c);
  const depHeaders = forwardableHeaders(dependency.headers);
  const cookieHeader = jar.headerFor(tokenUrl);
  if (cookieHeader === undefined && Object.keys(depHeaders).length === 0) {
    throw new SignInError(
      `${cfg.dependencyWhat} for ${dependsOn} has no cookie or header for ${host}; refusing to send the secret`,
    );
  }

  // 2. The exchange. The secret exists only inside this body.
  const values = { secret: ctx.secret, email: profile.account.email, identifier: identifier ?? "" };
  let body: string;
  let contentType: string;
  if (cfg.bodyFormat === "json") {
    // Object.fromEntries defines own properties, so no field name can hit a prototype setter.
    body = JSON.stringify(Object.fromEntries(fields.map(([name, t]) => [name, fill(t, values)])));
    contentType = "application/json";
  } else {
    const form = new URLSearchParams();
    for (const [name, t] of fields) form.append(name, fill(t, values));
    body = form.toString();
    contentType = "application/x-www-form-urlencoded";
  }
  const headers: Record<string, string> = {
    ...depHeaders,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "Content-Type": contentType,
    Origin: base.origin,
  };
  if (cookieHeader !== undefined) headers["Cookie"] = cookieHeader;

  const res = await send(fetchImpl, tokenUrl, { method: "POST", headers, body }, cfg.what);
  const setNow = jar.addFromResponse(res, tokenUrl);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new SignInError(
      `${cfg.what} at ${host} redirected (${res.status}); the ${cfg.dependencyWhat} is probably not valid`,
      res.status,
    );
  }
  // Not marked credentialsRejected: a 401 may equally mean the dependency session was refused.
  if (res.status === 401) {
    await res.body?.cancel();
    throw new SignInError(`${cfg.what} rejected by ${host} (${cfg.rejectHint})`, 401);
  }
  if (res.status === 403) {
    await res.body?.cancel();
    throw new SignInError(
      `${cfg.dependencyWhat} for ${dependsOn} may not use ${cfg.keys.tokenPath} at ${host}`,
      403,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new SignInError(`${cfg.what} at ${host} returned ${res.status}`, res.status);
  }

  // 3. Capture. Token values are never logged or put in an Error.
  const issuedMs = Date.now();
  let expiresMs = issuedMs + ttlMinutes * 60_000;
  const outHeaders: Record<string, string> = {};
  let json: unknown;
  if (capture.kind === "header") {
    json = await readJson(res, cfg.what, host);
    const token = getPath(json, capture.tokenField);
    if (typeof token !== "string" || !TOKEN_VALUE_RE.test(token)) {
      throw new SignInError(`${cfg.what} at ${host} did not return a usable token`, res.status);
    }
    outHeaders[capture.headerName] = capture.bearer ? `Bearer ${token}` : token;
  } else {
    const cookie = setNow.find((c) => c.name === capture.cookieName && isLive(c));
    if (cookie === undefined) {
      await res.body?.cancel();
      throw new SignInError(
        `${cfg.what} at ${host} did not set the session cookie (expected ${capture.cookieName})`,
        res.status,
      );
    }
    if (cookie.expires !== -1) expiresMs = Math.min(expiresMs, cookie.expires * 1000);
    if (cfg.expiresAtField !== undefined) {
      // Optional in cookie mode: a non-JSON body just means "no server expiry".
      const text = await res.text();
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    } else {
      await res.body?.cancel();
    }
  }

  // 4. Expiry: never beyond the TTL, the server's expiry or the dependency session.
  if (cfg.expiresAtField !== undefined) {
    const serverMs = parseExpiry(getPath(json, cfg.expiresAtField));
    if (serverMs !== undefined) expiresMs = Math.min(expiresMs, serverMs);
  }
  const depMs = Date.parse(dependency.expiresAt);
  if (Number.isFinite(depMs)) expiresMs = Math.min(expiresMs, depMs);
  if (expiresMs <= issuedMs) {
    throw new SignInError(`${cfg.what} at ${host} returned an already expired session`, res.status);
  }

  // The dependency's headers ride along, except one the capture replaces.
  const merged: Record<string, string> = {};
  const ownNames = new Set(Object.keys(outHeaders).map((n) => n.toLowerCase()));
  for (const [n, v] of Object.entries(depHeaders)) if (!ownNames.has(n.toLowerCase())) merged[n] = v;
  Object.assign(merged, outHeaders);

  const artifact: SessionArtifact = {
    profile: profile.name,
    strategy,
    baseUrl: profile.baseUrl,
    cookies: capCookies(jar.all().filter(isLive), Math.floor(expiresMs / 1000)),
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
  if (Object.keys(merged).length > 0) artifact.headers = merged;
  return artifact;
}

async function whoami(
  artifact: SessionArtifact,
  fetchImpl: typeof fetch = globalThis.fetch,
  profile?: Profile,
): Promise<WhoAmI> {
  const strategy = "dependent-token";
  const cfg = dependentTokenConfig(profile?.options);
  if (cfg.mePath === undefined) {
    throw new SignInError(`${strategy} cannot verify identity without profile option mePath`);
  }
  const url = resolveOptionUrl(artifact.baseUrl, cfg.mePath, "mePath");
  if (cfg.capture?.kind === "header") {
    const present = headerValue(artifact.headers, cfg.capture.headerName);
    if (present === undefined || !HEADER_VALUE_RE.test(present) || present === "") {
      throw new SignInError(`session artifact has no ${cfg.capture.headerName} header`);
    }
  }
  const headers: Record<string, string> = {
    ...forwardableHeaders(artifact.headers),
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  const jar = new CookieJar();
  for (const c of artifact.cookies) jar.add(c);
  const cookie = jar.headerFor(url);
  if (cookie !== undefined) headers["Cookie"] = cookie;

  const res = await send(fetchImpl, url, { method: "GET", headers }, cfg.identityWhat);
  if (!res.ok) {
    await res.body?.cancel();
    throw new SignInError(`${cfg.identityWhat} returned ${res.status}`, res.status);
  }
  const json = await readJson(res, cfg.identityWhat, url.host);
  if (!isRecord(json)) {
    throw new SignInError(`${cfg.identityWhat} at ${url.host} did not return an object`);
  }
  const root = json;

  const result: WhoAmI = { raw: sanitizeIdentity(root) };
  const email = getPath(root, cfg.emailField);
  if (typeof email === "string") result.email = email;
  for (const field of cfg.nameFields) {
    const name = getPath(root, field);
    if (typeof name === "string") {
      result.name = name;
      break;
    }
  }
  const role = getPath(json, cfg.roleField);
  if (typeof role === "string" || typeof role === "number") result.role = String(role);
  return result;
}

export const dependentTokenStrategy: Strategy = {
  name: "dependent-token",
  signIn,
  whoami,
};
