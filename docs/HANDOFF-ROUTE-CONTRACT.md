# Agent handoff route: server-side contract

What a consuming app must implement so an agent's browser pane (no cookie-import API) can sign in
by navigating to the one-time URL that `testlane handoff <profile>` returns. The reference
verifier is `verifyHandoffCode` in `src/handoff.ts` of this package (dependency-free apart from
`node:crypto`); the app route mirrors it step for step.

The broker may also consume the same URL itself: `testlane session` and `testlane check` on an
`app-handoff` profile that opted in with `options.mePath` (and a `dependent-token` profile that
depends on one) request it without a browser and hand out the session cookies the route sets. A
route that follows this contract needs no change for that; see
[The broker as the client](#the-broker-as-the-client).

A reference route implementation (Next.js + NextAuth) lives in
[examples/demo-app](../examples/demo-app); `npm run demo` starts it on `http://localhost:3000`.
The contract below is framework-neutral; where it names NextAuth or a hosting provider's
variables, substitute your framework's equivalents.

## Route

`GET /api/auth/agent-handoff?code=<code>` (path overridable per profile via `options.handoffPath`,
always a same-origin path).

## Enablement (all must hold, checked first; otherwise respond 404)

1. `process.env.AGENT_HANDOFF_ENABLED === "true"`.
2. The deployment is **positively marked non-production** through an explicit, allowlisted value:
   the route is off unless that marker is present, never "on unless marked production". The
   reference route reads `AGENT_HANDOFF_ENV` and requires it to be exactly one of `local`,
   `sandbox`, `testing` or `preview`, set only in the sandbox deployment's scope. A missing,
   empty or unknown value (including `production` and `prod`) means disabled. A gate that only
   checks the host's production signal is open on every host that does not set it (Fly, Render,
   Kubernetes, a VM), which is exactly where an app copied from the reference lands.
   The host's own production signal (for example `VERCEL_ENV === "production"` on Vercel, or your
   platform's equivalent) is an extra deny: it can switch the route off, never on.
3. The deployment branch (for example `VERCEL_GIT_COMMIT_REF` on Vercel) is not the release
   branch.
4. `AGENT_HANDOFF_SECRET` is set and at least **32 characters** long (server-only; the same value
   the human stored in the broker with `testlane store set <profile>`). A shorter secret is a
   misconfiguration: treat the route as disabled (404). Generate one with
   `openssl rand -base64 32`. The broker enforces the same minimum: `store set` refuses a shorter
   value for an `app-handoff` profile, and `mintHandoffCode` / `verifyHandoffCode` throw for one.

## Secret scope: one secret per deployment

A code names a profile, a nonce and an expiry, but **no audience**: it does not say which
deployment it is for. Any deployment that holds the same `AGENT_HANDOFF_SECRET` (and knows the
profile name) accepts it. Therefore use **one distinct secret per deployment** (per preview
environment, per app); never share a secret between two apps or between a sandbox and anything
more sensitive. Rotating a deployment's secret means a human re-runs `testlane store set` for
the profiles that point at it.

## Code format

```
payload = `${profileName}.${nonce}.${expiresAtUnixSeconds}`   // nonce: 16 random bytes, base64url
code    = base64url(payload) + "." + base64url(HMAC-SHA256(AGENT_HANDOFF_SECRET, payload))
```

TTL is 60 s. Profile names may contain `.`, so split the payload from the right.

## Verification order

1. Shape: exactly two dot-separated segments, strict canonical base64url, signature 32 bytes,
   code at most 1024 chars.
2. Signature: recompute the HMAC over the decoded payload bytes and compare with
   `crypto.timingSafeEqual` on equal-length buffers, **before** interpreting the payload.
3. Payload: profile name matches the broker's `PROFILE_NAME_RE`, nonce is 22 base64url chars,
   expiry is an integer.
4. Expiry: reject when `now >= expiresAt`, or when `expiresAt` is more than 60 s + 30 s skew ahead.
5. Single use: insert the nonce into an `AgentHandoffNonce` table (additive migration; columns
   `nonce` unique/PK, `expiresAt`, `createdAt`). A unique-constraint violation means replay. The
   insert is the burn; it happens only after steps 1-4 pass. Rows past `expiresAt` may be pruned.

## On success

1. Resolve `profileName` to an account email via the app's committed `testlane.profiles.json`
   (the entry must exist, use `strategy: "app-handoff"` and not be `environment: "production"`),
   then to an active user in the app (and tenant, if the app has tenants). Never create users
   here.
2. Mint the app's own session exactly as a normal login would (NextAuth: JWT `encode` with
   `NEXTAUTH_SECRET`, same claims/roles as the credentials provider; no role bypass), with
   `maxAge` = the profile's `session.ttlMinutes`.
3. Set the session cookie (`__Secure-next-auth.session-token` on https, HttpOnly, SameSite=Lax,
   Secure on https).
4. Write an audit row in the app's own audit log (for example action `auth.agent_handoff` with
   profile name, user id and requesting tool if known) in the same transaction as the nonce
   insert.
5. Respond `302 Location: /`.

## On any failure

Respond `404` with an empty body and no detail (disabled, malformed, bad signature, expired,
replayed, unknown profile, unknown user). Log the reason server-side only; never log the code or
the secret. The route never accepts a password and never reads or echoes `AGENT_HANDOFF_SECRET`.

## The broker as the client

This is a per-profile opt-in on the broker side: the profile must set `options.mePath` (for
NextAuth, `/api/auth/session` with `emailField` `user.email`). Without it `testlane session` and
`testlane check` refuse the profile before anything is minted, and only `testlane handoff`
works. For an opted-in profile (CLI, MCP or HTTP) the broker acts as the client itself:

- Before minting, it opens a TCP connection to the app's host and port and closes it again,
  sending nothing. A host that does not resolve or accept the connection gets no code.
- It then mints a code exactly as `handoff` does and sends one `GET <url>` with
  `redirect: manual`, no cookies, no `Referer` and no JavaScript. The request carries exactly
  these headers (Node's built-in `fetch` adds the last four itself):
  `User-Agent: testlane/<version>`, `Accept: text/html,application/xhtml+xml,*/*;q=0.8`,
  `Accept-Language: *`, `Sec-Fetch-Mode: cors`, `Accept-Encoding: gzip, deflate` and
  `Connection: keep-alive` (plus `Host`). There is no `Sec-Fetch-Site`, `Sec-Fetch-Dest` or
  `Sec-Fetch-User`. Do not make the route depend on browser-only signals.
- It requires the contract's redirect: any other status, including a `200` page, is a failed
  sign-in. The `Location` must be on the app's own origin, same scheme, host and port (a
  relative path such as `/` is fine); an off-origin `Location`, including a protocol-relative
  `//host`, is refused. The redirect is never followed.
- It keeps only **host-only** cookies from that response: a `Set-Cookie` with any `Domain`
  attribute, even one equal to the app's host, is dropped, and so is a cookie that breaks the
  `__Secure-` / `__Host-` prefix rules. So set the session cookie on the redirect response
  itself, without `Domain`, as the reference route does.
- It then calls `mePath` with the captured cookies and refuses the session unless the reported
  email matches the profile's account email.
- The code is single-use as always: the broker's request burns the nonce, so a code the broker
  consumed cannot be replayed from a browser or anywhere else.

The code and URL never leave the broker in this mode; the cookies the route set are the
deliverable, with the same lifetime (`maxAge` = the profile's `session.ttlMinutes`).

## Tests the app PR must include

Valid code → 302 + cookie + audit row; replay → 404; expired → 404; wrong secret → 404;
tampered payload → 404; flag off / marker missing / marker not allowlisted (`production`, `prod`,
empty) / production env / release branch → 404; production-tagged
profile → 404. If agents will use `session` / `check` on the profile, also verify against a
preview deployment that `testlane session <profile>` returns the session cookie and
`testlane check <profile>` reports the account (it needs `options.mePath`).
