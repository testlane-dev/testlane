import { readFile } from "node:fs/promises";
import path from "node:path";
import * as AjvModule from "ajv/dist/2020.js";
import * as AjvFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  FEATURE_CLEANUP_RECORD_STATES,
  FEATURE_RECORD_ID_RE,
  FeatureReportSchema,
  FeatureWorkflowManifestSchema,
  REQUIRED_FEATURE_STEPS,
  TestEnvironmentReceiptSchema,
  deriveFeatureReport,
  parseFeatureReport,
  parseFeatureWorkflow,
  parseTestEnvironmentReceipt,
  verifyReceiptForRun,
  type FeatureReportDraft,
} from "../src/workflows/feature-contracts.js";
import { REQUIRED_SMOKE_STEPS, deriveReport, parseWorkflow } from "../src/workflows/contracts.js";

const manifest = () => ({
  schemaVersion: 1 as const,
  kind: "feature-acceptance" as const,
  id: "records-two-role",
  target: { origin: "http://127.0.0.1:4310", environment: "testing" as const, buildId: "ref-build-1" },
  roles: {
    writer: { profile: "reference:local:writer", email: "writer@example.test", role: "Writer" },
    reader: { profile: "reference:local:reader", email: "reader@example.test", role: "Reader" },
  },
  checks: { readinessPath: "/ready", identityPath: "/api/me", environmentPath: "/api/test-environment" },
  record: {
    collectionPath: "/api/records",
    createPagePath: "/records/new",
    form: { idLabel: "Record ID", titleLabel: "Title", submitLabel: "Create record", createdText: "Record created" },
  },
  timeoutMs: 60_000,
  cleanupTimeoutMs: 10_000,
});

const receipt = () => ({
  schemaVersion: 1 as const,
  kind: "test-environment-receipt" as const,
  runId: "run-1",
  workflowId: "records-two-role",
  environment: "testing" as const,
  origin: "http://127.0.0.1:4310",
  buildId: "ref-build-1",
  dataScope: "scope-run-1",
  isolation: "dedicated-per-run" as const,
  issuedAt: "2026-09-24T12:00:00.000Z",
  expiresAt: "2026-09-24T12:15:00.000Z",
});

const draft = (overrides: Partial<FeatureReportDraft> = {}): FeatureReportDraft => ({
  schemaVersion: 1,
  kind: "feature-acceptance-report",
  workflowId: "records-two-role",
  runId: "run-1",
  startedAt: "2026-09-24T12:00:00.000Z",
  finishedAt: "2026-09-24T12:00:20.000Z",
  sourceTree: "0123456789abcdef0123456789abcdef01234567",
  target: { origin: "http://127.0.0.1:4310", environment: "testing", actualBuild: "ref-build-1" },
  roles: { writer: "reference:local:writer", reader: "reference:local:reader" },
  environmentRun: { runId: "run-1", dataScope: "scope-run-1" },
  steps: REQUIRED_FEATURE_STEPS.map((id) => ({ id, status: "passed" as const, reasonCode: "ok" as const, durationMs: 1, attempt: 1, processExitCode: 0 })),
  cleanup: { status: "complete" as const, record: "deleted-verified" as const },
  ...overrides,
});

describe("feature workflow contracts: manifest", () => {
  it("parses the exact manifest shape", () => {
    const parsed = parseFeatureWorkflow(manifest());
    expect(parsed.timeoutMs).toBe(60_000);
    expect(parsed.cleanupTimeoutMs).toBe(10_000);
    expect(parsed.target.buildId).toBe("ref-build-1");
  });

  it("has exactly the fixed 13 required feature steps in run order", () => {
    expect(REQUIRED_FEATURE_STEPS).toEqual([
      "profile-policy",
      "readiness",
      "environment-receipt",
      "writer-session",
      "reader-session",
      "writer-identity",
      "reader-identity",
      "record-absent",
      "browser-create",
      "api-readback",
      "reader-read",
      "reader-mutation-denied",
      "unchanged-after-denial",
    ]);
  });

  it("rejects unknown keys anywhere in the manifest", () => {
    expect(() => parseFeatureWorkflow({ ...manifest(), extra: true })).toThrow();
    expect(() => parseFeatureWorkflow({ ...manifest(), target: { ...manifest().target, extra: true } })).toThrow();
    expect(() => parseFeatureWorkflow({ ...manifest(), roles: { ...manifest().roles, writer: { ...manifest().roles.writer, extra: true } } })).toThrow();
    expect(() => parseFeatureWorkflow({ ...manifest(), record: { ...manifest().record, form: { ...manifest().record.form, extra: true } } })).toThrow();
  });

  it("requires target.buildId (unlike the smoke manifest, where it is optional)", () => {
    const { buildId: _buildId, ...targetWithoutBuild } = manifest().target;
    expect(() => parseFeatureWorkflow({ ...manifest(), target: targetWithoutBuild })).toThrow();
  });

  it("rejects a writer and reader that share the same profile", () => {
    expect(() =>
      parseFeatureWorkflow({
        ...manifest(),
        roles: { ...manifest().roles, reader: { ...manifest().roles.reader, profile: manifest().roles.writer.profile } },
      }),
    ).toThrow();
  });

  it("rejects a writer and reader whose emails differ only by case", () => {
    expect(() =>
      parseFeatureWorkflow({
        ...manifest(),
        roles: {
          writer: { ...manifest().roles.writer, email: "Writer@Example.test" },
          reader: { ...manifest().roles.reader, email: "writer@example.test" },
        },
      }),
    ).toThrow();
  });

  it("rejects a collectionPath with a trailing slash", () => {
    expect(() => parseFeatureWorkflow({ ...manifest(), record: { ...manifest().record, collectionPath: "/api/records/" } })).toThrow();
  });

  it("refuses unsafe paths (reusing the smoke primitives)", () => {
    for (const pathValue of ["//other.example/api", "/api/%2Fsecret", "/api\\health", "https://other.example/api", "/api/health?x=1", "/api/health#x", "/a/../b"]) {
      expect(() => parseFeatureWorkflow({ ...manifest(), checks: { ...manifest().checks, readinessPath: pathValue } })).toThrow();
    }
  });

  it("refuses unsafe origins and production hosts", () => {
    const credentialOrigin = "https://user:pass@example.test";
    for (const origin of [credentialOrigin, "https://example.test/path", "https://example.test/?x=1", "http://example.test", "https://production.example.test", "https://app.prod.example.test"]) {
      expect(() => parseFeatureWorkflow({ ...manifest(), target: { ...manifest().target, origin } })).toThrow();
    }
  });

  it("bounds timeoutMs to 1000..300000 and cleanupTimeoutMs to 1000..60000", () => {
    expect(() => parseFeatureWorkflow({ ...manifest(), timeoutMs: 999 })).toThrow();
    expect(() => parseFeatureWorkflow({ ...manifest(), timeoutMs: 300_001 })).toThrow();
    expect(parseFeatureWorkflow({ ...manifest(), timeoutMs: 300_000 }).timeoutMs).toBe(300_000);
    expect(() => parseFeatureWorkflow({ ...manifest(), cleanupTimeoutMs: 999 })).toThrow();
    expect(() => parseFeatureWorkflow({ ...manifest(), cleanupTimeoutMs: 60_001 })).toThrow();
    expect(parseFeatureWorkflow({ ...manifest(), cleanupTimeoutMs: 60_000 }).cleanupTimeoutMs).toBe(60_000);
  });

  it("exports the shared record-id pattern and cleanup record states", () => {
    expect(FEATURE_RECORD_ID_RE.test("record-abc12345")).toBe(true);
    expect(FEATURE_RECORD_ID_RE.test("R")).toBe(false);
    expect(FEATURE_CLEANUP_RECORD_STATES).toEqual(["none", "absent-verified", "deleted-verified", "retained-unowned", "failed"]);
  });
});

describe("feature workflow contracts: test-environment receipt", () => {
  it("parses the exact receipt shape", () => {
    const parsed = parseTestEnvironmentReceipt(receipt());
    expect(parsed.isolation).toBe("dedicated-per-run");
    expect(parsed.origin).toBe("http://127.0.0.1:4310");
  });

  it("rejects an isolation value other than the dedicated-per-run literal", () => {
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), isolation: "shared" })).toThrow();
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), isolation: "dedicated" })).toThrow();
  });

  it("rejects a lifetime longer than 24 hours", () => {
    const issuedAt = Date.parse(receipt().issuedAt);
    const tooLong = new Date(issuedAt + 24 * 60 * 60 * 1000 + 1).toISOString();
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), expiresAt: tooLong })).toThrow();
    const exactly24h = new Date(issuedAt + 24 * 60 * 60 * 1000).toISOString();
    expect(parseTestEnvironmentReceipt({ ...receipt(), expiresAt: exactly24h }).expiresAt).toBe(exactly24h);
  });

  it("rejects expiresAt at or before issuedAt", () => {
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), expiresAt: receipt().issuedAt })).toThrow();
    const before = new Date(Date.parse(receipt().issuedAt) - 1000).toISOString();
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), expiresAt: before })).toThrow();
  });

  it("rejects unknown keys, including a secret-looking extra field", () => {
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), extra: true })).toThrow();
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), sessionToken: "not-actually-used-but-still-refused" })).toThrow();
    expect(() => parseTestEnvironmentReceipt({ ...receipt(), password: "also-refused" })).toThrow();
  });
});

describe("feature workflow contracts: verifyReceiptForRun", () => {
  it("returns ok for a matching, currently-valid receipt", () => {
    const parsedManifest = parseFeatureWorkflow(manifest());
    const parsedReceipt = parseTestEnvironmentReceipt(receipt());
    const now = new Date("2026-09-24T12:05:00.000Z");
    expect(verifyReceiptForRun(parsedReceipt, parsedManifest, { now })).toEqual({ ok: true });
  });

  it("checks workflowId, origin, environment and buildId in that order", () => {
    const parsedManifest = parseFeatureWorkflow(manifest());
    const now = new Date("2026-09-24T12:05:00.000Z");
    expect(verifyReceiptForRun(parseTestEnvironmentReceipt({ ...receipt(), workflowId: "other-workflow" }), parsedManifest, { now })).toEqual({ ok: false, reason: "workflow-mismatch" });
    expect(verifyReceiptForRun(parseTestEnvironmentReceipt({ ...receipt(), origin: "http://127.0.0.1:9999" }), parsedManifest, { now })).toEqual({ ok: false, reason: "origin-mismatch" });
    expect(verifyReceiptForRun(parseTestEnvironmentReceipt({ ...receipt(), environment: "sandbox" }), parsedManifest, { now })).toEqual({ ok: false, reason: "environment-mismatch" });
    expect(verifyReceiptForRun(parseTestEnvironmentReceipt({ ...receipt(), buildId: "other-build" }), parsedManifest, { now })).toEqual({ ok: false, reason: "build-mismatch" });
  });

  it("reports not-yet-valid and expired, including the clock-skew edge", () => {
    const parsedManifest = parseFeatureWorkflow(manifest());
    const parsedReceipt = parseTestEnvironmentReceipt(receipt());
    const issuedAtMs = Date.parse(parsedReceipt.issuedAt);
    const expiresAtMs = Date.parse(parsedReceipt.expiresAt);

    // Exactly at the skew boundary: still valid.
    const atBoundary = new Date(issuedAtMs - 60_000);
    expect(verifyReceiptForRun(parsedReceipt, parsedManifest, { now: atBoundary, clockSkewMs: 60_000 })).toEqual({ ok: true });

    // One millisecond past the skew boundary: not yet valid.
    const pastBoundary = new Date(issuedAtMs - 60_001);
    expect(verifyReceiptForRun(parsedReceipt, parsedManifest, { now: pastBoundary, clockSkewMs: 60_000 })).toEqual({ ok: false, reason: "not-yet-valid" });

    // Exactly at expiry: expired (now < expiresAt is required, not <=).
    const atExpiry = new Date(expiresAtMs);
    expect(verifyReceiptForRun(parsedReceipt, parsedManifest, { now: atExpiry })).toEqual({ ok: false, reason: "expired" });

    // One millisecond before expiry: still valid.
    const beforeExpiry = new Date(expiresAtMs - 1);
    expect(verifyReceiptForRun(parsedReceipt, parsedManifest, { now: beforeExpiry })).toEqual({ ok: true });
  });
});

describe("feature workflow contracts: report derivation", () => {
  it("computes a passed report only when all 13 steps pass and the record is verified deleted", () => {
    const report = deriveFeatureReport(draft());
    expect(report.verdict).toBe("passed");
    expect(report.counts).toEqual({ required: 13, observed: 13, passed: 13, failed: 0, blocked: 0, cancelled: 0, skipped: 0, missing: 0 });
    expect(parseFeatureReport(report)).toEqual(report);
  });

  it("prefers cancelled over failed, and failed over blocked/missing", () => {
    const baseSteps = draft().steps;
    const cancelledMixed = baseSteps.slice(0, 12).map((step, index) => {
      if (index === 0) return { ...step, status: "cancelled" as const, reasonCode: "cancelled" as const, processExitCode: undefined };
      if (index === 1) return { ...step, status: "failed" as const, reasonCode: "assertion-failed" as const, processExitCode: 1 };
      return step;
    });
    const cancelledReport = deriveFeatureReport(draft({ steps: cancelledMixed, cleanup: { status: "failed", reasonCode: "cleanup-failed", record: "failed" } }));
    expect(cancelledReport.verdict).toBe("cancelled");

    const failedMixed = baseSteps.slice(0, 12).map((step, index) => (index === 1 ? { ...step, status: "failed" as const, reasonCode: "assertion-failed" as const, processExitCode: 1 } : step));
    const failedReport = deriveFeatureReport(draft({ steps: failedMixed }));
    expect(failedReport.verdict).toBe("failed");
    expect(failedReport.missingRequiredSteps).toEqual(["unchanged-after-denial"]);
  });

  it("keeps missing and skipped required steps from passing", () => {
    const missing = deriveFeatureReport(draft({ steps: draft().steps.slice(0, 12) }));
    expect(missing.verdict).toBe("blocked");
    expect(missing.missingRequiredSteps).toEqual(["unchanged-after-denial"]);

    const skipped = deriveFeatureReport(
      draft({ steps: draft().steps.map((step, index) => (index === 3 ? { ...step, status: "skipped" as const, reasonCode: "skipped" as const, processExitCode: undefined } : step)) }),
    );
    expect(skipped.verdict).toBe("blocked");
    expect(skipped.skippedRequiredSteps).toEqual(["writer-session"]);
  });

  it("rejects duplicate step ids", () => {
    expect(() => deriveFeatureReport(draft({ steps: [...draft().steps.slice(0, 12), draft().steps[0]!] }))).toThrow(/duplicate/);
  });

  it("fails an all-passed run when cleanup itself failed", () => {
    const report = deriveFeatureReport(draft({ cleanup: { status: "failed", reasonCode: "cleanup-failed", record: "failed" } }));
    expect(report.verdict).toBe("failed");
  });

  it("fails an all-passed run when the record is only absent-verified, not deleted-verified", () => {
    const report = deriveFeatureReport(draft({ cleanup: { status: "complete", record: "absent-verified" } }));
    expect(report.verdict).toBe("failed");
    // When browser-create was never observed at all (missing, not merely absent from a
    // completed run), a "none" cleanup record is legitimate; the run is blocked by the
    // missing required step rather than by an inconsistent cleanup record.
    const noneRecord = deriveFeatureReport(draft({ steps: draft().steps.filter((step) => step.id !== "browser-create"), cleanup: { status: "complete", record: "none" } }));
    expect(noneRecord.verdict).toBe("blocked");
    expect(noneRecord.missingRequiredSteps).toEqual(["browser-create"]);
  });

  it("rejects forged verdict and counts", () => {
    const failedMixed = draft().steps.map((step, index) => (index === 0 ? { ...step, status: "failed" as const, reasonCode: "assertion-failed" as const, processExitCode: 1 } : step));
    const forged = deriveFeatureReport(draft({ steps: failedMixed }));
    expect(forged.verdict).toBe("failed");
    expect(() => parseFeatureReport({ ...forged, verdict: "passed" })).toThrow();

    const report = deriveFeatureReport(draft());
    expect(() => parseFeatureReport({ ...report, counts: { ...report.counts, passed: 12, failed: 1 } })).toThrow();
  });

  it("rejects an observed browser-create step when the cleanup record is none", () => {
    expect(() => deriveFeatureReport(draft({ cleanup: { status: "complete", record: "none" } }))).toThrow();
  });

  it("requires environmentRun exactly when an environment-receipt step passed", () => {
    // environmentRun present, but the environment-receipt step did not pass: rejected.
    const stepsWithoutPassedReceipt = draft().steps.map((step) => (step.id === "environment-receipt" ? { ...step, status: "blocked" as const, reasonCode: "blocked-prerequisite" as const, processExitCode: undefined } : step));
    expect(() => deriveFeatureReport(draft({ steps: stepsWithoutPassedReceipt, environmentRun: { runId: "run-1", dataScope: "scope-run-1" } }))).toThrow();

    // environmentRun null, but the environment-receipt step passed: also rejected.
    expect(() => deriveFeatureReport(draft({ environmentRun: null }))).toThrow();
  });

  it("keeps zeroChecks and blocked verdict consistent for an empty run", () => {
    const empty = deriveFeatureReport(draft({ steps: [], environmentRun: null, cleanup: { status: "complete", record: "none" } }));
    expect(empty.verdict).toBe("blocked");
    expect(empty.zeroChecks).toBe(true);
  });
});

describe("feature workflow contracts: JSON schema parity", () => {
  it("validates canonical manifest, receipt and report examples and rejects malformed ones", async () => {
    const AjvConstructor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (options: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const addFormats = ((AjvFormatsModule as unknown as { default?: unknown }).default ?? AjvFormatsModule) as unknown as (instance: unknown) => void;
    const ajv = new AjvConstructor({ allErrors: true, strict: true });
    addFormats(ajv);

    const featureWorkflowSchema = JSON.parse(await readFile(path.join(process.cwd(), "schema/feature-workflow.schema.json"), "utf8")) as object;
    const featureReportSchema = JSON.parse(await readFile(path.join(process.cwd(), "schema/feature-workflow-report.schema.json"), "utf8")) as object;
    const receiptSchema = JSON.parse(await readFile(path.join(process.cwd(), "schema/test-environment-receipt.schema.json"), "utf8")) as object;

    const workflowValid = ajv.compile(featureWorkflowSchema);
    const receiptValid = ajv.compile(receiptSchema);
    const reportValid = ajv.compile(featureReportSchema);

    expect(workflowValid(manifest())).toBe(true);
    expect(workflowValid({ ...manifest(), record: { ...manifest().record, collectionPath: "/api/records/" } })).toBe(false);
    expect(workflowValid({ ...manifest(), checks: { ...manifest().checks, environmentPath: "//bad" } })).toBe(false);

    expect(receiptValid(receipt())).toBe(true);
    expect(receiptValid({ ...receipt(), isolation: "shared" })).toBe(false);
    expect(receiptValid({ ...receipt(), extra: true })).toBe(false);

    const report = deriveFeatureReport(draft());
    expect(reportValid(report)).toBe(true);
    expect(reportValid({ ...report, unexpected: true })).toBe(false);

    expect(FeatureWorkflowManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(TestEnvironmentReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(FeatureReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("feature workflow contracts: smoke v1 contract exports are unchanged", () => {
  it("still behaves identically through the primitives.ts refactor", () => {
    expect(REQUIRED_SMOKE_STEPS).toEqual(["profile-policy", "readiness", "broker-check", "session", "identity", "protected-page", "api", "anonymous-denied"]);
    const smokeManifest = {
      schemaVersion: 1 as const,
      kind: "authenticated-smoke" as const,
      id: "smoke-local",
      profile: "shop:sandbox:admin",
      target: { origin: "http://127.0.0.1:3020", environment: "sandbox" as const, buildId: "build-local-1" },
      identity: { email: "admin@example.test", role: "Admin" },
      checks: { readinessPath: "/api/health", identityPath: "/api/me", protectedPath: "/account", protectedHeading: "Account", apiPath: "/api/account" },
      timeoutMs: 30_000,
    };
    expect(parseWorkflow(smokeManifest).timeoutMs).toBe(30_000);
    const smokeReport = deriveReport({
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
    });
    expect(smokeReport.verdict).toBe("passed");
  });
});
