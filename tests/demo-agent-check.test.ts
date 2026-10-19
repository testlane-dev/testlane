/**
 * Unit tests for examples/demo-app/scripts/agent-check.mjs, the read-only
 * verifier behind docs/INTEGRATION-CLAUDE-CODE.md's "Real-agent acceptance
 * check". The verifier is plain ESM (no build step, dependency-free), so it
 * is exercised as a subprocess with synthetic report/audit fixtures rather
 * than imported: this is a decision-logic test (report + audit -> PASS/FAIL),
 * not a real-agent or real-broker test, and uses no real secrets anywhere.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "examples", "demo-app", "scripts", "agent-check.mjs");

const PROFILE = "demo:admin";
const PRODUCTION_PROFILE = "demo:production";
const REQUIRED_STEPS = [
  "profile-policy",
  "readiness",
  "broker-check",
  "session",
  "identity",
  "protected-page",
  "api",
  "anonymous-denied",
];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the verifier as a subprocess and never throws on a non-zero exit. */
function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function passingSteps(): Array<{ id: string; status: string; reasonCode: string; durationMs: number; attempt: number }> {
  return REQUIRED_STEPS.map((id) => ({ id, status: "passed", reasonCode: "ok", durationMs: 10, attempt: 1 }));
}

interface ReportOverrides {
  schemaVersion?: unknown;
  kind?: unknown;
  verdict?: unknown;
  profile?: unknown;
  steps?: unknown;
  finishedAt?: string;
}

function makeReport(overrides: ReportOverrides = {}): Record<string, unknown> {
  const finishedAt = overrides.finishedAt ?? new Date().toISOString();
  return {
    schemaVersion: overrides.schemaVersion ?? 1,
    kind: overrides.kind ?? "authenticated-smoke-report",
    workflowId: "demo-admin-smoke",
    runId: "run-test-1",
    startedAt: finishedAt,
    finishedAt,
    sourceTree: null,
    target: { origin: "http://localhost:3000", environment: "sandbox", actualBuild: null },
    profile: overrides.profile ?? PROFILE,
    steps: overrides.steps ?? passingSteps(),
    cleanup: { status: "complete", reasonCode: "ok" },
    verdict: overrides.verdict ?? "passed",
    counts: { required: 8, observed: 8, passed: 8, failed: 0, blocked: 0, cancelled: 0, skipped: 0, missing: 0 },
    missingRequiredSteps: [],
    skippedRequiredSteps: [],
    zeroChecks: false,
  };
}

interface AuditRowInput {
  ts?: string;
  event: string;
  profile: string;
  host?: string;
  environment?: string;
  strategy?: string;
  requester: string;
  ok: boolean;
}

function auditRow(overrides: AuditRowInput): Record<string, unknown> {
  return {
    ts: overrides.ts ?? new Date().toISOString(),
    event: overrides.event,
    profile: overrides.profile,
    host: overrides.host ?? "localhost:3000",
    environment: overrides.environment ?? "sandbox",
    strategy: overrides.strategy ?? "nextauth-credentials",
    requester: overrides.requester,
    ok: overrides.ok,
  };
}

function passingAuditRows(): Record<string, unknown>[] {
  return [
    auditRow({ event: "check", profile: PROFILE, requester: "claude-code", ok: true }),
    auditRow({ event: "refused", profile: PRODUCTION_PROFILE, environment: "production", requester: "claude-code", ok: false }),
  ];
}

let tmpDir: string;
let outputDir: string;
let home: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-check-test-"));
  outputDir = path.join(tmpDir, "output");
  home = path.join(tmpDir, "home");
  await Promise.all([writeFile(path.join(tmpDir, ".keep"), "")]);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeReportFile(name: string, report: Record<string, unknown>): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  await writeFile(file, `${JSON.stringify(report)}\n`, "utf8");
  return file;
}

async function writeAuditLog(rows: Record<string, unknown>[]): Promise<void> {
  await mkdir(home, { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  await writeFile(path.join(home, "audit.ndjson"), text, "utf8");
}

function auditLogText(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}

describe("examples/demo-app/scripts/agent-check.mjs", () => {
  it("PASS: a passing report plus a clean, agent-labelled audit log", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog(passingAuditRows());

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.stdout).toContain("VERDICT: PASS");
    expect(result.status).toBe(0);
  });

  it(
    "PASS: finds the default report even when run with cwd = examples/demo-app " +
      "(the shape of `npm --prefix examples/demo-app run agent-check`)",
    async () => {
      // A self-contained skeleton that mirrors the real repo's own relative layout
      // (<root>/examples/demo-app/scripts/agent-check.mjs, <root>/output/*.report.json),
      // entirely inside a fresh temp dir -- never the real repo's output/, which other
      // things may be writing to concurrently, and which this suite must not touch.
      const fakeRepoRoot = await mkdtemp(path.join(os.tmpdir(), "agent-check-cwd-test-"));
      try {
        const fakeDemoAppDir = path.join(fakeRepoRoot, "examples", "demo-app");
        const fakeScriptsDir = path.join(fakeDemoAppDir, "scripts");
        const fakeOutputDir = path.join(fakeRepoRoot, "output");
        const fakeHome = path.join(fakeRepoRoot, "home");
        await mkdir(fakeScriptsDir, { recursive: true });
        await mkdir(fakeOutputDir, { recursive: true });
        await mkdir(fakeHome, { recursive: true });

        // The real, current source file -- this exercises today's actual code, not a
        // frozen copy, so it stays a real regression test as the script evolves.
        const fakeScriptPath = path.join(fakeScriptsDir, "agent-check.mjs");
        await copyFile(scriptPath, fakeScriptPath);

        await writeFile(path.join(fakeOutputDir, "workflow-smoke-fake.report.json"), `${JSON.stringify(makeReport())}\n`, "utf8");
        await writeFile(path.join(fakeHome, "audit.ndjson"), auditLogText(passingAuditRows()), "utf8");

        const result = (() => {
          try {
            // No --report, no --output-dir: this is exactly the default-resolution code
            // path that used to default to `<cwd>/output` and therefore never found a
            // report when cwd was examples/demo-app -- npm's own `--prefix` flag sets
            // cwd to the target package directory, so this reproduces that shape without
            // needing npm itself in the test.
            const stdout = execFileSync(process.execPath, [fakeScriptPath, "--home", fakeHome, "--skip-production-check"], {
              encoding: "utf8",
              cwd: fakeDemoAppDir,
            });
            return { status: 0, stdout };
          } catch (error) {
            const err = error as { status?: number; stdout?: string };
            return { status: err.status ?? 1, stdout: err.stdout ?? "" };
          }
        })();

        expect(result.stdout).toMatch(/report found\s+PASS/);
        expect(result.stdout).toContain("VERIFIER VERDICT: PASS");
        expect(result.status).toBe(0);
      } finally {
        await rm(fakeRepoRoot, { recursive: true, force: true });
      }
    },
  );

  it("FAIL: a report whose verdict is not passed", async () => {
    const reportFile = await writeReportFile(
      "workflow-smoke-1.report.json",
      makeReport({
        verdict: "failed",
        steps: [
          { id: "profile-policy", status: "passed", reasonCode: "ok", durationMs: 1, attempt: 1 },
          { id: "readiness", status: "failed", reasonCode: "assertion-failed", durationMs: 1, attempt: 1 },
        ],
      }),
    );
    await writeAuditLog(passingAuditRows());

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VERDICT: FAIL");
    expect(result.stdout).toMatch(/verdict=passed\s+FAIL/);
    expect(result.stdout).toMatch(/8\/8 required steps passed\s+FAIL/);
  });

  it("FAIL: no report found", async () => {
    await writeAuditLog(passingAuditRows());
    // outputDir is never created: nothing to find.

    const result = run(["--output-dir", outputDir, "--home", home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VERDICT: FAIL");
    expect(result.stdout).toMatch(/report found\s+FAIL/);
    expect(result.stdout).toContain("no authenticated-smoke *.report.json found");
  });

  it("FAIL: the newest report predates --since (stale)", async () => {
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await writeReportFile("workflow-smoke-old.report.json", makeReport({ finishedAt: old }));
    await writeAuditLog(passingAuditRows());
    const since = new Date().toISOString();

    const result = run(["--output-dir", outputDir, "--home", home, "--since", since]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VERDICT: FAIL");
    expect(result.stdout).toMatch(/report found\s+FAIL/);
    expect(result.stdout).toContain("none at or after --since");
  });

  it("FAIL: a successful store.set row in the audit window", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog([...passingAuditRows(), auditRow({ event: "store.set", profile: PROFILE, requester: "claude-code", ok: true })]);

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VERDICT: FAIL");
    expect(result.stdout).toMatch(/zero successful store\/rotate events\s+FAIL/);
    expect(result.stdout).toContain("store.set");
  });

  it("FAIL: a successful rotate row in the audit window", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog([...passingAuditRows(), auditRow({ event: "rotate", profile: PROFILE, requester: "codex", ok: true })]);

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/zero successful store\/rotate events\s+FAIL/);
  });

  it("FAIL: the only demo:admin row is a non-agent requester", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog([
      auditRow({ event: "check", profile: PROFILE, requester: "cli", ok: true }),
      auditRow({ event: "refused", profile: PRODUCTION_PROFILE, environment: "production", requester: "cli", ok: false }),
    ]);

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VERDICT: FAIL");
    expect(result.stdout).toMatch(new RegExp(`agent session/check for ${PROFILE.replace(":", "\\:")}\\s+FAIL`));
  });

  it("PASS: --skip-production-check drops the production-refusal requirement", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog([auditRow({ event: "check", profile: PROFILE, requester: "claude-code", ok: true })]);

    const result = run(["--report", reportFile, "--home", home, "--skip-production-check"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VERDICT: PASS");
  });

  it("FAIL: without --skip-production-check, a missing production refusal fails", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog([auditRow({ event: "check", profile: PROFILE, requester: "claude-code", ok: true })]);

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(new RegExp(`refused attempt for ${PRODUCTION_PROFILE.replace(":", "\\:")}\\s+FAIL`));
  });

  it("FAIL: the report and the audit rows are internally fine but from different runs (no timestamp overlap)", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport({ finishedAt: now.toISOString() }));
    // The only agent row is timestamped two hours before the report's own run window.
    await writeAuditLog([auditRow({ ts: twoHoursAgo, event: "check", profile: PROFILE, requester: "claude-code", ok: true })]);

    const result = run(["--report", reportFile, "--home", home, "--skip-production-check"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/agent audit row inside report run window\s+FAIL/);
    expect(result.stdout).toContain("may be from different runs");
    // The audit-log section itself still passes: it does have an agent row for the profile.
    expect(result.stdout).toMatch(new RegExp(`agent session/check for ${PROFILE.replace(":", "\\:")}\\s+PASS`));
  });

  it("FAIL: the report file's mtime predates its correlated audit row (impossible for a real run)", async () => {
    const now = new Date();
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport({ finishedAt: now.toISOString() }));
    await writeAuditLog([auditRow({ ts: now.toISOString(), event: "check", profile: PROFILE, requester: "claude-code", ok: true })]);
    // Back-date the report file well past the stale-mtime tolerance (2s).
    const tenMinutesBeforeNow = new Date(now.getTime() - 10 * 60 * 1000);
    await utimes(reportFile, tenMinutesBeforeNow, tenMinutesBeforeNow);

    const result = run(["--report", reportFile, "--home", home, "--skip-production-check"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/report file mtime consistent with audit row\s+FAIL/);
    expect(result.stdout).toContain("a real run always appends its audit rows before it writes the report");
  });

  it("WARN only: the report file's mtime is much later than its correlated audit row, but the verdict still passes", async () => {
    const now = new Date();
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport({ finishedAt: now.toISOString() }));
    await writeAuditLog([auditRow({ ts: now.toISOString(), event: "check", profile: PROFILE, requester: "claude-code", ok: true })]);
    // Move the report file's mtime forward well past the drift-warning threshold (30m),
    // e.g. as if the evidence had been copied into place well after the run.
    const fortyMinutesAfterNow = new Date(now.getTime() + 40 * 60 * 1000);
    await utimes(reportFile, fortyMinutesAfterNow, fortyMinutesAfterNow);

    const result = run(["--report", reportFile, "--home", home, "--skip-production-check"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VERIFIER VERDICT: PASS");
    expect(result.stdout).toMatch(/report file mtime consistent with audit row\s+WARN/);
    expect(result.stdout).toContain("its timestamps may not be trustworthy");
  });

  it("prints the required human transcript checks (deny probes and run provenance) alongside the verifier verdict", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog(passingAuditRows());

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.stdout).toContain("Deny probes:");
    expect(result.stdout).toContain("Run provenance:");
    expect(result.stdout).toContain("authenticated-smoke/run.mjs --manifest");
    expect(result.stdout).toContain("necessary but not sufficient for the runbook's overall verdict");
  });

  it("never prints a raw audit row (no 'host' or 'strategy' field names leak into output)", async () => {
    const reportFile = await writeReportFile("workflow-smoke-1.report.json", makeReport());
    await writeAuditLog(passingAuditRows());

    const result = run(["--report", reportFile, "--home", home]);

    expect(result.stdout).not.toContain("nextauth-credentials");
    expect(result.stdout).not.toContain('"host"');
  });
});
