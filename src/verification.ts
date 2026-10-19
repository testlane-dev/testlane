import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface VerificationOptions {
  mode: "init" | "run" | "report";
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  brief?: string;
  target?: string;
  profile?: string;
  environment?: string;
  plan?: string;
  report?: string;
  outputDir?: string;
  profilesFile?: string;
  requester?: string;
  json?: boolean;
}

/** Run the shipped authoring scaffold or harness, using the app's normal permissions. */
export async function runVerification(options: VerificationOptions): Promise<number> {
  const entry = fileURLToPath(new URL(`../examples/agent-verification/${options.mode === "report" ? "render" : options.mode}.mjs`, import.meta.url));
  const args = [entry];
  for (const [flag, value, isPath] of [
    ["--brief", options.brief, true], ["--target", options.target, false],
    ["--profile", options.profile, false], ["--environment", options.environment, false],
    ["--plan", options.plan, true], ["--output-dir", options.outputDir, true],
    ["--report", options.report, true],
  ] as const) if (value !== undefined) args.push(flag, isPath ? path.resolve(options.cwd, value) : value);
  if (options.json) args.push("--json");
  const env: NodeJS.ProcessEnv = { ...process.env, DEBUG: "", PWDEBUG: "", NODE_DEBUG: "" };
  if (options.profilesFile !== undefined) env["TESTLANE_PROFILES"] = path.resolve(options.cwd, options.profilesFile);
  if (options.requester !== undefined) env["TESTLANE_REQUESTER"] = options.requester;
  return new Promise<number>((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: options.cwd, env, shell: false, windowsHide: true,
        stdio: options.mode === "run" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      });
    } catch {
      options.stderr.write("Testlane verification could not start.\n"); resolve(1); return;
    }
    child.stdout?.on("data", chunk => options.stdout.write(chunk));
    child.stderr?.on("data", chunk => options.stderr.write(chunk));
    let ready = false;
    let cancelled = false;
    let cancelSent = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const send = () => {
      if (!cancelled || !ready || cancelSent || !child.connected) return;
      cancelSent = true;
      child.send("testlane:verification:cancel:v1", () => {});
    };
    const cancel = () => {
      if (done || cancelled) return;
      cancelled = true;
      options.stderr.write("Testlane verification cancellation requested; waiting for cleanup.\n");
      timer = setTimeout(() => {
        options.stderr.write("Testlane verification did not finish; cleanup is unknown. Inspect retained test data.\n");
        child.kill("SIGKILL");
      }, 90_000);
      send();
    };
    const message = (value: unknown) => {
      if (value === "testlane:verification:ready:v1") { ready = true; send(); }
    };
    if (options.mode === "run") {
      process.on("SIGINT", cancel); process.on("SIGTERM", cancel); child.on("message", message);
    }
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      process.off("SIGINT", cancel); process.off("SIGTERM", cancel); child.off("message", message);
      resolve(cancelled ? 1 : code);
    };
    child.once("error", () => { options.stderr.write("Testlane verification could not start.\n"); finish(1); });
    child.once("close", code => finish(code ?? 1));
  });
}
