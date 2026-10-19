/**
 * Tiny in-memory cookie jar used by login strategies.
 *
 * Deliberately small: enough RFC 6265 behaviour (domain/path/secure matching,
 * Max-Age over Expires) to carry CSRF and session cookies through a scripted
 * sign-in. Cookie values are session material; nothing here logs them.
 */
import { isIP } from "node:net";
import type { SessionCookie } from "../types.js";

/** C0 controls (including tab) and DEL. C1 controls are a documented known limit. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Loopback hosts count as a secure context (as in browsers), so Secure cookies
 * set by a local dev server over plain http still round-trip. A `*.localhost`
 * subdomain does not: the system resolver (getaddrinfo, possibly DNS) decides
 * where it goes, and policy refuses plain http to it as well (src/policy.ts).
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function isSecureContext(url: URL): boolean {
  return url.protocol === "https:" || isLoopbackHost(url.hostname);
}

function parseSameSite(value: string): SessionCookie["sameSite"] {
  switch (value.trim().toLowerCase()) {
    case "strict":
      return "Strict";
    case "none":
      return "None";
    default:
      return "Lax";
  }
}

/** Path and Domain end up in the curl jar's tab-separated lines and in storageState: no control characters. */
function assertNoControlChars(attributeValue: string): void {
  if (CONTROL_CHAR_RE.test(attributeValue)) {
    throw new Error("invalid Set-Cookie header: cookie Path or Domain contains control characters");
  }
}

/**
 * Parse one Set-Cookie header value.
 *
 * - `expires` is unix seconds, or -1 for a session cookie. Max-Age wins over Expires.
 * - `domain` is the request hostname for host-only cookies, or "." + the Domain
 *   attribute (leading dot stripped first) for domain cookies.
 * - `path` defaults to "/"; `sameSite` defaults to "Lax".
 * - Cookie name prefixes are enforced as browsers do (RFC 6265bis, prefix
 *   matched case-insensitively): a `__Secure-` cookie must carry Secure; a
 *   `__Host-` cookie must carry Secure, no Domain attribute and `Path=/`.
 *
 * Throws (with a value-free message) when the header has no cookie name, when
 * the name, value, Path or Domain contains a control character or tab, or when
 * a prefix rule is broken; callers such as CookieJar.addFromResponse then
 * ignore the cookie.
 */
export function parseSetCookie(header: string, requestUrl: URL): SessionCookie {
  const [pair = "", ...attrs] = header.split(";");
  const eq = pair.indexOf("=");
  const name = (eq === -1 ? "" : pair.slice(0, eq)).trim();
  const value = (eq === -1 ? pair : pair.slice(eq + 1)).trim();
  if (name === "") throw new Error("invalid Set-Cookie header: missing cookie name");
  // Tabs/newlines would corrupt the curl jar (tab-separated) and header formats.
  if (CONTROL_CHAR_RE.test(name) || CONTROL_CHAR_RE.test(value)) {
    throw new Error("invalid Set-Cookie header: cookie name or value contains control characters");
  }

  let domain: string | undefined;
  let hasDomainAttr = false;
  let path: string | undefined;
  let expiresAttr: number | undefined;
  let maxAge: number | undefined;
  let httpOnly = false;
  let secure = false;
  let sameSite: SessionCookie["sameSite"] = "Lax";

  for (const raw of attrs) {
    const i = raw.indexOf("=");
    const key = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? "" : raw.slice(i + 1).trim();
    switch (key) {
      case "domain": {
        hasDomainAttr = true;
        assertNoControlChars(val);
        const d = val.replace(/^\.+/, "").toLowerCase();
        if (d !== "") domain = d;
        break;
      }
      case "path":
        assertNoControlChars(val);
        if (val.startsWith("/")) path = val;
        break;
      case "expires": {
        const ms = Date.parse(val);
        if (!Number.isNaN(ms)) expiresAttr = Math.floor(ms / 1000);
        break;
      }
      case "max-age":
        if (/^-?\d+$/.test(val)) maxAge = Number.parseInt(val, 10);
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "secure":
        secure = true;
        break;
      case "samesite":
        sameSite = parseSameSite(val);
        break;
      default:
        break;
    }
  }

  const lowerName = name.toLowerCase();
  if (lowerName.startsWith("__secure-") && !secure) {
    throw new Error("invalid Set-Cookie header: a __Secure- cookie must be Secure");
  }
  if (lowerName.startsWith("__host-") && (!secure || hasDomainAttr || path !== "/")) {
    throw new Error("invalid Set-Cookie header: a __Host- cookie must be Secure, without Domain, with Path=/");
  }

  let expires = -1;
  if (maxAge !== undefined) {
    // Max-Age <= 0 means "delete now"; 1 (the epoch + 1s) is unambiguously in the past.
    expires = maxAge <= 0 ? 1 : nowSeconds() + maxAge;
  } else if (expiresAttr !== undefined) {
    expires = Math.max(expiresAttr, 1);
  }

  return {
    name,
    value,
    domain: domain !== undefined ? `.${domain}` : requestUrl.hostname.toLowerCase(),
    path: path ?? "/",
    expires,
    httpOnly,
    secure,
    sameSite,
  };
}

/**
 * True when a Set-Cookie header carries a Domain attribute at all (any value,
 * even empty or equal to the host). Used for host-only capture.
 */
export function hasDomainAttribute(header: string): boolean {
  return header
    .split(";")
    .slice(1)
    .some((attr) => {
      const i = attr.indexOf("=");
      return (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase() === "domain";
    });
}

/** True when `hostname` may receive a cookie stored with `cookieDomain`. */
export function domainMatches(cookieDomain: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (cookieDomain.startsWith(".")) {
    const base = cookieDomain.slice(1);
    if (host === base) return true;
    // RFC 6265 suffix matching applies to hostnames, never IP-address literals.
    const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return isIP(address) === 0 && host.endsWith(`.${base}`);
  }
  return host === cookieDomain;
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

function isExpired(cookie: SessionCookie, now = nowSeconds()): boolean {
  return cookie.expires !== -1 && cookie.expires <= now;
}

export class CookieJar {
  private readonly cookies = new Map<string, SessionCookie>();

  private static key(c: SessionCookie): string {
    return `${c.domain}\u0000${c.path}\u0000${c.name}`;
  }

  /** Store (or replace) a cookie; an already-expired cookie deletes its match. */
  add(cookie: SessionCookie): void {
    const key = CookieJar.key(cookie);
    if (isExpired(cookie)) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, { ...cookie });
  }

  /**
   * Record every Set-Cookie on `res`. Malformed headers (including names or
   * values with control characters / tabs, and broken `__Secure-` / `__Host-`
   * prefix rules) and cookies whose Domain attribute does not match the request
   * host are skipped. With `hostOnly`, every cookie that carries a Domain
   * attribute at all (even one equal to the host) is skipped too.
   * Returns the cookies parsed from this response (including deletions).
   */
  addFromResponse(res: Response, url: URL, opts: { hostOnly?: boolean } = {}): SessionCookie[] {
    const parsed: SessionCookie[] = [];
    for (const header of res.headers.getSetCookie()) {
      if (opts.hostOnly === true && hasDomainAttribute(header)) continue;
      let cookie: SessionCookie;
      try {
        cookie = parseSetCookie(header, url);
      } catch {
        continue;
      }
      if (!domainMatches(cookie.domain, url.hostname)) continue;
      if (cookie.secure && !isSecureContext(url)) continue;
      this.add(cookie);
      parsed.push(cookie);
    }
    return parsed;
  }

  /** The Cookie header value for a request to `url`, or undefined when nothing applies. */
  headerFor(url: URL): string | undefined {
    const now = nowSeconds();
    const secureOk = isSecureContext(url);
    const matching = [...this.cookies.values()]
      .filter(
        (c) =>
          !isExpired(c, now) &&
          domainMatches(c.domain, url.hostname) &&
          pathMatches(c.path, url.pathname || "/") &&
          (!c.secure || secureOk),
      )
      .sort((a, b) => b.path.length - a.path.length);
    if (matching.length === 0) return undefined;
    return matching.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Copies of all live cookies. */
  all(): SessionCookie[] {
    const now = nowSeconds();
    return [...this.cookies.values()].filter((c) => !isExpired(c, now)).map((c) => ({ ...c }));
  }
}
