/** Internal parent state. No credentials, native values, child output or errors. */
import { types } from "node:util";
import { ACCOUNT_UUID } from "./adapter.js";
import { browserRunProfile, copyDenseDataArray, copyOwnDataRecord } from "./worker-contracts.js";

export const MANAGED_CODES = Object.freeze([
  "BROWSER_MANAGED_INPUT_REFUSED", "BROWSER_MANAGED_PLATFORM_REFUSED", "BROWSER_MANAGED_PREFLIGHT_REFUSED",
  "BROWSER_MANAGED_STATE_REFUSED", "BROWSER_MANAGED_LOCKED", "BROWSER_MANAGED_RECOVERY_REQUIRED",
  "BROWSER_MANAGED_NATIVE_PRESENT", "BROWSER_MANAGED_NATIVE_FAILED", "BROWSER_MANAGED_CHILD_UNKNOWN",
  "BROWSER_MANAGED_ACCOUNT_FAILED", "BROWSER_MANAGED_BARRIER_FAILED", "BROWSER_MANAGED_RUN_FAILED",
  "BROWSER_MANAGED_REPORT_INVALID", "BROWSER_MANAGED_CLEANUP_INCOMPLETE", "BROWSER_MANAGED_CANCELLED",
] as const);
export type ManagedCode = typeof MANAGED_CODES[number];
const errors = new WeakSet<object>();
export class ManagedBrowserError extends Error {
  readonly code: ManagedCode;
  readonly stopped: boolean;
  constructor(code: ManagedCode, stopped = true) {
    const fixed = MANAGED_CODES.includes(code) ? code : "BROWSER_MANAGED_STATE_REFUSED";
    super(fixed); this.name = "ManagedBrowserError"; this.stack = fixed; this.code = fixed; this.stopped = stopped; errors.add(this);
  }
}
export function managedErrorCode(value: unknown): ManagedCode | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value) || !errors.has(value) || Object.getPrototypeOf(value) !== ManagedBrowserError.prototype) return;
  const field = Object.getOwnPropertyDescriptor(value, "code");
  return field && Object.hasOwn(field, "value") && MANAGED_CODES.includes(field.value as ManagedCode) ? field.value as ManagedCode : undefined;
}
export function managedStopConfirmed(value: unknown): boolean {
  if (!managedErrorCode(value)) return false;
  return Object.getOwnPropertyDescriptor(value, "stopped")?.value === true;
}
export type ChildState = "not-started" | "pending" | "settled" | "unknown";
export type CleanupState = "pending" | "completed" | "incomplete";
export type VerificationState = "not-run" | "passed" | "failed" | "blocked" | "cancelled";
export interface ManagedJournal {
  schemaVersion: 1; targetId: string; bindingHash: string; runId: string; expiresAt: number; environmentHash: string;
  phase: "preparing" | "accounts" | "runner" | "cleanup" | "complete" | "recovery-required";
  child: ChildState; nativeChild: "settled" | "pending" | "unknown";
  baseline: { profile: string; absent: boolean | null }[];
  attemptedProfiles: string[];
  barrier: "not-requested" | "pending" | "success" | "failed";
  accounts: CleanupState; native: CleanupState; files: CleanupState;
  verification: VerificationState; reasonCodes: ManagedCode[];
}
export interface ManagedBrowserReport {
  readonly schemaVersion: 1;
  readonly runId: string | null;
  readonly verdict: "passed" | "failed" | "blocked" | "cancelled";
  readonly reasonCodes: readonly ManagedCode[];
  readonly verification: VerificationState;
  readonly cleanup: "completed" | "incomplete";
  readonly accounts: CleanupState;
  readonly nativeEntries: CleanupState;
  readonly temporaryFiles: CleanupState;
  readonly recoveryRequired: boolean;
}
export function journalFor(targetId: string, bindingHash: string, runId: string, expiresAt: number, environmentHash: string): ManagedJournal {
  return normalizeManagedJournal({ schemaVersion: 1, targetId, bindingHash, runId, expiresAt, environmentHash, phase: "preparing", child: "not-started", nativeChild: "settled",
    baseline: ["editor", "reviewer"].map(role => ({ profile: browserRunProfile(targetId, runId, role as "editor" | "reviewer"), absent: null })),
    attemptedProfiles: [], barrier: "not-requested", accounts: "pending", native: "pending", files: "pending", verification: "not-run", reasonCodes: [] });
}
export function normalizeManagedJournal(input: unknown): ManagedJournal {
  try {
    const data = copyOwnDataRecord(input, ["schemaVersion", "targetId", "bindingHash", "runId", "expiresAt", "environmentHash", "phase", "child", "nativeChild", "baseline", "attemptedProfiles", "barrier", "accounts", "native", "files", "verification", "reasonCodes"]);
    if (data["schemaVersion"] !== 1 || [data["targetId"], data["runId"]].some(v => typeof v !== "string" || !ACCOUNT_UUID.test(v)) ||
      typeof data["bindingHash"] !== "string" || !/^[a-f0-9]{64}$/.test(data["bindingHash"]) || typeof data["expiresAt"] !== "number" || !Number.isSafeInteger(data["expiresAt"]) || data["expiresAt"] <= 0 ||
      typeof data["environmentHash"] !== "string" || !/^[a-f0-9]{64}$/.test(data["environmentHash"]) ||
      !["preparing", "accounts", "runner", "cleanup", "complete", "recovery-required"].includes(data["phase"] as string) ||
      !["not-started", "pending", "settled", "unknown"].includes(data["child"] as string) || !["settled", "pending", "unknown"].includes(data["nativeChild"] as string) ||
      !["not-requested", "pending", "success", "failed"].includes(data["barrier"] as string) ||
      [data["accounts"], data["native"], data["files"]].some(v => !["pending", "completed", "incomplete"].includes(v as string)) ||
      !["not-run", "passed", "failed", "blocked", "cancelled"].includes(data["verification"] as string)) throw Error();
    const profiles = [browserRunProfile(data["targetId"] as string, data["runId"] as string, "editor"), browserRunProfile(data["targetId"] as string, data["runId"] as string, "reviewer")];
    const baseline = copyDenseDataArray(data["baseline"], 2).map((v, index) => {
      const row = copyOwnDataRecord(v, ["profile", "absent"]);
      if (row["profile"] !== profiles[index] || (row["absent"] !== null && typeof row["absent"] !== "boolean")) throw Error();
      return { profile: row["profile"] as string, absent: row["absent"] as boolean | null };
    });
    const array = (value: unknown, max: number): unknown[] => {
      if (types.isProxy(value) || !Array.isArray(value)) throw Error();
      const size = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size > max) throw Error();
      return copyDenseDataArray(value, size);
    };
    const attempted = array(data["attemptedProfiles"], 2);
    if (new Set(attempted).size !== attempted.length || attempted.some(v => !profiles.includes(v as string) || !baseline.some(row => row.profile === v && row.absent === true))) throw Error();
    const reasons = array(data["reasonCodes"], MANAGED_CODES.length);
    if (new Set(reasons).size !== reasons.length || reasons.some(v => !MANAGED_CODES.includes(v as ManagedCode))) throw Error();
    if (data["phase"] === "complete" && (data["child"] === "pending" || data["child"] === "unknown" || data["nativeChild"] !== "settled" || [data["accounts"], data["native"], data["files"]].some(v => v !== "completed"))) throw Error();
    return { ...(data as unknown as ManagedJournal), baseline, attemptedProfiles: attempted as string[], reasonCodes: reasons as ManagedCode[] };
  } catch { throw new ManagedBrowserError("BROWSER_MANAGED_STATE_REFUSED"); }
}
export function remember(journal: ManagedJournal, code: ManagedCode): void { if (!journal.reasonCodes.includes(code)) journal.reasonCodes.push(code); }
export function managedReport(journal: ManagedJournal): ManagedBrowserReport {
  const cleanup = journal.phase === "complete" && journal.accounts === "completed" && journal.native === "completed" && journal.files === "completed" && journal.child !== "pending" && journal.child !== "unknown" && journal.nativeChild === "settled" ? "completed" : "incomplete";
  const passed = journal.verification === "passed" && journal.barrier === "success" && cleanup === "completed" && journal.reasonCodes.length === 0;
  const verdict = passed ? "passed" : journal.verification === "failed" ? "failed" : journal.reasonCodes.includes("BROWSER_MANAGED_CANCELLED") || journal.verification === "cancelled" ? "cancelled" : "blocked";
  return Object.freeze({ schemaVersion: 1, runId: journal.runId, verdict, reasonCodes: Object.freeze([...journal.reasonCodes]), verification: journal.verification,
    cleanup, accounts: journal.accounts, nativeEntries: journal.native, temporaryFiles: journal.files, recoveryRequired: cleanup !== "completed" });
}

/** Synchronous completion boundary; never writes a journal after lock release. */
export function finalManagedReport(journal: ManagedJournal, cancelled: boolean): ManagedBrowserReport {
  if (cancelled) remember(journal, "BROWSER_MANAGED_CANCELLED");
  return managedReport(journal);
}
