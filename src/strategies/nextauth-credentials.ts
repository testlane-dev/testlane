/**
 * `nextauth-credentials` strategy (next-auth v4, credentials provider).
 *
 * Flow:
 *   1. GET  <csrfPath>      -> { csrfToken } + csrf cookie
 *   2. POST <callbackPath>  form: csrfToken, <emailField>, <passwordField>, json=true, callbackUrl
 *        200 { url }  or  302 Location   (url carries ?error=... on failure)
 *   3. capture the session cookie (next-auth.session-token / __Secure-next-auth.session-token)
 *
 * The secret is used only to build the POST body. It is never logged, never
 * placed in an Error, and never copied into the artifact.
 *
 * Profile options (all optional, non-secret; schema in ./options.ts):
 *   csrfPath, callbackPath, sessionPath (paths on the baseUrl origin, "/..."),
 *   sessionCookieName, emailField, passwordField,
 *   roleField (dot path into the session JSON, default "user.role"),
 *   and the strategy-agnostic rotate* options used by `testlane rotate` /
 *   `status` (rotatePath, rotateMethod, rotateBodyFormat, rotateBody,
 *   rotateVia, rotateEveryDays; see rotateProfile in src/commands.ts).
 *
 * A refused password (401/403, or error=CredentialsSignin) is a SignInError
 * with credentialsRejected = true, which lets the broker try a pending rotated
 * secret once (src/commands.ts).
 *
 * TTL note: ttlMinutes bounds the artifact's expiresAt / cookie expiry that the
 * broker hands out, but it is advisory towards the server: the next-auth JWT
 * keeps its own maxAge until the Phase-2 handoff route enforces TTL server-side.
 */
import { CookieJar } from "../http/cookie-jar.js";
import { SignInError, type Profile, type SessionArtifact, type SessionCookie } from "../types.js";
import type { SignInContext, Strategy, WhoAmI } from "./index.js";
import { isSafeOptionPath } from "./options.js";
import { VERSION } from "../version.js";

/** User-Agent sent to apps by every strategy. */
export const USER_AGENT = `testlane/${VERSION}`;

const DEFAULTS = {
  csrfPath: "/api/auth/csrf",
  callbackPath: "/api/auth/callback/credentials",
  sessionPath: "/api/auth/session",
  emailField: "email",
  passwordField: "password",
  roleField: "user.role",
} as const;

const AUTO_SESSION_COOKIE_NAMES = ["__Secure-next-auth.session-token", "next-auth.session-token"];
const DEFAULT_SESSION_COOKIE_NAME = "next-auth.session-token";

const SENSITIVE_KEY_RE = /token|secret|password|cookie/i;

/** Deep-copy `value`, dropping any object key that looks like credential material. */
export function sanitizeIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEY_RE.test(k)) continue;
        out[k] = clean(inner);
      }
      return out;
    }
    return v;
  };
  return clean(value) as Record<string, unknown>;
}

function opt(profile: Profile, key: keyof typeof DEFAULTS): string {
  const v = profile.options?.[key];
  return v !== undefined && v.trim() !== "" ? v : DEFAULTS[key];
}

/**
 * Join an option path onto baseUrl, preserving any path prefix in baseUrl.
 *
 * Only a plain path starting with "/" is accepted (see isSafeOptionPath);
 * absolute URLs, protocol-relative "//host" and anything else are refused with
 * a SignInError, and the result must stay on baseUrl's origin. Profile loading
 * already enforces this; the re-check here means a profile object built any
 * other way still cannot redirect the secret. The option value is not echoed.
 */
function resolveUrl(baseUrl: string, path: string, key: string): URL {
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function getPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Only short, code-like error values from the server are echoed back. */
function safeErrorCode(code: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : "unknown";
}

async function send(
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
        ? ` (${err["cause"]["code"]})`
        : "";
    throw new SignInError(`could not reach ${what} at ${url.host}${code}`);
  }
}

async function readJson(res: Response, what: string, host: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SignInError(`${what} at ${host} did not return JSON`, res.status);
  }
}

function pickSessionCookies(
  fromCallback: SessionCookie[],
  configuredName: string | undefined,
): SessionCookie | undefined {
  const live = fromCallback.filter(
    (c) => c.value !== "" && (c.expires === -1 || c.expires > Date.now() / 1000),
  );
  const names = configuredName !== undefined ? [configuredName] : AUTO_SESSION_COOKIE_NAMES;
  for (const name of names) {
    const found = live.find((c) => c.name === name);
    if (found) return found;
  }
  return undefined;
}

async function signIn(ctx: SignInContext): Promise<SessionArtifact> {
  const { profile, ttlMinutes } = ctx;
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new SignInError(`ttlMinutes must be a positive number (got ${String(ttlMinutes)})`);
  }

  const baseUrl = new URL(profile.baseUrl);
  const host = baseUrl.host;
  const jar = new CookieJar();
  const commonHeaders = { "User-Agent": USER_AGENT, Accept: "application/json" };

  // Resolve every endpoint up front so a bad option refuses before any request.
  const csrfUrl = resolveUrl(profile.baseUrl, opt(profile, "csrfPath"), "csrfPath");
  const callbackUrl = resolveUrl(profile.baseUrl, opt(profile, "callbackPath"), "callbackPath");
  resolveUrl(profile.baseUrl, opt(profile, "sessionPath"), "sessionPath");

  // 1. CSRF token + cookie.
  const csrfRes = await send(fetchImpl, csrfUrl, { method: "GET", headers: commonHeaders }, "CSRF endpoint");
  jar.addFromResponse(csrfRes, csrfUrl);
  if (!csrfRes.ok) {
    await csrfRes.body?.cancel();
    throw new SignInError(`CSRF endpoint returned ${csrfRes.status}`, csrfRes.status);
  }
  const csrfJson = await readJson(csrfRes, "CSRF endpoint", host);
  const csrfToken = isRecord(csrfJson) ? csrfJson["csrfToken"] : undefined;
  if (typeof csrfToken !== "string" || csrfToken === "") {
    throw new SignInError(`CSRF endpoint at ${host} did not return a csrfToken`);
  }

  // 2. Credentials callback. The secret exists only inside this body.
  const body = new URLSearchParams();
  body.set("csrfToken", csrfToken);
  body.set(opt(profile, "emailField"), profile.account.email);
  body.set(opt(profile, "passwordField"), ctx.secret);
  body.set("json", "true");
  body.set("callbackUrl", profile.baseUrl);

  const headers: Record<string, string> = {
    ...commonHeaders,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const cookieHeader = jar.headerFor(callbackUrl);
  if (cookieHeader !== undefined) headers["Cookie"] = cookieHeader;

  const cbRes = await send(
    fetchImpl,
    callbackUrl,
    { method: "POST", headers, body: body.toString() },
    "credentials callback",
  );
  const cbCookies = jar.addFromResponse(cbRes, callbackUrl);

  let target: string | undefined;
  if (cbRes.status >= 300 && cbRes.status < 400) {
    await cbRes.body?.cancel();
    target = cbRes.headers.get("location") ?? undefined;
  } else if (cbRes.status === 200) {
    const json = await readJson(cbRes, "credentials callback", host);
    const url = isRecord(json) ? json["url"] : undefined;
    if (typeof url === "string") target = url;
  } else {
    await cbRes.body?.cancel();
    if (cbRes.status === 401 || cbRes.status === 403) {
      throw new SignInError(`credentials rejected by ${host}`, cbRes.status, { credentialsRejected: true });
    }
    throw new SignInError(`credentials callback at ${host} returned ${cbRes.status}`, cbRes.status);
  }

  if (target !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(target, baseUrl);
    } catch {
      parsed = undefined;
    }
    const error = parsed?.searchParams.get("error");
    if (error !== null && error !== undefined) {
      if (error === "CredentialsSignin") {
        throw new SignInError(`credentials rejected by ${host}`, cbRes.status, { credentialsRejected: true });
      }
      throw new SignInError(`sign-in failed at ${host}: ${safeErrorCode(error)}`, cbRes.status);
    }
  }

  // 3. Session cookie.
  const configuredName = profile.options?.["sessionCookieName"];
  const sessionCookie = pickSessionCookies(
    cbCookies,
    configuredName !== undefined && configuredName.trim() !== "" ? configuredName : undefined,
  );
  if (!sessionCookie) {
    const expected = configuredName ?? DEFAULT_SESSION_COOKIE_NAME;
    throw new SignInError(
      `sign-in succeeded but no session cookie was set (expected ${expected})`,
      cbRes.status,
    );
  }

  const issuedMs = Date.now();
  let expiresMs = issuedMs + ttlMinutes * 60_000;
  if (sessionCookie.expires !== -1) expiresMs = Math.min(expiresMs, sessionCookie.expires * 1000);

  return {
    profile: profile.name,
    strategy: "nextauth-credentials",
    baseUrl: profile.baseUrl,
    cookies: [{ ...sessionCookie, expires: Math.floor(expiresMs / 1000) }],
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

async function whoami(
  artifact: SessionArtifact,
  fetchImpl: typeof fetch = globalThis.fetch,
  profile?: Profile,
): Promise<WhoAmI> {
  const sessionPath = profile ? opt(profile, "sessionPath") : DEFAULTS.sessionPath;
  const roleField = profile ? opt(profile, "roleField") : DEFAULTS.roleField;
  const url = resolveUrl(artifact.baseUrl, sessionPath, "sessionPath");
  const cookie = artifact.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const res = await send(
    fetchImpl,
    url,
    { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "application/json", Cookie: cookie } },
    "session endpoint",
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new SignInError(`session endpoint returned ${res.status}`, res.status);
  }
  const json = await readJson(res, "session endpoint", url.host);
  const user = isRecord(json) ? json["user"] : undefined;
  if (!isRecord(user)) {
    throw new SignInError(`session endpoint at ${url.host} returned no user (session not valid)`);
  }

  const result: WhoAmI = { raw: sanitizeIdentity(user) };
  if (typeof user["email"] === "string") result.email = user["email"];
  if (typeof user["name"] === "string") result.name = user["name"];
  const role = getPath(json, roleField);
  if (typeof role === "string" || typeof role === "number") result.role = String(role);
  return result;
}

export const nextAuthCredentialsStrategy: Strategy = {
  name: "nextauth-credentials",
  signIn,
  whoami,
};
