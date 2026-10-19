import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const runtimeModule = path.join(repo, "examples", "demo-app", "lib", "runtime-config.js");
const children: ReturnType<typeof spawn>[] = [];

function value() {
  return randomBytes(32).toString("base64url");
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
});

describe("demo runtime configuration transport", () => {
  it("initializes the provider from one-shot stdin without env, argv, or files", async () => {
    const values = {
      nextAuthSecret: value(),
      handoffSecret: value(),
      adminPassword: value(),
      qaPassword: value(),
    };
    const childSource = `
      import { initializeRuntimeConfig, getRuntimeConfig } from ${JSON.stringify(pathToFileURL(runtimeModule).href)};
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const before = getRuntimeConfig() === null;
      initializeRuntimeConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const config = getRuntimeConfig();
      process.stdout.write(JSON.stringify({
        before,
        ready: config !== null,
        keys: Object.keys(config ?? {}).sort(),
        argvHasValue: process.argv.some((arg) => Object.values(config ?? {}).includes(arg)),
      }));
    `;
    const env = { ...process.env };
    for (const key of ["NEXTAUTH_SECRET", "AGENT_HANDOFF_SECRET", "DEMO_ADMIN_PASSWORD", "DEMO_QA_PASSWORD"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: repo,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(JSON.stringify(values));
    const exit = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("runtime provider child timed out"));
      }, 10_000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    expect(exit, "runtime provider child exited unsuccessfully").toBe(0);
    const result = JSON.parse(stdout);
    expect(result.before).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.keys).toEqual(["adminPassword", "handoffSecret", "nextAuthSecret", "qaPassword"]);
    expect(result.argvHasValue).toBe(false);
    expect(Object.values(values).some((secret) => stdout.includes(secret))).toBe(false);
    expect(Object.values(values).some((secret) => stderr.includes(secret))).toBe(false);
  });
});
