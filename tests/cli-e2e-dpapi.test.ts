/**
 * End-to-end through the real CLI process with the real DPAPI store (Windows only):
 * store set (piped stdin) -> session --format curl -> store delete.
 * The throwaway secret is generated here and must never appear in any output.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURL_JAR_HEADER } from "../src/session/curl-jar.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = path.join(repoRoot, "src", "cli.ts");

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCliProcess(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

describe.skipIf(process.platform !== "win32")("CLI end-to-end with the DPAPI store", () => {
  let home = "";
  let fake: FakeNextAuth;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-e2e-"));
  });

  afterEach(async () => {
    await fake?.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("store set -> session --format curl -> store delete, secret never printed", async () => {
    const secret = randomBytes(18).toString("base64url");
    const email = "agent.e2e@fake.test";
    fake = await startFakeNextAuth({ users: [{ email, password: secret }] });

    const profile = "fake:e2e";
    const profilesFile = path.join(home, "profiles.json");
    await fs.writeFile(
      profilesFile,
      JSON.stringify({
        version: 1,
        profiles: {
          [profile]: {
            app: "fake-app",
            environment: "sandbox",
            baseUrl: fake.baseUrl,
            strategy: "nextauth-credentials",
            account: { email, role: "Tester" },
            session: { ttlMinutes: 30 },
          },
        },
      }),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = { ...process.env, TESTLANE_HOME: home };
    delete env["TESTLANE_PROFILES"];
    delete env["TESTLANE_REQUESTER"];
    const common = ["--profiles", profilesFile, "--requester", "e2e-test"];

    const results: ProcResult[] = [];

    const set = await runCliProcess([...common, "store", "set", profile], env, `${secret}\n`);
    results.push(set);
    expect(set.stderr).toBe("");
    expect(set.code).toBe(0);
    expect(set.stdout).toContain(`stored secret for ${profile} in dpapi store`);

    const storeDir = path.join(home, "store");
    const stored = (await fs.readdir(storeDir)).filter((f) => f.endsWith(".dpapi"));
    expect(stored).toHaveLength(1);
    const ciphertext = await fs.readFile(path.join(storeDir, stored[0] ?? ""), "utf8");
    expect(ciphertext).not.toContain(secret);

    const session = await runCliProcess([...common, "session", profile, "--format", "curl"], env);
    results.push(session);
    expect(session.stderr).toBe("");
    expect(session.code).toBe(0);
    expect(session.stdout.startsWith(`${CURL_JAR_HEADER}\n`)).toBe(true);
    expect(session.stdout).toMatch(/\tnext-auth\.session-token\t[0-9a-f]{64}\n/);

    const del = await runCliProcess([...common, "store", "delete", profile], env);
    results.push(del);
    expect(del.stderr).toBe("");
    expect(del.code).toBe(0);
    expect(del.stdout).toContain(`deleted secret for ${profile}`);

    for (const r of results) {
      for (const text of [r.stdout, r.stderr]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain("[REDACTED]");
      }
    }

    const remaining = (await fs.readdir(storeDir)).filter((f) => f.endsWith(".dpapi"));
    expect(remaining).toHaveLength(0);

    const auditText = await fs.readFile(path.join(home, "audit.ndjson"), "utf8");
    expect(auditText).not.toContain(secret);
    const rows = auditText
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { event: string; requester: string; ok: boolean });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.event)).toEqual(["store.set", "session", "store.delete"]);
    for (const row of rows) {
      expect(row.requester).toBe("e2e-test");
      expect(row.ok).toBe(true);
    }
  }, 60_000);
});
