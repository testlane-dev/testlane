/** Internal outcome projector. Child text never becomes a managed report field. */
import { createHash } from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import { copyDenseDataArray, copyOwnDataRecord } from "./worker-contracts.js";
import type { PreparedBrowserPlan } from "./preflight.js";
import type { VerificationState } from "./managed-state.js";

export interface ManagedPlannedCase { readonly id: string; readonly spec: string; readonly cleanup: { readonly required: boolean } }
export interface ManagedOutcome { readonly verification: VerificationState; readonly settled: boolean }
export interface ManagedReportSources { readonly helperSHA256: string; readonly harnessSHA256: string }
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const casesByStatus: Record<string, readonly string[]> = {
  passed: ["CASE_PASSED"], failed: ["CASE_FAILED", "CASE_TIMED_OUT", "CLEANUP_FAILED"],
  blocked: ["CASE_NOT_RUN", "RETRY_OR_DUPLICATE_CASE", "CASE_SKIPPED", "EXPECTED_FAILURE_NOT_ACCEPTED", "AUTHORING_HELPER_REQUIRED", "CLEANUP_NOT_CONFIRMED", "UNAPPROVED_ATTACHMENT", "NO_ASSERTIONS_OBSERVED"],
  cancelled: ["FORCED_STOP", "RUN_CANCELLED"],
};
const runReasons = ["GLOBAL_TEST_ERROR", "CASE_MAPPING_INVALID", "RUN_CONFIGURATION_INVALID", "REPORTER_INVALID", "NO_TESTS_DISCOVERED", "FORCED_STOP", "RUN_CANCELLED", "TEST_RUN_FAILED", "PLAN_NOT_REVIEWED", "PLAN_CHANGED_DURING_RUN", "SPEC_CHANGED_DURING_RUN", "UNAPPROVED_ARTIFACT", "ARTIFACT_MISSING", "PLAN_INVALID", "PROJECT_INVALID", "SPEC_INVALID", "PLAYWRIGHT_UNAVAILABLE", "RUNNER_BLOCKED", "RUNNER_START_FAILED", "RUN_TIMED_OUT"];
const integer = (value: unknown, maximum = 1000000): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function array(value: unknown, max: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value)) throw Error();
  const size = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (!integer(size, max)) throw Error(); return copyDenseDataArray(value, size);
}

/**
 * Accept a settled failed report as well as a passing one, so assertion failure
 * can still receive verified cleanup. Malformed/unbound/forced reports remain
 * unknown. This does not attest the quality of app-owned business assertions.
 */
export async function projectManagedBrowserOutcome(value: unknown, code: number | null, prepared: PreparedBrowserPlan, planned: readonly ManagedPlannedCase[], sources: ManagedReportSources): Promise<ManagedOutcome> {
  const unknown = Object.freeze({ verification: "blocked" as const, settled: false });
  try {
    const contractsURL = new URL("../../examples/agent-verification/contracts.mjs", import.meta.url).href;
    const runtimeURL = new URL("../../examples/agent-verification/runtime.mjs", import.meta.url).href;
    const contracts = await import(contractsURL) as { HARNESS_VERSION: string; validDiagnostic(value: unknown): boolean; runDiagnostics(value: string[]): unknown[]; caseDiagnosticCode(reason: string, observed?: string): string };
    const { LIMITS } = await import(runtimeURL) as { LIMITS: readonly string[] };
    const data = copyOwnDataRecord(value, ["schemaVersion", "runId", "harness", "helper", "plan", "specs", "reportPath", "verdict", "reasonCodes", "diagnostics", "cases", "artifacts", "limits", "execution"],
      ["schemaVersion", "runId", "harness", "helper", "plan", "specs", "reportPath", "verdict", "reasonCodes", "cases", "artifacts", "limits", "execution"]);
    const verdict = data["verdict"];
    if (data["schemaVersion"] !== 1 || typeof data["runId"] !== "string" || !UUID.test(data["runId"]) || typeof verdict !== "string" || !Object.hasOwn(casesByStatus, verdict) ||
        data["reportPath"] !== "run-" + data["runId"] + "/report.json" || copyOwnDataRecord(data["plan"], ["sha256"])["sha256"] !== prepared.plan.sha256) return unknown;
    const harness = copyOwnDataRecord(data["harness"], ["version", "sha256"]), helper = copyOwnDataRecord(data["helper"], ["version", "sha256"]);
    if (harness["version"] !== contracts.HARNESS_VERSION || helper["version"] !== "1" || [harness["sha256"], helper["sha256"]].some(v => typeof v !== "string" || !SHA.test(v)) ||
        harness["sha256"] !== sources.harnessSHA256 || helper["sha256"] !== sources.helperSHA256) return unknown;
    const expectedSpecs = new Map(planned.map(item => {
      const source = prepared.specs.find(bound => bound.file === path.resolve(prepared.projectDirectory, item.spec)); if (!source) throw Error();
      return [hash(item.spec), source.sha256];
    }));
    const specs = array(data["specs"], 100), seenSpecs = new Set<string>();
    for (const item of specs) { const spec = copyOwnDataRecord(item, ["id", "sha256"]); if (typeof spec["id"] !== "string" || seenSpecs.has(spec["id"]) || expectedSpecs.get(spec["id"]) !== spec["sha256"]) return unknown; seenSpecs.add(spec["id"]); }
    const limits = array(data["limits"], 20);
    if (seenSpecs.size !== expectedSpecs.size || array(data["artifacts"], 0).length || limits.some(v => typeof v !== "string") || JSON.stringify(limits) !== JSON.stringify(LIMITS)) return unknown;
    const reasons = array(data["reasonCodes"], runReasons.length);
    if (new Set(reasons).size !== reasons.length || reasons.some(v => typeof v !== "string" || !runReasons.includes(v))) return unknown;
    if (data["diagnostics"] !== undefined) {
      const diagnostics = array(data["diagnostics"], runReasons.length).map(v => copyOwnDataRecord(v, ["code", "summary", "remedy"])), expected = contracts.runDiagnostics(reasons as string[]);
      if (diagnostics.some(v => Object.values(v).some(text => typeof text !== "string"))) return unknown;
      if (diagnostics.length !== expected.length || JSON.stringify(diagnostics) !== JSON.stringify(expected) || diagnostics.some(v => !contracts.validDiagnostic(v))) return unknown;
    }
    const execution = copyOwnDataRecord(data["execution"], ["exitCode", "cancelled", "forced"]);
    if (!(execution["exitCode"] === null || integer(execution["exitCode"], 255)) || typeof execution["cancelled"] !== "boolean" || typeof execution["forced"] !== "boolean" || execution["forced"] || reasons.includes("FORCED_STOP")) return unknown;
    const rows = array(data["cases"], 100), seen = new Set<string>(); let failed = false;
    if (rows.length !== planned.length || rows.length === 0) return unknown;
    for (const item of rows) {
      const row = copyOwnDataRecord(item, ["id", "status", "reason", "cleanup", "attempts", "assertionsObserved", "specId", "failureLocation", "diagnostic"], ["id", "status", "reason", "cleanup", "attempts"]);
      const plan = planned.find(p => p.id === row["id"]), status = row["status"], reason = row["reason"];
      if (!plan || seen.has(plan.id) || typeof status !== "string" || !Object.hasOwn(casesByStatus, status) || !casesByStatus[status]!.includes(reason as string) ||
          !integer(row["attempts"], 300) || (row["assertionsObserved"] !== undefined && !integer(row["assertionsObserved"])) ||
          (row["assertionsObserved"] === undefined && row["attempts"] !== 0)) return unknown;
      seen.add(plan.id);
      const cleanup = copyOwnDataRecord(row["cleanup"], ["required", "status"]);
      if (cleanup["required"] !== plan.cleanup.required || !["completed", "failed", "not-required", "unknown"].includes(cleanup["status"] as string) ||
          (row["specId"] !== undefined && row["specId"] !== hash(plan.spec))) return unknown;
      if (row["failureLocation"] !== undefined && row["failureLocation"] !== null) {
        const location = copyOwnDataRecord(row["failureLocation"], ["line", "column"]);
        if (![location["line"], location["column"]].every(v => integer(v) && v >= 1) || status !== "failed" || !row["specId"] || !(typeof row["assertionsObserved"] === "number" && row["assertionsObserved"] >= 1)) return unknown;
      }
      if (row["diagnostic"] !== undefined) {
        const diagnostic = copyOwnDataRecord(row["diagnostic"], ["code", "summary", "remedy"]);
        if (!contracts.validDiagnostic(diagnostic) || status === "passed" || contracts.caseDiagnosticCode(reason as string, diagnostic["code"] as string) !== diagnostic["code"] ||
            (diagnostic["code"] === "ASSERTION_FAILED" && !(typeof row["assertionsObserved"] === "number" && row["assertionsObserved"] >= 1))) return unknown;
      }
      if ((status === "passed" && (row["attempts"] !== 1 || !(typeof row["assertionsObserved"] === "number" && row["assertionsObserved"] >= 1) || !row["specId"] ||
          (cleanup["status"] !== "completed" && (plan.cleanup.required || cleanup["status"] !== "not-required")))) ||
          (status === "failed" && row["attempts"] !== 1) || (reason === "CLEANUP_FAILED" && cleanup["status"] !== "failed") ||
          (reason === "CASE_NOT_RUN" && row["attempts"] !== 0) || (reason === "NO_ASSERTIONS_OBSERVED" && row["assertionsObserved"] !== 0) ||
          reason === "FORCED_STOP") return unknown;
      failed ||= status === "failed";
      if (verdict === "passed" && status !== "passed") return unknown;
    }
    if (verdict === "passed" && (reasons.length || code !== 0 || execution["exitCode"] !== 0 || execution["cancelled"])) return unknown;
    if (verdict === "failed" && (!failed || code !== 1 || execution["cancelled"])) return unknown;
    if (verdict === "blocked" && (code !== 2 || execution["cancelled"])) return unknown;
    if (verdict === "cancelled" && (code !== 130 || execution["cancelled"] !== true)) return unknown;
    return Object.freeze({ verification: verdict as ManagedOutcome["verification"], settled: true });
  } catch { return unknown; }
}
