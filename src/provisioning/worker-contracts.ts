/** Pure private handoff data. This module never imports parent account authority. */
import path from "node:path";
import { types } from "node:util";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const NONCE = /^[a-f0-9]{48}$/;
const TTL_MS = 600_000;

export function provisioningRefusal(): never {
  throw new Error("BROWSER_ACCOUNT_BINDING_REFUSED");
}

/** Internal shared data reader; it never invokes getters, proxies or coercion. */
export function copyOwnDataRecord(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) provisioningRefusal();
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (keys.some(key => typeof key !== "string" || !allowed.includes(key)) || required.some(key => !Object.hasOwn(fields, key))) provisioningRefusal();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key as string];
    if (!field || !Object.hasOwn(field, "value") || field.enumerable !== true) provisioningRefusal();
    Object.defineProperty(result, key, { value: field.value as unknown, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function copyDenseDataArray(value: unknown, length: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) provisioningRefusal();
  const fields = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const size = fields["length"];
  if (!size || !Object.hasOwn(size, "value") || size.value !== length || Reflect.ownKeys(fields).length !== length + 1) provisioningRefusal();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = fields[String(index)];
    if (!field || !Object.hasOwn(field, "value") || field.enumerable !== true) provisioningRefusal();
    result.push(field.value as unknown);
  }
  return result;
}

export function boundedDataString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) provisioningRefusal();
  return value;
}

/** Syntax only; the future parent must separately retain and verify real paths. */
export function absoluteLocalPath(value: unknown): string {
  const result = boundedDataString(value, 4096);
  if (!path.isAbsolute(result) || path.resolve(result) !== result || result.startsWith("\\\\") || result.startsWith("//")) provisioningRefusal();
  return result;
}

export function canonicalLoopbackOrigin(value: unknown): string {
  const result = boundedDataString(value, 2048);
  let url: URL;
  try { url = new URL(result); } catch { return provisioningRefusal(); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.origin !== result) provisioningRefusal();
  return result;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) provisioningRefusal();
  return value;
}

function expiry(value: unknown, nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(nowMs + TTL_MS) ||
      typeof value !== "number" || !Number.isSafeInteger(value) || value <= nowMs || value > nowMs + TTL_MS) provisioningRefusal();
  return value;
}

export interface BrowserWorkerBinding {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly runId: string;
  readonly expiresAt: number;
  readonly fixture: {
    readonly cliPath: string;
    readonly baseURL: string;
    readonly roles: { readonly editor: readonly [string]; readonly reviewer: readonly [string] };
  };
  readonly revocation: { readonly directory: string; readonly nonce: string };
}

/** Profile slots are private run-owned names, never a caller's existing profile. */
export function browserRunProfile(targetId: string, runId: string, role: "editor" | "reviewer"): string {
  uuid(targetId); uuid(runId);
  if (role !== "editor" && role !== "reviewer") provisioningRefusal();
  return `tl-disposable:${targetId}:${runId}:${role}`;
}

export function normalizeBrowserWorkerBinding(value: unknown, nowMs: number): BrowserWorkerBinding {
  const data = copyOwnDataRecord(value, ["schemaVersion", "targetId", "runId", "expiresAt", "fixture", "revocation"]);
  if (data["schemaVersion"] !== 1) provisioningRefusal();
  const targetId = uuid(data["targetId"]), runId = uuid(data["runId"]), expiresAt = expiry(data["expiresAt"], nowMs);
  const fixture = copyOwnDataRecord(data["fixture"], ["cliPath", "baseURL", "roles"]);
  const roles = copyOwnDataRecord(fixture["roles"], ["editor", "reviewer"]);
  const editor = browserRunProfile(targetId, runId, "editor"), reviewer = browserRunProfile(targetId, runId, "reviewer");
  if (copyDenseDataArray(roles["editor"], 1)[0] !== editor || copyDenseDataArray(roles["reviewer"], 1)[0] !== reviewer) provisioningRefusal();
  const revocation = copyOwnDataRecord(data["revocation"], ["directory", "nonce"]);
  if (typeof revocation["nonce"] !== "string" || !NONCE.test(revocation["nonce"])) provisioningRefusal();
  return Object.freeze({ schemaVersion: 1, targetId, runId, expiresAt,
    fixture: Object.freeze({ cliPath: absoluteLocalPath(fixture["cliPath"]), baseURL: canonicalLoopbackOrigin(fixture["baseURL"]),
      roles: Object.freeze({ editor: Object.freeze([editor] as [string]), reviewer: Object.freeze([reviewer] as [string]) }) }),
    revocation: Object.freeze({ directory: absoluteLocalPath(revocation["directory"]), nonce: revocation["nonce"] }) });
}

/** Called with parent-generated identities; this does not create files or accounts. */
export function createBrowserWorkerBinding(value: unknown, nowMs: number): BrowserWorkerBinding {
  const data = copyOwnDataRecord(value, ["targetId", "runId", "expiresAt", "cliPath", "baseURL", "runDirectory", "nonce"]);
  const targetId = uuid(data["targetId"]), runId = uuid(data["runId"]);
  return normalizeBrowserWorkerBinding({ schemaVersion: 1, targetId, runId, expiresAt: data["expiresAt"],
    fixture: { cliPath: data["cliPath"], baseURL: data["baseURL"], roles: {
      editor: [browserRunProfile(targetId, runId, "editor")], reviewer: [browserRunProfile(targetId, runId, "reviewer")] } },
    revocation: { directory: path.join(absoluteLocalPath(data["runDirectory"]), "revocation"), nonce: data["nonce"] } }, nowMs);
}

/** Pass this unchanged options shape to the existing createTestlaneTest(). */
export function browserFixtureOptions(value: unknown, nowMs: number): BrowserWorkerBinding["fixture"] {
  return normalizeBrowserWorkerBinding(value, nowMs).fixture;
}
