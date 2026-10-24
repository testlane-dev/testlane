import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagedBrowserPlanUnchanged, prepareManagedBrowserPlan } from "../src/provisioning/preflight.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, "tl-browser-preflight-"));
  const files = new Set<string>(), directories: string[] = [];
  cleanup.push(async () => {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith("tl-browser-preflight-")) throw new Error("OWNED_TEST_PATH_REFUSED");
    for (const file of files) await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    for (const directory of directories.reverse()) await rmdir(directory);
    await rmdir(root);
  });
  for (const name of ["node_modules", "node_modules/@playwright", "node_modules/@playwright/test"]) {
    const directory = path.join(root, name); await mkdir(directory); directories.push(directory);
  }
  const put = async (name: string, value: string) => { const file = path.join(root, name); files.add(file); await writeFile(file, value); return file; };
  await put("package.json", '{"name":"synthetic-consumer","private":true,"type":"module"}');
  // Resolution fixture only: no Playwright package/CLI/spec is imported or run.
  await put("node_modules/@playwright/test/package.json", '{"name":"@playwright/test","exports":{"./cli":"./cli.mjs"}}');
  await put("node_modules/@playwright/test/cli.mjs", "throw new Error('SYNTHETIC_CLI_MUST_NOT_RUN');\n");
  const specFile = await put("flow.spec.mjs", "throw new Error('SYNTHETIC_SPEC_MUST_NOT_RUN');\n");
  const adapterFile = await put("adapter.mjs", "throw new Error('SYNTHETIC_ADAPTER_MUST_NOT_RUN');\n");
  const plan = { schemaVersion: 1, status: "reviewed", title: "Synthetic browser behavior", projectDir: ".",
    target: { baseUrl: "http://127.0.0.1:4888", environment: "testing" }, evidence: { screenshots: "off" },
    cases: [{ id: "owned-flow", title: "Synthetic owned record", spec: "flow.spec.mjs", expected: ["Persisted result"], cleanup: { required: true, description: "Remove owned record" } }] };
  const binding = { schemaVersion: 1, status: "reviewed", target: { id: "11111111-1111-1111-1111-111111111111", origin: plan.target.baseUrl, environment: "testing" },
    adapter: { protocol: "testlane-disposable-browser-v1", modulePath: adapterFile, sha256: createHash("sha256").update("unexecuted").digest("hex") },
    roles: ["Editor", "Reviewer"], ttlMs: 600000, maxAccountsPerRun: 2, maxActiveAccounts: 4, maxCreateAttemptsPerHour: 10,
    effects: { email: false, sms: false, billing: false, webhooks: false },
    authTemplate: { strategy: "form-post", options: { loginPath: "/api/login", bodyFormat: "json", fields: '{"email":"{{email}}","password":"{{secret}}"}', sessionCookieName: "synthetic_session", mePath: "/api/me" }, roleLabels: { Editor: "Editor", Reviewer: "Reviewer" } } };
  const planFile = await put("plan.json", JSON.stringify(plan));
  return { root, files, put, plan, binding, planFile, specFile };
}

describe("managed browser preflight before account side effects", () => {
  it("resolves the installed app dependency and binds unchanged entries without executing app code", async () => {
    const f = await fixture(), prepared = await prepareManagedBrowserPlan(f.planFile, f.binding);
    expect(prepared.projectDirectory).toBe(f.root); expect(prepared.specs).toHaveLength(1);
    expect(prepared.playwrightCLI.file).toBe(path.join(f.root, "node_modules/@playwright/test/cli.mjs"));
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.specs)).toBe(true);
    await expect(assertManagedBrowserPlanUnchanged(prepared)).resolves.toBeUndefined();
  });

  it("blocks draft, mismatched origin/environment and screenshots before account creation", async () => {
    const f = await fixture();
    const variants = [{ ...f.plan, status: "draft" }, { ...f.plan, target: { ...f.plan.target, baseUrl: "http://localhost:4888" } },
      { ...f.plan, target: { ...f.plan.target, environment: "preview" } }, { ...f.plan, evidence: { screenshots: "manual" } }];
    for (const plan of variants) {
      await f.put("plan.json", JSON.stringify(plan));
      await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
    }
  });

  it("requires app-local Playwright and an in-project regular spec", async () => {
    const f = await fixture();
    await f.put("node_modules/@playwright/test/package.json", '{"name":"@playwright/test","exports":{}}');
    await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
    await f.put("node_modules/@playwright/test/package.json", '{"name":"@playwright/test","exports":{"./cli":"./cli.mjs"}}');
    await f.put("plan.json", JSON.stringify({ ...f.plan, cases: [{ ...f.plan.cases[0], spec: "../outside.spec.mjs" }] }));
    await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
  });

  it("rejects edited/replaced plan and spec entries and linked inputs", async () => {
    const f = await fixture(), prepared = await prepareManagedBrowserPlan(f.planFile, f.binding);
    await f.put("flow.spec.mjs", "// changed synthetic entry\n");
    await expect(assertManagedBrowserPlanUnchanged(prepared)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
    const linked = path.join(f.root, "linked-plan.json"); f.files.add(linked); await link(f.planFile, linked);
    await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
  });

  it("bounds plan data and omits raw parse/lookup errors", async () => {
    const f = await fixture();
    for (const text of ['{"synthetic-private-canary":', "x".repeat(256 * 1024 + 1)]) {
      await f.put("plan.json", text);
      await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
    }
  });

  it("rejects a dependency export retarget even when the original CLI bytes are unchanged", async () => {
    const f = await fixture(), prepared = await prepareManagedBrowserPlan(f.planFile, f.binding);
    await f.put("node_modules/@playwright/test/alternate-cli.mjs", "throw new Error('ALTERNATE_CLI_MUST_NOT_RUN');\n");
    await f.put("node_modules/@playwright/test/package.json", '{"name":"@playwright/test","exports":{"./cli":"./alternate-cli.mjs"}}');
    await expect(assertManagedBrowserPlanUnchanged(prepared)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
  });

  it("refuses conditional CLI exports and app package self-reference", async () => {
    const f = await fixture();
    await f.put("node_modules/@playwright/test/package.json", '{"name":"@playwright/test","exports":{"./cli":{"review":"./cli.mjs","default":"./cli.mjs"}}}');
    await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
    await f.put("node_modules/@playwright/test/package.json", '{"name":"@playwright/test","exports":{"./cli":"./cli.mjs"}}');
    await f.put("package.json", '{"name":"@playwright/test","private":true,"type":"module","exports":{"./cli":"./flow.spec.mjs"}}');
    await expect(prepareManagedBrowserPlan(f.planFile, f.binding)).rejects.toThrow(/^BROWSER_PLAN_PREFLIGHT_REFUSED$/);
  });
});
