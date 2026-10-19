/**
 * Raw HTTP header lines: `Cookie: <header>` (when the artifact has cookies)
 * followed by one `Name: value` line per `artifact.headers` entry, e.g. the
 * dependent-token session's `x-device-access`. Suitable for `curl -H @file` or a
 * fetch wrapper. Contains live session material.
 *
 * This is the only format that carries `artifact.headers`; cookie,
 * storage-state and curl formats can only express cookies.
 */
import type { SessionArtifact } from "../types.js";
import { toCookieHeader } from "./cookie.js";

/** RFC 9110 field-name token. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
/** Field value: visible ASCII and spaces/tabs only, so a value can never start a new line. */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_RE = /^[\t\x20-\x7e]*$/;

/** Names of the artifact's extra (non-cookie) headers, in insertion order. */
export function extraHeaderNames(artifact: SessionArtifact): string[] {
  return Object.keys(artifact.headers ?? {});
}

/**
 * Header lines for `artifact`. Throws (without echoing any value) when a name
 * or value could not be written as a single header line.
 */
export function toHeaderLines(artifact: SessionArtifact): string[] {
  const lines: string[] = [];
  if (artifact.cookies.length > 0) {
    const cookie = toCookieHeader(artifact);
    if (!HEADER_VALUE_RE.test(cookie)) throw new Error("session cookie is not representable as a header line");
    lines.push(`Cookie: ${cookie}`);
  }
  for (const [name, value] of Object.entries(artifact.headers ?? {})) {
    if (!HEADER_NAME_RE.test(name)) throw new Error("session header name is not a valid HTTP field name");
    if (typeof value !== "string" || !HEADER_VALUE_RE.test(value)) {
      throw new Error(`session header ${name} is not representable as a header line`);
    }
    lines.push(`${name}: ${value}`);
  }
  return lines;
}
