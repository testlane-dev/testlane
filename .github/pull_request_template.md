<!--
Never paste secrets, cookies, storage states, tokens or handoff URLs, in the description, the
diff, test fixtures or logs. Generate test values at run time.
Security fixes: coordinate through SECURITY.md before opening a public pull request.
-->

## What and why

<!-- One paragraph. Link the issue if there is one. -->

## Changes

-

## Security checklist

- [ ] No secret, cookie, token or handoff URL appears in code, fixtures, docs, logs or this description.
- [ ] Tests use a scratch `TESTLANE_HOME` and the in-memory store or a fake `spawn`; nothing touches a real vault or network.
- [ ] Every new path that loads a secret has a test asserting the secret is absent from output, errors, audit rows and written files.
- [ ] This change does / does not touch a file that needs a security review (`src/vault.ts`, `src/handoff.ts`, `src/policy.ts`, rotation in `src/commands.ts`, `src/lock.ts`, `src/redact.ts`, `src/audit.ts`, `src/store/**`, `src/mcp.ts`, `src/serve.ts`, argv handling in `src/cli.ts`, `examples/`).
- If it does: the guarantee(s) from SECURITY.md it touches, why they still hold, and the test that proves it:

## Verification

<!-- Exact commands and results. Paste counts, not artifacts. -->

```text
npm run check        -> exit 
tests:               passed / failed / skipped
```

- [ ] Docs updated where behaviour or boundaries changed (`docs/cli.md`, integration docs, threat model) and a `CHANGELOG.md` entry added.
- [ ] Commit messages follow Conventional Commits (`feat(scope): …`, `fix(scope): …`, `docs: …`).
