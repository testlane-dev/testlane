import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { projectManagedBrowserOutcome } from "../src/provisioning/managed-report.js";
import type { PreparedBrowserPlan } from "../src/provisioning/preflight.js";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture() {
  const runtimeURL = new URL("../examples/agent-verification/runtime.mjs", import.meta.url).href;
  const { LIMITS } = await import(runtimeURL) as { LIMITS: string[] };
  const root = path.resolve("synthetic-managed-app"), source = path.join(root, "flow.spec.mjs");
  const bound = (file: string, sha256: string) => ({ file, sha256, dev: 1n, ino: 1n });
  const prepared: PreparedBrowserPlan = { plan: bound(path.join(root, "plan.json"), "a".repeat(64)), projectDirectory: root,
    packageFile: bound(path.join(root, "package.json"), "b".repeat(64)), playwrightManifest: bound(path.join(root, "node_modules/@playwright/test/package.json"), "c".repeat(64)),
    playwrightCLI: bound(path.join(root, "node_modules/@playwright/test/cli.js"), "d".repeat(64)), specs: [bound(source, "e".repeat(64))], origin: "http://127.0.0.1:4555", environment: "testing" };
  const planned = [{ id: "complete-flow", spec: "flow.spec.mjs", cleanup: { required: true } }], runId = randomUUID();
  const report = { schemaVersion: 1, runId, harness: { version: "1", sha256: "f".repeat(64) }, helper: { version: "1", sha256: "1".repeat(64) }, plan: { sha256: prepared.plan.sha256 },
    specs: [{ id: hash(planned[0]!.spec), sha256: "e".repeat(64) }], reportPath: `run-${runId}/report.json`, verdict: "passed", reasonCodes: [] as string[],
    cases: [{ id: "complete-flow", status: "passed", reason: "CASE_PASSED", attempts: 1, assertionsObserved: 4, cleanup: { required: true, status: "completed" }, specId: hash(planned[0]!.spec), failureLocation: null }],
    artifacts: [], limits: LIMITS, execution: { exitCode: 0, cancelled: false, forced: false } };
  const sources = { helperSHA256: report.helper.sha256, harnessSHA256: report.harness.sha256 };
  return { prepared, planned, report, read: (value: unknown, code = 0) => projectManagedBrowserOutcome(value, code, prepared, planned, sources) };
}

it("accepts the bound passed report and a valid intended failed report as settled outcomes", async () => {
  const f = await fixture(); expect(await f.read(f.report)).toEqual({ verification: "passed", settled: true });
  const failed = structuredClone(f.report); failed.verdict = "failed"; failed.reasonCodes = ["TEST_RUN_FAILED"]; failed.execution.exitCode = 1;
  Object.assign(failed.cases[0]!, { status: "failed", reason: "CASE_FAILED" });
  expect(await f.read(failed, 1)).toEqual({ verification: "failed", settled: true });
});

it("forced, malformed, mismatched and unbound reports remain unknown with no raw data", async () => {
  const f = await fixture(), unknown = { verification: "blocked", settled: false };
  for (const mutate of [
    (v: typeof f.report) => { v.execution.forced = true; v.execution.cancelled = true; },
    (v: typeof f.report) => { v.reasonCodes.push("FORCED_STOP"); },
    (v: typeof f.report) => { v.plan.sha256 = "b".repeat(64); },
    (v: typeof f.report) => { v.helper.sha256 = "b".repeat(64); },
    (v: typeof f.report) => { v.harness.sha256 = "b".repeat(64); },
    (v: typeof f.report) => { v.specs[0]!.sha256 = "f".repeat(64); },
    (v: typeof f.report) => { v.cases[0]!.id = "different-case"; },
    (v: typeof f.report) => { v.cases[0]!.attempts = 2; },
    (v: typeof f.report) => { v.cases[0]!.cleanup.status = "unknown"; },
    (v: typeof f.report) => { v.cases[0]!.assertionsObserved = 0; },
  ]) { const candidate = structuredClone(f.report); mutate(candidate); expect(await f.read(candidate)).toEqual(unknown); }
  expect(await f.read(f.report, 1)).toEqual(unknown);
  expect(await f.read({ ...f.report, unreviewed: "synthetic-private-canary" })).toEqual(unknown);
});

it("refuses getters/proxies and nested coercion candidates before they can execute", async () => {
  const f = await fixture(); let invoked = false;
  const trap = () => { invoked = true; throw Error("synthetic-private-canary"); };
  const hostile = Object.defineProperty({ ...f.report }, "verdict", { get: trap, enumerable: true });
  expect((await f.read(hostile)).settled).toBe(false);
  expect((await f.read(new Proxy(f.report, { ownKeys: trap }))).settled).toBe(false);
  expect((await f.read({ ...f.report, verdict: { [Symbol.toPrimitive]: trap } })).settled).toBe(false);
  expect((await f.read({ ...f.report, limits: [{ toJSON: trap }] })).settled).toBe(false);
  expect((await f.read({ ...f.report, diagnostics: [{ code: "synthetic-private-canary", summary: { toJSON: trap }, remedy: "none" }] })).settled).toBe(false);
  const revoked = Proxy.revocable([], {}); revoked.revoke(); expect((await f.read({ ...f.report, cases: revoked.proxy })).settled).toBe(false);
  expect(invoked).toBe(false);
});
