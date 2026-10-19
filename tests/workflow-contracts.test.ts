import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import * as AjvModule from "ajv/dist/2020.js";
import * as AjvFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SMOKE_STEPS,
  deriveReport,
  parseReport,
  parseWorkflow,
  WorkflowManifestSchema,
  WorkflowReportSchema,
  type WorkflowReportDraft,
} from "../src/workflows/contracts.js";

const manifest = () => ({
  schemaVersion: 1 as const,
  kind: "authenticated-smoke" as const,
  id: "smoke-local",
  profile: "shop:sandbox:admin",
  target: { origin: "http://127.0.0.1:3020", environment: "sandbox" as const, buildId: "build-local-1" },
  identity: { email: "admin@example.test", role: "Admin" },
  checks: {
    readinessPath: "/api/health",
    identityPath: "/api/me",
    protectedPath: "/account",
    protectedHeading: "Account",
    apiPath: "/api/account",
  },
  timeoutMs: 30_000,
});

const draft = (overrides: Partial<WorkflowReportDraft> = {}): WorkflowReportDraft => ({
  schemaVersion: 1,
  kind: "authenticated-smoke-report",
  workflowId: "smoke-local",
  runId: "run-local-1",
  startedAt: "2026-09-24T12:00:00.000Z",
  finishedAt: "2026-09-24T12:00:01.000Z",
  sourceTree: "0123456789abcdef0123456789abcdef01234567",
  target: { origin: "http://127.0.0.1:3020", environment: "sandbox", actualBuild: "build-local-1" },
  profile: "shop:sandbox:admin",
  steps: REQUIRED_SMOKE_STEPS.map((id) => ({ id, status: "passed" as const, reasonCode: "ok" as const, durationMs: 1, attempt: 1, processExitCode: 0 })),
  cleanup: { status: "complete" as const },
  ...overrides,
});

describe("workflow contracts", () => {
  it("parses the exact manifest shape and rejects unknown keys", () => {
    expect(parseWorkflow(manifest()).timeoutMs).toBe(30_000);
    expect(() => parseWorkflow({ ...manifest(), extra: true })).toThrow();
    expect(() => parseWorkflow({ ...manifest(), timeoutMs: 999 })).toThrow();
    expect(() => parseWorkflow({ ...manifest(), profile: "Shop/Admin" })).toThrow();
  });

  it("refuses unsafe paths, origins, production tags and production hosts", () => {
    for (const pathValue of ["//other.example/api", "/api/%2Fsecret", "/api\\health", "https://other.example/api", "/api/health?x=1", "/api/health#x", "/a/../b"]) {
      expect(() => parseWorkflow({ ...manifest(), checks: { ...manifest().checks, readinessPath: pathValue } })).toThrow();
    }
    const credentialOrigin = `https://${randomBytes(8).toString("hex")}:${randomBytes(16).toString("hex")}@example.test`;
    for (const origin of [credentialOrigin, "https://example.test/path", "https://example.test/?x=1", "http://example.test", "https://production.example.test", "https://app.prod.example.test"]) {
      expect(() => parseWorkflow({ ...manifest(), target: { ...manifest().target, origin } })).toThrow();
    }
    expect(() => parseWorkflow({ ...manifest(), target: { ...manifest().target, environment: "production" as never } })).toThrow();
  });

  it("normalizes accepted trailing slash origins for manifests and reports", () => {
    const parsed = parseWorkflow({ ...manifest(), target: { ...manifest().target, origin: "http://127.0.0.1:3020/" } });
    expect(parsed.target.origin).toBe("http://127.0.0.1:3020");
    const report = deriveReport(draft({ target: { origin: "https://sandbox.example.test/", environment: "testing", actualBuild: null } }));
    expect(report.target.origin).toBe("https://sandbox.example.test");
  });

  it("computes a passed report only when every required step and cleanup pass", () => {
    const report = deriveReport(draft());
    expect(report.verdict).toBe("passed");
    expect(report.counts).toEqual({ required: 8, observed: 8, passed: 8, failed: 0, blocked: 0, cancelled: 0, skipped: 0, missing: 0 });
    expect(parseReport(report)).toEqual(report);
  });

  it("keeps missing, skipped, duplicate and empty checks from passing", () => {
    const missing = deriveReport(draft({ steps: draft().steps.slice(0, 7) }));
    expect(missing.verdict).toBe("blocked");
    expect(missing.missingRequiredSteps).toEqual(["anonymous-denied"]);
    const skipped = deriveReport(draft({ steps: draft().steps.map((step, index) => index === 2 ? { ...step, status: "skipped", reasonCode: "skipped", processExitCode: undefined } : step) }));
    expect(skipped.verdict).toBe("blocked");
    expect(skipped.skippedRequiredSteps).toEqual(["broker-check"]);
    expect(() => deriveReport(draft({ steps: [...draft().steps.slice(0, 7), draft().steps[0]!] }))).toThrow(/duplicate/);
    const empty = deriveReport(draft({ steps: [] }));
    expect(empty.verdict).toBe("blocked");
    expect(empty.zeroChecks).toBe(true);
  });

  it("rejects forged verdicts and records failed cleanup and cancellation", () => {
    const forged = deriveReport(draft({ steps: draft().steps.map((step, index) => index === 0 ? { ...step, status: "failed", reasonCode: "assertion-failed", processExitCode: 1 } : step) }));
    expect(forged.verdict).toBe("failed");
    expect(() => parseReport({ ...forged, verdict: "passed" })).toThrow();
    const cleanupFailure = deriveReport(draft({ cleanup: { status: "failed", reasonCode: "cleanup-failed" } }));
    expect(cleanupFailure.verdict).toBe("failed");
    const cancelled = deriveReport(draft({ steps: draft().steps.map((step, index) => index === 0 ? { ...step, status: "cancelled", reasonCode: "cancelled", processExitCode: undefined } : step) }));
    expect(cancelled.verdict).toBe("cancelled");
  });

  it("confines evidence references and permits observed durations beyond the workflow deadline", () => {
    const baseStep = draft().steps[0]!;
    for (const evidence of [
      { log: "/absolute.log", exit: "ok.exit" },
      { log: "C:logs/run.log", exit: "ok.exit" },
      { log: "foo/../run.log", exit: "ok.exit" },
      { log: "./run.log", exit: "ok.exit" },
      { log: "foo//run.log", exit: "ok.exit" },
    ]) {
      expect(() => deriveReport(draft({ steps: [{ ...baseStep, evidence }] }))).toThrow();
    }
    const late = deriveReport(draft({ steps: [{ ...baseStep, durationMs: 120_001 }] }));
    expect(late.verdict).toBe("blocked");
    expect(late.steps[0]?.durationMs).toBe(120_001);
    expect(late.missingRequiredSteps).toHaveLength(7);
  });

  it("keeps source checkout and actual remote build metadata distinct", () => {
    const report = deriveReport(draft({ sourceTree: null, target: { origin: "https://sandbox.example.test", environment: "testing", actualBuild: null } }));
    expect(report.sourceTree).toBeNull();
    expect(report.target.actualBuild).toBeNull();
  });

  it("rejects source tree values that are not Git hashes", () => {
    expect(() => deriveReport(draft({ sourceTree: "0123" }))).toThrow();
    expect(() => deriveReport(draft({ sourceTree: "g".repeat(40) }))).toThrow();
    expect(deriveReport(draft({ sourceTree: "a".repeat(64) })).sourceTree).toBe("a".repeat(64));
  });

  it("has JSON schema parity for valid and malformed wire values", async () => {
    const AjvConstructor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile: (schema: object) => (data: unknown) => boolean };
    const addFormats = ((AjvFormatsModule as unknown as { default?: unknown }).default ?? AjvFormatsModule) as unknown as (instance: unknown) => void;
    const ajv = new AjvConstructor({ allErrors: true, strict: true });
    addFormats(ajv);
    const workflowSchema = JSON.parse(await readFile(path.join(process.cwd(), "schema/workflow.schema.json"), "utf8")) as object;
    const reportSchema = JSON.parse(await readFile(path.join(process.cwd(), "schema/workflow-report.schema.json"), "utf8")) as object;
    const workflowValid = ajv.compile(workflowSchema);
    const reportValid = ajv.compile(reportSchema);
    expect(workflowValid(manifest())).toBe(true);
    expect(workflowValid({ ...manifest(), target: { ...manifest().target, origin: "http://127.0.0.1:3020/" } })).toBe(true);
    expect(workflowValid({ ...manifest(), target: { ...manifest().target, origin: "https://notprod.example.test" } })).toBe(true);
    const report = deriveReport(draft());
    expect(reportValid(report)).toBe(true);
    expect(reportValid(deriveReport(draft({ steps: [{ ...draft().steps[0]!, durationMs: 120_001 }] })))).toBe(true);
    expect(workflowValid({ ...manifest(), checks: { ...manifest().checks, apiPath: "//bad" } })).toBe(false);
    expect(workflowValid({ ...manifest(), checks: { ...manifest().checks, apiPath: "/a/../b" } })).toBe(false);
    expect(reportValid({ ...report, unexpected: true })).toBe(false);
    // Derived verdict consistency is a runtime concern and is checked above by parseReport.
    expect(WorkflowManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(WorkflowReportSchema.safeParse(report).success).toBe(true);
  });
});
