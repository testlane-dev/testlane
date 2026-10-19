/**
 * Policy engine: decides whether the broker may issue a session for a profile.
 *
 * Production profiles are refused unconditionally. There is deliberately no
 * override flag, environment variable or interactive bypass anywhere here.
 */
import { PolicyError, type Profile } from "./types.js";

/** Global ceiling on any issued session, regardless of profile settings. */
export const MAX_TTL_MINUTES = 480;

export interface PolicyContext {
  interactive: boolean;
  requestedTtlMinutes?: number;
  targetUrl?: string;
  /**
   * Hostnames (hostnameOf form: no port, no trailing dot) of every production
   * profile in the registry (see productionHosts() in profiles.ts). A session
   * whose baseUrl or target hostname is in this set is refused as
   * "production-refused", whatever the profile's own environment tag says.
   */
  productionHosts?: ReadonlySet<string>;
}

export interface PolicyDecision {
  ttlMinutes: number;
  host: string;
}

/**
 * `hostname[:port]` of a URL, lowercase, with the port included only when it
 * is not the scheme's default (WHATWG URL already drops default ports).
 * IPv6 literals keep their brackets, e.g. "[::1]:3000".
 *
 * @throws TypeError when `url` is not an absolute URL.
 */
export function hostOf(url: string): string {
  const u = new URL(url);
  // A trailing dot (fully-qualified form) names the same host.
  const hostname = u.hostname.toLowerCase().replace(/\.+$/, "");
  return u.port !== "" ? `${hostname}:${u.port}` : hostname;
}

/** `hostname[:port]` where the hostname is a bracketed IPv6 literal or has no ":" (a loose shape; the URL parser decides). */
const HOST_ENTRY_RE = /^(\[[^\]]*\]|[^\s:/?#@\\[\]]+)(?::([0-9]{1,5}))?$/;

/**
 * Canonical `hostname[:port]` of an allowedHosts entry, or null when the entry
 * is not a plain host name or IP literal (with an optional port) that the
 * WHATWG URL parser accepts. The hostname goes through the same parser that
 * normalises a baseUrl or target in hostOf(), so every spelling of one host
 * (IPv6 compression or expansion, IPv4-mapped IPv6, short or decimal IPv4
 * such as `127.1`, case) becomes one string; a trailing dot is dropped, as in
 * hostOf(). The port is kept as written (decimal, no leading zeros).
 */
export function canonicalHostEntry(entry: string): string | null {
  const m = HOST_ENTRY_RE.exec(entry);
  if (m === null) return null;
  let hostname: string;
  try {
    hostname = new URL(`http://${m[1] ?? ""}`).hostname.replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (hostname === "") return null;
  if (m[2] === undefined) return hostname;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? `${hostname}:${port}` : null;
}

/** An IPv4-mapped IPv6 literal as the URL parser serialises it: `[::ffff:a00:5]`. */
const IPV4_MAPPED_RE = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/**
 * The hostname part of a hostOf() value or "host:port" string, in canonical
 * form (see canonicalHostEntry) with any port and trailing dot removed.
 * Production hosts are compared by hostname only, so a different port, case or
 * spelling (`[::ffff:10.0.0.5]`, `[2001:db8:0:0::1]`, `127.1`) cannot be used
 * to sidestep the denylist. An IPv4-mapped IPv6 literal is folded onto the
 * IPv4 address it reaches, so it cannot hide a production IPv4 host either.
 */
export function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const canonical = canonicalHostEntry(trimmed) ?? trimmed;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(canonical);
  const hostname = (m?.[1] ?? canonical).replace(/\.+$/, "");
  const mapped = IPV4_MAPPED_RE.exec(hostname);
  if (mapped === null) return hostname;
  const high = Number.parseInt(mapped[1] ?? "0", 16);
  const low = Number.parseInt(mapped[2] ?? "0", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True when `host` (as produced by hostOf) is baseUrl's host or listed in allowedHosts. */
export function isAllowedHost(profile: Profile, host: string): boolean {
  const wanted = canonicalHostEntry(host) ?? host.toLowerCase();
  let base: string;
  try {
    base = hostOf(profile.baseUrl);
  } catch {
    return false;
  }
  if (wanted === base) return true;
  return (profile.allowedHosts ?? []).some((h) => canonicalHostEntry(h) === wanted);
}

/**
 * Hosts that may be reached over plain http: `localhost` itself and the
 * loopback IP literals 127.0.0.1 and ::1 (WHATWG URL already turns `127.1`
 * into 127.0.0.1). A `*.localhost` subdomain is NOT exempt: Node resolves it
 * through getaddrinfo, which can fall through to DNS, so a password could
 * travel in cleartext to a host that is not on this machine.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** Refusal text for plain http to `hostname`; names the way out, and the *.localhost case explicitly. */
function insecureTransportMessage(subject: string, hostname: string): string {
  if (hostname.toLowerCase().endsWith(".localhost")) {
    return (
      `${subject} must use https: plain http to a *.localhost name is refused because the system resolver, ` +
      "not the loopback interface, decides where it goes. Use https, or http://localhost:<port> / http://127.0.0.1:<port>."
    );
  }
  return `${subject} must use https (plain http is only allowed for localhost / loopback).`;
}

/**
 * Check a request against policy. Rules, in order:
 *  1. environment "production" is always refused (no override exists).
 *  2. baseUrl must be https unless it points at a loopback host.
 *     baseUrl's host must not be a production host (ctx.productionHosts).
 *  3. ctx.targetUrl, when given, must be http(s), not a production host, on
 *     baseUrl's host or an allowedHosts entry, and https unless loopback.
 *  4. TTL: a profile TTL of 0 issues nothing. The limit is
 *     min(profile TTL, MAX_TTL_MINUTES); a request above the limit is refused
 *     (never silently capped). Without a request the limit is issued.
 */
export function assertAllowed(profile: Profile, ctx: PolicyContext): PolicyDecision {
  // (1) Production: unconditional. Deliberately ignores ctx.interactive and the environment.
  if (profile.environment === "production") {
    throw new PolicyError(
      `Profile "${profile.name}" is tagged environment "production" and is always refused. ` +
        "Testlane never issues production sessions; there is no override flag, " +
        "environment variable or interactive bypass, by design.",
      "production-refused",
    );
  }

  // (2) Transport.
  let base: URL;
  try {
    base = new URL(profile.baseUrl);
  } catch {
    throw new PolicyError(
      `Profile "${profile.name}" has an invalid baseUrl.`,
      "invalid-profile",
    );
  }
  const baseHost = hostOf(profile.baseUrl);
  const refuseProductionHost = (host: string, what: string): void => {
    if (ctx.productionHosts?.has(hostnameOf(host)) === true) {
      throw new PolicyError(
        `${what} host "${host}" of profile "${profile.name}" belongs to a production profile and is always refused. ` +
          "There is no override flag, environment variable or interactive bypass, by design.",
        "production-refused",
      );
    }
  };
  // Production hosts are refused before any other check, like the environment tag.
  refuseProductionHost(baseHost, "baseUrl");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHostname(base.hostname))) {
    throw new PolicyError(
      insecureTransportMessage(`Profile "${profile.name}" baseUrl`, base.hostname),
      "insecure-transport",
    );
  }

  // (3) Target host allowlist.
  if (ctx.targetUrl !== undefined) {
    let target: URL;
    try {
      target = new URL(ctx.targetUrl);
    } catch {
      throw new PolicyError(
        `Target URL for profile "${profile.name}" is not a valid absolute URL.`,
        "host-not-allowed",
      );
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new PolicyError(
        `Target URL for profile "${profile.name}" must use http or https.`,
        "host-not-allowed",
      );
    }
    const targetHost = hostOf(ctx.targetUrl);
    refuseProductionHost(targetHost, "Target");
    if (!isAllowedHost(profile, targetHost)) {
      const allowed = [baseHost, ...(profile.allowedHosts ?? [])].join(", ");
      throw new PolicyError(
        `Host "${targetHost}" is not allowed for profile "${profile.name}". Allowed: ${allowed}`,
        "host-not-allowed",
      );
    }
    if (target.protocol === "http:" && !isLoopbackHostname(target.hostname)) {
      throw new PolicyError(
        insecureTransportMessage(`Target URL for profile "${profile.name}"`, target.hostname),
        "insecure-transport",
      );
    }
  }

  // (4) TTL.
  const profileTtl = profile.session.ttlMinutes;
  if (profileTtl === 0) {
    throw new PolicyError(
      `Profile "${profile.name}" has session.ttlMinutes 0 and issues no sessions.`,
      "ttl-exceeded",
    );
  }
  const limit = Math.min(profileTtl, MAX_TTL_MINUTES);
  const requested = ctx.requestedTtlMinutes;
  if (requested === undefined) return { ttlMinutes: limit, host: baseHost };
  if (!Number.isInteger(requested) || requested < 1) {
    throw new PolicyError(
      `Requested TTL must be a positive whole number of minutes (got ${String(requested)}).`,
      "ttl-exceeded",
    );
  }
  if (requested > limit) {
    const why =
      limit < profileTtl
        ? `the global maximum of ${MAX_TTL_MINUTES} min`
        : `profile "${profile.name}" limit of ${profileTtl} min`;
    throw new PolicyError(`Requested TTL ${requested} min exceeds ${why}.`, "ttl-exceeded");
  }
  return { ttlMinutes: requested, host: baseHost };
}
