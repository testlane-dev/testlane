/**
 * Shared, internal zod primitives for Testlane's workflow contracts: origin and
 * path parsing, id/profile/text schemas, the reason-code set, step status, evidence
 * references, and production/loopback host helpers.
 *
 * This module is private to `src/workflows/*.ts`. It is not re-exported from
 * `src/index.ts`. Every value here was moved out of `contracts.ts` unchanged
 * (same behaviour, same error messages) so that `contracts.ts` (smoke v1) and
 * `feature-contracts.ts` (feature acceptance v1) share exactly one implementation
 * of URL/path safety instead of two independently-maintained copies.
 */
import { z } from "zod";
import { PROFILE_NAME_RE } from "../types.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PRODUCTION_LABELS = new Set(["prod", "production", "live"]);

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(value);
}

export function isProductionHostname(hostname: string): boolean {
  return hostname.toLowerCase().split(".").some((label) => PRODUCTION_LABELS.has(label));
}

/** Parse and canonicalize an origin string, or return undefined when it is unsafe. */
export function parseWorkflowOrigin(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
      return undefined;
    }
    if (parsed.pathname !== "/") return undefined;
    if (value !== `${parsed.protocol}//${parsed.host}` && value !== `${parsed.protocol}//${parsed.host}/`) {
      return undefined;
    }
    if (isProductionHostname(parsed.hostname)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** A canonical origin. Credentials, paths, queries, fragments and production hosts are refused. */
export const WorkflowOriginSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => parseWorkflowOrigin(value) !== undefined, "origin must be a canonical HTTPS or loopback HTTP origin")
  .transform((value) => parseWorkflowOrigin(value)?.origin ?? value);

function isSafeWorkflowPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%")) return false;
  if (value.includes("://") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value, "https://workflow.invalid");
    return parsed.origin === "https://workflow.invalid" && parsed.pathname === value;
  } catch {
    return false;
  }
}

/** A same-origin request path. Encoded escapes and URL-like values are refused. */
export const WorkflowPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeWorkflowPath, "path must be an unencoded same-origin path starting with a single slash");

/** A bounded ASCII identifier: workflow/run/build/data-scope ids. */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "id contains unsupported characters");

/** A broker profile name, e.g. "shop:sandbox:admin". */
export const ProfileSchema = z.string().min(1).max(128).regex(PROFILE_NAME_RE, "invalid profile name");

/** Bounded human text with no control characters or surrounding whitespace. Never a secret. */
export const NonSecretTextSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "text contains a control character")
  .refine((value) => value.trim() === value, "text must not have surrounding whitespace");

/** The reason-code set shared by every workflow step and cleanup outcome. */
export const REASON_CODES = [
  "ok",
  "assertion-failed",
  "blocked-prerequisite",
  "cancelled",
  "cleanup-failed",
  "environment",
  "launch-failed",
  "missing",
  "process-failed",
  "production-refused",
  "skipped",
  "target-refused",
  "timeout",
] as const;

export type WorkflowReasonCode = (typeof REASON_CODES)[number];
export const ReasonCodeSchema = z.enum(REASON_CODES);

export const StepStatusSchema = z.enum(["passed", "failed", "blocked", "cancelled", "skipped"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

const EXPECTED_REASON_CODE: Record<StepStatus, WorkflowReasonCode> = {
  passed: "ok",
  failed: "assertion-failed",
  blocked: "blocked-prerequisite",
  cancelled: "cancelled",
  skipped: "skipped",
};

/** Extra reason codes a *failed* step may carry instead of the plain "assertion-failed". */
const FAILED_ALTERNATE_REASON_CODES = new Set<WorkflowReasonCode>([
  "environment",
  "launch-failed",
  "process-failed",
  "production-refused",
  "target-refused",
  "timeout",
]);

/** The default reason code that pairs with a step status. */
export function expectedReasonCodeForStatus(status: StepStatus): WorkflowReasonCode {
  return EXPECTED_REASON_CODE[status];
}

/** True when reasonCode is an acceptable pairing for status. Shared by every step schema. */
export function isValidStepReasonCode(status: StepStatus, reasonCode: WorkflowReasonCode): boolean {
  if (reasonCode === EXPECTED_REASON_CODE[status]) return true;
  return status === "failed" && FAILED_ALTERNATE_REASON_CODES.has(reasonCode);
}

function isConfinedEvidenceRef(value: string): boolean {
  if (value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** A pair of sanitized, confined `.log`/`.exit` evidence references. Never a response body. */
export const EvidenceRefSchema = z
  .object({
    log: z.string().min(1).max(512).regex(/^[A-Za-z0-9._/-]+$/u).refine(isConfinedEvidenceRef, "evidence reference must be relative and confined"),
    exit: z.string().min(1).max(512).regex(/^[A-Za-z0-9._/-]+$/u).refine(isConfinedEvidenceRef, "evidence reference must be relative and confined"),
  })
  .strict();
