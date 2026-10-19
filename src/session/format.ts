/** Session output formats shared by the CLI, MCP server and HTTP surface. */
import type { SessionArtifact } from "../types.js";
import { toCookieHeader } from "./cookie.js";
import { toCurlJar } from "./curl-jar.js";
import { toHeaderLines } from "./headers.js";
import { toSessionJson } from "./json.js";
import { toStorageState } from "./storage-state.js";

export const SESSION_FORMATS = ["cookie", "storage-state", "curl", "headers", "json"] as const;
export type SessionFormat = (typeof SESSION_FORMATS)[number];

/** Formats that can carry only cookies (artifact.headers are dropped). */
export const COOKIE_ONLY_FORMATS: readonly SessionFormat[] = ["cookie", "storage-state", "curl"];

export function isSessionFormat(value: string): value is SessionFormat {
  return (SESSION_FORMATS as readonly string[]).includes(value);
}

export function formatSession(artifact: SessionArtifact, format: SessionFormat): string {
  switch (format) {
    case "cookie":
      return toCookieHeader(artifact);
    case "storage-state":
      return JSON.stringify(toStorageState(artifact), null, 2);
    case "curl":
      return toCurlJar(artifact);
    case "headers":
      return toHeaderLines(artifact).join("\n");
    case "json":
      return JSON.stringify(toSessionJson(artifact), null, 2);
    default: {
      const never: never = format;
      throw new Error(`Unknown session format "${String(never)}"`);
    }
  }
}
