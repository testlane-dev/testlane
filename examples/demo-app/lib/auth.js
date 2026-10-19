/**
 * next-auth v4 configuration: credentials provider, JWT sessions, no database.
 *
 * This is the shape the broker's `nextauth-credentials` strategy expects:
 * GET /api/auth/csrf, POST /api/auth/callback/credentials (email, password),
 * a `next-auth.session-token` cookie, and GET /api/auth/session returning
 * { user: { email, role } }.
 */
import CredentialsProvider from "next-auth/providers/credentials";
import { verifyPassword } from "./users.js";
import { getRuntimeConfig } from "./runtime-config.js";

/** Normal-login session lifetime. The handoff route uses the profile's ttlMinutes instead. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** The claims callback, shared by normal login and the handoff route. */
async function jwtCallback({ token, user }) {
  if (user) {
    token.role = user.role;
  }
  return token;
}

export const authOptions = {
  // Runtime secrets arrive through scripts/app.mjs and remain process-local.
  // An uninitialized app has no signing secret and therefore cannot authenticate.
  secret: getRuntimeConfig()?.nextAuthSecret,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        return verifyPassword(credentials?.email, credentials?.password);
      },
    }),
  ],
  callbacks: {
    jwt: jwtCallback,
    async session({ session, token }) {
      if (session.user) {
        session.user.role = token.role;
      }
      return session;
    },
  },
};

/**
 * The JWT payload a normal credentials login produces for `user`: next-auth's
 * default token ({ name, email, picture, sub }) passed through the same jwt
 * callback. The handoff route uses this so an agent never gets more (or other)
 * claims than the human would by typing the password. No role bypass.
 */
export async function sessionClaimsFor(user) {
  const defaultToken = { name: user.name, email: user.email, picture: undefined, sub: user.id };
  return jwtCallback({ token: defaultToken, user, account: null, trigger: "signIn" });
}
