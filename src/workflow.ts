/** Invoke only the two shipped, reviewed workflow runners. No arbitrary script path. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkflowRunOptions {
  kind: "smoke" | "feature";
  manifest: string;
  receipt?: string;
  outputDir?: string;
  json?: boolean;
  cwd: string;
  profilesFile?: string;
  requester?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function runWorkflow(options: WorkflowRunOptions): Promise<number> {
  const template = options.kind === "smoke" ? "authenticated-smoke" : "feature-acceptance";
  const runner = fileURLToPath(new URL(`../examples/workflows/${template}/run.mjs`, import.meta.url));
  const args = [runner, "--manifest", path.resolve(options.cwd, options.manifest)];
  if (options.receipt !== undefined) args.push("--receipt", path.resolve(options.cwd, options.receipt));
  if (options.outputDir !== undefined) args.push("--output-dir", path.resolve(options.cwd, options.outputDir));
  if (options.json) args.push("--json");
  const env = { ...process.env };
  if (options.profilesFile !== undefined) env["TESTLANE_PROFILES"] = path.resolve(options.cwd, options.profilesFile);
  if (options.requester !== undefined) env["TESTLANE_REQUESTER"] = options.requester;
  // Environment debug hooks can cause otherwise sanitized subprocesses/browser code to log credentials.
  env["DEBUG"] = ""; env["PWDEBUG"] = ""; env["NODE_DEBUG"] = "";
  return new Promise<number>((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    } catch {
      options.stderr.write("Testlane workflow could not start; check the installation and Node runtime.\n");
      resolve(1);
      return;
    }
    child.stdout?.on("data", chunk => options.stdout.write(chunk));
    child.stderr?.on("data", chunk => options.stderr.write(chunk));
    let ready = false;
    let cancelled = false;
    let cancelSent = false;
    let finished = false;
    let emergencyTimer: NodeJS.Timeout | undefined;
    const sendCancel = () => {
      if (!cancelled || !ready || cancelSent || !child.connected) return;
      cancelSent = true;
      // A fixed control message, not an OS signal: child.kill is forceful on Windows.
      child.send("testlane:workflow:cancel:v1", () => {});
    };
    const onCancel = () => {
      if (finished || cancelled) return;
      cancelled = true;
      options.stderr.write("Testlane workflow cancellation requested; waiting for cleanup.\n");
      // Feature cleanup has its own <=60s budget. Smoke cleanup uses its
      // <=120s run deadline. Allow evidence writing and runner exit grace too.
      emergencyTimer = setTimeout(() => {
        options.stderr.write("Testlane workflow did not finish cleanup in time; stopping it. Inspect the app for retained test data.\n");
        child.kill("SIGKILL");
      }, options.kind === "feature" ? 75_000 : 135_000);
      sendCancel();
    };
    const onMessage = (message: unknown) => {
      if (message !== "testlane:workflow:ready:v1") return;
      ready = true;
      sendCancel();
    };
    process.on("SIGINT", onCancel);
    process.on("SIGTERM", onCancel);
    child.on("message", onMessage);
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (emergencyTimer !== undefined) clearTimeout(emergencyTimer);
      process.off("SIGINT", onCancel);
      process.off("SIGTERM", onCancel);
      child.off("message", onMessage);
      resolve(cancelled ? 1 : code);
    };
    child.once("error", () => { options.stderr.write("Testlane workflow could not start; check the installation and Node runtime.\n"); finish(1); });
    child.once("close", code => finish(code === 0 ? 0 : 1));
  });
}
