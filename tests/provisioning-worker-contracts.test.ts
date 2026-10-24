import path from "node:path";
import { expect, it } from "vitest";
import { browserFixtureOptions, browserRunProfile, createBrowserWorkerBinding, normalizeBrowserWorkerBinding } from "../src/provisioning/worker-contracts.js";

const root = path.join(path.parse(process.cwd()).root, "private-synthetic-run");
const now = 1_000_000, targetId = "11111111-1111-1111-1111-111111111111", runId = "22222222-2222-2222-2222-222222222222";
const input = () => ({ targetId, runId, expiresAt: now + 600_000, cliPath: path.join(root, "installed", "dist", "cli.js"), baseURL: "http://127.0.0.1:4555", runDirectory: root, nonce: "a".repeat(48) });
const config = () => createBrowserWorkerBinding(input(), now);
const refused = (operation: () => unknown) => expect(operation).toThrow(/^BROWSER_ACCOUNT_BINDING_REFUSED$/);

it("derives two distinct target/run/role profiles and supplies the unchanged fixture shape", () => {
  const value = config(), fixture = browserFixtureOptions(value, now);
  expect(fixture).toEqual({ cliPath: input().cliPath, baseURL: input().baseURL, roles: { editor: [`tl-disposable:${targetId}:${runId}:editor`], reviewer: [`tl-disposable:${targetId}:${runId}:reviewer`] } });
  expect(value.revocation.directory).toBe(path.join(root, "revocation"));
  const secondRun = "33333333-3333-3333-3333-333333333333";
  expect(browserRunProfile(targetId, secondRun, "editor")).not.toBe(fixture.roles.editor[0]);
  expect(browserRunProfile(secondRun, runId, "editor")).not.toBe(fixture.roles.editor[0]);
  expect(Object.keys(fixture).sort()).toEqual(["baseURL", "cliPath", "roles"]);
  expect(Object.keys(value).sort()).toEqual(["expiresAt", "fixture", "revocation", "runId", "schemaVersion", "targetId"]);
});

it("freezes a copied worker lease and admits neither expiry renewal nor nonfinite clocks", () => {
  const value = config();
  for (const item of [value, value.fixture, value.fixture.roles, value.fixture.roles.editor, value.fixture.roles.reviewer, value.revocation]) expect(Object.isFrozen(item)).toBe(true);
  for (const expiresAt of [now, now - 1, now + 600_001, NaN, Infinity, 1.5]) refused(() => createBrowserWorkerBinding({ ...input(), expiresAt }, now));
  for (const time of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) refused(() => normalizeBrowserWorkerBinding(value, time));
  refused(() => browserFixtureOptions(value, value.expiresAt));
});

it("refuses reused human profiles, parallel slots, target swaps and parent authority", () => {
  const value = config();
  for (const roles of [{ editor: ["human:testing:editor"], reviewer: value.fixture.roles.reviewer }, { ...value.fixture.roles, reviewer: value.fixture.roles.editor }, { ...value.fixture.roles, editor: [...value.fixture.roles.editor, "human:testing:editor"] }]) refused(() => normalizeBrowserWorkerBinding({ ...value, fixture: { ...value.fixture, roles } }, now));
  refused(() => normalizeBrowserWorkerBinding({ ...value, targetId: "33333333-3333-3333-3333-333333333333" }, now));
  for (const extra of ["adapter", "policy", "authTemplate", "ledger", "password", "session"]) refused(() => normalizeBrowserWorkerBinding({ ...value, [extra]: "private-synthetic-canary" }, now));
  refused(() => normalizeBrowserWorkerBinding({ ...value, fixture: { ...value.fixture, baseURL: "https://preview.example.test" } }, now));
});

it("refuses malformed barriers/paths and no callbacks execute during normalization", () => {
  const value = config(); let invoked = false;
  const barrier = { ...value.revocation }; Object.defineProperty(barrier, "nonce", { enumerable: true, get() { invoked = true; return "a".repeat(48); } });
  const roles: string[] = []; Object.defineProperty(roles, "0", { enumerable: true, get() { invoked = true; return value.fixture.roles.editor[0]; } });
  const proxied = new Proxy(value.fixture, { ownKeys() { invoked = true; throw Error("private-synthetic-canary"); } });
  for (const item of [{ ...value, revocation: barrier }, { ...value, fixture: { ...value.fixture, roles: { ...value.fixture.roles, editor: roles } } }, { ...value, fixture: proxied }, { ...value, revocation: { ...value.revocation, nonce: "b".repeat(47) } }, { ...value, fixture: { ...value.fixture, cliPath: "./cli.js" } }, { ...value, [Symbol("private")]: "private-synthetic-canary" }]) refused(() => normalizeBrowserWorkerBinding(item, now));
  expect(invoked).toBe(false);
});

it("refuses revoked array proxies with the same fixed error before intrinsic array checks", () => {
  let invoked = false;
  const value = config(), revocable = Proxy.revocable([value.fixture.roles.editor[0]], { get() { invoked = true; throw Error("private-synthetic-canary"); } });
  revocable.revoke();
  refused(() => normalizeBrowserWorkerBinding({ ...value, fixture: { ...value.fixture, roles: { ...value.fixture.roles, editor: revocable.proxy } } }, now));
  expect(invoked).toBe(false);
});
