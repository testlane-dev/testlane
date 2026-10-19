# Local account provisioning experiment: acceptance evidence

This is a **source-only experiment**, not a released npm/CLI/MCP feature or an
external authentication-provider integration. The [experiment guide](../../../examples/account-provisioning/README.md)
describes its authority, limits and recovery contract.

The sanitized [receipt](receipt.json) records a Windows DPAPI acceptance run on
2026-10-19. It used the synthetic loopback backend and the source adapter/controller
from this checkout, plus a fresh npm pack installed into an isolated consumer.
The broker retains the baseline version string `0.7.0-beta.2`; the receipt's
`fresh-source-pack` mode and tree digest identify the tested development bytes.
This is not a claim that the already published registry artifact includes account
provisioning. The proof explicitly verifies that the prototype is absent from the
installed package.

The observed flow was:

- Generate separate Editor and Reviewer accounts with fixed ten-minute grants.
- Seed generated passwords through stdin into scratch DPAPI profiles; obtain live
  sessions through the actual installed broker.
- Confirm the app's exact account identity and role, then observe each role's
  allowed operation (200) and denied inverse operation (403).
- Revoke/delete only the two journal-owned accounts. Both existing sessions and
  subsequent sign-ins return 401 while the same server remains running.
- Confirm an unrelated control account remains unchanged and its session usable.
- Delete both attempted native-store entries and verify their absence, remove
  session files, confirm owned helper termination, and scan outputs/private state
  for raw, URI, base64 and base64url forms of generated passwords/session tokens.

`sourceHashes` and `supportHashes` bind the prototype and imported support code
before/after execution. The actual source native-child helper must match its
installed-package counterpart. `installedBrokerTreeSha256` uses sorted canonical
JSON `[normalized relative path, SHA256(file bytes)]` tuples; its regression test
rejects an ambiguity that raw filename/file-byte concatenation would permit.

Reproduce from a built source checkout using a new absolute output directory:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:account-provisioning
npm.cmd run proof:account-provisioning -- --output-dir C:/temp/testlane-provision-proof-1
```

Unit tests additionally cover disabled/production/remote policies, role escalation,
arbitrary deletion, replay, concurrent target-wide quotas, rate-limit churn, expiry,
clock rollback, lost responses, pending create/credential delivery, failed cleanup,
foreign-ID tampering and corrupt/missing/aliased state. They run in the regular CI
check job without provider credentials or a native store.

The live proof demonstrates this local synthetic adapter and Windows DPAPI. It does
not demonstrate a hosted provider, remote quota system, browser or agent authoring,
macOS/Linux native-store acceptance, cross-machine recovery, malicious-code
sandboxing or power-failure durability. The bounded journal retains at most 1,000
runs and 1,000 lifetime operations. Real providers need separately reviewed
authority, disposable auth/database projects, delivery/billing controls and proven
session revocation; an environment label alone cannot establish those properties.
