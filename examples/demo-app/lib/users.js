/**
 * The demo's "user table": two users held in memory, no database.
 *
 * Passwords are generated per run by scripts/demo.mjs and handed to the app
 * bootstrap over stdin. They are hashed with scrypt once, at first use, and
 * only the hashes are kept here. A real app keeps its users in its database.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getRuntimeConfig } from "./runtime-config.js";

const SEED = [
  { id: "u_admin", name: "Demo Admin", email: "admin@demo.test", role: "Admin", passwordKey: "adminPassword" },
  { id: "u_qa", name: "Demo QA", email: "qa@demo.test", role: "QA", passwordKey: "qaPassword" },
];

function hashPassword(password) {
  const salt = randomBytes(16);
  return { salt, hash: scryptSync(password, salt, 32) };
}

function buildUsers() {
  const runtime = getRuntimeConfig();
  return SEED.map(({ passwordKey, ...user }) => {
    const password = runtime?.[passwordKey];
    // A user without a configured password simply cannot sign in with one.
    const credential = typeof password === "string" && password.length > 0 ? hashPassword(password) : null;
    return { ...user, active: true, credential };
  });
}

// Survive dev-mode module reloads without rehashing.
const users = (globalThis.__demoUsers ??= buildUsers());

/** Public fields only (never the credential). */
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

export function findActiveUserByEmail(email) {
  if (typeof email !== "string") return null;
  const u = users.find((x) => x.active && x.email === email.trim().toLowerCase());
  return u ? publicUser(u) : null;
}

/** Credentials check for the next-auth credentials provider. Constant-time hash compare. */
export function verifyPassword(email, password) {
  if (typeof email !== "string" || typeof password !== "string" || password.length === 0) return null;
  const u = users.find((x) => x.active && x.email === email.trim().toLowerCase());
  // Hash even for an unknown user so timing does not reveal which emails exist.
  const cred = u?.credential ?? { salt: Buffer.alloc(16), hash: Buffer.alloc(32) };
  const candidate = scryptSync(password, cred.salt, 32);
  const ok = timingSafeEqual(candidate, cred.hash) && u !== undefined && u.credential !== null;
  return ok ? publicUser(u) : null;
}
