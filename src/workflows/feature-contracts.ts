import { z } from "zod";
import {
  EvidenceRefSchema,
  IdSchema,
  NonSecretTextSchema,
  ProfileSchema,
  ReasonCodeSchema,
  StepStatusSchema,
  WorkflowOriginSchema,
  WorkflowPathSchema,
  isProductionHostname,
  isValidStepReasonCode,
  parseWorkflowOrigin,
} from "./primitives.js";

/**
 * The checks whose result is required for a two-role feature acceptance run, in
 * the order a serial runner uses them.
 */
export const REQUIRED_FEATURE_STEPS = [
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
] as const;

export type FeatureStepId = (typeof REQUIRED_FEATURE_STEPS)[number];

/** Record ids the runner may create: lowercase, digits and hyphens, 8-64 characters. */
export const FEATURE_RECORD_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/u;

/** The cleanup outcomes a feature-acceptance report may record for its created record. */
export const FEATURE_CLEANUP_RECORD_STATES = ["none", "absent-verified", "deleted-verified", "retained-unowned", "failed"] as const;
export type FeatureCleanupRecordState = (typeof FEATURE_CLEANUP_RECORD_STATES)[number];

const FeatureTargetSchema = z
  .object({
    origin: WorkflowOriginSchema,
    environment: z.enum(["sandbox", "testing"]),
    buildId: IdSchema,
  })
  .strict();

const FeatureRoleSchema = z
  .object({
    profile: ProfileSchema,
    email: z.string().email().max(320),
    role: NonSecretTextSchema,
  })
  .strict();

const FeatureRolesSchema = z
  .object({
    writer: FeatureRoleSchema,
    reader: FeatureRoleSchema,
  })
  .strict();

const FeatureChecksSchema = z
  .object({
    readinessPath: WorkflowPathSchema,
    identityPath: WorkflowPathSchema,
    environmentPath: WorkflowPathSchema,
  })
  .strict();

const CollectionPathSchema = WorkflowPathSchema.refine((value) => !value.endsWith("/"), "collectionPath must not end with a slash");

const FeatureFormSchema = z
  .object({
    idLabel: NonSecretTextSchema,
    titleLabel: NonSecretTextSchema,
    submitLabel: NonSecretTextSchema,
    createdText: NonSecretTextSchema,
  })
  .strict();

const FeatureRecordSchema = z
  .object({
    collectionPath: CollectionPathSchema,
    createPagePath: WorkflowPathSchema,
    form: FeatureFormSchema,
  })
  .strict();

/**
 * A strict, secret-free manifest for one bounded two-role feature acceptance run.
 * Reuses the smoke workflow's origin/path/id/profile/text primitives so there is one
 * implementation of URL and path safety.
 */
export const FeatureWorkflowManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("feature-acceptance"),
    id: IdSchema,
    target: FeatureTargetSchema,
    roles: FeatureRolesSchema,
    checks: FeatureChecksSchema,
    record: FeatureRecordSchema,
    timeoutMs: z.number().int().min(1_000).max(300_000),
    cleanupTimeoutMs: z.number().int().min(1_000).max(60_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    // Keep the policy defense in depth if the target schema is changed later.
    const parsed = parseWorkflowOrigin(manifest.target.origin);
    if (parsed && isProductionHostname(parsed.hostname)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "origin"], message: "production host is refused" });
    }
    if (manifest.roles.writer.profile === manifest.roles.reader.profile) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", "reader", "profile"], message: "writer and reader profiles must differ" });
    }
    if (manifest.roles.writer.email.toLowerCase() === manifest.roles.reader.email.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", "reader", "email"], message: "writer and reader emails must differ" });
    }
  });

export type FeatureWorkflowManifest = z.infer<typeof FeatureWorkflowManifestSchema>;

/** Parse a feature-acceptance manifest and return its secret-free, runtime-validated value. */
export function parseFeatureWorkflow(input: unknown): FeatureWorkflowManifest {
  return FeatureWorkflowManifestSchema.parse(input);
}

const RECEIPT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * A trusted setup adapter's receipt that a run's live test environment is the one the
 * manifest expects. This is a contract with the adapter, not cryptographic proof of an
 * app's backing data: a loopback host or a sandbox/testing tag alone never establishes
 * isolated data.
 */
export const TestEnvironmentReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("test-environment-receipt"),
    runId: IdSchema,
    workflowId: IdSchema,
    environment: z.enum(["sandbox", "testing"]),
    origin: WorkflowOriginSchema,
    buildId: IdSchema,
    dataScope: IdSchema,
    isolation: z.literal("dedicated-per-run"),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((receipt, context) => {
    const issuedAt = Date.parse(receipt.issuedAt);
    const expiresAt = Date.parse(receipt.expiresAt);
    if (!(expiresAt > issuedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
    } else if (expiresAt - issuedAt > RECEIPT_MAX_LIFETIME_MS) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "receipt lifetime must not exceed 24 hours" });
    }
  });

export type TestEnvironmentReceipt = z.infer<typeof TestEnvironmentReceiptSchema>;

/** Parse a trusted test-environment receipt and return its runtime-validated value. */
export function parseTestEnvironmentReceipt(input: unknown): TestEnvironmentReceipt {
  return TestEnvironmentReceiptSchema.parse(input);
}

export type ReceiptCheck =
  | { ok: true }
  | { ok: false; reason: "workflow-mismatch" | "origin-mismatch" | "environment-mismatch" | "build-mismatch" | "not-yet-valid" | "expired" };

const DEFAULT_CLOCK_SKEW_MS = 60_000;

/**
 * Verify a parsed receipt matches a parsed manifest for this run, in this fixed check
 * order: workflow id, origin, environment, build id, not-yet-valid, expired.
 */
export function verifyReceiptForRun(
  receipt: TestEnvironmentReceipt,
  manifest: FeatureWorkflowManifest,
  options: { now?: Date; clockSkewMs?: number } = {},
): ReceiptCheck {
  const now = options.now ?? new Date();
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (receipt.workflowId !== manifest.id) return { ok: false, reason: "workflow-mismatch" };
  if (receipt.origin !== manifest.target.origin) return { ok: false, reason: "origin-mismatch" };
  if (receipt.environment !== manifest.target.environment) return { ok: false, reason: "environment-mismatch" };
  if (receipt.buildId !== manifest.target.buildId) return { ok: false, reason: "build-mismatch" };
  const issuedAtMs = Date.parse(receipt.issuedAt);
  const expiresAtMs = Date.parse(receipt.expiresAt);
  const nowMs = now.getTime();
  if (issuedAtMs > nowMs + clockSkewMs) return { ok: false, reason: "not-yet-valid" };
  if (!(nowMs < expiresAtMs)) return { ok: false, reason: "expired" };
  return { ok: true };
}

const FeatureStepSchema = z
  .object({
    id: z.enum(REQUIRED_FEATURE_STEPS),
    status: StepStatusSchema,
    reasonCode: ReasonCodeSchema,
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    attempt: z.number().int().min(1).max(100),
    processExitCode: z.number().int().min(0).max(255).optional(),
    evidence: EvidenceRefSchema.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (!isValidStepReasonCode(step.status, step.reasonCode)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "reasonCode does not match status" });
    }
    if (step.status === "passed" && step.processExitCode !== undefined && step.processExitCode !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["processExitCode"], message: "passed step must have exit code 0" });
    }
  });

const FeatureCleanupReasonSchema = z.enum(["ok", "cleanup-failed"]);
const FeatureCleanupRecordSchema = z.enum(FEATURE_CLEANUP_RECORD_STATES);
const COMPLETE_CLEANUP_RECORD_STATES = new Set<FeatureCleanupRecordState>(["none", "absent-verified", "deleted-verified"]);
const FAILED_ONLY_CLEANUP_RECORD_STATES = new Set<FeatureCleanupRecordState>(["retained-unowned", "failed"]);

const FeatureCleanupSchema = z
  .object({
    status: z.enum(["complete", "failed"]),
    reasonCode: FeatureCleanupReasonSchema.optional(),
    record: FeatureCleanupRecordSchema,
    evidence: EvidenceRefSchema.optional(),
  })
  .strict()
  .superRefine((cleanup, context) => {
    if (cleanup.status === "failed" && cleanup.reasonCode !== "cleanup-failed") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "failed cleanup requires cleanup-failed" });
    }
    if (cleanup.status === "complete" && cleanup.reasonCode !== undefined && cleanup.reasonCode !== "ok") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "complete cleanup requires ok" });
    }
    if (cleanup.status === "complete" && !COMPLETE_CLEANUP_RECORD_STATES.has(cleanup.record)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["record"], message: "complete cleanup requires an absent, deleted or never-created record" });
    }
    if (FAILED_ONLY_CLEANUP_RECORD_STATES.has(cleanup.record) && cleanup.status !== "failed") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "a retained or failed record requires a failed cleanup status" });
    }
  });

const FeatureCountsSchema = z
  .object({
    required: z.literal(REQUIRED_FEATURE_STEPS.length),
    observed: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
    passed: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
    failed: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
    blocked: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
    cancelled: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
    skipped: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
    missing: z.number().int().min(0).max(REQUIRED_FEATURE_STEPS.length),
  })
  .strict();

const FeatureVerdictSchema = z.enum(["passed", "failed", "blocked", "cancelled"]);

const EnvironmentRunSchema = z
  .object({
    runId: IdSchema,
    dataScope: IdSchema,
  })
  .strict()
  .nullable();

const FeatureReportShape = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("feature-acceptance-report"),
    workflowId: IdSchema,
    runId: IdSchema,
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    sourceTree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).nullable(),
    target: z
      .object({
        origin: WorkflowOriginSchema,
        environment: z.enum(["sandbox", "testing"]),
        actualBuild: IdSchema.nullable(),
      })
      .strict(),
    roles: z
      .object({
        writer: ProfileSchema,
        reader: ProfileSchema,
      })
      .strict(),
    environmentRun: EnvironmentRunSchema,
    steps: z.array(FeatureStepSchema).max(REQUIRED_FEATURE_STEPS.length),
    cleanup: FeatureCleanupSchema,
    verdict: FeatureVerdictSchema,
    counts: FeatureCountsSchema,
    missingRequiredSteps: z.array(z.enum(REQUIRED_FEATURE_STEPS)),
    skippedRequiredSteps: z.array(z.enum(REQUIRED_FEATURE_STEPS)),
    zeroChecks: z.boolean(),
  })
  .strict();

function findMissingFeatureSteps(steps: readonly z.infer<typeof FeatureStepSchema>[]): FeatureStepId[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`duplicate workflow step: ${step.id}`);
    ids.add(step.id);
  }
  return REQUIRED_FEATURE_STEPS.filter((id) => !ids.has(id));
}

function deriveFeatureCounts(steps: readonly z.infer<typeof FeatureStepSchema>[], missing: readonly FeatureStepId[]) {
  return {
    required: REQUIRED_FEATURE_STEPS.length as 13,
    observed: steps.length,
    passed: steps.filter((step) => step.status === "passed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    blocked: steps.filter((step) => step.status === "blocked").length,
    cancelled: steps.filter((step) => step.status === "cancelled").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
    missing: missing.length,
  };
}

function deriveFeatureVerdict(
  steps: readonly z.infer<typeof FeatureStepSchema>[],
  cleanup: z.infer<typeof FeatureCleanupSchema>,
  missing: readonly FeatureStepId[],
): z.infer<typeof FeatureVerdictSchema> {
  if (steps.some((step) => step.status === "cancelled")) return "cancelled";
  if (cleanup.status === "failed" || steps.some((step) => step.status === "failed")) return "failed";
  if (steps.length === 0 || missing.length > 0 || steps.some((step) => step.status === "blocked" || step.status === "skipped")) return "blocked";
  // All 13 required steps observed and passed, and cleanup complete (the only remaining
  // cleanup.status value here, since "failed" was handled above): a pass requires the
  // created record to have been verified deleted, not merely absent-verified or none.
  return cleanup.record === "deleted-verified" ? "passed" : "failed";
}

const FeatureReportBodySchema = FeatureReportShape.superRefine((value, context) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["finishedAt"], message: "finishedAt precedes startedAt" });
  }
  try {
    const missing = findMissingFeatureSteps(value.steps);
    const skipped = value.steps.filter((step) => step.status === "skipped").map((step) => step.id);
    const counts = deriveFeatureCounts(value.steps, missing);
    const verdict = deriveFeatureVerdict(value.steps, value.cleanup, missing);
    if (JSON.stringify(value.verdict) !== JSON.stringify(verdict)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "verdict is inconsistent with steps and cleanup" });
    if (JSON.stringify(value.counts) !== JSON.stringify(counts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["counts"], message: "counts are inconsistent with steps" });
    if (JSON.stringify(value.missingRequiredSteps) !== JSON.stringify(missing)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["missingRequiredSteps"], message: "missing required steps are inconsistent" });
    if (JSON.stringify(value.skippedRequiredSteps) !== JSON.stringify(skipped)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["skippedRequiredSteps"], message: "skipped required steps are inconsistent" });
    if (value.zeroChecks !== (value.steps.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["zeroChecks"], message: "zeroChecks is inconsistent with steps" });
  } catch (error) {
    // Structural validation normally catches this first; keep this refinement safe if the shape evolves.
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: error instanceof Error ? error.message : "invalid step set" });
  }

  const hasObservedBrowserCreate = value.steps.some((step) => step.id === "browser-create");
  if (hasObservedBrowserCreate && value.cleanup.record === "none") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cleanup", "record"], message: "an observed browser-create step requires a cleanup record other than none" });
  }

  const hasPassedEnvironmentReceipt = value.steps.some((step) => step.id === "environment-receipt" && step.status === "passed");
  if (hasPassedEnvironmentReceipt && value.environmentRun === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["environmentRun"], message: "a passed environment-receipt step requires environmentRun" });
  }
  if (!hasPassedEnvironmentReceipt && value.environmentRun !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["environmentRun"], message: "environmentRun requires a passed environment-receipt step" });
  }
});

export const FeatureReportSchema = FeatureReportBodySchema;
export type FeatureReport = z.infer<typeof FeatureReportSchema>;
export type FeatureReportDraft = Omit<FeatureReport, "verdict" | "counts" | "missingRequiredSteps" | "skippedRequiredSteps" | "zeroChecks">;
const FeatureReportDraftSchema = FeatureReportShape.omit({ verdict: true, counts: true, missingRequiredSteps: true, skippedRequiredSteps: true, zeroChecks: true });

/** Compute all report fields controlled by the runner from a validated observation draft. */
export function deriveFeatureReport(input: unknown): FeatureReport {
  let draftInput: unknown = input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { verdict: _verdict, counts: _counts, missingRequiredSteps: _missing, skippedRequiredSteps: _skipped, zeroChecks: _zero, ...withoutDerived } = input as Record<string, unknown>;
    draftInput = withoutDerived;
  }
  const draft = FeatureReportDraftSchema.parse(draftInput);
  const missing = findMissingFeatureSteps(draft.steps);
  const skipped = draft.steps.filter((step) => step.status === "skipped").map((step) => step.id);
  return FeatureReportSchema.parse({
    ...draft,
    verdict: deriveFeatureVerdict(draft.steps, draft.cleanup, missing),
    counts: deriveFeatureCounts(draft.steps, missing),
    missingRequiredSteps: missing,
    skippedRequiredSteps: skipped,
    zeroChecks: draft.steps.length === 0,
  });
}

/** Parse a complete report, rejecting derived verdict/count fields that were forged. */
export function parseFeatureReport(input: unknown): FeatureReport {
  const report = FeatureReportSchema.parse(input);
  const derived = deriveFeatureReport(report);
  if (JSON.stringify(report.verdict) !== JSON.stringify(derived.verdict) || JSON.stringify(report.counts) !== JSON.stringify(derived.counts) || JSON.stringify(report.missingRequiredSteps) !== JSON.stringify(derived.missingRequiredSteps) || JSON.stringify(report.skippedRequiredSteps) !== JSON.stringify(derived.skippedRequiredSteps) || report.zeroChecks !== derived.zeroChecks) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["verdict"], message: "report verdict or derived counts are inconsistent" }]);
  }
  return report;
}
