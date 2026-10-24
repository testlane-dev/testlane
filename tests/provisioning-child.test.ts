import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserChildError, runBrowserChild } from "../src/provisioning/child.js";

const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "HOME", "TEMP", "TMP"]) {
  const value = process.env[key];
  if (value) env[key === "Path" ? "PATH" : key] = value;
}
const child = (code: string, extra: Partial<Parameters<typeof runBrowserChild>[0]> = {}) => runBrowserChild({
  entry: process.execPath, args: ["-e", code], cwd: process.cwd(), env, timeoutMs: 5000, ...extra,
});

describe("managed parent child boundary", () => {
  it("uses stdin for the private input and inherits only the supplied environment", async () => {
    const result = await child("let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({stdin:s==='synthetic-test-input\\n',argv:!process.argv.includes('synthetic-test-input'),env:process.env.TESTLANE_HOME===undefined}));});", { input: "synthetic-test-input" });
    expect(result).toEqual({ code: 0, stdout: '{"stdin":true,"argv":true,"env":true}', stderrEmpty: true });
  });

  it("returns an exit outcome and a stderr boolean without copying stderr values", async () => {
    const result = await child("process.stdout.write('ordinary');process.stderr.write('synthetic-private-error');process.exitCode=7;");
    expect(result).toEqual({ code: 7, stdout: "ordinary", stderrEmpty: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
  });

  it("rejects malformed requests and pre-cancelled launch without running code", async () => {
    await expect(child("process.exit(99)", { cwd: "relative" })).rejects.toMatchObject({ code: "BROWSER_CHILD_INPUT_REFUSED", terminationConfirmed: true });
    await expect(child("process.exit(99)", { input: "synthetic\nsecond-line" })).rejects.toMatchObject({ code: "BROWSER_CHILD_INPUT_REFUSED", terminationConfirmed: true });
    await expect(child("process.exit(99)", { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "BROWSER_CHILD_CANCELLED", terminationConfirmed: true });
    await expect(child("process.exit(99)", { entry: path.join(process.cwd(), "missing-synthetic-executable") })).rejects.toMatchObject({ code: "BROWSER_CHILD_START_FAILED", terminationConfirmed: true });
  });

  it("refuses missing ambient env, hostile descriptors and malformed JS inputs before launch", async () => {
    let touched = false;
    const getter = Object.defineProperty({}, "PATH", { enumerable: true, get() { touched = true; throw new Error("synthetic-canary"); } });
    const proxy = new Proxy({}, { ownKeys() { touched = true; throw new Error("synthetic-canary"); } });
    const options = { entry: process.execPath, args: ["-e", "process.exit(99)"], cwd: process.cwd(), env, timeoutMs: 5000 };
    const badValues: unknown[] = [null, { ...options, env: undefined }, { ...options, env: null }, { ...options, env: getter },
      { ...options, env: proxy }, { ...options, env: { PATH: "one", path: "two" } }, { ...options, env: { PATH: undefined } },
      { ...options, cwd: 1 }, { ...options, entry: {} }, { ...options, args: [1] }, { ...options, signal: {} },
      { ...options, input: { toString() { touched = true; throw new Error("synthetic-canary"); } } },
      Object.defineProperty({ ...options }, "input", { enumerable: true, get() { touched = true; throw new Error("synthetic-canary"); } }),
    ];
    for (const value of badValues) await expect(runBrowserChild(value as Parameters<typeof runBrowserChild>[0])).rejects.toMatchObject({ code: "BROWSER_CHILD_INPUT_REFUSED", terminationConfirmed: true });
    expect(touched).toBe(false);
  });

  it("refuses invalid UTF-8 instead of returning replacement bytes", async () => {
    await expect(child("process.stdout.write(Buffer.from([255]));")).rejects.toMatchObject({ code: "BROWSER_CHILD_OUTPUT_INVALID", terminationConfirmed: true });
  });

  it("bounds output, cancels the owned tree and never includes child text in the error", async () => {
    let failure: unknown;
    try { await child("process.stdout.write('synthetic-canary'.repeat(1000));setInterval(()=>{},1000);", { maxOutputBytes: 16 }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BrowserChildError);
    expect(failure).toMatchObject({ code: "BROWSER_CHILD_OUTPUT_LIMIT", terminationConfirmed: true });
    expect(String(failure)).not.toContain("synthetic-canary");
  });

  it("bounds a live unresponsive command and cancels it on an explicit signal", async () => {
    await expect(child("setInterval(()=>{},1000)", { timeoutMs: 150 })).rejects.toMatchObject({ code: "BROWSER_CHILD_TIMEOUT", terminationConfirmed: true });
    const controller = new AbortController();
    const operation = child("setInterval(()=>{},1000)", { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 150);
    try { await expect(operation).rejects.toMatchObject({ code: "BROWSER_CHILD_CANCELLED", terminationConfirmed: true }); }
    finally { clearTimeout(timer); }
  });
});
