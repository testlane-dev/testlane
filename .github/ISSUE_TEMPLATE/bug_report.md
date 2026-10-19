---
name: Bug report
about: Something in Testlane does not work as documented
title: ""
labels: bug
assignees: ""
---

<!--
STOP: never paste a secret, password, PIN, cookie value, storage state, curl cookie jar,
header value, HTTP bearer token or handoff URL into this issue, not even an expired one.
Replace every such value with <redacted>. Use *.test / *.example hosts and @example.test emails.

If this could be a security problem (a secret leaking, a production profile or host being
reached, a handoff code accepted twice, rotation losing a credential, a permission-rule gap),
do NOT open an issue. Follow SECURITY.md instead.
-->

## What happened

<!-- One or two sentences. -->

## What you expected

## Environment

- Testlane version: <!-- npm ls -g @testlane/cli, or package.json version of your checkout -->
- OS and version: <!-- e.g. Windows 11 23H2, macOS 15.1, Ubuntu 24.04 -->
- Node version: <!-- node --version -->
- Store kind: <!-- dpapi | keychain-macos | secret-service | encrypted-file (and TESTLANE_STORE if set) -->
- Strategy: <!-- nextauth-credentials | form-post | dependent-token | app-handoff | other -->
- Surface: <!-- CLI | MCP | HTTP (serve) -->
- Agent / harness, if relevant: <!-- e.g. Claude Code 2.x on PowerShell, Codex CLI -->

## Command and result

<!--
The exact command (or MCP tool call / HTTP request) with secrets removed, and the exit code.
Include stderr. Replace any artifact output with <redacted>.
-->

```text
$ testlane ...
exit code: 
```

## Profile (redacted)

<!-- The relevant profile entry with hosts and emails replaced by *.test / *.example values. -->

```json
```

## Audit rows (optional)

<!-- Output of `testlane audit --tail 5` for the attempt. Audit rows contain no secrets, but check
     anyway. -->

## Steps to reproduce

1.
2.
3.

- [ ] I confirm this issue contains no secret, cookie, storage state, token or handoff URL.
