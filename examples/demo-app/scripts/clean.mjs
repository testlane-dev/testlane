#!/usr/bin/env node
/**
 * `npm run clean`: delete the demo's stored secrets and the whole .demo/ folder.
 *
 * Only on Windows do the secrets live inside .demo/home (DPAPI files). On macOS
 * and Linux they are items in your login Keychain / Secret Service (service
 * agent-auth, keys agent-auth/demo:admin and agent-auth/demo:handoff:qa) that
 * TESTLANE_HOME does not isolate, so removing .demo/ would leave them behind.
 * They are therefore deleted first, with the built CLI's `store delete`, on
 * every platform and whether or not .demo/ still exists (`npm run smoke` and
 * the workflow proof use other folders under it, but the same two entries).
 *
 * Exits 1 when an entry could not be deleted (for example a locked keyring):
 * unlock it and run `npm run clean` again.
 */
import { rmSync } from "node:fs";
import { STATE_DIR, deleteVaultEntries, log, resolveBroker } from "./lib.mjs";

let failed = [];
try {
  failed = await deleteVaultEntries(resolveBroker());
} catch (err) {
  log(`could not delete vault entries: ${err instanceof Error ? err.message : String(err)}`);
  failed = ["(all)"];
}
rmSync(STATE_DIR, { recursive: true, force: true });
log("removed .demo/");
if (failed.length > 0) {
  log("some stored secrets are still in your keychain: unlock it and run `npm run clean` again");
  process.exitCode = 1;
}
