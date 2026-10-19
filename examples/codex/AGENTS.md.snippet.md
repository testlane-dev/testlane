## Sign into test apps with Testlane

Use the human-approved Testlane registry. The broker holds stored passwords and issues
session credentials for the approved sandbox/test accounts.

- Discover approved profiles with `testlane profiles` or MCP `list_profiles`.
- `check <profile>` performs a separate sign-in and reports identity; it does not
  authenticate the browser you are using.
- Prefer MCP `session_file` when the browser/API client shares the broker's
  filesystem. Pass the returned path directly to the client; do not read the file.
  Call `release_session_file` with its cleanup id after loading, using `finally` to
  release it on setup failure. Close the browser context when checks finish.
- If MCP file delivery is unavailable, use the repo's documented CLI recipe:
  `session <profile> --format storage-state --out <fresh-file>` or `--format curl`.
  Use a fresh ignored per-run path, load it into the intended client, then remove it.
- MCP `session` returns live credentials inline; use it only when the client needs
  that contract. Never print, commit, upload or paste session files. Removing a file
  does not revoke the app's session.
- A URL-only browser needs `handoff <profile>` and the app's handoff route. Open the
  returned URL once within 60 seconds; do not copy it into logs or screenshots.
- Never ask for or enter a stored password/PIN/key, read a credential store, run
  `store set|delete` or `rotate`, change account overrides, or edit/substitute a
  registry/home (`--profiles`, `TESTLANE_PROFILES`, `TESTLANE_HOME` or legacy names).
  Those are human operations. Do not write session credential values yourself.
- Exit 2: stop on policy refusal. Exit 3: check app availability and report sign-in
  failure. Exit 4/6: ask the human to inspect the profile/keychain and run `store set`
  if appropriate. Exit 5: stop and report command misuse. See the repo's exit-code guide.
- `status` and `audit` report metadata. Report pending/overdue rotation alerts; let the
  human resolve them. A changed account email after a sandbox reset needs human
  `account set <profile> --email <new email>`, not a registry edit by the agent.
