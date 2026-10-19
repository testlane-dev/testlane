/**
 * GET /api/auth/agent-handoff?code=<code>
 *
 * The sandbox-only route from docs/HANDOFF-ROUTE-CONTRACT.md: an agent's
 * browser (which cannot import cookies) navigates here with the one-time code
 * from `testlane handoff <profile>`; the route verifies the code, burns its
 * nonce, mints the app's own next-auth session exactly as a password login
 * would, and redirects to "/".
 *
 * Every failure is a bare 404 with no body and no detail; the reason is logged
 * server-side only, never the code or the secret.
 */
import { encode } from "next-auth/jwt";
import { sessionClaimsFor } from "../../../../lib/auth.js";
import { handoffEnabled } from "../../../../lib/handoff-gate.js";
import { HANDOFF_SECRET_MIN_LENGTH, MemoryNonceStore, verifyHandoffCode } from "../../../../lib/handoff-verify.js";
import { handoffProfile } from "../../../../lib/profiles.js";
import { findActiveUserByEmail } from "../../../../lib/users.js";
import { getRuntimeConfig } from "../../../../lib/runtime-config.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DEMO ONLY: nonces live in process memory (kept on globalThis so dev-mode
// reloads do not forget them). A real app MUST persist them, e.g. an
// `AgentHandoffNonce` table (nonce PK, expiresAt, createdAt) whose insert is
// the burn, written in the same transaction as the audit row below.
const nonceStore = (globalThis.__demoHandoffNonces ??= new MemoryNonceStore());

// DEMO ONLY: in-memory stand-in for the app's ActivityLog table.
const activityLog = (globalThis.__demoActivityLog ??= []);

function notFound(reason) {
  if (reason) console.warn(`[agent-handoff] refused: ${reason}`);
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * Enablement: every condition must hold, otherwise the route does not exist (404).
 * The environment gate fails closed (lib/handoff-gate.js): off unless
 * AGENT_HANDOFF_ENABLED=true AND AGENT_HANDOFF_ENV names a non-production environment.
 */
function handoffSecretIfEnabled() {
  if (!handoffEnabled(process.env)) return null;
  const secret = getRuntimeConfig()?.handoffSecret;
  if (typeof secret !== "string" || secret.length < HANDOFF_SECRET_MIN_LENGTH) return null;
  return secret;
}

export async function GET(request) {
  const secret = handoffSecretIfEnabled();
  if (secret === null) return notFound("disabled");

  const nextAuthSecret = getRuntimeConfig()?.nextAuthSecret;
  if (!nextAuthSecret) return notFound("disabled (no NEXTAUTH_SECRET)");

  const code = request.nextUrl.searchParams.get("code");
  if (code === null) return notFound("malformed");

  // Steps 1-5 of the contract: shape, signature, payload, expiry, single use (the burn).
  const result = await verifyHandoffCode({ code, secret, nonceStore });
  if (!result.ok) return notFound(result.reason);

  // Resolve profile -> account email -> active user. Never create users here.
  const profile = await handoffProfile(result.profileName);
  if (profile === null) return notFound("unknown profile");
  const user = findActiveUserByEmail(profile.email);
  if (user === null) return notFound("unknown user");

  // Mint the same session a password login would produce (same claims, same role).
  // maxAge = the profile's ttlMinutes. Note: next-auth v4 re-issues the JWT with
  // its own session.maxAge whenever /api/auth/session is read, so treat this as
  // the initial lifetime; enforce a hard cap in the jwt callback if you need one.
  const maxAge = profile.ttlMinutes * 60;
  const token = await sessionClaimsFor(user);
  const jwt = await encode({ token, secret: nextAuthSecret, maxAge });

  // Same cookie name/flags next-auth itself uses: secure cookies when the app URL is https.
  const appUrl = process.env.NEXTAUTH_URL ?? request.nextUrl.origin;
  const secure = appUrl.startsWith("https://");
  const cookieName = `${secure ? "__Secure-" : ""}next-auth.session-token`;
  const cookie = [
    `${cookieName}=${jwt}`,
    "Path=/",
    `Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

  const entry = {
    action: "auth.agent_handoff",
    profile: result.profileName,
    userId: user.id,
    at: new Date().toISOString(),
  };
  activityLog.push(entry);
  console.log(`[agent-handoff] ${JSON.stringify(entry)}`);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// Next would otherwise answer HEAD by running GET (which would burn the nonce).
export async function HEAD() {
  return new Response(null, { status: 404 });
}
