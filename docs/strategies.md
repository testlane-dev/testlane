# Login strategies

A profile's `strategy` decides how the broker turns the stored secret into a session. Every
strategy follows the same rules:

- The secret is read from the store only after policy allowed the request (never for
  `production` profiles), is used only inside the sign-in request body, and is never logged,
  placed in an error message, written to the audit log or copied into the session artifact.
- Every endpoint option (`*Path`) is a path on the profile's own origin (`"/..."`). Absolute
  URLs, protocol-relative `//host`, backslashes, whitespace, query strings and fragments are
  refused at load time and again before any request.
- Options are validated when the registry loads. Unknown keys are rejected, so a typo cannot
  silently fall back to a default. Error messages name the option key, never its value.
- The artifact never outlives `session.ttlMinutes`. Cookie expiries are capped to the same
  instant.
- Cookie name prefixes are enforced as browsers enforce them: a `__Secure-` cookie without
  `Secure`, or a `__Host-` cookie without `Secure`, with a `Domain` attribute or without
  `Path=/`, is ignored (prefixes matched case-insensitively).

The authoritative option schemas are in `src/strategies/options.ts`, and
`schema/profiles.schema.json` mirrors them for editors.

| Strategy | Secret | Session artifact |
| --- | --- | --- |
| [`nextauth-credentials`](#nextauth-credentials) | password | the next-auth session cookie |
| [`form-post`](#form-post) | password | the cookies live after the login, including `sessionCookieName` |
| [`dependent-token`](#dependent-token) | password, PIN or key | the dependency's cookies and headers, plus a captured token header or cookie |
| [`app-handoff`](#app-handoff) | the app's handoff secret | `handoff`: the one-time URL; `session`, once the profile opts in with `mePath`: the host-only cookies the app's handoff route set (the broker consumes the one-time URL itself) |
| `oauth-client-credentials`, `api-key` | - | not implemented; `session` and `check` refuse them |

---

## nextauth-credentials

This strategy signs in to a next-auth v4 app through its credentials provider:

1. `GET <csrfPath>` returns `{ csrfToken }` and a CSRF cookie.
2. `POST <callbackPath>` sends a form with `csrfToken`, `<emailField>`, `<passwordField>`,
   `json=true` and `callbackUrl`.
3. The broker captures the session cookie: `sessionCookieName`, or, when that is not set, the
   first of `__Secure-next-auth.session-token` and `next-auth.session-token`.

```json
"demo:local:admin": {
  "app": "demo",
  "environment": "sandbox",
  "baseUrl": "https://app.example.test",
  "strategy": "nextauth-credentials",
  "account": { "email": "admin@example.test", "role": "Administrator" },
  "session": { "ttlMinutes": 120 }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `csrfPath` | `/api/auth/csrf` | CSRF endpoint |
| `callbackPath` | `/api/auth/callback/credentials` | credentials callback |
| `sessionPath` | `/api/auth/session` | session JSON used by `check` |
| `sessionCookieName` | automatic | the session cookie to capture |
| `emailField` / `passwordField` | `email` / `password` | form field names in the callback POST |
| `roleField` | `user.role` | dot path of the role in the session JSON |
| `rotate*` | - | see [rotation.md](rotation.md) |

**Session artifact:** one cookie, the next-auth session cookie. Its expiry is capped at
`min(ttlMinutes, the cookie's own expiry)`.

**Security notes**

- A `401`/`403` or `error=CredentialsSignin` counts as "credentials rejected". Only then does
  the broker try a pending rotated secret, and it tries it once.
- `ttlMinutes` bounds the artifact the broker hands out, but the app's JWT keeps its own
  `maxAge` on the server. Treat the cookie as valid for that full lifetime.

---

## form-post

This strategy signs in through a generic HTML login form or a JSON sign-in endpoint:

1. Optional: when `primeCookies` is `"true"`, the broker sends `GET <loginPath>` to collect
   pre-login cookies such as a CSRF cookie.
2. `POST <loginPath>` sends `fields` with `{{email}}` and `{{secret}}` substituted, with
   `redirect: manual`.
3. Up to 5 same-origin redirects are followed with `GET`. An off-origin redirect is refused.
4. The login succeeds only when `sessionCookieName` was set by the POST or its redirects (a
   cookie from the priming GET does not count). Two optional checks can be added:
   `successPath` requires the final page to be under that path, and `successBodyField`
   requires the final response to be JSON with a non-empty string at that dot path.

HTML form:

```json
"demo:testing:clerk": {
  "app": "demo",
  "environment": "testing",
  "baseUrl": "https://app.example.test",
  "strategy": "form-post",
  "account": { "email": "clerk@example.test", "role": "Clerk" },
  "session": { "ttlMinutes": 60 },
  "options": {
    "loginPath": "/login",
    "primeCookies": "true",
    "fields": "{\"username\":\"{{email}}\",\"password\":\"{{secret}}\",\"remember\":\"1\"}",
    "sessionCookieName": "sid",
    "successPath": "/dashboard",
    "mePath": "/api/me"
  }
}
```

JSON sign-in endpoint (`bodyFormat: "json"`):

```json
"demo:sandbox:operator": {
  "app": "demo",
  "environment": "sandbox",
  "baseUrl": "https://sandbox.example.test",
  "strategy": "form-post",
  "account": { "email": "operator@example.test", "role": "owner" },
  "session": { "ttlMinutes": 120 },
  "options": {
    "loginPath": "/api/auth/sign-in/email",
    "bodyFormat": "json",
    "fields": "{\"email\":\"{{email}}\",\"password\":\"{{secret}}\"}",
    "sessionCookieName": "app_session",
    "successBodyField": "token",
    "mePath": "/api/auth/workspaces",
    "roleField": "workspaces.0.role"
  }
}
```

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `loginPath` | yes | - | login form or JSON sign-in endpoint |
| `fields` | yes | - | JSON object string. Values may contain `{{email}}` and `{{secret}}`. |
| `sessionCookieName` | yes | - | the cookie that proves the login worked |
| `bodyFormat` | no | `form` | `form` sends `application/x-www-form-urlencoded`. `json` sends `application/json` plus an `Origin` header. |
| `primeCookies` | no | `false` | `"true"` sends `GET loginPath` first |
| `successPath` | no | - | the final page must be at or below this path |
| `successBodyField` | no | - | dot path that must hold a non-empty string in the final JSON response (checked for presence only) |
| `mePath` | for `check` | - | identity endpoint |
| `emailField` / `roleField` | no | `email` / `role` | dot paths into the `mePath` JSON. Numeric segments index arrays, e.g. `workspaces.0.role`. |
| `rotate*` | no | - | see [rotation.md](rotation.md) |

**Session artifact:** every live cookie after the login, including `sessionCookieName`. Expiry
is `min(ttlMinutes, the session cookie's expiry)`.

**Security notes**

- The POST is sent once. Redirects are followed with `GET` and no body, so the secret never
  travels twice and never leaves the origin.
- Some apps also set the session cookie on anonymous pages. For example, a failed login that
  redirects back to the login page re-sets it. The cookie alone cannot tell success from
  failure there, so configure `successPath`.
- The value at `successBodyField` is usually session material. It is checked for presence
  only and is never logged, stored or returned.

---

## dependent-token

This strategy is for apps where one session unlocks another. The broker first signs in
another profile, such as a dedicated service account. It then POSTs this
profile's secret to an endpoint using that session, and captures a token or cookie from the
response.

1. `ctx.sessionFor(dependsOn)`: the broker signs in the `dependsOn` profile through its own
   policy, vault and audit path. The dependency may use any sign-in strategy, including
   [`app-handoff`](#app-handoff) for a password-less device or service account that has opted
   in with `options.mePath` (see [app-handoff](#app-handoff)).
   - The dependency must be on the **same host** and must **not be production**.
   - Cycles and nesting deeper than 2 levels are refused before any secret is read.
   - The dependency's audit row has the format `internal:dependent:for=<this profile>`.
   - The dependency session's origin must equal this profile's origin.
2. `POST <tokenPath>` goes out with the dependency's cookies and forwardable headers. The body
   is `fields` with `{{secret}}`, `{{email}}` and `{{identifier}}` substituted, sent as JSON
   (the default) or urlencoded. A redirect is a failure and is never followed.
3. The broker captures exactly one of:
   - `tokenField`: a dot path in the JSON response. The value is returned as header
     `tokenHeader`. When `tokenHeader` is omitted, the header is `Authorization` with a
     `Bearer ` prefix. When it is set, the header uses that exact name and the raw value.
   - `sessionCookieName`: a cookie the response must set.
4. Expiry is the minimum of these, whichever are available:
   - `ttlMinutes`
   - `expiresAtField`. ISO 8601, unix seconds and unix milliseconds are detected
     automatically; numbers below 10^11 are treated as seconds.
   - the captured cookie's expiry
   - the dependency session's `expiresAt`

A service account, then a scoped reader session, using an illustrative API contract.
Configure these paths and fields for your own app; they are not built-in defaults:

```json
"demo:testing:service": {
  "app": "demo",
  "environment": "testing",
  "baseUrl": "https://api.example.test",
  "strategy": "nextauth-credentials",
  "account": { "email": "service-agent@example.test", "role": "Service" },
  "session": { "ttlMinutes": 60 }
},
"demo:testing:reader": {
  "app": "demo",
  "environment": "testing",
  "baseUrl": "https://api.example.test",
  "strategy": "dependent-token",
  "account": { "email": "reader@example.test", "role": "Reader", "identifier": "subject-42" },
  "session": { "ttlMinutes": 30 },
  "options": {
    "dependsOn": "demo:testing:service",
    "tokenPath": "/api/device/exchange",
    "fields": "{\"subject\":\"{{identifier}}\",\"credential\":\"{{secret}}\"}",
    "tokenField": "accessToken",
    "tokenHeader": "x-device-access",
    "expiresAtField": "expiresAt",
    "mePath": "/api/device/identity",
    "emailField": "subject.email",
    "roleField": "subject.role"
  }
}
```

Service account, then a per-user bearer token (form body, `Authorization: Bearer`):

```json
"demo:testing:user-token": {
  "app": "demo",
  "environment": "testing",
  "baseUrl": "https://api.example.test",
  "strategy": "dependent-token",
  "account": { "email": "qa-user@example.test", "role": "Member" },
  "session": { "ttlMinutes": 30 },
  "options": {
    "dependsOn": "demo:testing:service",
    "tokenPath": "/internal/impersonate",
    "bodyFormat": "form",
    "fields": "{\"email\":\"{{email}}\",\"password\":\"{{secret}}\"}",
    "tokenField": "data.accessToken",
    "expiresAtField": "data.expiresAt",
    "mePath": "/api/me"
  }
}
```

With a cookie instead of a token, replace `tokenField` (and `tokenHeader`) with
`"sessionCookieName": "user_session"`.

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dependsOn` | yes | - | profile signed in first (same host, non-production, not this profile) |
| `tokenPath` | yes | - | endpoint that exchanges the secret |
| `fields` | yes | - | JSON object string of string values. It must contain `{{secret}}`, may use `{{email}}` and `{{identifier}}`, and may not use any other placeholder. |
| `bodyFormat` | no | `json` | `json` or `form` |
| `secretPattern` | no | - | JavaScript regex (`u` flag, at most 256 characters) the secret must match before any request. It is used as written, so anchor it (`^...$`). |
| `tokenField` | one of | - | dot path of the token in the JSON response |
| `sessionCookieName` | one of | - | cookie the response must set |
| `tokenHeader` | no | `Authorization` (`Bearer <token>`) | header that carries the token. Requires `tokenField`. Transport and cookie headers (`Cookie`, `Host`, `Content-Length`, `Origin`, ...) are refused. |
| `expiresAtField` | no | - | dot path of the server-side expiry |
| `mePath` | for `check` | - | identity endpoint, called with the artifact's cookies and headers |
| `emailField` / `roleField` | no | `email` / `role` | dot paths into the `mePath` JSON |

`dependsOn`, `tokenPath`, `fields` and the capture option are optional at load time, so a
registry still loads while a profile is being configured. The strategy refuses to sign in
without them before any request is sent. Setting both `tokenField` and `sessionCookieName`,
or setting `tokenHeader` without `tokenField`, is rejected at load time. When `fields` uses
`{{identifier}}`, the profile needs `account.identifier`.

**Session artifact**

- `cookies`: the dependency session's cookies plus any cookie set by the `tokenPath`
  response (in cookie mode this includes `sessionCookieName`). Every expiry is capped at the
  artifact's `expiresAt`.
- `headers`: the dependency session's forwardable headers plus the captured token header in
  token mode. The captured header replaces a dependency header of the same name. The
  cookie-only output formats (`cookie`, `storage-state`, `curl`) cannot carry headers, so use
  `--format headers` or `--format json`. The CLI, MCP and HTTP surfaces name any dropped header,
  never its value.

**Security notes**

- **The artifact contains the dependency session.** Whoever receives it also holds the
  service or other dependency session, and that session may stay valid on the server much longer
  than `ttlMinutes` (next-auth's default JWT `maxAge` is 30 days). Use a dedicated account for
  `dependsOn` that holds only the permission the exchange needs. Never use a shared or human
  login.
- The secret is shape-checked against `secretPattern` before the dependency is signed in or
  any request is sent. The refusal message never includes the value.
- The secret appears only in the POST body. It is never logged, put in an error or copied
  into the artifact.
- The captured token is session material. It is returned in the artifact only and never
  logged or placed in an error. It must be printable ASCII without spaces (at most 4096
  characters), because it travels in an HTTP header.
- The POST goes only to the profile origin, and only when the dependency session is on that
  origin and has a cookie or header for it. The dependency's `Cookie`, `Host`,
  `Content-Length` and other transport headers are never forwarded.
- A `401` is reported as `token sign-in rejected by <host> (secret, account or dependency session)`
  and is **not** marked "credentials rejected", because it may equally mean the dependency
  session was refused. A `403` names the dependency.

---

## app-handoff

This strategy is for accounts that the app lets in through its own sandbox-only **handoff
route** instead of a password (see [HANDOFF-ROUTE-CONTRACT.md](HANDOFF-ROUTE-CONTRACT.md)). The
stored secret is the deployment's `AGENT_HANDOFF_SECRET`, not a password. The broker uses it in
two ways:

- **`handoff`** is for browsers that cannot import cookies, such as Claude's built-in pane.
  `testlane handoff <profile>` mints a **60-second, single-use**, HMAC-signed code and prints
  `{ "url", "expiresAt", "profile" }`. The URL is `<baseUrl origin><handoffPath>?code=<code>`.
  The browser opens it; the app's route verifies the code, burns the nonce, sets its session
  and redirects.
- **`session` and `check`** (CLI, MCP and HTTP), and a [`dependent-token`](#dependent-token)
  profile whose `dependsOn` is this profile, have the **broker consume the same URL itself**
  and hand out the session cookies. This is an **explicit per-profile opt-in: the profile must
  set `options.mePath`**. Without it, `session` and `check` (and a dependency on the profile)
  are refused exactly as before 0.4: exit 2, audit reason `strategy-not-supported`, before the
  store is read or any code is minted, with a message pointing at `handoff` and at `mePath`.
  So an existing `app-handoff` profile never starts handing out its session cookie on an
  upgrade (see [Upgrading to 0.4](upgrading.md#upgrading-to-04)). For an opted-in profile:
  1. The broker checks that the app's host and port accept a TCP connection (it connects and
     closes, sending nothing). An unreachable app (DNS failure, connection refused, timeout) is
     a sign-in failure (exit 3) and no code is minted.
  2. It mints a code exactly as `handoff` does (same secret, 60-second TTL, fresh nonce) and
     writes the `handoff` audit row before the code leaves the process. The row carries reason
     `consumed-by-broker` and the format of the sign-in it serves; a `testlane handoff` row has
     no reason.
  3. It sends `GET <url>` with `redirect: manual`. If that request gets no answer, a second
     `handoff` row with `ok: false` and reason `consumed-by-broker:no-answer` follows. The
     route must answer a 3xx whose `Location` is on the profile origin (same scheme, host and
     port), and the redirect is not followed. Any other status (the route answers a bare 404
     for every refusal), a missing `Location` or an off-origin one (including a
     protocol-relative `//host`) is a sign-in failure (exit 3). The `Location` is never echoed.
  4. It captures **host-only cookies only**: a `Set-Cookie` that carries any `Domain` attribute,
     even one equal to the host, is dropped, and the `__Secure-` / `__Host-` prefix rules apply.
     No cookie left is a sign-in failure.
  5. It sends `GET <mePath>` with those cookies, reads `emailField` and compares it
     case-insensitively with `account.email`. A missing or different email refuses the session
     (exit 3) before anything is issued.
  6. The artifact expires at the minimum of `ttlMinutes` and every captured cookie's expiry;
     each cookie is capped at that instant.

  Every failure after the mint also ends in a failure row for the `session` or `check`, so a
  `consumed-by-broker` row never stands alone.

```json
"demo:testing:handoff:qa": {
  "app": "demo",
  "environment": "testing",
  "baseUrl": "https://staging.example.test",
  "strategy": "app-handoff",
  "account": { "email": "qa@example.test", "role": "QA" },
  "session": { "ttlMinutes": 60 },
  "options": {
    "handoffPath": "/api/auth/agent-handoff",
    "mePath": "/api/auth/session",
    "emailField": "user.email",
    "roleField": "user.role"
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `handoffPath` | `/api/auth/agent-handoff` | the app route that consumes the code (used by `handoff`, `session` and `check`) |
| `mePath` | - | identity endpoint. **Required for `session`, `check` and use as a `dependsOn`**: setting it is the opt-in. The broker confirms the email there before issuing anything |
| `emailField` / `roleField` | `email` / `role` | dot paths into the `mePath` JSON. For NextAuth's `/api/auth/session` use `user.email` / `user.role` |

**Session artifact:** the host-only cookies the handoff route set (for a NextAuth app, its
session cookie), with no extra headers, so every output format carries it: `cookie`,
`storage-state`, `curl`, `headers` and `json`.

**Security notes**

- The stored secret is the app's `AGENT_HANDOFF_SECRET`, at least 32 characters (for example
  from `openssl rand -base64 32`). It never appears in the code, URL or output. A stored value
  shorter than that is refused by `handoff`, `session` and `check` alike.
- Each deployment needs its own secret. A code carries no audience, so it verifies on every
  deployment that shares the secret.
- Every code is audited (event `handoff`) before it leaves the broker: before the URL is
  printed by `handoff`, and before the broker sends it to the app for `session` / `check`.
- Production profiles and hosts, a missing `mePath` (for `session` / `check`), an unsafe
  `handoffPath` and the other policy refusals stop both paths **before the store is read**.
  Origin and environment binding and the 32-character minimum are checked **when the stored
  value is read**, before any code is minted or any request is sent.
- The code itself is a one-time credential. `handoff` deliberately returns it, and it expires
  after 60 seconds. For `session` / `check` it only ever travels to the profile origin, the
  route burns it on that request, and it is never printed, logged or placed in an error.
- A `session` artifact for an app-handoff profile is a live session for the account, reusable
  until the app expires it (the route mints it with `maxAge` = `ttlMinutes`), not a 60-second
  URL, and it includes the HttpOnly session cookie that a navigate-only browser never exposed
  to the agent. It has the same trust level as any other strategy's artifact: see
  [threat-model.md](threat-model.md) (T9). Before adding `mePath` to a profile, a human should
  re-check that account's privileges.
