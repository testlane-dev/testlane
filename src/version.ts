import { readFileSync } from "node:fs";

/**
 * The package version, read once from package.json (one level above src/ or
 * dist/). Falls back to "0.0.0" when package.json is not there (e.g. a bundled copy).
 */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = packageVersion();
