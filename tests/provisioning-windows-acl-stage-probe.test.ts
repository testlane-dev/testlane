import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { markedWindowsDirectoryScript, observeWindowsAclStages, retainFailedWindowsPreflight } from "./provisioning-windows-acl-stage-probe.js";

it("the marked script reconstructs the actual unchanged guard and refuses altered/duplicate anchors", async () => {
  const source = await readFile(new URL("../src/provisioning/private-directory.ts", import.meta.url), "utf8");
  const value = markedWindowsDirectoryScript(source);
  expect(value.reconstructed).toBe(value.original);
  expect((value.script.match(/TLACL:/g) ?? []).length).toBe(17);
  expect(value.script).toContain("$raw=[Console]::In.ReadToEnd()");
  expect(value.script).toContain("$request=$raw | ConvertFrom-Json");
  expect(() => markedWindowsDirectoryScript(source + source)).toThrow("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED");
  expect(() => markedWindowsDirectoryScript(source.replace("$inheritance=", "$changed="))).toThrow("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED");
});
it("actual event control exports only fixed markers/counts and preserves the 15s/5s unknown-close bounds", async () => {
  vi.useFakeTimers();
  try {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), unref: vi.fn() });
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const task = observeWindowsAclStages("fixed-script", "C:\\owned-parent", "C:\\Windows", spawn);
    child.emit("spawn"); child.stderr.write("TLACL:entry\r\nTLACL:input-begin\r\nPRIVATE_CANARY_URL_SECRET\n");
    child.stdout.write("PRIVATE_CANARY_STDOUT"); child.emit("error", new Error("PRIVATE_CANARY_ERROR"));
    await vi.advanceTimersByTimeAsync(14999); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(4999); expect(child.unref).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); const result = await task;
    expect(result).toMatchObject({ timeout: true, stopWaitExpired: true, closed: false, diagnosticCompleted: false, unexpectedOutput: true, rawOutputExported: false, executions: 1 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|fixed-script|owned-parent|Windows/);
    expect(result).toMatchObject({ stages: [{ stage: "entry" }, { stage: "input-begin" }] });
    expect(spawn).toHaveBeenCalledTimes(1); expect(child.unref).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it("one diagnostic can neither turn a failed preflight into pass nor replace its fixed failure", async () => {
  const run = vi.fn(async () => {});
  await retainFailedWindowsPreflight(true, true, run); expect(run).not.toHaveBeenCalled();
  await expect(retainFailedWindowsPreflight(false, false, run)).rejects.toThrow("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED"); expect(run).not.toHaveBeenCalled();
  await expect(retainFailedWindowsPreflight(false, true, run)).rejects.toThrow("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED"); expect(run).toHaveBeenCalledTimes(1);
  const refused = vi.fn(async () => { throw new Error("PRIVATE_CANARY"); });
  await expect(retainFailedWindowsPreflight(false, true, refused)).rejects.toThrow("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED"); expect(refused).toHaveBeenCalledTimes(1);
});

it("only the complete ordered marker sequence with exact READY and acknowledged close completes", async () => {
  for (const fixedRefusal of [false, true]) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), unref: vi.fn() });
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const task = observeWindowsAclStages("fixed-script", "C:\\owned-parent", "C:\\Windows", spawn);
    child.emit("spawn");
    for (const stage of ["entry", "input-begin", "input-end", "json-end", "identity-end", "parent-info-end", "parent-acl-begin", "parent-acl-end", "parent-rules-end", "create-begin", "create-end", "target-info-end", "target-acl-begin", "target-acl-end", "target-rules-end", "ready"]) child.stderr.write("TLACL:" + stage + "\r\n");
    if (fixedRefusal) child.stderr.write("BROWSER_PRIVATE_DIRECTORY_REFUSED");
    child.stdout.write("BROWSER_PRIVATE_DIRECTORY_READY"); child.emit("exit", 0); child.emit("close", 0);
    expect(await task).toMatchObject({ closed: true, code: 0, readyEqual: true, diagnosticCompleted: !fixedRefusal, fixedRefusal, executions: 1, targetAlwaysRetained: true });
    expect(spawn).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
  }
});
