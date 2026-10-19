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

export { WorkflowOriginSchema, WorkflowPathSchema } from "./primitives.js";
export type { WorkflowReasonCode } from "./primitives.js";

/** The checks whose result is required for an authenticated smoke run. */
export const REQUIRED_SMOKE_STEPS = [
  "profile-policy",
  "readiness",
  "broker-check",
  "session",
  "identity",
  "protected-page",
  "api",
  "anonymous-denied",
] as const;

export type SmokeStepId = (typeof REQUIRED_SMOKE_STEPS)[number];

const TargetSchema = z
  .object({
    origin: WorkflowOriginSchema,
    environment: z.enum(["sandbox", "testing"]),
    buildId: IdSchema.optional(),
  })
  .strict();

const ChecksSchema = z
  .object({
    readinessPath: WorkflowPathSchema,
    identityPath: WorkflowPathSchema,
    protectedPath: WorkflowPathSchema,
    protectedHeading: NonSecretTextSchema,
    apiPath: WorkflowPathSchema,
  })
  .strict();

export const WorkflowManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("authenticated-smoke"),
    id: IdSchema,
    profile: ProfileSchema,
    target: TargetSchema,
    identity: z
      .object({
        email: z.string().email().max(320),
        role: NonSecretTextSchema,
      })
      .strict(),
    checks: ChecksSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    // Keep the policy defense in depth if the target schema is changed later.
    const parsed = parseWorkflowOrigin(manifest.target.origin);
    if (parsed && isProductionHostname(parsed.hostname)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "origin"], message: "production host is refused" });
    }
  });

export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;

const StepSchema = z
  .object({
    id: z.enum(REQUIRED_SMOKE_STEPS),
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

const RunMetadataShape = z
  .object({
    schemaVersion: z.literal(1),
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
  })
  .strict();

const CleanupSchema = z
  .object({
    status: z.enum(["complete", "failed"]),
    reasonCode: ReasonCodeSchema.optional(),
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
  });

const CountsSchema = z
  .object({
    required: z.literal(REQUIRED_SMOKE_STEPS.length),
    observed: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
    passed: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
    failed: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
    blocked: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
    cancelled: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
    skipped: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
    missing: z.number().int().min(0).max(REQUIRED_SMOKE_STEPS.length),
  })
  .strict();

const VerdictSchema = z.enum(["passed", "failed", "blocked", "cancelled"]);

const ReportShape = RunMetadataShape.extend({
    kind: z.literal("authenticated-smoke-report"),
    profile: ProfileSchema,
    steps: z.array(StepSchema).max(REQUIRED_SMOKE_STEPS.length),
    cleanup: CleanupSchema,
    verdict: VerdictSchema,
    counts: CountsSchema,
    missingRequiredSteps: z.array(z.enum(REQUIRED_SMOKE_STEPS)),
    skippedRequiredSteps: z.array(z.enum(REQUIRED_SMOKE_STEPS)),
    zeroChecks: z.boolean(),
  }).strict();
const ReportBodySchema = ReportShape.superRefine((value, context) => {
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["finishedAt"], message: "finishedAt precedes startedAt" });
    }
    try {
      const missing = validateStepSet(value.steps);
      const skipped = value.steps.filter((step) => step.status === "skipped").map((step) => step.id);
      const counts = deriveCounts(value.steps, missing);
      const verdict = deriveVerdict(value.steps, value.cleanup, missing);
      if (JSON.stringify(value.verdict) !== JSON.stringify(verdict)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "verdict is inconsistent with steps and cleanup" });
      if (JSON.stringify(value.counts) !== JSON.stringify(counts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["counts"], message: "counts are inconsistent with steps" });
      if (JSON.stringify(value.missingRequiredSteps) !== JSON.stringify(missing)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["missingRequiredSteps"], message: "missing required steps are inconsistent" });
      if (JSON.stringify(value.skippedRequiredSteps) !== JSON.stringify(skipped)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["skippedRequiredSteps"], message: "skipped required steps are inconsistent" });
      if (value.zeroChecks !== (value.steps.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["zeroChecks"], message: "zeroChecks is inconsistent with steps" });
    } catch (error) {
      // Structural validation normally catches this first; keep this refinement safe if the shape evolves.
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: error instanceof Error ? error.message : "invalid step set" });
    }
  });

export const WorkflowReportSchema = ReportBodySchema;
export type WorkflowReport = z.infer<typeof WorkflowReportSchema>;
export type WorkflowReportDraft = Omit<WorkflowReport, "verdict" | "counts" | "missingRequiredSteps" | "skippedRequiredSteps" | "zeroChecks">;
const WorkflowReportDraftSchema = ReportShape.omit({ verdict: true, counts: true, missingRequiredSteps: true, skippedRequiredSteps: true, zeroChecks: true });

function deriveVerdict(steps: readonly z.infer<typeof StepSchema>[], cleanup: z.infer<typeof CleanupSchema>, missing: readonly SmokeStepId[]): z.infer<typeof VerdictSchema> {
  if (steps.some((step) => step.status === "cancelled")) return "cancelled";
  if (cleanup.status === "failed") return "failed";
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.length === 0 || missing.length > 0 || steps.some((step) => step.status === "blocked" || step.status === "skipped")) return "blocked";
  return "passed";
}

function deriveCounts(steps: readonly z.infer<typeof StepSchema>[], missing: readonly SmokeStepId[]) {
  return {
    required: REQUIRED_SMOKE_STEPS.length as 8,
    observed: steps.length,
    passed: steps.filter((step) => step.status === "passed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    blocked: steps.filter((step) => step.status === "blocked").length,
    cancelled: steps.filter((step) => step.status === "cancelled").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
    missing: missing.length,
  };
}

function validateStepSet(steps: readonly z.infer<typeof StepSchema>[]): SmokeStepId[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`duplicate workflow step: ${step.id}`);
    ids.add(step.id);
  }
  return REQUIRED_SMOKE_STEPS.filter((id) => !ids.has(id));
}

/** Parse a manifest and return its secret-free, runtime-validated value. */
export function parseWorkflow(input: unknown): WorkflowManifest {
  return WorkflowManifestSchema.parse(input);
}

/** Compute all report fields controlled by the runner from a validated observation draft. */
export function deriveReport(input: unknown): WorkflowReport {
  let draftInput: unknown = input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { verdict: _verdict, counts: _counts, missingRequiredSteps: _missing, skippedRequiredSteps: _skipped, zeroChecks: _zero, ...withoutDerived } = input as Record<string, unknown>;
    draftInput = withoutDerived;
  }
  const draft = WorkflowReportDraftSchema.parse(draftInput);
  const missing = validateStepSet(draft.steps);
  const skipped = draft.steps.filter((step) => step.status === "skipped").map((step) => step.id);
  return WorkflowReportSchema.parse({
    ...draft,
    verdict: deriveVerdict(draft.steps, draft.cleanup, missing),
    counts: deriveCounts(draft.steps, missing),
    missingRequiredSteps: missing,
    skippedRequiredSteps: skipped,
    zeroChecks: draft.steps.length === 0,
  });
}

/** Parse a complete report, rejecting derived verdict/count fields that were forged. */
export function parseReport(input: unknown): WorkflowReport {
  const report = WorkflowReportSchema.parse(input);
  const derived = deriveReport(report);
  if (JSON.stringify(report.verdict) !== JSON.stringify(derived.verdict) || JSON.stringify(report.counts) !== JSON.stringify(derived.counts) || JSON.stringify(report.missingRequiredSteps) !== JSON.stringify(derived.missingRequiredSteps) || JSON.stringify(report.skippedRequiredSteps) !== JSON.stringify(derived.skippedRequiredSteps) || report.zeroChecks !== derived.zeroChecks) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["verdict"], message: "report verdict or derived counts are inconsistent" }]);
  }
  return report;
}
