/** Trusted parent-side adapter protocol. Never imported by the worker helper. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { types } from "node:util";
import { normalizeBrowserAccountBinding, type BrowserAccountBinding } from "./contracts.js";
import { absoluteLocalPath, copyOwnDataRecord } from "./worker-contracts.js";

export type BrowserAccountRole = "Editor" | "Reviewer";
export const BROWSER_ACCOUNT_FAILURE_CODES = Object.freeze([
  "BROWSER_ACCOUNT_ADAPTER_REFUSED", "BROWSER_ACCOUNT_INPUT_REFUSED", "BROWSER_ACCOUNT_STATE_INVALID", "BROWSER_ACCOUNT_STATE_LOCKED",
  "BROWSER_ACCOUNT_STATE_IO_FAILED", "BROWSER_ACCOUNT_RUN_REFUSED", "BROWSER_ACCOUNT_EXPIRED", "BROWSER_ACCOUNT_CLOCK_REFUSED",
  "BROWSER_ACCOUNT_QUOTA_REFUSED", "BROWSER_ACCOUNT_REPLAY_REFUSED", "BROWSER_ACCOUNT_ROLE_REFUSED", "BROWSER_ACCOUNT_OWNERSHIP_REFUSED",
  "BROWSER_ACCOUNT_CREATE_UNKNOWN", "BROWSER_ACCOUNT_SEED_UNKNOWN", "BROWSER_ACCOUNT_CLEANUP_INCOMPLETE",
] as const);
export type BrowserAccountFailureCode = typeof BROWSER_ACCOUNT_FAILURE_CODES[number];
const accountErrors = new WeakSet<object>();
export class BrowserAccountError extends Error {
  readonly code: BrowserAccountFailureCode;
  constructor(code: BrowserAccountFailureCode) {
    const fixed = BROWSER_ACCOUNT_FAILURE_CODES.includes(code) ? code : "BROWSER_ACCOUNT_INPUT_REFUSED";
    super(fixed); this.name = "BrowserAccountError"; this.code = fixed; this.stack = fixed; accountErrors.add(this);
  }
}
export const accountFailure = (code: BrowserAccountFailureCode): BrowserAccountError => new BrowserAccountError(code);
export function readBrowserAccountFailureCode(value: unknown): BrowserAccountFailureCode | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value) || !accountErrors.has(value) || !types.isNativeError(value) || Object.getPrototypeOf(value) !== BrowserAccountError.prototype) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, "code");
  return field && Object.hasOwn(field, "value") && BROWSER_ACCOUNT_FAILURE_CODES.includes(field.value as BrowserAccountFailureCode) ? field.value as BrowserAccountFailureCode : undefined;
}
export const ACCOUNT_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUIREMENTS = ["targetBinding", "immutableOwnership", "targetWideQuotas", "expiry", "disabledEffects", "tombstones", "liveRevocation"] as const;

export interface BrowserAccountOwner {
  readonly targetId: string;
  readonly bindingHash: string;
  readonly runId: string;
  readonly operationId: string;
  readonly role: BrowserAccountRole;
  readonly email: string;
  readonly expiresAt: number;
}
export interface BrowserCoordinatorBinding { readonly root: string; readonly targetId: string; readonly bindingHash: string; readonly nonce: string }
export interface BrowserOwnedInspection {
  readonly present: boolean;
  readonly id: string | null;
  readonly revoked: boolean;
  readonly deliveryPending: boolean;
  readonly ownedRecords: number;
  readonly activeReservations: number;
}
export interface BrowserTargetVerification {
  readonly target: BrowserAccountBinding["target"];
  readonly bindingHash: string;
  readonly enforced: Readonly<Record<typeof REQUIREMENTS[number], true>>;
}

/**
 * Flat closures: methods are called with this=undefined. The app must atomically
 * enforce the original owner tuple, quotas/expiry, delivery fence and revocation
 * against its actual account store, including retries and other coordinators.
 * Deleting users alone is insufficient when old access sessions remain valid.
 */
export interface BrowserAccountAdapter {
  readonly metadata: { readonly protocol: BrowserAccountBinding["adapter"]["protocol"]; readonly target: BrowserAccountBinding["target"] };
  readonly verifyTarget: (binding: BrowserAccountBinding, bindingHash: string) => Promise<BrowserTargetVerification>;
  readonly coordinatorBinding: () => Promise<BrowserCoordinatorBinding | null>;
  readonly bindCoordinator: (binding: BrowserCoordinatorBinding) => Promise<{ readonly bound: true }>;
  readonly createOwned: (owner: BrowserAccountOwner, password: string) => Promise<{ readonly id: string }>;
  readonly inspectOwned: (owner: BrowserAccountOwner) => Promise<BrowserOwnedInspection>;
  readonly beginCredentialDelivery: (owner: BrowserAccountOwner) => Promise<{ readonly pending: true }>;
  readonly endCredentialDelivery: (owner: BrowserAccountOwner) => Promise<{ readonly pending: false }>;
  readonly revokeDeleteOwned: (owner: BrowserAccountOwner) => Promise<{ readonly revoked: true }>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw accountFailure("BROWSER_ACCOUNT_INPUT_REFUSED");
  return encoded;
}
export function browserBindingHash(value: unknown): string {
  return createHash("sha256").update(canonical(normalizeBrowserAccountBinding(value))).digest("hex");
}
export function browserAccountEmail(runId: string, role: BrowserAccountRole): string {
  if (typeof runId !== "string" || !ACCOUNT_UUID.test(runId) || (role !== "Editor" && role !== "Reviewer")) throw accountFailure("BROWSER_ACCOUNT_INPUT_REFUSED");
  return `tlp-${runId}-${role.toLowerCase()}@example.test`;
}

export function readAccountOwner(value: unknown): BrowserAccountOwner {
  try {
    const data = copyOwnDataRecord(value, ["targetId", "bindingHash", "runId", "operationId", "role", "email", "expiresAt"]);
    if (![data["targetId"], data["runId"], data["operationId"]].every(item => typeof item === "string" && ACCOUNT_UUID.test(item)) ||
        typeof data["bindingHash"] !== "string" || !HASH.test(data["bindingHash"]) || (data["role"] !== "Editor" && data["role"] !== "Reviewer") ||
        data["email"] !== browserAccountEmail(data["runId"] as string, data["role"]) || typeof data["expiresAt"] !== "number" || !Number.isSafeInteger(data["expiresAt"]) || data["expiresAt"] <= 0) throw Error();
    return Object.freeze(data as unknown as BrowserAccountOwner);
  } catch { throw accountFailure("BROWSER_ACCOUNT_OWNERSHIP_REFUSED"); }
}
export function readCoordinatorBinding(value: unknown): BrowserCoordinatorBinding | null {
  if (value === null) return null;
  try {
    const data = copyOwnDataRecord(value, ["root", "targetId", "bindingHash", "nonce"]);
    if (typeof data["targetId"] !== "string" || !ACCOUNT_UUID.test(data["targetId"]) || [data["bindingHash"], data["nonce"]].some(item => typeof item !== "string" || !HASH.test(item))) throw Error();
    return Object.freeze({ root: absoluteLocalPath(data["root"]), targetId: data["targetId"], bindingHash: data["bindingHash"] as string, nonce: data["nonce"] as string });
  } catch { throw accountFailure("BROWSER_ACCOUNT_STATE_INVALID"); }
}
export function readOwnedInspection(value: unknown): BrowserOwnedInspection {
  try {
    const data = copyOwnDataRecord(value, ["present", "id", "revoked", "deliveryPending", "ownedRecords", "activeReservations"]);
    if ([data["present"], data["revoked"], data["deliveryPending"]].some(item => typeof item !== "boolean") ||
        (data["id"] !== null && (typeof data["id"] !== "string" || !ACCOUNT_UUID.test(data["id"]))) || (data["present"] === true && data["id"] === null) ||
        [data["ownedRecords"], data["activeReservations"]].some(item => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0 || item > 1_000_000)) throw Error();
    return Object.freeze(data as unknown as BrowserOwnedInspection);
  } catch { throw accountFailure("BROWSER_ACCOUNT_OWNERSHIP_REFUSED"); }
}
export function readAdapterAcknowledgement(value: unknown, key: "bound" | "pending" | "revoked", expected: boolean): void {
  try { if (copyOwnDataRecord(value, [key])[key] !== expected) throw Error(); }
  catch { throw accountFailure("BROWSER_ACCOUNT_ADAPTER_REFUSED"); }
}
export function readCreatedAccount(value: unknown): string {
  try { const id = copyOwnDataRecord(value, ["id"])["id"]; if (typeof id !== "string" || !ACCOUNT_UUID.test(id)) throw Error(); return id; }
  catch { throw accountFailure("BROWSER_ACCOUNT_CREATE_UNKNOWN"); }
}

async function verifyEntry(binding: BrowserAccountBinding): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const file = binding.adapter.modulePath;
    if (await realpath(file) !== file) throw Error();
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 1_048_576n) throw Error();
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const retained = await handle.stat({ bigint: true });
    if (!retained.isFile() || retained.nlink !== 1n || retained.dev !== before.dev || retained.ino !== before.ino || retained.size !== before.size) throw Error();
    const bytes = Buffer.alloc(Number(retained.size) + 1);
    let count = 0;
    while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, null); if (result.bytesRead === 0) break; count += result.bytesRead; }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (count !== Number(retained.size) || after.nlink !== 1n || named.nlink !== 1n || after.size !== retained.size || after.mtimeNs !== retained.mtimeNs || named.dev !== retained.dev || named.ino !== retained.ino || await realpath(file) !== file ||
        createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !== binding.adapter.sha256) throw Error();
  } catch { throw accountFailure("BROWSER_ACCOUNT_ADAPTER_REFUSED"); }
  finally { try { await handle?.close(); } catch { throw accountFailure("BROWSER_ACCOUNT_ADAPTER_REFUSED"); } }
}

/** Entry-only source check, never a loader or proof of transitive imported code. */
export async function verifyBrowserAccountAdapter(value: unknown, input: unknown): Promise<{ readonly adapter: BrowserAccountAdapter; readonly binding: BrowserAccountBinding; readonly bindingHash: string }> {
  try {
    const binding = normalizeBrowserAccountBinding(input), bindingHash = browserBindingHash(binding);
    const methods = ["verifyTarget", "coordinatorBinding", "bindCoordinator", "createOwned", "inspectOwned", "beginCredentialDelivery", "endCredentialDelivery", "revokeDeleteOwned"] as const;
    const data = copyOwnDataRecord(value, ["metadata", ...methods]);
    const metadata = copyOwnDataRecord(data["metadata"], ["protocol", "target"]), target = copyOwnDataRecord(metadata["target"], ["id", "origin", "environment"]);
    if (metadata["protocol"] !== binding.adapter.protocol || canonical(target) !== canonical(binding.target) || methods.some(key => typeof data[key] !== "function" || types.isProxy(data[key]))) throw Error();
    await verifyEntry(binding);
    const closures: Record<string, unknown> = { metadata: Object.freeze({ protocol: binding.adapter.protocol, target: binding.target }) };
    for (const key of methods) closures[key] = (...args: unknown[]) => Reflect.apply(data[key] as (...values: unknown[]) => unknown, undefined, args);
    const adapter = Object.freeze(closures) as unknown as BrowserAccountAdapter;
    const verified = copyOwnDataRecord(await adapter.verifyTarget(binding, bindingHash), ["target", "bindingHash", "enforced"]);
    const checkedTarget = copyOwnDataRecord(verified["target"], ["id", "origin", "environment"]), enforced = copyOwnDataRecord(verified["enforced"], REQUIREMENTS);
    if (canonical(checkedTarget) !== canonical(binding.target) || verified["bindingHash"] !== bindingHash || Object.values(enforced).some(item => item !== true)) throw Error();
    // This is the trusted adapter's reviewed attestation, not independent proof
    // of provider configuration, effective scope or live session revocation.
    return Object.freeze({ adapter, binding, bindingHash });
  } catch { throw accountFailure("BROWSER_ACCOUNT_ADAPTER_REFUSED"); }
}
