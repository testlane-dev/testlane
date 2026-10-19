# Designing cases from a feature brief

Keep expectations separate from the current implementation. Find selectors and response fields in the repository, but derive permitted behavior from the user's brief, app contracts or an established test oracle. Record an unresolved requirement instead of guessing.

For each proposed case, make these decisions concrete:

| Decision | What to record |
| --- | --- |
| Requirement | The user behavior or permission rule this case covers |
| Identity | Actual signed-in identity to compare with the approved account; roles alone are insufficient |
| Action | UI interaction and/or API request against discovered app routes |
| Oracle | Exact status, state transition, visible output or invariant |
| Negative boundary | Relevant anonymous/alternate-role request and proof that a rejected mutation did not alter state |
| Data ownership | How this run identifies only its own disposable records |
| Cleanup | Who can remove them, how absence is verified, and what blocks replay after interruption |
| Evidence | Minimal local facts needed to review the result; screenshots only if authorized |

## Example brief, not a fixed test suite

> In our local team-notes app, a writer can publish a draft. A reader can view published notes but cannot publish or edit them. Anonymous users cannot read the notes API. Verify this in the browser and API. You may create and delete notes owned by this run in the sandbox. Use the existing writer and reader test profiles. Do not retain screenshots.

The agent must inspect that app to discover its actual routes, selectors, expected response fields and deletion mechanism. A plausible case plan might include:

| ID | Concrete check to resolve against the app |
| --- | --- |
| identity | Both contexts identify the expected distinct accounts |
| writer-publish | The writer creates and publishes an owned note; API readback and the reader's page show that note |
| reader-denied | A reader publication/edit request receives the contract's denial and a fresh read proves the note unchanged |
| anonymous-denied | A separate unauthenticated request cannot read the protected resource |

Each mutating case needs a verified cleanup obligation. Case IDs and grouping may change with the app's test architecture; do not copy these as canned checks for an unrelated feature. Choose whether identity belongs inside each feature case or in a separate case so that a feature cannot pass using the wrong account.

## Execution details that change the conclusion

- Use the authenticated context's request API, with redirects disabled where a status or origin is part of the oracle. Check response success before parsing JSON; avoid attaching raw error responses.
- A hidden button is useful UI evidence but insufficient for an authorization claim. Test the underlying protected operation and unchanged state when relevant.
- A distinct profile name is insufficient for parallel isolation. The fixture checks declared account emails; the app still needs isolated records and a separate mapping for another invocation.
- Test cleanup under the role allowed to delete the owned record. If setup partially fails, retain only the case/run marker and owned cleanup identifier in a separate ignored app journal; Playwright temporary output is not retained for recovery. Do not swallow a cleanup failure to preserve a green report.
- Cookie sessions are the fixture's supported mechanism. Token-header or browser storage mechanisms need a separately reviewed adapter, not an invented storage-state conversion.
- Navigation guards detect/reject observed off-origin documents; they do not provide network containment. Review target pages/endpoints for side effects.
