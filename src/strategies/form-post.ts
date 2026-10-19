/**
 * `form-post` strategy: a generic HTML login form or JSON sign-in endpoint.
 *
 * Flow:
 *   1. (optional, options.primeCookies === "true") GET <loginPath> to collect
 *      pre-login cookies such as a CSRF cookie.
 *   2. POST <loginPath> with the configured `fields`, redirect "manual":
 *      bodyFormat "form" (default) sends application/x-www-form-urlencoded;
 *      bodyFormat "json" sends application/json (a JSON object of the
 *      substituted string fields) plus an Origin header for the profile origin.
 *   3. Follow up to MAX_REDIRECTS same-origin redirects with GET, carrying the
 *      cookie jar. An off-origin redirect is refused (never followed).
 *   4. Succeed only when <sessionCookieName> was set during steps 2-3 (and,
 *      when successPath is configured, the final page is under successPath,
 *      resolved against baseUrl like loginPath, i.e. below any baseUrl path prefix;
 *      and, when successBodyField is configured, the final response is JSON
 *      with a non-empty string at that dot path). A 2xx answer to the POST
 *      itself (typical for JSON endpoints: 200/201, no redirect) is fine.
 *      A cookie set only by the priming GET does not count. Apps that also set
 *      the session cookie on anonymous pages (a failed login redirecting back
 *      to the login page re-sets it) need successPath to tell failure apart.
 *
 * Profile options (non-secret; schema in ./options.ts):
 *   loginPath (required), fields (required; JSON object string whose values may
 *   contain "{{email}}" and "{{secret}}"), sessionCookieName (required),
 *   bodyFormat ("form" | "json"; default "form"), primeCookies ("true" | "false"),
 *   successPath, successBodyField (dot path into the final response JSON), mePath,
 *   roleField / emailField (dot paths into the mePath JSON; defaults "role" / "email";
 *   numeric segments index arrays, e.g. "workspaces.0.role"), and the
 *   strategy-agnostic rotate* options (see rotateProfile in src/commands.ts).
 *
 * A 401/403, or a login that did not set the session cookie / reach
 * successPath / return successBodyField, is a SignInError with
 * credentialsRejected = true (the broker may then try a pending rotated secret once).
 *
 * The value at successBodyField is typically session material (a token); it
 * is only checked for presence, never logged, returned or put in an Error.
 *
 * The secret is substituted only into the POST body. It is never logged, never
 * placed in an Error, and never copied into the artifact. Redirects are
 * followed with GET and no body, so the secret is sent exactly once.
 *
 * This module also exports the small HTTP helpers shared with dependent-token.
 */
import { CookieJar } from "../http/cookie-jar.js";
import { SignInError, type Profile, type SessionArtifact, type SessionCookie } from "../types.js";
import type { SignInContext, Strategy, WhoAmI } from "./index.js";
import { sanitizeIdentity, USER_AGENT } from "./nextauth-credentials.js";
import { isSafeOptionPath } from "./options.js";

export const MAX_REDIRECTS = 5;

const EMAIL_PLACEHOLDER = "{{email}}";
const SECRET_PLACEHOLDER = "{{secret}}";
const FIELD_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,64}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const DOT_PATH_RE = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,7}$/;

// ---------------------------------------------------------------------------
// Shared helpers (also used by dependent-token)
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const ARRAY_INDEX_RE = /^(0|[1-9][0-9]{0,5})$/;

/**
 * Value at a dot path such as "user.role" or "workspaces.0.role", or undefined.
 * A numeric segment indexes an array; only own properties are followed (so
 * "__proto__" or "constructor" never reach the prototype chain).
 */
export function getPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split(".")) {
    if (Array.isArray(cur)) {
      if (!ARRAY_INDEX_RE.test(part)) return undefined;
      cur = cur[Number(part)];
    } else if (isRecord(cur)) {
      if (!Object.hasOwn(cur, part)) return undefined;
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** A trimmed, non-empty option value, or undefined. */
export function optionValue(profile: Profile, key: string): string | undefined {
  const v = profile.options?.[key];
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

export function assertTtl(ttlMinutes: number): void {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new SignInError(`ttlMinutes must be a positive number (got ${String(ttlMinutes)})`);
  }
}

/**
 * Join an option path onto baseUrl (keeping any baseUrl path prefix). Only a
 * plain "/..." path is accepted and the result must stay on baseUrl's origin;
 * otherwise a SignInError names the option key, never its value.
 */
export function resolveOptionUrl(baseUrl: string, path: string, key: string): URL {
  if (!isSafeOptionPath(path)) {
    throw new SignInError(
      `profile option ${key} must be a path starting with "/" on the profile origin; refusing to sign in`,
    );
  }
  const base = new URL(baseUrl);
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  if (url.origin !== base.origin) {
    throw new SignInError(`profile option ${key} resolves outside the profile origin; refusing to sign in`);
  }
  return url;
}

/** fetch with redirect "manual"; network failures become a value-free SignInError. */
export async function send(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  what: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: "manual" });
  } catch (err) {
    const code =
      isRecord(err) && isRecord(err["cause"]) && typeof err["cause"]["code"] === "string"
        ? ` (${safeCode(err["cause"]["code"])})`
        : "";
    throw new SignInError(`could not reach ${what} at ${url.host}${code}`);
  }
}

export async function readJson(res: Response, what: string, host: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SignInError(`${what} at ${host} did not return JSON`, res.status);
  }
}

function safeCode(code: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : "unknown";
}

/** Cap every cookie's expiry at `expiresSec` (session cookies get it too). */
export function capCookies(cookies: SessionCookie[], expiresSec: number): SessionCookie[] {
  return cookies.map((c) => ({
    ...c,
    expires: c.expires === -1 ? expiresSec : Math.min(c.expires, expiresSec),
  }));
}

// ---------------------------------------------------------------------------
// form-post
// ---------------------------------------------------------------------------

function requiredOption(profile: Profile, key: string): string {
  const v = optionValue(profile, key);
  if (v === undefined) {
    throw new SignInError(`profile option ${key} is required for strategy form-post; refusing to sign in`);
  }
  return v;
}

/** Parse `fields`; the error never echoes the option value. */
function parseFields(raw: string): [string, string][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    throw new SignInError("profile option fields must be a JSON object of form field names to strings");
  }
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!FIELD_NAME_RE.test(k) || typeof v !== "string") {
      throw new SignInError("profile option fields must be a JSON object of form field names to strings");
    }
    entries.push([k, v]);
  }
  if (!entries.some(([, v]) => v.includes(SECRET_PLACEHOLDER))) {
    throw new SignInError(`profile option fields must contain the ${SECRET_PLACEHOLDER} placeholder`);
  }
  return entries;
}

/**
 * Replace placeholders without String.replace (whose "$&"-style patterns would
 * mangle a secret containing "$"). The secret is inserted last, so neither the
 * email nor the secret is ever re-scanned for placeholders.
 */
function fill(template: string, email: string, secret: string): string {
  return template
    .split(SECRET_PLACEHOLDER)
    .map((part) => part.split(EMAIL_PLACEHOLDER).join(email))
    .join(secret);
}

/** True when `pathname` is `prefix` or below it (segment-aware). */
function underPath(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(withSlash);
}

function withCookie(headers: Record<string, string>, jar: CookieJar, url: URL): Record<string, string> {
  const cookie = jar.headerFor(url);
  return cookie === undefined ? { ...headers } : { ...headers, Cookie: cookie };
}

function isLive(c: SessionCookie): boolean {
  return c.value !== "" && (c.expires === -1 || c.expires > Date.now() / 1000);
}

async function signIn(ctx: SignInContext): Promise<SessionArtifact> {
  const { profile, ttlMinutes } = ctx;
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  assertTtl(ttlMinutes);

  // Validate every option before any request.
  const loginUrl = resolveOptionUrl(profile.baseUrl, requiredOption(profile, "loginPath"), "loginPath");
  const fields = parseFields(requiredOption(profile, "fields"));
  const sessionCookieName = requiredOption(profile, "sessionCookieName");
  if (!COOKIE_NAME_RE.test(sessionCookieName)) {
    throw new SignInError("profile option sessionCookieName must be a valid cookie name");
  }
  const successPath = optionValue(profile, "successPath");
  // Resolved like every other option path, so a baseUrl path prefix ("/app") is honoured.
  const successPrefix =
    successPath !== undefined ? resolveOptionUrl(profile.baseUrl, successPath, "successPath").pathname : undefined;
  const mePath = optionValue(profile, "mePath");
  if (mePath !== undefined) resolveOptionUrl(profile.baseUrl, mePath, "mePath");
  const primeCookies = optionValue(profile, "primeCookies");
  if (primeCookies !== undefined && primeCookies !== "true" && primeCookies !== "false") {
    throw new SignInError('profile option primeCookies must be "true" or "false"');
  }
  const bodyFormat = optionValue(profile, "bodyFormat") ?? "form";
  if (bodyFormat !== "form" && bodyFormat !== "json") {
    throw new SignInError('profile option bodyFormat must be "form" or "json"');
  }
  const successBodyField = optionValue(profile, "successBodyField");
  if (successBodyField !== undefined && !DOT_PATH_RE.test(successBodyField)) {
    throw new SignInError("profile option successBodyField must be a dot path");
  }

  const base = new URL(profile.baseUrl);
  const host = base.host;
  const jar = new CookieJar();
  const common: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  };

  // 1. Optional priming GET (CSRF cookies and the like).
  if (primeCookies === "true") {
    const res = await send(fetchImpl, loginUrl, { method: "GET", headers: withCookie(common, jar, loginUrl) }, "login page");
    jar.addFromResponse(res, loginUrl);
    await res.body?.cancel();
    if (res.status >= 400) throw new SignInError(`login page at ${host} returned ${res.status}`, res.status);
  }

  // 2. The login POST. The secret exists only inside this body.
  let body: string;
  let postHeaders: Record<string, string>;
  if (bodyFormat === "json") {
    // Object.fromEntries defines own properties, so no field name can hit a prototype setter.
    body = JSON.stringify(
      Object.fromEntries(fields.map(([name, template]) => [name, fill(template, profile.account.email, ctx.secret)])),
    );
    postHeaders = {
      ...withCookie({ ...common, Accept: "application/json" }, jar, loginUrl),
      "Content-Type": "application/json",
      Origin: base.origin,
    };
  } else {
    const form = new URLSearchParams();
    for (const [name, template] of fields) form.append(name, fill(template, profile.account.email, ctx.secret));
    body = form.toString();
    postHeaders = { ...withCookie(common, jar, loginUrl), "Content-Type": "application/x-www-form-urlencoded" };
  }

  /** Names of cookies set (non-empty, not deleted) during the POST and its redirects. */
  const setDuringLogin = new Set<string>();
  const record = (res: Response, url: URL): void => {
    for (const c of jar.addFromResponse(res, url)) {
      if (isLive(c)) setDuringLogin.add(c.name);
      else setDuringLogin.delete(c.name);
    }
  };

  let current = loginUrl;
  let res = await send(
    fetchImpl,
    loginUrl,
    { method: "POST", headers: postHeaders, body },
    "login form",
  );
  record(res, loginUrl);

  // 3. Same-origin redirects, GET only (the secret is never re-sent).
  let redirects = 0;
  while (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (location === null) {
      throw new SignInError(`login at ${host} redirected without a Location header`, res.status);
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new SignInError(`login at ${host} redirected more than ${MAX_REDIRECTS} times`, res.status);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SignInError(`login at ${host} returned an invalid redirect`, res.status);
    }
    if (next.origin !== base.origin) {
      throw new SignInError(`login at ${host} redirected off the profile origin; refusing to follow`, res.status);
    }
    redirects += 1;
    current = next;
    res = await send(fetchImpl, next, { method: "GET", headers: withCookie(common, jar, next) }, "login redirect");
    record(res, next);
  }

  const rejected = { credentialsRejected: true } as const;
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new SignInError(`credentials rejected by ${host}`, res.status, rejected);
  }
  if (res.status >= 400) {
    await res.body?.cancel();
    throw new SignInError(`login at ${host} returned ${res.status}`, res.status);
  }
  if (successBodyField !== undefined) {
    // Presence check only: the value is session material and is dropped here.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    const marker = getPath(parsed, successBodyField);
    if (typeof marker !== "string" || marker === "") {
      throw new SignInError(
        `login response at ${host} did not include successBodyField (credentials probably rejected)`,
        res.status,
        rejected,
      );
    }
  } else {
    await res.body?.cancel();
  }
  if (successPrefix !== undefined && !underPath(current.pathname, successPrefix)) {
    throw new SignInError(
      `login at ${host} did not end under successPath (credentials probably rejected)`,
      res.status,
      rejected,
    );
  }

  // 4. The session cookie must have been set by the login itself, not just primed.
  const live = jar.all().filter(isLive);
  const sessionCookie = live.find((c) => c.name === sessionCookieName);
  if (sessionCookie === undefined || !setDuringLogin.has(sessionCookieName)) {
    throw new SignInError(
      `login at ${host} did not set the session cookie (expected ${sessionCookieName}; credentials probably rejected)`,
      res.status,
      rejected,
    );
  }

  const issuedMs = Date.now();
  let expiresMs = issuedMs + ttlMinutes * 60_000;
  if (sessionCookie.expires !== -1) expiresMs = Math.min(expiresMs, sessionCookie.expires * 1000);
  const expiresSec = Math.floor(expiresMs / 1000);

  return {
    profile: profile.name,
    strategy: "form-post",
    baseUrl: profile.baseUrl,
    cookies: capCookies(live, expiresSec),
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

async function whoami(
  artifact: SessionArtifact,
  fetchImpl: typeof fetch = globalThis.fetch,
  profile?: Profile,
): Promise<WhoAmI> {
  const mePath = profile !== undefined ? optionValue(profile, "mePath") : undefined;
  if (mePath === undefined) {
    throw new SignInError("form-post cannot verify identity without profile option mePath");
  }
  const roleField = (profile !== undefined ? optionValue(profile, "roleField") : undefined) ?? "role";
  const emailField = (profile !== undefined ? optionValue(profile, "emailField") : undefined) ?? "email";
  if (!DOT_PATH_RE.test(roleField) || !DOT_PATH_RE.test(emailField)) {
    throw new SignInError("profile options roleField / emailField must be dot paths");
  }
  const url = resolveOptionUrl(artifact.baseUrl, mePath, "mePath");
  const jar = new CookieJar();
  for (const c of artifact.cookies) jar.add(c);
  const headers = withCookie({ "User-Agent": USER_AGENT, Accept: "application/json" }, jar, url);

  const res = await send(fetchImpl, url, { method: "GET", headers }, "identity endpoint");
  if (!res.ok) {
    await res.body?.cancel();
    throw new SignInError(`identity endpoint returned ${res.status}`, res.status);
  }
  const json = await readJson(res, "identity endpoint", url.host);
  if (!isRecord(json)) {
    throw new SignInError(`identity endpoint at ${url.host} did not return an object`);
  }

  const result: WhoAmI = { raw: sanitizeIdentity(json) };
  const email = getPath(json, emailField);
  if (typeof email === "string") result.email = email;
  const name = getPath(json, "name") ?? getPath(json, "user.name");
  if (typeof name === "string") result.name = name;
  const role = getPath(json, roleField);
  if (typeof role === "string" || typeof role === "number") result.role = String(role);
  return result;
}

export const formPostStrategy: Strategy = {
  name: "form-post",
  signIn,
  whoami,
};
