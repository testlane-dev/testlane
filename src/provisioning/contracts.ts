/** Parent-only reviewed input. No module loading, provisioning or filesystem I/O. */
import { validateStrategyOptions } from "../strategies/options.js";
import { absoluteLocalPath, boundedDataString, canonicalLoopbackOrigin, copyDenseDataArray, copyOwnDataRecord, provisioningRefusal } from "./worker-contracts.js";

export const BROWSER_ADAPTER_PROTOCOL = "testlane-disposable-browser-v1";
export const BROWSER_ACCOUNT_ROLES = Object.freeze(["Editor", "Reviewer"] as const);
export const BROWSER_ACCOUNT_TTL_MS = 600_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ENVIRONMENTS = ["local", "sandbox", "testing", "preview"] as const;
const FORM_OPTIONS = ["loginPath", "fields", "sessionCookieName", "bodyFormat", "primeCookies", "successPath", "successBodyField", "mePath", "roleField", "emailField"];
const NEXTAUTH_OPTIONS = ["csrfPath", "callbackPath", "sessionPath", "sessionCookieName", "emailField", "passwordField", "roleField"];

export interface BrowserAuthTemplate {
  readonly strategy: "form-post" | "nextauth-credentials";
  readonly options: Readonly<Record<string, string>>;
  readonly roleLabels: { readonly Editor: string; readonly Reviewer: string };
}

export interface BrowserAccountBinding {
  readonly schemaVersion: 1;
  readonly status: "reviewed";
  readonly target: { readonly id: string; readonly origin: string; readonly environment: typeof ENVIRONMENTS[number] };
  readonly adapter: { readonly protocol: typeof BROWSER_ADAPTER_PROTOCOL; readonly modulePath: string; readonly sha256: string };
  readonly roles: readonly ["Editor", "Reviewer"];
  readonly ttlMs: 600000;
  readonly maxAccountsPerRun: 2;
  readonly maxActiveAccounts: 4;
  readonly maxCreateAttemptsPerHour: 10;
  readonly effects: { readonly email: false; readonly sms: false; readonly billing: false; readonly webhooks: false };
  readonly authTemplate: BrowserAuthTemplate;
}

export function normalizeBrowserAuthTemplate(value: unknown): BrowserAuthTemplate {
  const data = copyOwnDataRecord(value, ["strategy", "options", "roleLabels"]);
  if (data["strategy"] !== "form-post" && data["strategy"] !== "nextauth-credentials") provisioningRefusal();
  const strategy = data["strategy"];
  const source = copyOwnDataRecord(data["options"], strategy === "form-post" ? FORM_OPTIONS : NEXTAUTH_OPTIONS, []);
  const options: Record<string, string> = {};
  let total = 0;
  for (const key of Object.keys(source)) {
    const text = boundedDataString(source[key], 2048);
    total += text.length;
    if (total > 8192) provisioningRefusal();
    options[key] = text;
  }
  // Reuse the broker's same-origin path, cookie/field and closed option schemas,
  // after hostile descriptors have been removed. Never expose schema error data.
  if (!validateStrategyOptions(strategy, options).success) provisioningRefusal();
  if (strategy === "form-post") {
    if (!options["loginPath"] || !options["fields"] || !options["sessionCookieName"] || !options["mePath"]) provisioningRefusal();
    let decoded: unknown;
    try { decoded = JSON.parse(options["fields"]); } catch { return provisioningRefusal(); }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) provisioningRefusal();
    const keys = Object.keys(decoded);
    if (keys.length < 2 || keys.length > 16) provisioningRefusal();
    const fields = copyOwnDataRecord(decoded, keys);
    let hasEmail = false, hasSecret = false;
    for (const field of Object.values(fields)) {
      if (typeof field !== "string" || field.length > 512) provisioningRefusal();
      hasEmail ||= field.includes("{{email}}"); hasSecret ||= field.includes("{{secret}}");
      // These are the only substitution names understood by form-post.
      if (/\{\{(?!email\}\}|secret\}\})/.test(field)) provisioningRefusal();
    }
    if (!hasEmail || !hasSecret) provisioningRefusal();
  }
  const roles = copyOwnDataRecord(data["roleLabels"], ["Editor", "Reviewer"]);
  const editor = boundedDataString(roles["Editor"], 64), reviewer = boundedDataString(roles["Reviewer"], 64);
  if (editor.trim() !== editor || reviewer.trim() !== reviewer || editor === reviewer) provisioningRefusal();
  return Object.freeze({ strategy, options: Object.freeze(options), roleLabels: Object.freeze({ Editor: editor, Reviewer: reviewer }) });
}

/**
 * Syntax and policy normalization only. The explicit consumer wrapper imports
 * trusted app code. An entry hash does not attest its imports, loaded object,
 * provider settings, private directories or actual nonproduction authority.
 */
export function normalizeBrowserAccountBinding(value: unknown): BrowserAccountBinding {
  const data = copyOwnDataRecord(value, ["schemaVersion", "status", "target", "adapter", "roles", "ttlMs", "maxAccountsPerRun", "maxActiveAccounts", "maxCreateAttemptsPerHour", "effects", "authTemplate"]);
  if (data["schemaVersion"] !== 1 || data["status"] !== "reviewed" || data["ttlMs"] !== BROWSER_ACCOUNT_TTL_MS ||
      data["maxAccountsPerRun"] !== 2 || data["maxActiveAccounts"] !== 4 || data["maxCreateAttemptsPerHour"] !== 10) provisioningRefusal();
  const roles = copyDenseDataArray(data["roles"], 2);
  if (roles[0] !== "Editor" || roles[1] !== "Reviewer") provisioningRefusal();
  const target = copyOwnDataRecord(data["target"], ["id", "origin", "environment"]);
  if (typeof target["id"] !== "string" || !UUID.test(target["id"]) || !ENVIRONMENTS.includes(target["environment"] as typeof ENVIRONMENTS[number])) provisioningRefusal();
  const adapter = copyOwnDataRecord(data["adapter"], ["protocol", "modulePath", "sha256"]);
  if (adapter["protocol"] !== BROWSER_ADAPTER_PROTOCOL || typeof adapter["sha256"] !== "string" || !SHA256.test(adapter["sha256"])) provisioningRefusal();
  const effects = copyOwnDataRecord(data["effects"], ["email", "sms", "billing", "webhooks"]);
  if (Object.values(effects).some(effect => effect !== false)) provisioningRefusal();
  return Object.freeze({ schemaVersion: 1, status: "reviewed",
    target: Object.freeze({ id: target["id"], origin: canonicalLoopbackOrigin(target["origin"]), environment: target["environment"] as typeof ENVIRONMENTS[number] }),
    adapter: Object.freeze({ protocol: BROWSER_ADAPTER_PROTOCOL, modulePath: absoluteLocalPath(adapter["modulePath"]), sha256: adapter["sha256"] }),
    roles: BROWSER_ACCOUNT_ROLES, ttlMs: BROWSER_ACCOUNT_TTL_MS, maxAccountsPerRun: 2, maxActiveAccounts: 4, maxCreateAttemptsPerHour: 10,
    effects: Object.freeze({ email: false, sms: false, billing: false, webhooks: false }), authTemplate: normalizeBrowserAuthTemplate(data["authTemplate"]) });
}
