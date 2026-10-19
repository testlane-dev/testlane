/**
 * Resolve a handoff profile name to its registry entry.
 *
 * A real app reads its own committed `testlane.profiles.json`. The demo's
 * registry is generated per run (the port may change), so scripts/demo.mjs
 * passes its absolute path as DEMO_PROFILES_FILE. The file holds no secrets.
 */
import { readFile } from "node:fs/promises";

/**
 * The entry for `profileName` when it may be used for a handoff: it exists,
 * uses strategy "app-handoff", is not tagged "production" and names an
 * account email. Otherwise null.
 */
export async function handoffProfile(profileName) {
  const file = process.env.DEMO_PROFILES_FILE;
  if (!file) return null;
  let registry;
  try {
    registry = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  const profiles = registry?.profiles;
  if (profiles === null || typeof profiles !== "object" || !Object.hasOwn(profiles, profileName)) return null;
  const entry = profiles[profileName];
  if (entry?.strategy !== "app-handoff") return null;
  if (entry.environment === "production") return null;
  if (typeof entry.account?.email !== "string" || entry.account.email === "") return null;
  const ttlMinutes = entry.session?.ttlMinutes;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) return null;
  return { name: profileName, email: entry.account.email, ttlMinutes };
}
