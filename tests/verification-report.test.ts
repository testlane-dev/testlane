import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const rendererUrl = new URL("../examples/agent-verification/render.mjs", import.meta.url);
const runtimeUrl = new URL("../examples/agent-verification/runtime.mjs", import.meta.url);
const { renderVerificationReport } = await import(rendererUrl.href) as {
  renderVerificationReport: (options: { reportFile: string; planFile: string }) => Promise<{ status: string; filename: string }>;
};
const { LIMITS } = await import(runtimeUrl.href) as { LIMITS: string[] };
const execute = promisify(execFile);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const runId = "b4b5ecaf-9108-44f3-bc61-c07ba480207f";
const filename = "screenshot-1b84ce6c-efc0-43c0-b936-88d5d059ce07.png";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZkbwAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
type Row = { id: string; status: string; reason: string; cleanup: { required: boolean; status: string }; attempts: number; assertionsObserved?: number; specId?: string };
type Artifact = { kind: string; path: string; caseId: string; size: number; sha256: string; private: boolean; review: string };

async function fixture({ screenshot = false, malicious = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-report-"));
  roots.push(directory);
  const plan = {
    schemaVersion: 1, status: "reviewed", title: malicious ? '<script>alert("plan")</script>' : "Verify a saved note",
    target: { baseUrl: "http://127.0.0.1:40123", environment: "testing" },
    evidence: { screenshots: screenshot ? "manual" : "off" },
    cases: [{ id: "save-note", title: malicious ? '<img src=x onerror="alert(1)">' : "Saved note survives reload", spec: "e2e/notes.spec.mjs",
      expected: [malicious ? '</li><script>alert("expected")</script><li>' : "The exact note is present after reload"],
      cleanup: { required: true, description: malicious ? '<a href="javascript:alert(1)">cleanup</a>' : "Delete only this run's note and assert it is absent" } }],
  };
  const planFile = path.join(directory, "plan.json");
  const reportFile = path.join(directory, "report.json");
  const planBytes = JSON.stringify(plan, null, 2) + "\n";
  const specId = sha(plan.cases[0]!.spec);
  const report = {
    schemaVersion: 1, runId, harness: { version: "1", sha256: "a".repeat(64) }, helper: { version: "1", sha256: "b".repeat(64) },
    plan: { sha256: sha(planBytes) }, specs: [{ id: specId, sha256: "c".repeat(64) }], reportPath: `run-${runId}/report.json`,
    verdict: "passed", reasonCodes: [] as string[],
    cases: [{ id: "save-note", status: "passed", reason: "CASE_PASSED", cleanup: { required: true, status: "completed" }, attempts: 1, assertionsObserved: 3, specId }] as Row[],
    artifacts: [] as Artifact[], limits: LIMITS,
    execution: { exitCode: 0 as number | null, cancelled: false, forced: false },
  };
  if (screenshot) {
    await fs.mkdir(path.join(directory, "artifacts"));
    await fs.writeFile(path.join(directory, "artifacts", filename), png);
    report.artifacts.push({ kind: "screenshot", path: "artifacts/" + filename, caseId: "save-note", size: png.length, sha256: sha(png), private: true, review: "unreviewed" });
  }
  const saveReport = () => fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(planFile, planBytes);
  await saveReport();
  return { directory, planFile, reportFile, plan, report, saveReport };
}

afterEach(async () => {
  for (const directory of roots.splice(0)) {
    const resolved = path.resolve(directory);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved)).toMatch(/^testlane-report-/);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

describe("private static verification report", () => {
  it("renders an honest failed report, hashes, assertions, cleanup and limits without modifying inputs", async () => {
    const item = await fixture();
    item.report.verdict = "failed";
    item.report.execution.exitCode = 1;
    item.report.cases[0]!.status = "failed";
    item.report.cases[0]!.reason = "CASE_FAILED";
    await item.saveReport();
    const before = await fs.readFile(item.reportFile);
    expect(await renderVerificationReport(item)).toEqual({ status: "rendered", filename: "summary.html" });
    expect(await fs.readFile(item.reportFile)).toEqual(before);
    const html = await fs.readFile(path.join(item.directory, "summary.html"), "utf8");
    expect(html).toContain('class="status failed">failed');
    expect(html).toContain("Saved note survives reload");
    expect(html).toContain("3 observed assertions");
    expect(html).toContain("CASE_FAILED");
    expect(html).toContain("Cleanup: completed (required)");
    expect(html).toContain(item.report.plan.sha256);
    expect(html).toContain("c".repeat(64));
    expect(html).toContain("not signed");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("base-uri 'none'; form-action 'none'");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).not.toMatch(/<script|<link|<iframe|<img|\sonclick=/i);
  });

  it("binds the exact plan bytes rather than equivalent parsed JSON", async () => {
    const item = await fixture();
    await fs.appendFile(item.planFile, " ");
    await expect(renderVerificationReport(item)).rejects.toThrow("PLAN_HASH_MISMATCH");
    await expect(fs.stat(path.join(item.directory, "summary.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("escapes malicious planned titles, expectations and cleanup descriptions", async () => {
    const item = await fixture({ malicious: true });
    await renderVerificationReport(item);
    const html = await fs.readFile(path.join(item.directory, "summary.html"), "utf8");
    expect(html).toContain("&lt;script&gt;alert(&quot;plan&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;/li&gt;&lt;script&gt;alert(&quot;expected&quot;)&lt;/script&gt;&lt;li&gt;");
    expect(html).toContain("&lt;a href=&quot;javascript:alert(1)&quot;&gt;cleanup&lt;/a&gt;");
    expect(html).not.toMatch(/<script|<img|href="javascript:/i);
  });

  it("links only checked local PNG evidence and marks its contents private and unreviewed", async () => {
    const item = await fixture({ screenshot: true });
    await renderVerificationReport(item);
    const html = await fs.readFile(path.join(item.directory, "summary.html"), "utf8");
    expect(html).toContain('download href="artifacts/' + filename + '"');
    expect(html).toContain("private, unreviewed");
    expect(html).toContain("no binary redaction is claimed");
  });

  it.each(["../outside.png", "artifacts/../outside.png", "https://example.test/image.png", "C:/outside.png", "artifacts\\" + filename])("refuses unsafe artifact path %s", async unsafe => {
    const item = await fixture({ screenshot: true });
    item.report.artifacts[0]!.path = unsafe;
    await item.saveReport();
    await expect(renderVerificationReport(item)).rejects.toThrow("ARTIFACT_INVALID");
  });

  it("rejects artifact hash and size mismatches before creating a summary", async () => {
    const item = await fixture({ screenshot: true });
    item.report.artifacts[0]!.sha256 = "d".repeat(64);
    await item.saveReport();
    await expect(renderVerificationReport(item)).rejects.toThrow("ARTIFACT_INVALID");
    item.report.artifacts[0]!.sha256 = sha(png);
    item.report.artifacts[0]!.size++;
    await item.saveReport();
    await expect(renderVerificationReport(item)).rejects.toThrow("ARTIFACT_INVALID");
    await expect(fs.stat(path.join(item.directory, "summary.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink/junction artifact directory even when bytes and hash match", async () => {
    const item = await fixture({ screenshot: true });
    const artifactDirectory = path.join(item.directory, "artifacts");
    const target = path.join(item.directory, "outside-artifacts");
    await fs.rename(artifactDirectory, target);
    await fs.symlink(target, artifactDirectory, process.platform === "win32" ? "junction" : "dir");
    await expect(renderVerificationReport(item)).rejects.toThrow("ARTIFACT_INVALID");
  });

  it("refuses a non-PNG even when the declared bytes, size and hash agree", async () => {
    const item = await fixture({ screenshot: true });
    const bytes = Buffer.from("<html>not a screenshot</html>");
    await fs.writeFile(path.join(item.directory, "artifacts", filename), bytes);
    item.report.artifacts[0]!.size = bytes.length;
    item.report.artifacts[0]!.sha256 = sha(bytes);
    await item.saveReport();
    await expect(renderVerificationReport(item)).rejects.toThrow("ARTIFACT_INVALID");
  });

  it("refuses to overwrite a prior summary and preserves the existing report", async () => {
    const item = await fixture();
    const original = await fs.readFile(item.reportFile);
    await fs.writeFile(path.join(item.directory, "summary.html"), "prior reviewed summary");
    await expect(renderVerificationReport(item)).rejects.toThrow("SUMMARY_EXISTS");
    expect(await fs.readFile(path.join(item.directory, "summary.html"), "utf8")).toBe("prior reviewed summary");
    expect(await fs.readFile(item.reportFile)).toEqual(original);
  });

  it.each(["zero-assertions", "failed-cleanup", "unknown-case", "unknown-reason", "duplicate-case", "raw-error", "bad-spec", "negative-count", "global-failure"])("refuses inconsistent or unsafe report state: %s", async mutation => {
    const item = await fixture();
    const row = item.report.cases[0]!;
    if (mutation === "zero-assertions") row.assertionsObserved = 0;
    if (mutation === "failed-cleanup") row.cleanup.status = "failed";
    if (mutation === "unknown-case") row.id = "not-planned";
    if (mutation === "unknown-reason") row.reason = "RAW_OBSERVED_VALUE";
    if (mutation === "duplicate-case") item.report.cases.push({ ...row });
    if (mutation === "raw-error") Object.assign(item.report, { error: "raw browser response must not render" });
    if (mutation === "bad-spec") row.specId = "e".repeat(64);
    if (mutation === "negative-count") row.assertionsObserved = -1;
    if (mutation === "global-failure") item.report.reasonCodes = ["TEST_RUN_FAILED"];
    await item.saveReport();
    await expect(renderVerificationReport(item)).rejects.toThrow("REPORT_INVALID");
  });

  it("renders a blocked setup without inventing absent assertion or source evidence", async () => {
    const item = await fixture();
    item.report.verdict = "blocked";
    item.report.reasonCodes = ["PLAYWRIGHT_UNAVAILABLE"];
    item.report.specs = [];
    item.report.cases = [{ id: "save-note", status: "blocked", reason: "CASE_NOT_RUN", cleanup: { required: true, status: "unknown" }, attempts: 0 }];
    const { helper: _helper, execution: _execution, ...report } = item.report;
    report.harness = { version: "1", sha256: undefined as unknown as string };
    await fs.writeFile(item.reportFile, JSON.stringify(report));
    await renderVerificationReport(item);
    const html = await fs.readFile(path.join(item.directory, "summary.html"), "utf8");
    expect(html).toContain('class="status blocked">blocked');
    expect(html).toContain("0 observed assertions");
    expect(html).toContain("not recorded");
    expect(html).toContain("Cleanup: unknown");
  });

  it("standalone JSON output contains only fixed status and filename", async () => {
    const item = await fixture({ malicious: true });
    const output = await execute(process.execPath, [fileURLToPath(rendererUrl), "--report", item.reportFile, "--plan", item.planFile, "--json"], { windowsHide: true });
    expect(JSON.parse(output.stdout)).toEqual({ status: "rendered", filename: "summary.html" });
    expect(output.stderr).toBe("");
  });

  it("executes the standalone CLI through a symlink or Windows junction path alias", async () => {
    const item = await fixture();
    const alias = path.join(item.directory, "renderer-alias");
    await fs.symlink(path.dirname(fileURLToPath(rendererUrl)), alias, process.platform === "win32" ? "junction" : "dir");
    const output = await execute(process.execPath, [path.join(alias, "render.mjs"), "--report", item.reportFile, "--plan", item.planFile, "--json"], { windowsHide: true });
    expect(JSON.parse(output.stdout)).toEqual({ status: "rendered", filename: "summary.html" });
    expect(output.stderr).toBe("");
    expect((await fs.stat(path.join(item.directory, "summary.html"))).isFile()).toBe(true);
  });
});
