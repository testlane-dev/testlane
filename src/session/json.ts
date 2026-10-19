/**
 * `json` session format: a machine-readable object carrying the same header
 * set as `--format headers` (Cookie, when the artifact has cookies, plus any
 * extra headers such as `x-device-access`, in the same order), plus metadata
 * mirroring the MCP `session` tool's `structuredContent` (`profile`, `format`,
 * `expiresAt`, `droppedHeaders`).
 *
 * Built from `toHeaderLines` so the two formats can never carry a different
 * header set, or accept a header name/value the other would refuse: the same
 * RFC 9110 field-name and printable-ASCII checks apply, and the same error is
 * thrown (without echoing the value) when a header cannot be represented.
 *
 * `droppedHeaders` is always empty here: unlike the cookie-only formats
 * (`cookie`, `storage-state`, `curl`), `json` — like `headers` — carries every
 * artifact header. The field is still present so a caller that branches on
 * `droppedHeaders` needs no special case per format.
 */
import type { SessionArtifact } from "../types.js";
import { toHeaderLines } from "./headers.js";

export interface SessionJson {
  profile: string;
  format: "json";
  /** ISO timestamp after which the artifact should be considered dead. */
  expiresAt: string;
  /** `Cookie` (when present) plus any extra headers, in the same order as `--format headers`. */
  headers: Record<string, string>;
  /** Header names this format could not carry. Always empty for `json`. */
  droppedHeaders: string[];
}

/** Throws the same (safe, value-free) errors as `toHeaderLines` for an unrepresentable header. */
export function toSessionJson(artifact: SessionArtifact): SessionJson {
  const headers: Record<string, string> = {};
  for (const line of toHeaderLines(artifact)) {
    const sep = line.indexOf(": ");
    headers[line.slice(0, sep)] = line.slice(sep + 2);
  }
  return {
    profile: artifact.profile,
    format: "json",
    expiresAt: artifact.expiresAt,
    headers,
    droppedHeaders: [],
  };
}
