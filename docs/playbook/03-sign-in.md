# 03 Sign-in

## The rule

Agents receive **session artifacts, never passwords**. Pick the artifact that fits the client:
a cookie jar or header lines for HTTP tools, a `storageState` for Playwright or a CDP-driven
browser, a one-time handoff URL for a browser pane that can only navigate. The **app** enforces
how long an agent session lives, on the server, because the artifact's own expiry is advisory.

## Why

- **A password the agent can type is a password in its transcript.** It ends up in the
  conversation log, in screenshots, in terminal scrollback and in any tool output that echoes a
  form. Credential guards in the harness will also, correctly, refuse to handle it, and the agent
  stalls at the sign-in screen.
- **The wrong artifact leads to workarounds.** A browser pane without a cookie-import API cannot
  use a cookie jar; an agent handed one will try to type a password instead. Give each client the
  artifact it can consume.
- **Client refresh extends cookies.** Most session libraries refresh the session cookie on
  activity (sliding expiry) or when the client polls the session endpoint. A cookie the broker
  issued for 120 minutes can be kept alive for the library's full `maxAge` (often 30 days) by a
  browser that keeps using it. The broker cannot see or stop that; only the app can.

## How

### Choose the artifact

| Client | Command | Artifact |
| --- | --- | --- |
| curl, HTTP scripts | `testlane session <p> --format curl --out .agent/cookies.txt` | Netscape cookie jar |
| Any HTTP client | `testlane session <p> --format headers` | `Cookie: …` (and app headers) lines |
| Playwright | `testlane session <p> --format storage-state --out .agent/storage.json` | Playwright `storageState` JSON |
| Browser driven over CDP | the same `storageState`, loaded into the context | cookies |
| Browser pane (navigate only) | `testlane handoff <p>` | one-time URL, 60 s, single use |
| Proving identity only | `testlane check <p>` | email and role, no artifact |

Start every unattended run with `testlane check <profile>`: it signs in, asks the app who it is, and
prints only identity facts. A failure here (exit 3) is cheaper to diagnose than a failure halfway
through a browser flow.

### HTTP tools

```bash
mkdir -p .agent
testlane session acme:staging:sales --format curl --out .agent/cookies.txt
curl -sS -b .agent/cookies.txt https://staging.acme.test/api/me
```

For a URL other than the profile's `baseUrl`, pass it as `--target` so the broker checks the host
allowlist before issuing anything:

```bash
testlane session acme:staging:sales --format curl --target https://api.staging.acme.test/orders --out .agent/api-cookies.txt
```

`--out` creates a new file with mode 0600 and refuses to replace an existing one. Use a new file
name per run rather than `--force`.

### Playwright and CDP

```bash
testlane session acme:staging:sales --format storage-state --ttl 60 --out .agent/storage.json
```

```ts
// playwright.config.ts
export default defineConfig({
  use: { baseURL: "https://staging.acme.test", storageState: ".agent/storage.json" },
});
```

For a browser you attach to over CDP, load the same file into the context:

```ts
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const state = JSON.parse(readFileSync(".agent/storage.json", "utf8"));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
await context.addCookies(state.cookies);
```

`--ttl` may ask for less than the profile's limit; asking for more is refused (exit 2), never
silently capped.

### Browser panes: handoff URLs

A browser pane that can only navigate needs the app to turn a one-time code into a session. The
app implements the route in [HANDOFF-ROUTE-CONTRACT.md](../HANDOFF-ROUTE-CONTRACT.md); the agent
does this:

```bash
testlane handoff acme:staging:handoff-sales
# {"url": "https://staging.acme.test/api/auth/agent-handoff?code=…", "expiresAt": "…", "profile": "…"}
```

and navigates the pane to `url` within 60 seconds. The code is single-use. If it expired or was
used, request a new one; never retry the old URL. The URL is a bearer credential until it is used:
do not paste it into issues, chat or evidence files.

### Enforce the TTL in the app

Put the agent's session lifetime into the session itself when it is created, and check it on
every request on the server:

1. When the handoff route (or the credentials sign-in for an agent account) creates the session,
   store an absolute expiry: `agentExpiresAt = now + profile ttlMinutes`.
2. In the session or token callback that runs on every request, reject the session when
   `now >= agentExpiresAt`, **regardless of any refresh**. Do not recompute the expiry on refresh.
3. Identify agent sessions on the server (the account's email domain, a flag on the user row),
   never from a client-supplied value.

```ts
// Library-neutral sketch of a token/session callback.
async function onEveryRequest(token: SessionToken): Promise<SessionToken | null> {
  if (token.agentExpiresAt !== undefined && Date.now() >= token.agentExpiresAt) {
    return null; // treat as signed out; with server-side sessions, delete the session row too
  }
  return token; // refresh may extend the library's own expiry, never agentExpiresAt
}
```

How "reject" looks depends on the library (returning an empty token, throwing, deleting a
session row). Test it: sign in as an agent account, advance the clock past the TTL, make a request
that would normally refresh the cookie, and assert the app answers as signed out.

### Handle artifacts as credentials

- Write them under a gitignored directory (`.agent/`), never into the repository tree.
- Never `cat` them, attach them to evidence, or paste them into chat.
- Delete them at the end of the run: `rm -f .agent/*.txt .agent/*.json`.
- Prefer the CLI with `--out` over an MCP tool when you do not want the artifact to appear in the
  conversation context; the MCP `session` tool returns it inline.

## Checklist

- [ ] No flow asks the agent to type, paste or read a password; sign-in screens are passed with a broker artifact.
- [ ] Each client uses the artifact it can consume (jar, headers, storageState, handoff URL).
- [ ] Unattended runs start with `testlane check <profile>`.
- [ ] Session files go to a gitignored directory, with a fresh name per run, and are deleted afterwards.
- [ ] The app stores an absolute agent expiry at sign-in and enforces it server-side on every request.
- [ ] A test proves an agent session is rejected after its TTL even when the client keeps refreshing.
- [ ] Handoff URLs are used within 60 seconds, once, and never recorded.
