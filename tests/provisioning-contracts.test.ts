import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_ADAPTER_PROTOCOL, normalizeBrowserAccountBinding, normalizeBrowserAuthTemplate } from "../src/provisioning/contracts.js";

const localPath = (...parts: string[]) => path.join(path.parse(process.cwd()).root, "reviewed-synthetic", ...parts);
const auth = () => ({ strategy: "form-post", options: { loginPath: "/api/login", bodyFormat: "json",
  fields: '{"email":"{{email}}","password":"{{secret}}"}', sessionCookieName: "test_session", mePath: "/api/me", emailField: "email", roleField: "role" },
  roleLabels: { Editor: "writer", Reviewer: "reader" } });
const binding = () => ({ schemaVersion: 1, status: "reviewed", target: { id: "11111111-1111-1111-1111-111111111111", origin: "http://127.0.0.1:4555", environment: "testing" },
  adapter: { protocol: BROWSER_ADAPTER_PROTOCOL, modulePath: localPath("unimported-adapter.mjs"), sha256: "a".repeat(64) },
  roles: ["Editor", "Reviewer"], ttlMs: 600_000, maxAccountsPerRun: 2, maxActiveAccounts: 4, maxCreateAttemptsPerHour: 10,
  effects: { email: false, sms: false, billing: false, webhooks: false }, authTemplate: auth() });
const refused = (operation: () => unknown) => expect(operation).toThrow(/^BROWSER_ACCOUNT_BINDING_REFUSED$/);

describe("reviewed parent browser account data", () => {
  it("pins the bounded policy and copies/freezes the complete input without loading the adapter", () => {
    const input = binding(), result = normalizeBrowserAccountBinding(input);
    expect(result).toEqual(input);
    input.target.origin = "http://localhost:4556"; input.authTemplate.roleLabels.Editor = "changed";
    expect(result.target.origin).toBe("http://127.0.0.1:4555"); expect(result.authTemplate.roleLabels.Editor).toBe("writer");
    for (const value of [result, result.target, result.adapter, result.roles, result.effects, result.authTemplate, result.authTemplate.options, result.authTemplate.roleLabels]) expect(Object.isFrozen(value)).toBe(true);
  });

  it("admits only explicit canonical loopback targets and fixed enabled policy", () => {
    for (const origin of ["https://localhost:4555", "http://[::1]:4555"]) expect(normalizeBrowserAccountBinding({ ...binding(), target: { ...binding().target, origin } }).target.origin).toBe(origin);
    for (const origin of ["https://sandbox.example.test", "http://127.1:4555", "http://LOCALHOST:4555", "http://localhost:4555/", "http://user@localhost:4555", "http://localhost:4555/path", "http://localhost:4555?token=x"]) refused(() => normalizeBrowserAccountBinding({ ...binding(), target: { ...binding().target, origin } }));
    for (const change of [{ status: "draft" }, { ttlMs: 600001 }, { maxAccountsPerRun: 3 }, { maxActiveAccounts: 5 }, { maxCreateAttemptsPerHour: 11 }, { roles: ["Editor", "Admin"] }, { effects: { ...binding().effects, email: true } }]) refused(() => normalizeBrowserAccountBinding({ ...binding(), ...change }));
    refused(() => normalizeBrowserAccountBinding({ ...binding(), target: { ...binding().target, environment: "production" } }));
  });

  it("requires entry identity syntax without accepting a loader or extra authority fields", () => {
    for (const adapter of [{ ...binding().adapter, modulePath: "./adapter.mjs" }, { ...binding().adapter, sha256: "A".repeat(64) }, { ...binding().adapter, protocol: "other" }, { ...binding().adapter, adminKey: "synthetic-canary" }]) refused(() => normalizeBrowserAccountBinding({ ...binding(), adapter }));
    refused(() => normalizeBrowserAccountBinding({ ...binding(), ledger: localPath("ledger") }));
  });

  it("reuses the broker cookie-option contract for the closed password strategies", () => {
    const next = normalizeBrowserAuthTemplate({ strategy: "nextauth-credentials", options: { csrfPath: "/api/auth/csrf", callbackPath: "/api/auth/callback/credentials", sessionPath: "/api/auth/session", emailField: "email", passwordField: "password", roleField: "user.role" }, roleLabels: auth().roleLabels });
    expect(next.strategy).toBe("nextauth-credentials");
    for (const strategy of ["app-handoff", "dependent-token", "oidc-pkce"]) refused(() => normalizeBrowserAuthTemplate({ ...auth(), strategy }));
    for (const options of [{ ...auth().options, rotatePath: "/api/password" }, { ...auth().options, adminKey: "synthetic-canary" }, { ...auth().options, headers: "synthetic-canary" }, { ...auth().options, loginPath: "//other.example.test/login" }, { ...auth().options, loginPath: "/\\other/login" }]) refused(() => normalizeBrowserAuthTemplate({ ...auth(), options }));
  });

  it("refuses incomplete email/secret substitution, unknown placeholders and oversized options", () => {
    for (const fields of ['{"email":"{{email}}","password":"literal"}', '{"email":"literal","password":"{{secret}}"}', '{"email":"{{email}}","password":"{{secret}}","admin":"{{providerKey}}"}', "[]"]) refused(() => normalizeBrowserAuthTemplate({ ...auth(), options: { ...auth().options, fields } }));
    refused(() => normalizeBrowserAuthTemplate({ ...auth(), options: { ...auth().options, sessionCookieName: "x".repeat(2049) } }));
    const { mePath: _identityPath, ...withoutIdentity } = auth().options;
    refused(() => normalizeBrowserAuthTemplate({ ...auth(), options: withoutIdentity }));
    refused(() => normalizeBrowserAuthTemplate({ ...auth(), roleLabels: { Editor: "same", Reviewer: "same" } }));
    refused(() => normalizeBrowserAuthTemplate({ ...auth(), roleLabels: { Editor: " writer ", Reviewer: "reader" } }));
  });

  it("ignores no unknown parent/template metadata and never evaluates hostile input", () => {
    let invoked = false;
    const getter = { ...binding() }; Object.defineProperty(getter, "adapter", { enumerable: true, get() { invoked = true; throw Error("synthetic-canary"); } });
    const nested = { ...auth().options }; Object.defineProperty(nested, "loginPath", { enumerable: true, get() { invoked = true; throw Error("synthetic-canary"); } });
    const proxy = new Proxy(binding(), { getPrototypeOf() { invoked = true; throw Error("synthetic-canary"); } });
    for (const value of [getter, proxy, { ...binding(), authTemplate: { ...auth(), options: nested } }, Object.create(binding()), { ...binding(), [Symbol("private")]: "synthetic-canary" }, { ...binding(), authTemplate: { ...auth(), account: { email: "synthetic-canary" } } }]) refused(() => normalizeBrowserAccountBinding(value));
    expect(invoked).toBe(false);
  });

  it("refuses array callbacks/accessors and contains encoded canaries only in fixed errors", () => {
    let invoked = false;
    const roles = ["Editor", "Reviewer"];
    Object.defineProperty(roles, "map", { get() { invoked = true; throw Error("synthetic-canary"); } });
    refused(() => normalizeBrowserAccountBinding({ ...binding(), roles }));
    const hole = new Array(2); hole[1] = "Reviewer";
    refused(() => normalizeBrowserAccountBinding({ ...binding(), roles: hole }));
    for (const canary of ["private-synthetic-canary", encodeURIComponent("private synthetic canary"), Buffer.from("private synthetic canary").toString("base64")]) {
      refused(() => normalizeBrowserAccountBinding({ ...binding(), target: { ...binding().target, origin: canary } }));
      refused(() => normalizeBrowserAuthTemplate({ ...auth(), options: { ...auth().options, unknown: canary } }));
    }
    expect(invoked).toBe(false);
  });
});
