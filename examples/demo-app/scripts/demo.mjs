#!/usr/bin/env node
/**
 * `npm run demo`: the five-minute tour of Testlane, zero external services.
 *
 *  1. generate throwaway secrets in memory, never printed or written to a file
 *  2. write .demo/testlane.profiles.json (demo:admin, demo:handoff:qa, demo:production)
 *  3. seed the vault over stdin with `testlane store set`. TESTLANE_HOME=.demo/home holds the
 *     audit log; only on Windows are the secrets inside it too (DPAPI files). On macOS and Linux
 *     they go into your login Keychain / Secret Service (service agent-auth); `npm run clean`
 *     deletes them
 *  4. start the demo app with its custom Next bootstrap on DEMO_PORT (default 3000)
 *  5. print the "try this" block
 *  6. stop cleanly on Ctrl+C
 */
import { rmSync } from "node:fs";
import path from "node:path";
import {
  IS_WINDOWS,
  STATE_DIR,
  assertPortFree,
  demoPort,
  ensureDemoDeps,
  generateSecrets,
  log,
  resolveBroker,
  seedVault,
  startApp,
  stopApp,
  tryThisBlock,
  vaultLocation,
  waitForApp,
  warmUp,
  writeProfiles,
} from "./lib.mjs";

let app = null;
let seeded = false;
let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (app) {
    log("stopping the demo app...");
    stopApp(app);
  }
  if (seeded && !IS_WINDOWS) {
    log("the demo's throwaway secrets are still in your keychain; delete them with:");
    log("  npm --prefix examples/demo-app run clean   (from the repo root)");
  }
  process.exitCode = code;
  // Give taskkill / SIGTERM a moment, then leave.
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

async function main() {
  const port = demoPort();
  await assertPortFree(port);

  ensureDemoDeps();
  const broker = resolveBroker();
  log(`broker: ${broker.kind === "dist" ? "dist/cli.js" : "tsx src/cli.ts"} (home folder .demo/home)`);

  const secrets = generateSecrets();
  log("generated throwaway secrets in memory (not printed or written to a file)");
  writeProfiles(port);
  log("wrote .demo/testlane.profiles.json");
  rmSync(path.join(STATE_DIR, "jar.txt"), { force: true }); // `session --out` never overwrites

  await seedVault(broker, secrets);
  seeded = true;
  log("seeded demo:admin (password) and demo:handoff:qa (handoff secret) via stdin");
  log(`they are stored in ${vaultLocation()}`);

  log(`starting the demo app on port ${port} (first compile takes a few seconds)...`);
  app = startApp(port, secrets, (_stream, line) => {
    if (line.trim() !== "") process.stdout.write(`[app] ${line}\n`);
  });
  app.on("exit", (code) => {
    if (!stopping) {
      log(`the app exited (code ${code})`);
      shutdown(code === 0 ? 0 : 1);
    }
  });

  await waitForApp(port, app);
  await warmUp(port);
  process.stdout.write(`${tryThisBlock(port, broker)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[demo] ${err instanceof Error ? err.message : String(err)}\n`);
  shutdown(1);
});
