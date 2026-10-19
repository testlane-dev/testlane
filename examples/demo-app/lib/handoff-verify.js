/**
 * mirrors src/handoff.ts verifyHandoffCode
 *
 * A copy of the broker's reference verifier (and MemoryNonceStore), kept
 * dependency-free apart from node:crypto so an app can paste it. The demo app
 * is a separate project and deliberately does not import from the broker's
 * src/. If you change the code format in src/handoff.ts, change this file too.
 *
 * Code format:
 *   payload = `${profileName}.${nonce}.${expiresAtUnixSeconds}`   (nonce: 16 random bytes, base64url)
 *   code    = base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload))
 *
 * Order: shape -> signature (constant time, before the payload is interpreted)
 * -> payload fields -> expiry -> single-use nonce. Never throws for a bad code;
 * throws only for a missing or too-short secret (misconfiguration).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const HANDOFF_TTL_SECONDS = 60;
export const HANDOFF_MAX_CLOCK_SKEW_SECONDS = 30;
export const HANDOFF_SECRET_MIN_LENGTH = 32;

/** Same as the broker's PROFILE_NAME_RE (src/types.ts). */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$/;

const SIGNATURE_BYTES = 32;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const EXPIRY_RE = /^[1-9][0-9]{0,11}$/;
const MAX_CODE_LENGTH = 1024;

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < HANDOFF_SECRET_MIN_LENGTH) {
    throw new Error(
      `handoff secret must be a non-empty string of at least ${HANDOFF_SECRET_MIN_LENGTH} characters (misconfigured AGENT_HANDOFF_SECRET)`,
    );
  }
}

function sign(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Strict base64url: alphabet only, no padding, and canonical (re-encodes to itself). */
function decodeB64url(s) {
  if (!B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

/**
 * Process-local nonce store (mirrors MemoryNonceStore). `consume` resolves true
 * exactly once per nonce. Entries are pruned once their code has expired.
 *
 * DEMO ONLY: a real app must persist nonces so a replay is refused across
 * restarts and across every instance (serverless functions, multiple pods),
 * e.g. an `AgentHandoffNonce` table with `nonce` as the primary key, where a
 * unique-constraint violation on insert means "replayed".
 */
export class MemoryNonceStore {
  #seen = new Map();
  #now;

  constructor(opts = {}) {
    this.#now = opts.now ?? (() => new Date());
  }

  async consume(nonce, expiresAt) {
    const nowMs = this.#now().getTime();
    for (const [n, exp] of this.#seen) if (exp <= nowMs) this.#seen.delete(n);
    if (this.#seen.has(nonce)) return false;
    // Keep the entry at least until the code expires, so it cannot be replayed within its life.
    this.#seen.set(nonce, Math.max(expiresAt.getTime(), nowMs + 1));
    return true;
  }

  get size() {
    return this.#seen.size;
  }
}

/**
 * @returns {Promise<{ok: true, profileName: string, nonce: string, expiresAt: Date} | {ok: false, reason: "malformed"|"bad-signature"|"expired"|"replayed"}>}
 */
export async function verifyHandoffCode({ code, secret, now, nonceStore }) {
  assertSecret(secret);
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = code.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const payload = decodeB64url(parts[0] ?? "");
  const signature = decodeB64url(parts[1] ?? "");
  if (payload === null || signature === null || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "malformed" };
  }

  // (1) Signature, constant time on equal-length buffers.
  const expected = sign(secret, payload);
  if (!timingSafeEqual(expected, signature)) return { ok: false, reason: "bad-signature" };

  // (2) Payload fields (only reached for a code the secret holder signed).
  const text = payload.toString("utf8");
  const lastDot = text.lastIndexOf(".");
  const midDot = lastDot > 0 ? text.lastIndexOf(".", lastDot - 1) : -1;
  if (midDot <= 0) return { ok: false, reason: "malformed" };
  const profileName = text.slice(0, midDot);
  const nonce = text.slice(midDot + 1, lastDot);
  const expText = text.slice(lastDot + 1);
  if (!PROFILE_NAME_RE.test(profileName) || !NONCE_RE.test(nonce) || !EXPIRY_RE.test(expText)) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = new Date(Number(expText) * 1000);

  // (3) Expiry.
  const nowMs = (now ?? new Date()).getTime();
  if (nowMs >= expiresAt.getTime()) return { ok: false, reason: "expired" };
  if (expiresAt.getTime() - nowMs > (HANDOFF_TTL_SECONDS + HANDOFF_MAX_CLOCK_SKEW_SECONDS) * 1000) {
    return { ok: false, reason: "malformed" };
  }

  // (4) Single use.
  if (!(await nonceStore.consume(nonce, expiresAt))) return { ok: false, reason: "replayed" };
  return { ok: true, profileName, nonce, expiresAt };
}
