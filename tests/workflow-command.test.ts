import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkflow, type WorkflowRunOptions } from "../src/workflow.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const { spawn: actualSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const children: ChildProcess[] = [];
const cwd = fileURLToPath(new URL("../", import.meta.url));

class Capture extends Writable {
  text = "";
  override _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    this.text += String(chunk);
    done();
  }
}
function options(kind: "smoke" | "feature" = "feature"): WorkflowRunOptions & { stdout: Capture; stderr: Capture } {
  return { kind, manifest: "reviewed workflow.json", receipt: "receipt.json", outputDir: "output", json: true, cwd, stdout: new Capture(), stderr: new Capture() };
}
function substituteChild(program: string, flags: string[] = []) {
  vi.mocked(spawn).mockImplementation((command, args, spawnOptions) => {
    expect(command).toBe(process.execPath);
    expect(args?.[0]).toMatch(/examples[\\/]workflows[\\/](?:feature-acceptance|authenticated-smoke)[\\/]run\.mjs$/);
    expect(spawnOptions?.shell).toBe(false);
    expect(spawnOptions?.stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
    const child = actualSpawn(command, [...flags, "--input-type=module", "-e", program], { ...spawnOptions, env: { ...spawnOptions?.env, NODE_NO_WARNINGS: "1" } });
    children.push(child);
    return child;
  });
}
beforeEach(() => { vi.mocked(spawn).mockReset().mockImplementation(actualSpawn); });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  })));
  vi.restoreAllMocks();
});

describe("workflow command cancellation", () => {
  it("queues cancellation before child readiness and waits for cooperative cleanup", async () => {
    substituteChild(`
      process.on('message', message => {
        if (message !== 'testlane:workflow:cancel:v1') throw new Error('unexpected control message');
        setTimeout(() => { process.stdout.write('cleanup-complete\\n'); process.disconnect(); }, 40);
      });
      setTimeout(() => process.send('testlane:workflow:ready:v1'), 40);
    `);
    const opts = options();
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const pending = runWorkflow(opts);
    const child = children[0]!;
    const kill = vi.spyOn(child, "kill");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    expect(await pending).toBe(1);
    expect(opts.stdout.text).toContain("cleanup-complete");
    expect(kill).not.toHaveBeenCalled();
    expect(opts.stderr.text.match(/cancellation requested/g)).toHaveLength(1);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    const args = vi.mocked(spawn).mock.calls[0]![1]!;
    expect(args).toContain(path.join(cwd, "reviewed workflow.json"));
    expect(args).not.toContain("--broker-cli");
  });

  it.each(["smoke", "feature"] as const)("gives an unresponsive %s child its full cleanup window before emergency termination", async kind => {
    substituteChild(`process.on('message', () => {}); process.send('testlane:workflow:ready:v1');`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opts = options(kind);
    const pending = runWorkflow(opts);
    const child = children.at(-1)!;
    const kill = vi.spyOn(child, "kill");
    await new Promise<void>(resolve => child.once("message", () => resolve()));
    process.emit("SIGTERM");
    const bound = kind === "feature" ? 75_000 : 135_000;
    await vi.advanceTimersByTimeAsync(bound - 1);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(await pending).toBe(1);
    expect(opts.stderr.text).toContain("retained test data");
  });

  it("preserves a normal successful exit without signal listeners or IPC keeping it alive", async () => {
    substituteChild(`process.stdout.write('passed\\n'); process.exitCode = 0; process.disconnect();`);
    const opts = options();
    expect(await runWorkflow(opts)).toBe(0);
    expect(opts.stdout.text).toContain("passed");
    expect(opts.stderr.text).toBe("");
  });

  it("reports synchronous spawn failures without echoing raw errors", async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("private-error-detail"); });
    const opts = options();
    expect(await runWorkflow(opts)).toBe(1);
    expect(opts.stderr.text).toContain("could not start");
    expect(opts.stderr.text).not.toContain("private-error-detail");
  });

  it.each(["authenticated-smoke", "feature-acceptance"])("retains an IPC cancellation received before the actual %s runner creates its deadline", async template => {
    const runner = path.join(cwd, "examples", "workflows", template, "run.mjs");
    // Exercise the real runner control flow in another Node process. Only its
    // workflow effects are doubled; the parent and runner use actual IPC.
    const program = `
      import { mock } from 'node:test';
      const runner = ${JSON.stringify(pathToFileURL(runner).href)};
      const sibling = name => new URL(name, runner).href;
      let release;
      const cancelledBeforeRead = new Promise(resolve => { release = resolve; });
      process.once('message', message => { if (message === 'testlane:workflow:cancel:v1') release(); });
      mock.module('node:fs/promises', { namedExports: { readFile: async () => { await cancelledBeforeRead; return '{}'; } } });
      const workflow = { id: 'cancel-proof', timeoutMs: 1000, target: { origin: 'http://127.0.0.1:4310', environment: 'testing' }, profile: 'app:testing', roles: { writer: { profile: 'app:writer' }, reader: { profile: 'app:reader' } } };
      mock.module(sibling('manifest.mjs'), { namedExports: { parseWorkflow: () => workflow, parseFeatureWorkflow: () => workflow, parseTestEnvironmentReceipt: value => value } });
      const derive = input => ({ ...input, verdict: input.steps.some(step => step.status === 'cancelled') ? 'cancelled' : 'passed' });
      mock.module(sibling('report.mjs'), { namedExports: { deriveReport: derive, deriveFeatureReport: derive } });
      const run = async ({ deadline, onStep }) => {
        if (!deadline.isCancelled()) throw new Error('early cancellation was lost');
        onStep('profile-policy', 'cancelled', 'CANCELLED', 0);
        return { actualBuild: null, environmentRun: null, cleanup: { status: 'complete', record: 'none' } };
      };
      mock.module(sibling('runtime.mjs'), { namedExports: {
        createDeadline: () => { let cancelled = false; return { cancel: () => { cancelled = true; }, isCancelled: () => cancelled, dispose() {} }; },
        launchHintLine: () => null, browserInstallDirectory: () => '', runId: () => 'test-run',
        runAuthenticatedChecks: run, runFeatureAcceptance: run,
        writeEvidence: async () => ({ report: 'test-report.json' }), writeFeatureEvidence: async () => ({ report: 'test-report.json' })
      } });
      if (${JSON.stringify(template)} === 'authenticated-smoke') mock.module(sibling('self-test.mjs'), { namedExports: { runSelfTest: async () => { throw new Error('unused'); } } });
      const { main } = await import(runner);
      process.exitCode = await main(['--manifest', 'ignored.json', '--json']);
      process.disconnect();
    `;
    substituteChild(program, ["--experimental-test-module-mocks"]);
    const opts = options(template === "authenticated-smoke" ? "smoke" : "feature");
    const pending = runWorkflow(opts);
    process.emit("SIGINT");
    expect(await pending).toBe(1);
    const report = JSON.parse(opts.stdout.text) as { verdict: string; cleanup: { status: string }; steps: { status: string }[] };
    expect(report.verdict).toBe("cancelled");
    expect(report.steps).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(report.cleanup.status).toBe("complete");
    expect(opts.stderr.text).not.toContain("early cancellation was lost");
  });
});
