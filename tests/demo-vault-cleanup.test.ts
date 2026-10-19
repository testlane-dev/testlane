/**
 * `npm run clean` (and the end of `npm run smoke` / the workflow proof) must
 * delete the demo's two stored secrets with the broker's `store delete`: on
 * macOS and Linux they live in the user's own keychain, not under the demo's
 * TESTLANE_HOME, so removing .demo/ alone would leave them behind.
 *
 * Drives deleteVaultEntries (examples/demo-app/scripts/lib.mjs) with a fake
 * broker script, so no real keychain, vault or network is involved. The
 * state folder is a scratch directory (DEMO_STATE_DIR is read at import time).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "demo-vault-cleanup-"));
const stateDir = path.join(scratch, "state");
const fakeBroker = path.join(scratch, "fake-broker.mjs");
const callLog = path.join(scratch, "calls.log");

writeFileSync(
  fakeBroker,
  `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.env.FAKE_MODE === "ok") {
  process.stdout.write("deleted secret for " + process.argv[4] + "\\n");
} else if (process.env.FAKE_MODE === "no-keychain") {
  process.stderr.write("no keychain available: install secret-tool\\n");
  process.exit(1);
} else {
  process.stderr.write("secret-service delete failed (exit 1): the keyring is locked\\n");
  process.exit(1);
}
`,
);

process.env["DEMO_STATE_DIR"] = stateDir;
process.env["FAKE_LOG"] = callLog;
const lib = (await import(pathToFileURL(path.join(repo, "examples", "demo-app", "scripts", "lib.mjs")).href)) as {
  deleteVaultEntries: (broker: { prefix: string[] }, say?: (line: string) => void) => Promise<string[]>;
  VAULT_PROFILES: string[];
  PROFILES_FILE: string;
};
const broker = { prefix: [fakeBroker] };

beforeEach(() => {
  rmSync(callLog, { force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function calls(): string[] {
  return existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [];
}

describe("deleteVaultEntries", () => {
  it("names exactly the two seeded profiles", () => {
    expect(lib.VAULT_PROFILES).toEqual(["demo:admin", "demo:handoff:qa"]);
  });

  it("runs `store delete` for each seeded profile, writing the registry first when it is missing", async () => {
    process.env["FAKE_MODE"] = "ok";
    const said: string[] = [];
    const failed = await lib.deleteVaultEntries(broker, (line) => said.push(line));
    expect(failed).toEqual([]);
    expect(calls()).toEqual(["store delete demo:admin", "store delete demo:handoff:qa"]);
    expect(said).toEqual(["deleted secret for demo:admin", "deleted secret for demo:handoff:qa"]);
    const registry = JSON.parse(readFileSync(lib.PROFILES_FILE, "utf8")) as { profiles: Record<string, unknown> };
    expect(Object.keys(registry.profiles)).toEqual(["demo:admin", "demo:handoff:qa", "demo:production"]);
  });

  it("reports the profiles it could not delete (for example a locked keyring)", async () => {
    process.env["FAKE_MODE"] = "locked";
    const said: string[] = [];
    const failed = await lib.deleteVaultEntries(broker, (line) => said.push(line));
    expect(failed).toEqual(["demo:admin", "demo:handoff:qa"]);
    expect(said[0]).toContain("store delete demo:admin failed (exit 1)");
  });

  it("does not count 'no keychain available' as a failure: nothing could have been stored", async () => {
    process.env["FAKE_MODE"] = "no-keychain";
    const said: string[] = [];
    const failed = await lib.deleteVaultEntries(broker, (line) => said.push(line));
    expect(failed).toEqual([]);
    expect(said[0]).toContain("nothing to delete");
  });
});
