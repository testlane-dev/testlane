#!/usr/bin/env node
/**
 * Real-broker workflow proof for the bundled demo app: runs the UNMODIFIED
 * `examples/workflows/authenticated-smoke/run.mjs` CLI as a child process
 * against the REAL, running Testlane demo app (Next.js 15 + next-auth v4,
 * `nextauth-credentials` strategy) and the real built broker CLI
 * (`dist/cli.js`), inside the demo's own throwaway state directory.
 *
 * This is the `nextauth-credentials` companion to
 * examples/workflows/test-support/smoke-real-broker-proof.mjs, which only
 * proves the `form-post` strategy against a dependency-free fixture app.
 * Here the target is a real Next.js app with real routing, SSR redirects and
 * next-auth's own CSRF/callback/session endpoints.
 *
 * Cases (same app + vault instance; only the manifest differs):
 *   happy       - demo:admin, correct identity: all 8 required steps pass.
 *   wrong-role  - demo:admin profile, manifest identity role "QA" (the
 *                 registry says "Admin" for demo:admin): the profile-policy
 *                 step refuses before any broker-check/session call, so the
 *                 broker never asks the app to sign anyone in for this case
 *                 (verified two ways: the only observed step is
 *                 profile-policy, and the scratch audit log gains no new
 *                 rows).
 *
 * The manifest's target.buildId is intentionally omitted: the demo app never
 * sends an X-Build-Id header, and the smoke runner's readiness build check
 * (authenticated-smoke/runtime.mjs fetchStatus) is skipped whenever
 * target.buildId is undefined. That is by design here, not a gap -- the
 * happy case instead asserts actualBuild stays null.
 *
 * Isolation: DEMO_STATE_DIR and DEMO_NEXT_DIST_DIR are set to a unique
 * folder under examples/demo-app *before* lib.mjs is imported (it reads
 * these env vars at module load time), so the broker home, registry and Next
 * build output are throwaway, unique to this run, and removed again in
 * `finally`. The vault is inside that folder only on Windows (DPAPI files);
 * on Linux the two seeded secrets are items in the user's own keyring (the
 * same names `npm run demo` uses), so `finally` also deletes them with
 * `store delete`.
 *
 * No secret ever reaches argv, an environment variable inherited by a child
 * we spawn, a log line, or a file other than over broker stdin. Leak checks
 * are booleans only (see verifyNoLeaks): never a comparison that could echo
 * a generated value. Exit 0 only when every case met its expectations, 1
 * when any failed, 2 when a prerequisite is missing -- never a green skip.
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { realBrokerSupport } from "../../workflows/test-support/real-broker.mjs";

const MAX_CAPTURE = 64 * 1024;
const SMOKE_TIMEOUT_MS = 90_000;
const CASE_NAMES = ["happy", "wrong-role"];

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function boundedText(value) {
  return typeof value === "string" ? value.slice(0, MAX_CAPTURE) : "";
}

function textContainsAny(haystack, needles) {
  return needles.some((needle) => typeof needle === "string" && needle.length > 0 && haystack.includes(needle));
}

function leaksAreClean(leaks) {
  return Object.values(leaks).every((value) => value === false);
}

async function readTextOrEmpty(file) {
  if (file === null || file === undefined) return "";
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function auditRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // malformed line: ignored, never surfaced
    }
  }
  return rows;
}

function countAuditEvents(text, profile, event, ok) {
  return auditRows(text).filter((row) => row?.profile === profile && row?.event === event && row?.ok === ok).length;
}

/** An ephemeral loopback port: bind :0, read the assignment, close, and use it for the app. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close((err) => {
        if (err) reject(err);
        else if (port === null) reject(new Error("could not determine a free port"));
        else resolve(port);
      });
    });
  });
}

async function listSmokeEvidence(dir) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  const reportName = entries.find((f) => f.endsWith(".report.json"));
  const logName = entries.find((f) => f.endsWith(".log"));
  const exitName = entries.find((f) => f.endsWith(".exit"));
  return {
    reportPath: reportName !== undefined ? path.join(dir, reportName) : null,
    logPath: logName !== undefined ? path.join(dir, logName) : null,
    exitPath: exitName !== undefined ? path.join(dir, exitName) : null,
  };
}

/** Run the UNMODIFIED smoke CLI as a child process: an executable path plus argv, shell:false. */
function runSmokeChild(smokeRunPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeRunPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: SMOKE_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: boundedText(stdout), stderr: boundedText(stderr) }));
  });
}

async function verifyNoLeaks({ secrets, smokeResult, evidence, manifestPath, registryPath, auditText }) {
  const [reportText, logText, exitText, manifestText, registryText] = await Promise.all([
    readTextOrEmpty(evidence.reportPath),
    readTextOrEmpty(evidence.logPath),
    readTextOrEmpty(evidence.exitPath),
    readTextOrEmpty(manifestPath),
    readTextOrEmpty(registryPath),
  ]);
  return {
    stdout: textContainsAny(smokeResult.stdout, secrets),
    stderr: textContainsAny(smokeResult.stderr, secrets),
    report: textContainsAny(reportText, secrets),
    log: textContainsAny(logText, secrets),
    exit: textContainsAny(exitText, secrets),
    manifest: textContainsAny(manifestText, secrets),
    registry: textContainsAny(registryText, secrets),
    auditLog: textContainsAny(auditText, secrets),
  };
}

// ---------------------------------------------------------------------------
// Isolation: DEMO_STATE_DIR (and DEMO_NEXT_DIST_DIR) must be set *before*
// lib.mjs is imported -- it reads them at module load time.
// ---------------------------------------------------------------------------

const RUN_SUFFIX = `${Date.now().toString(36)}-${randomHex(4)}`;
const STATE_DIR_REL = `.demo/workflow-proof-${RUN_SUFFIX}`;
const NEXT_DIST_DIR_REL = `.next-workflow-proof-${RUN_SUFFIX}`;
process.env.DEMO_STATE_DIR ||= STATE_DIR_REL;
process.env.DEMO_NEXT_DIST_DIR ||= NEXT_DIST_DIR_REL;

const {
  DEMO_DIR,
  REPO_ROOT,
  STATE_DIR,
  HOME_DIR,
  PROFILES_FILE,
  PROFILE_ADMIN,
  assertPortFree,
  baseUrlFor,
  brokerEnv,
  deleteVaultEntries,
  demoPort,
  generateSecrets,
  resolveBroker,
  seedVault,
  startApp,
  stopApp,
  waitForApp,
  warmUp,
  writeProfiles,
} = await import("./lib.mjs");

const brokerCli = path.join(REPO_ROOT, "dist", "cli.js");
const contractsPath = path.join(REPO_ROOT, "dist", "workflows", "contracts.js");
const smokeDir = path.join(REPO_ROOT, "examples", "workflows", "authenticated-smoke");
const smokeRunPath = path.join(smokeDir, "run.mjs");
const nextPackagePath = path.join(DEMO_DIR, "node_modules", "next", "package.json");

// ---------------------------------------------------------------------------
// One case: build a secret-free manifest against the running demo app, run
// the unmodified smoke CLI as a child, and check the observed report, the
// real broker audit log and the leak checks against expectations.
// ---------------------------------------------------------------------------

async function runCase(caseName, ctx) {
  const identity =
    caseName === "wrong-role" ? { email: "admin@demo.test", role: "QA" } : { email: "admin@demo.test", role: "Admin" };
  const manifest = {
    schemaVersion: 1,
    kind: "authenticated-smoke",
    id: `demo-real-broker-${caseName}`,
    profile: PROFILE_ADMIN,
    target: { origin: ctx.origin, environment: "sandbox" }, // no buildId: the demo sends no X-Build-Id
    identity,
    checks: {
      readinessPath: "/api/auth/csrf",
      identityPath: "/api/me",
      protectedPath: "/",
      protectedHeading: "Testlane demo",
      apiPath: "/api/me",
    },
    timeoutMs: 60_000,
  };

  const caseDir = path.join(ctx.stateDir, `case-${caseName}`);
  await mkdir(caseDir, { recursive: true });
  const manifestPath = path.join(caseDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const smokeOutputDir = path.join(caseDir, "smoke-output");
  await mkdir(smokeOutputDir, { recursive: true });

  const auditPath = path.join(HOME_DIR, "audit.ndjson");
  const auditTextBefore = await readTextOrEmpty(auditPath);
  const auditRowsBefore = auditRows(auditTextBefore).length;
  const checkOkBefore = countAuditEvents(auditTextBefore, PROFILE_ADMIN, "check", true);
  const sessionOkBefore = countAuditEvents(auditTextBefore, PROFILE_ADMIN, "session", true);

  const env = brokerEnv({ TESTLANE_STORE: ctx.store, AGENT_AUTH_STORE: "" });
  const smokeArgs = ["--manifest", manifestPath, "--broker-cli", ctx.brokerCli, "--output-dir", smokeOutputDir, "--json"];
  const smokeResult = await runSmokeChild(smokeRunPath, smokeArgs, env);

  let report = null;
  try {
    report = JSON.parse(smokeResult.stdout.trim());
  } catch {
    report = null;
  }

  const evidence = await listSmokeEvidence(smokeOutputDir);
  const auditTextAfter = await readTextOrEmpty(auditPath);
  const auditRowsAfter = auditRows(auditTextAfter).length;
  const checkOkAfter = countAuditEvents(auditTextAfter, PROFILE_ADMIN, "check", true);
  const sessionOkAfter = countAuditEvents(auditTextAfter, PROFILE_ADMIN, "session", true);

  const leaks = await verifyNoLeaks({
    secrets: ctx.secrets,
    smokeResult,
    evidence,
    manifestPath,
    registryPath: PROFILES_FILE,
    auditText: auditTextAfter,
  });

  const observed = {
    exitCode: smokeResult.code,
    verdict: report?.verdict ?? null,
    steps: (report?.steps ?? []).map((step) => ({ id: step.id, status: step.status, reasonCode: step.reasonCode })),
    actualBuild: report?.target?.actualBuild ?? null,
  };
  const stepIds = observed.steps.map((step) => step.id);
  const stepStatus = (id) => observed.steps.find((step) => step.id === id)?.status;

  let expected;
  let assertions;
  if (caseName === "happy") {
    expected = {
      exitCode: 0,
      verdict: "passed",
      steps: "8/8 passed",
      actualBuild: null,
      auditCheckOkDelta: ">=1",
      auditSessionOkDelta: ">=1",
    };
    assertions = {
      exitCode: observed.exitCode === 0,
      verdict: observed.verdict === "passed",
      allStepsPassed: observed.steps.length === 8 && observed.steps.every((step) => step.status === "passed"),
      actualBuildNull: observed.actualBuild === null,
      auditCheckOk: checkOkAfter - checkOkBefore >= 1,
      auditSessionOk: sessionOkAfter - sessionOkBefore >= 1,
      evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
      noLeaks: leaksAreClean(leaks),
    };
  } else {
    expected = {
      exitCode: 1,
      verdict: "failed",
      profilePolicyStatus: "failed",
      onlyStep: "profile-policy",
      auditRowDelta: 0,
      note: "the app received no sign-in for this case: profile-policy refuses before broker-check/session are ever called",
    };
    assertions = {
      exitCode: observed.exitCode === 1,
      verdict: observed.verdict === "failed",
      profilePolicyFailed: stepStatus("profile-policy") === "failed",
      onlyProfilePolicyObserved: stepIds.length === 1 && stepIds[0] === "profile-policy",
      noNewAuditRows: auditRowsAfter === auditRowsBefore,
      evidencePresent: evidence.reportPath !== null && evidence.logPath !== null && evidence.exitPath !== null,
      noLeaks: leaksAreClean(leaks),
    };
  }

  const met = Object.values(assertions).every(Boolean);

  return {
    name: caseName,
    met,
    expected,
    observed,
    assertions,
    leaks,
    auditDelta: {
      checkOk: checkOkAfter - checkOkBefore,
      sessionOk: sessionOkAfter - sessionOkBefore,
      totalRows: auditRowsAfter - auditRowsBefore,
    },
    evidence: {
      report: evidence.reportPath !== null ? path.basename(evidence.reportPath) : null,
      log: evidence.logPath !== null ? path.basename(evidence.logPath) : null,
      exit: evidence.exitPath !== null ? path.basename(evidence.exitPath) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Proof evidence (create-only; never overwrites; never prints a case's raw
// stdout/stderr/report bytes -- only the derived summary above).
// ---------------------------------------------------------------------------

async function writeProofEvidence(outputDir, summary) {
  await mkdir(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  const stem = `demo-real-broker-proof-${ts}-${randomHex(3)}`;
  const jsonPath = path.join(outputDir, `${stem}.json`);
  const logPath = path.join(outputDir, `${stem}.log`);
  const exitPath = path.join(outputDir, `${stem}.exit`);
  const exitCode = summary.verdict === "passed" ? 0 : summary.verdict === "blocked" ? 2 : 1;
  const logLines =
    summary.cases.length > 0
      ? summary.cases.map((c) => `${c.name}: met=${c.met} exit=${c.observed?.exitCode ?? "n/a"} verdict=${c.observed?.verdict ?? "n/a"}`)
      : [`blocked: ${summary.prerequisites.reasons.join("; ") || "(unknown)"}`];
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(logPath, `${logLines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(exitPath, `${exitCode}\n`, { encoding: "utf8", flag: "wx" });
  return { exitCode, jsonPath, logPath, exitPath };
}

// ---------------------------------------------------------------------------
// Cleanup: remove exactly the unique state dir and Next dist dir this run
// created, both confined inside examples/demo-app. Never touches a live
// `npm run demo` / `npm run smoke` run (different DEMO_STATE_DIR).
// ---------------------------------------------------------------------------

async function cleanupDirs() {
  const expectedStateDir = path.resolve(DEMO_DIR, ".demo", `workflow-proof-${RUN_SUFFIX}`);
  if (path.resolve(STATE_DIR) === expectedStateDir) {
    await rm(expectedStateDir, { recursive: true, force: true });
  }
  const expectedNextDistDir = path.resolve(DEMO_DIR, `.next-workflow-proof-${RUN_SUFFIX}`);
  const actualNextDistDir = path.resolve(DEMO_DIR, NEXT_DIST_DIR_REL);
  if (actualNextDistDir === expectedNextDistDir) {
    await rm(expectedNextDistDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usage() {
  process.stderr.write("usage: node workflow-proof.mjs [--output-dir dir] [--json]\n");
}

function argsOf(argv, defaultOutputDir) {
  const out = { outputDir: defaultOutputDir, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--output-dir") out.outputDir = argv[++i];
    else {
      usage();
      throw new Error("USAGE");
    }
  }
  return out;
}

export async function runWorkflowProof(argv = []) {
  const startedAt = new Date().toISOString();
  const options = argsOf(argv, path.join(REPO_ROOT, "output"));

  const support = realBrokerSupport();
  const reasons = [];
  if (!support.supported) reasons.push(`real broker unsupported: ${support.reason}`);
  if (!existsSync(brokerCli)) reasons.push(`missing built broker CLI: run "npm run build" (expected ${brokerCli})`);
  if (!existsSync(contractsPath)) reasons.push(`missing built workflow contracts: run "npm run build" (expected ${contractsPath})`);
  if (!existsSync(smokeRunPath)) reasons.push(`missing smoke runner: ${smokeRunPath}`);
  if (!existsSync(nextPackagePath)) {
    reasons.push(`demo app dependencies are not installed: run "npm --prefix examples/demo-app ci" (expected ${nextPackagePath})`);
  }

  let chromiumExecutable = null;
  try {
    const requireFromSmoke = createRequire(path.join(smokeDir, "package.json"));
    const playwright = requireFromSmoke("playwright");
    chromiumExecutable = playwright.chromium.executablePath();
  } catch {
    reasons.push("playwright is not installed in examples/workflows/authenticated-smoke (npm install there)");
  }
  if (chromiumExecutable !== null && !existsSync(chromiumExecutable)) {
    reasons.push("chromium is not installed (npx playwright install chromium)");
  }

  if (reasons.length > 0) {
    const summary = {
      schemaVersion: 1,
      kind: "demo-real-broker-proof",
      strategy: "nextauth-credentials",
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      store: support.store,
      prerequisites: { ok: false, reasons },
      verdict: "blocked",
      cases: [],
    };
    const evidence = await writeProofEvidence(options.outputDir, summary);
    return { exitCode: evidence.exitCode, summary, evidence, options };
  }

  const broker = resolveBroker(); // dist/cli.js already confirmed present; root deps already installed

  let port;
  if (process.env.DEMO_PORT !== undefined && process.env.DEMO_PORT.trim() !== "") port = demoPort();
  else port = await getFreePort();
  await assertPortFree(port);
  const origin = baseUrlFor(port);

  const secretsObj = generateSecrets();
  const secretValues = Object.values(secretsObj);
  writeProfiles(port);

  let app = null;
  const cases = [];
  try {
    try {
      await seedVault(broker, secretsObj);
      app = startApp(port, secretsObj, () => {}); // app output is never inspected or echoed
      await waitForApp(port, app);
      await warmUp(port);

      for (const caseName of CASE_NAMES) {
        try {
          cases.push(
            await runCase(caseName, {
              origin,
              stateDir: STATE_DIR,
              store: support.store,
              secrets: secretValues,
              brokerCli,
            }),
          );
        } catch (err) {
          cases.push({ name: caseName, met: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      if (cases.length === 0) {
        cases.push({ name: "setup", met: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    stopApp(app);
    // On macOS and Linux the seeded secrets are in the user's own keychain, not in the state dir removed below.
    // Silent: with --json, stdout must stay one JSON document (a failure here never changes the verdict).
    await deleteVaultEntries(broker, () => {}).catch(() => {});
    await cleanupDirs();
  }

  const allMet = cases.length > 0 && cases.every((c) => c.met === true);
  const summary = {
    schemaVersion: 1,
    kind: "demo-real-broker-proof",
    strategy: "nextauth-credentials",
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    store: support.store,
    port,
    buildIdNote: "target.buildId omitted by design: the demo app sends no X-Build-Id header, so the readiness build check is skipped",
    prerequisites: { ok: true, reasons: [] },
    verdict: allMet ? "passed" : "failed",
    cases,
  };
  const evidence = await writeProofEvidence(options.outputDir, summary);
  return { exitCode: allMet ? 0 : 1, summary, evidence, options };
}

async function main(argv) {
  const { exitCode, summary, evidence, options } = await runWorkflowProof(argv);
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stdout.write(`${summary.verdict} (${evidence.jsonPath})\n`);
  return exitCode;
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): on macOS the OS tmpdir is itself a symlink (/var ->
// /private/var), so a script invoked as `node /var/.../workflow-proof.mjs`
// gets process.argv[1] === '/var/.../workflow-proof.mjs' while
// import.meta.url resolves to the realpath '/private/var/...' -- a plain
// path.resolve() compare never matches, main() silently never runs, and the
// process exits 0 with no output.
function isEntryPoint(metaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : "workflow-proof failed"}\n`);
    process.exitCode = 1;
  }
}
