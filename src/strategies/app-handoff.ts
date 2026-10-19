/**
 * `app-handoff` for `session` / `check`: the broker consumes its own one-time
 * handoff URL and hands out the session cookies the app set.
 *
 * `testlane handoff <profile>` gives a navigate-only browser a one-time URL.
 * Clients that can import cookies (curl, Playwright) and dependent-token
 * profiles whose `dependsOn` is a password-less, handoff-only account need a
 * session artifact instead, so for them the broker follows the same URL
 * itself. This is an explicit per-profile opt-in: without options.mePath the
 * broker refuses (the commands refuse even earlier, before the store is read),
 * so an existing app-handoff profile never silently starts handing out its
 * HttpOnly session cookie.
 *
 *   1. Every option is checked, mePath included, before anything else.
 *   2. The app's host and port must accept a TCP connection (connect and
 *      close; nothing is sent). An unreachable app (DNS failure, connection
 *      refused, timeout) fails here, before any code exists.
 *   3. Mint a code exactly as `testlane handoff` does (mintHandoffCode: the
 *      stored AGENT_HANDOFF_SECRET, HANDOFF_TTL_SECONDS, a fresh 16-byte
 *      nonce) and build the same URL (buildHandoffUrl:
 *      <baseUrl origin><handoffPath>?code=<code>).
 *   4. ctx.recordHandoff(): the broker writes the "handoff" audit row before
 *      the code leaves the process. Without the hook nothing is minted.
 *   5. GET the URL with redirect "manual". If that request gets no answer,
 *      ctx.recordHandoff({ reason: "no-answer" }) records that the code was
 *      not delivered. The route contract answers 302 + Set-Cookie; anything
 *      but a 3xx is a sign-in failure (the route answers a bare 404 for every
 *      refusal). The redirect must name a Location on the profile origin, and
 *      it is never followed.
 *   6. Capture host-only cookies only: a Set-Cookie carrying any Domain
 *      attribute (even one equal to the host) is dropped, and the jar enforces
 *      the `__Secure-` / `__Host-` prefix rules. At least one live cookie is
 *      required.
 *   7. Expiry = min(ttlMinutes, every captured cookie's expiry); every cookie
 *      is capped at it.
 *   8. GET options.mePath with the captured cookies, read options.emailField
 *      (dot path, default "email") and compare it case-insensitively with
 *      account.email. A missing or different email refuses the session before
 *      anything is returned.
 *
 * The code and URL are one-time credentials consumed here: they are never
 * returned, logged or placed in an Error (errors name the host only; `send`
 * replaces any fetch error with its own host-only message), and the app burns
 * the nonce on this request. The captured cookies are session material: they
 * go into the artifact only. The stored secret is used only to sign the code;
 * it never leaves the process.
 */
import net from "node:net";
import { CookieJar } from "../http/cookie-jar.js";
import { buildHandoffUrl, HANDOFF_SECRET_MIN_LENGTH, mintHandoffCode } from "../handoff.js";
import { SignInError, type Profile, type SessionArtifact, type SessionCookie } from "../types.js";
import { assertTtl, capCookies, getPath, isRecord, optionValue, readJson, resolveOptionUrl, send } from "./form-post.js";
import type { SignInContext, Strategy, WhoAmI } from "./index.js";
import { sanitizeIdentity, USER_AGENT } from "./nextauth-credentials.js";

const DOT_PATH_RE = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,7}$/;
const SAFE_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** How long the reachability check may take before the app counts as unreachable. */
export const HANDOFF_PROBE_TIMEOUT_MS = 10_000;

interface Config {
  mePath: string | undefined;
  emailField: string;
  roleField: string;
}

function readConfig(profile: Profile | undefined): Config {
  const opt = (key: string): string | undefined => (profile !== undefined ? optionValue(profile, key) : undefined);
  const emailField = opt("emailField") ?? "email";
  const roleField = opt("roleField") ?? "role";
  if (!DOT_PATH_RE.test(emailField) || !DOT_PATH_RE.test(roleField)) {
    throw new SignInError("profile options emailField / roleField must be dot paths");
  }
  return { mePath: opt("mePath"), emailField, roleField };
}

function isLive(c: SessionCookie): boolean {
  return c.value !== "" && (c.expires === -1 || c.expires > Date.now() / 1000);
}

/** Drop a response body we do not read; a failing cancel changes nothing. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The body is never used.
  }
}

/**
 * Open and close a TCP connection to `url`'s host and port without sending a
 * byte. Rejects with a host-only SignInError ("could not reach handoff route
 * at <host> (<code>)"), never with the URL.
 */
export function probeTcp(url: URL, timeoutMs: number = HANDOFF_PROBE_TIMEOUT_MS): Promise<void> {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (code: string | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (code === undefined) resolve();
      else reject(new SignInError(`could not reach handoff route at ${url.host} (${code})`));
    };
    socket.setTimeout(timeoutMs, () => finish("ETIMEDOUT"));
    socket.once("connect", () => finish(undefined));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(typeof err.code === "string" && SAFE_CODE_RE.test(err.code) ? err.code : "unreachable");
    });
  });
}

/** GET the identity endpoint with the artifact's cookies; value-free errors. */
async function fetchIdentity(
  artifact: SessionArtifact,
  url: URL,
  cfg: Config,
  fetchImpl: typeof fetch,
): Promise<WhoAmI> {
  const jar = new CookieJar();
  for (const c of artifact.cookies) jar.add(c);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  const cookie = jar.headerFor(url);
  if (cookie !== undefined) headers["Cookie"] = cookie;

  const res = await send(fetchImpl, url, { method: "GET", headers }, "identity endpoint");
  if (!res.ok) {
    await discard(res);
    throw new SignInError(`identity endpoint at ${url.host} returned ${res.status}`, res.status);
  }
  let json: unknown;
  try {
    json = await readJson(res, "identity endpoint", url.host);
  } catch (err) {
    if (err instanceof SignInError) throw err;
    // e.g. undici's "TypeError: terminated" when the connection drops mid-body.
    throw new SignInError(`identity endpoint at ${url.host} failed while sending its answer`, res.status);
  }
  if (!isRecord(json)) {
    throw new SignInError(`identity endpoint at ${url.host} did not return an object`);
  }
  const result: WhoAmI = { raw: sanitizeIdentity(json) };
  const email = getPath(json, cfg.emailField);
  if (typeof email === "string") result.email = email;
  const name = getPath(json, "name") ?? getPath(json, "user.name");
  if (typeof name === "string") result.name = name;
  const role = getPath(json, cfg.roleField);
  if (typeof role === "string" || typeof role === "number") result.role = String(role);
  return result;
}

async function signIn(ctx: SignInContext): Promise<SessionArtifact> {
  const { profile, ttlMinutes } = ctx;
  assertTtl(ttlMinutes);
  // Refused before anything is minted; the message never names the value or its length.
  if (typeof ctx.secret !== "string" || ctx.secret.length < HANDOFF_SECRET_MIN_LENGTH) {
    throw new SignInError(
      `stored handoff secret is shorter than ${HANDOFF_SECRET_MIN_LENGTH} characters; refusing to mint a code`,
    );
  }

  // 1. Every option before any request.
  const cfg = readConfig(profile);
  if (cfg.mePath === undefined) {
    throw new SignInError(
      "app-handoff session needs profile option mePath (the per-profile opt-in); refusing to mint a code",
    );
  }
  const meUrl = resolveOptionUrl(profile.baseUrl, cfg.mePath, "mePath");
  if (ctx.recordHandoff === undefined) {
    throw new SignInError("app-handoff needs the broker's audit hook (no recordHandoff provided); refusing to mint a code");
  }
  const recordHandoff = ctx.recordHandoff;
  const base = new URL(profile.baseUrl);
  const host = base.host;
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  // buildHandoffUrl refuses an unsafe handoffPath (PolicyError) before anything is minted.
  buildHandoffUrl(profile, "probe");

  // 2. No code is minted for an app that cannot be reached.
  await (ctx.probeOrigin ?? probeTcp)(base);

  // 3. The same code and URL `testlane handoff` would print.
  const minted = mintHandoffCode({ profileName: profile.name, secret: ctx.secret });
  const url = new URL(buildHandoffUrl(profile, minted.code));
  if (url.origin !== base.origin) {
    throw new SignInError(`handoff URL for ${profile.name} left the profile origin; refusing to send it`);
  }

  // 4. Audited before the code leaves the process; an audit failure stops here.
  await recordHandoff();

  // 5. The broker is the browser: one GET, never a followed redirect.
  let res: Response;
  try {
    res = await send(
      fetchImpl,
      url,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      },
      "handoff route",
    );
  } catch (err) {
    // No answer: the "handoff" row must not stand as a delivered code on its own.
    await recordHandoff({ reason: "no-answer" });
    throw err;
  }
  const jar = new CookieJar();
  // 6. Host-only cookies for the profile host; any Domain attribute is dropped.
  jar.addFromResponse(res, url, { hostOnly: true });
  await discard(res);
  if (res.status < 300 || res.status >= 400) {
    throw new SignInError(
      `handoff route at ${host} answered ${res.status} instead of a redirect; the app refused the code ` +
        "(route disabled, handoff secret mismatch, or unknown profile or user)",
      res.status,
    );
  }
  const location = res.headers.get("location");
  if (location === null || location.trim() === "") {
    throw new SignInError(`handoff route at ${host} redirected without a Location header`, res.status);
  }
  let next: URL;
  try {
    next = new URL(location, url);
  } catch {
    throw new SignInError(`handoff route at ${host} returned an invalid redirect`, res.status);
  }
  if (next.origin !== base.origin) {
    throw new SignInError(`handoff route at ${host} redirected off the profile origin; refusing the session`, res.status);
  }

  const live = jar.all().filter(isLive);
  if (live.length === 0) {
    throw new SignInError(
      `handoff route at ${host} redirected but set no host-only session cookie for the profile host`,
      res.status,
    );
  }

  // 7. Never beyond the TTL or any captured cookie.
  const issuedMs = Date.now();
  let expiresMs = issuedMs + ttlMinutes * 60_000;
  for (const c of live) if (c.expires !== -1) expiresMs = Math.min(expiresMs, c.expires * 1000);
  if (expiresMs <= issuedMs) {
    throw new SignInError(`handoff route at ${host} set an already expired session`, res.status);
  }
  const artifact: SessionArtifact = {
    profile: profile.name,
    strategy: "app-handoff",
    baseUrl: profile.baseUrl,
    cookies: capCookies(live, Math.floor(expiresMs / 1000)),
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };

  // 8. The app confirms whose session this is before anything is issued.
  const who = await fetchIdentity(artifact, meUrl, cfg, fetchImpl);
  const expected = profile.account.email;
  if (who.email === undefined) {
    throw new SignInError(
      `identity endpoint at ${meUrl.host} did not report an email at emailField (expected ${expected}); refusing the session`,
    );
  }
  if (who.email.toLowerCase() !== expected.toLowerCase()) {
    throw new SignInError(
      `the handoff session at ${host} belongs to another account, but the profile expects ${expected}; refusing the session`,
    );
  }
  return artifact;
}

async function whoami(
  artifact: SessionArtifact,
  fetchImpl: typeof fetch = globalThis.fetch,
  profile?: Profile,
): Promise<WhoAmI> {
  const cfg = readConfig(profile);
  if (cfg.mePath === undefined) {
    throw new SignInError("app-handoff cannot confirm the identity without profile option mePath");
  }
  const url = resolveOptionUrl(artifact.baseUrl, cfg.mePath, "mePath");
  return fetchIdentity(artifact, url, cfg, fetchImpl);
}

export const appHandoffStrategy: Strategy = {
  name: "app-handoff",
  signIn,
  whoami,
};
