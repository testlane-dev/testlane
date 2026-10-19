/** Cookie-header output: "name=value; name2=value2". Contains live session material. */
import type { SessionArtifact } from "../types.js";

export function toCookieHeader(artifact: SessionArtifact): string {
  return artifact.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
