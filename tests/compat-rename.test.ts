/**
 * Compatibility with installations from before the rename to Testlane
 * (package `agent-auth`, state in ~/.agent-auth, `agent-auth.profiles.json`,
 * AGENT_AUTH_* variables). Existing setups must keep working with no re-seeding.
 *
 * Every home used here is a fresh temp directory: HOME / USERPROFILE are
 * pointed at it for the "default home" cases, so os.homedir() never resolves
 * to the real one. Secrets are generated per test.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { ENV_VARS, lookupEnv, readEnv } from "../src/env.js";
import {
  accountOverridesPath,
  agentAuthHome,
  auditLogPath,
  storeDir,
  testlaneHome,
  userProfilesPath,
} from "../src/paths.js";
import { getProfile, loadProfiles, readAccountOverrides, writeAccountOverrides } from "../src/profiles.js";
import { detectRequester, surfaceRequester } from "../src/requester.js";
import { DpapiStore } from "../src/store/dpapi.js";
import { KEY_PREFIX, secretKeyFor } from "../src/store/index.js";
import { KEYCHAIN_SERVICE, KEYCHAIN_VALUE_PREFIX } from "../src/store/keychain-macos.js";
import { SECRET_SERVICE_ATTR } from "../src/store/secret-service.js";
import { selectStore } from "../src/store/select.js";
import type { Profile } from "../src/types.js";
import { getProfileSecret } from "../src/vault.js";
import { VERSION } from "../src/version.js";
import { MemoryStore } from "./helpers/memory-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** Every variable this file touches, restored after each test. */
const ENV_KEYS = [
  ...Object.keys(ENV_VARS),
  ...Object.values(ENV_VARS),
  "HOME",
  "USERPROFILE",
] as const;

let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "testlane-compat-")));
  // Start every test with neither home variable set (blank = unset).
  process.env["TESTLANE_HOME"] = "";
  process.env["AGENT_AUTH_HOME"] = "";
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Point os.homedir() at `dir` on every platform (USERPROFILE on Windows, HOME elsewhere). */
function fakeUserHome(dir: string): void {
  process.env["HOME"] = dir;
  process.env["USERPROFILE"] = dir;
  expect(os.homedir()).toBe(dir);
}

class Capture extends Writable {
  text = "";
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    cb();
  }
}

const throwaway = (): string => `compat-${randomBytes(18).toString("base64url")}`;

function registry(profiles: Record<string, unknown>): string {
  return `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`;
}

const sandboxEntry = {
  app: "compat-app",
  environment: "sandbox",
  baseUrl: "http://localhost:3999",
  strategy: "nextauth-credentials",
  account: { email: "agent@compat.test", role: "Admin" },
  session: { ttlMinutes: 30 },
};

describe("environment variables: TESTLANE_* first, AGENT_AUTH_* as fallback", () => {
  it("maps every current name to its pre-rename name", () => {
    expect(ENV_VARS).toEqual({
      TESTLANE_HOME: "AGENT_AUTH_HOME",
      TESTLANE_PROFILES: "AGENT_AUTH_PROFILES",
      TESTLANE_REQUESTER: "AGENT_AUTH_REQUESTER",
      TESTLANE_STORE: "AGENT_AUTH_STORE",
      TESTLANE_REAL_KEYCHAIN: "AGENT_AUTH_REAL_KEYCHAIN",
    });
  });

  it("reads the legacy name only when the current one is unset or blank", () => {
    const env = { AGENT_AUTH_STORE: "dpapi" };
    expect(lookupEnv("TESTLANE_STORE", env)).toEqual({ value: "dpapi", source: "AGENT_AUTH_STORE" });
    expect(readEnv("TESTLANE_STORE", { ...env, TESTLANE_STORE: "  " })).toBe("dpapi");
    expect(lookupEnv("TESTLANE_STORE", { ...env, TESTLANE_STORE: "encrypted-file" })).toEqual({
      value: "encrypted-file",
      source: "TESTLANE_STORE",
    });
    expect(readEnv("TESTLANE_STORE", {})).toBeUndefined();
    expect(readEnv("TESTLANE_STORE", { AGENT_AUTH_STORE: "" })).toBeUndefined();
  });

  it("AGENT_AUTH_HOME is honoured when TESTLANE_HOME is unset; TESTLANE_HOME wins when both are set", () => {
    const legacy = path.join(tmp, "legacy-home");
    const current = path.join(tmp, "current-home");
    process.env["AGENT_AUTH_HOME"] = legacy;
    expect(testlaneHome()).toBe(legacy);
    expect(agentAuthHome()).toBe(legacy);
    expect(storeDir()).toBe(path.join(legacy, "store"));
    expect(auditLogPath()).toBe(path.join(legacy, "audit.ndjson"));
    process.env["TESTLANE_HOME"] = current;
    expect(testlaneHome()).toBe(current);
  });

  it("AGENT_AUTH_PROFILES names the registry when TESTLANE_PROFILES is unset, and errors name the variable used", async () => {
    const file = path.join(tmp, "legacy-env.json");
    await fs.writeFile(file, registry({ "compat:env": sandboxEntry }));
    process.env["TESTLANE_HOME"] = path.join(tmp, "home");
    process.env["TESTLANE_PROFILES"] = "";
    process.env["AGENT_AUTH_PROFILES"] = file;
    const reg = await loadProfiles({ cwd: tmp });
    expect(Object.keys(reg.profiles)).toEqual(["compat:env"]);
    expect(reg.sources).toEqual([file]);

    process.env["AGENT_AUTH_PROFILES"] = path.join(tmp, "missing.json");
    await expect(loadProfiles({ cwd: tmp })).rejects.toThrow(/AGENT_AUTH_PROFILES does not exist/);
    process.env["TESTLANE_PROFILES"] = path.join(tmp, "also-missing.json");
    await expect(loadProfiles({ cwd: tmp })).rejects.toThrow(/TESTLANE_PROFILES does not exist/);
  });

  it("AGENT_AUTH_REQUESTER still labels audit rows when TESTLANE_REQUESTER is unset", () => {
    process.env["TESTLANE_REQUESTER"] = "";
    process.env["AGENT_AUTH_REQUESTER"] = "legacy-label";
    expect(detectRequester()).toBe("legacy-label");
    expect(surfaceRequester(undefined, "mcp")).toBe("legacy-label");
    process.env["TESTLANE_REQUESTER"] = "new-label";
    expect(detectRequester()).toBe("new-label");
    expect(surfaceRequester(undefined, "http")).toBe("new-label");
  });

  it("AGENT_AUTH_STORE still picks the store, and its errors name the legacy variable", () => {
    const opts = { platform: "darwin" as const, dir: path.join(tmp, "store"), allowAnyPlatform: true };
    expect(selectStore({ ...opts, env: { AGENT_AUTH_STORE: "keychain-macos" } }).kind).toBe("keychain-macos");
    expect(() => selectStore({ ...opts, env: { AGENT_AUTH_STORE: "plaintext" } })).toThrow(
      /^AGENT_AUTH_STORE must be one of/,
    );
    expect(() => selectStore({ ...opts, env: { TESTLANE_STORE: "plaintext", AGENT_AUTH_STORE: "dpapi" } })).toThrow(
      /^TESTLANE_STORE must be one of/,
    );
  });
});

describe("default home: ~/.testlane, else an existing ~/.agent-auth", () => {
  it("uses ~/.testlane when neither exists, and creates nothing", () => {
    fakeUserHome(tmp);
    expect(testlaneHome()).toBe(path.join(tmp, ".testlane"));
    expect(existsSync(path.join(tmp, ".testlane"))).toBe(false);
  });

  it("uses ~/.agent-auth when ~/.testlane is missing; nothing is moved, copied or deleted", async () => {
    fakeUserHome(tmp);
    const legacy = path.join(tmp, ".agent-auth");
    await fs.mkdir(path.join(legacy, "store"), { recursive: true });
    await fs.writeFile(path.join(legacy, "audit.ndjson"), "");
    expect(testlaneHome()).toBe(legacy);
    expect(storeDir()).toBe(path.join(legacy, "store"));
    expect(auditLogPath()).toBe(path.join(legacy, "audit.ndjson"));
    expect(existsSync(path.join(tmp, ".testlane"))).toBe(false);
    expect(existsSync(path.join(legacy, "audit.ndjson"))).toBe(true);
  });

  it("prefers ~/.testlane once it exists", async () => {
    fakeUserHome(tmp);
    await fs.mkdir(path.join(tmp, ".agent-auth"));
    await fs.mkdir(path.join(tmp, ".testlane"));
    expect(testlaneHome()).toBe(path.join(tmp, ".testlane"));
  });

  it("an explicit home variable beats both directories", async () => {
    fakeUserHome(tmp);
    await fs.mkdir(path.join(tmp, ".agent-auth"));
    process.env["AGENT_AUTH_HOME"] = path.join(tmp, "explicit");
    expect(testlaneHome()).toBe(path.join(tmp, "explicit"));
  });
});

describe("registry and overrides file names", () => {
  beforeEach(() => {
    process.env["TESTLANE_HOME"] = path.join(tmp, "home");
    process.env["TESTLANE_PROFILES"] = "";
    process.env["AGENT_AUTH_PROFILES"] = "";
  });

  it("discovers agent-auth.profiles.json walking up, like testlane.profiles.json", async () => {
    const repo = path.join(tmp, "repo");
    const deep = path.join(repo, "packages", "web");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(repo, "agent-auth.profiles.json"), registry({ "compat:legacy": sandboxEntry }));
    const reg = await loadProfiles({ cwd: deep });
    expect(Object.keys(reg.profiles)).toEqual(["compat:legacy"]);
    expect(reg.sources).toEqual([path.join(repo, "agent-auth.profiles.json")]);
  });

  it("the nearest directory wins whatever its file is called", async () => {
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner");
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(outer, "testlane.profiles.json"), registry({ "compat:outer": sandboxEntry }));
    await fs.writeFile(path.join(inner, "agent-auth.profiles.json"), registry({ "compat:inner": sandboxEntry }));
    expect(Object.keys((await loadProfiles({ cwd: inner })).profiles)).toEqual(["compat:inner"]);
  });

  it("in one directory testlane.profiles.json wins, with one stderr notice per directory", async () => {
    const repo = path.join(tmp, "both");
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, "testlane.profiles.json"), registry({ "compat:current": sandboxEntry }));
    await fs.writeFile(path.join(repo, "agent-auth.profiles.json"), registry({ "compat:legacy": sandboxEntry }));
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const reg = await loadProfiles({ cwd: repo });
    await loadProfiles({ cwd: repo });
    expect(Object.keys(reg.profiles)).toEqual(["compat:current"]);
    expect(reg.sources).toEqual([path.join(repo, "testlane.profiles.json")]);
    const notices = writes.filter((w) => w.includes("both testlane.profiles.json and agent-auth.profiles.json"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(repo);
  });

  it("reads a user-level agent-auth.profiles.json and agent-auth.overrides.json in a pre-rename home", async () => {
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "agent-auth.profiles.json"), registry({ "compat:user": sandboxEntry }));
    expect(userProfilesPath()).toBe(path.join(home, "agent-auth.profiles.json"));
    const legacyOverrides = path.join(home, "agent-auth.overrides.json");
    await fs.writeFile(
      legacyOverrides,
      JSON.stringify({ version: 1, overrides: { "compat:user": { account: { email: "rotated@compat.test" } } } }),
    );
    expect(accountOverridesPath()).toBe(legacyOverrides);

    const reg = await loadProfiles({ cwd: tmp });
    expect(getProfile(reg, "compat:user").account.email).toBe("rotated@compat.test");
    expect(reg.overrides).toEqual(["compat:user"]);

    // `account set` keeps updating the existing legacy file in place (no second file appears).
    await writeAccountOverrides({ "compat:user": { email: "again@compat.test" } });
    expect(await readAccountOverrides(legacyOverrides)).toEqual({ "compat:user": { email: "again@compat.test" } });
    expect(existsSync(path.join(home, "testlane.overrides.json"))).toBe(false);
  });

  it("new homes get the new names; once both exist the new one is used", async () => {
    const home = path.join(tmp, "home");
    expect(userProfilesPath()).toBe(path.join(home, "testlane.profiles.json"));
    expect(accountOverridesPath()).toBe(path.join(home, "testlane.overrides.json"));
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "agent-auth.overrides.json"), JSON.stringify({ version: 1, overrides: {} }));
    await fs.writeFile(path.join(home, "testlane.overrides.json"), JSON.stringify({ version: 1, overrides: {} }));
    expect(accountOverridesPath()).toBe(path.join(home, "testlane.overrides.json"));
  });
});

describe("stored secrets: storage identifiers are unchanged", () => {
  const profile: Profile = {
    name: "compat:local:admin",
    app: "compat-app",
    environment: "sandbox",
    baseUrl: "http://localhost:3999",
    strategy: "nextauth-credentials",
    account: { email: "agent@compat.test", role: "Admin" },
    session: { ttlMinutes: 30 },
  };

  /** The value exactly as 0.2.x wrote it: a v3 envelope under `agent-auth/<profile>`. */
  function preRenameEnvelope(secret: string): string {
    return JSON.stringify({
      v: 3,
      origin: "http://localhost:3999",
      environment: "sandbox",
      secret,
      storedAt: "2026-09-01T00:00:00.000Z",
    });
  }

  it("keeps the store key prefix and the keychain / Secret Service names", () => {
    expect(KEY_PREFIX).toBe("agent-auth/");
    expect(secretKeyFor(profile)).toBe("agent-auth/compat:local:admin");
    expect(KEYCHAIN_SERVICE).toBe("agent-auth");
    expect(KEYCHAIN_VALUE_PREFIX).toBe("agent-auth-b64:");
    expect(SECRET_SERVICE_ATTR).toBe("agent-auth");
  });

  it("reads a secret written by the pre-rename code path (MemoryStore)", async () => {
    const secret = throwaway();
    const store = new MemoryStore();
    await store.set("agent-auth/compat:local:admin", preRenameEnvelope(secret));
    expect(await getProfileSecret(store, profile)).toBe(secret);
  });

  it.skipIf(process.platform !== "win32")(
    "reads a DPAPI file written before the rename, from ~/.agent-auth/store, via the default store and the CLI",
    async () => {
      fakeUserHome(tmp);
      const legacyStore = path.join(tmp, ".agent-auth", "store");
      await fs.mkdir(legacyStore, { recursive: true });
      const secret = throwaway();
      // Written independently of src/store/dpapi.ts: CurrentUser DPAPI with the literal
      // pre-rename entropy, file name = base64url("agent-auth/<profile>") + ".dpapi".
      const cipherB64 = await protectLikeBefore(preRenameEnvelope(secret));
      const file = path.join(
        legacyStore,
        `${Buffer.from("agent-auth/compat:local:admin", "utf8").toString("base64url")}.dpapi`,
      );
      await fs.writeFile(file, cipherB64, "ascii");

      // The default store resolves to the legacy home and decrypts the old file.
      const store = new DpapiStore();
      expect(store.dir).toBe(legacyStore);
      expect(await getProfileSecret(store, profile)).toBe(secret);

      // The CLI (no injected store) sees it too, without printing it.
      const reg = path.join(tmp, "compat.profiles.json");
      await fs.writeFile(reg, registry({ "compat:local:admin": sandboxEntry }));
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await runCli(["--profiles", reg, "--json", "status"], { stdout, stderr, deps: { cwd: tmp } });
      const out = stdout.text;
      const err = stderr.text;
      expect(code, err).toBe(0);
      const report = JSON.parse(out) as { profiles: Array<{ profile: string; hasSecret: boolean; alerts: string[] }> };
      const row = report.profiles.find((p) => p.profile === "compat:local:admin");
      expect(row?.hasSecret).toBe(true);
      expect(row?.alerts).toEqual([]);
      expect(out + err).not.toContain(secret);
      expect(existsSync(path.join(tmp, ".testlane"))).toBe(false);
    },
  );
});

/** DPAPI-protect `plaintext` (CurrentUser) with the pre-rename entropy; returns base64. */
function protectLikeBefore(plaintext: string): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    "$entropy = [System.Text.Encoding]::UTF8.GetBytes('agent-auth-vault/v1')",
    "$out = [System.Security.Cryptography.ProtectedData]::Protect($in, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("ascii")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell exit ${code}`))));
    child.stdin.end(Buffer.from(plaintext, "utf8").toString("base64"));
  });
}

describe("package: public testlane executable", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license: string;
    bin: Record<string, string>;
    files: string[];
  };

  it("installs only the testlane executable, which ships in the package", () => {
    expect(pkg.name).toBe("@testlane/cli");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.bin).toEqual({ testlane: "./dist/cli.js" });
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("examples/demo-app");
  });

  it("--version prints the package version and --help names testlane (whatever bin name started it)", async () => {
    expect(VERSION).toBe(pkg.version);
    for (const argv of [["--version"], ["-V"]]) {
      const stdout = new Capture();
      expect(await runCli(argv, { stdout, stderr: new Capture() })).toBe(0);
      expect(stdout.text).toBe(`${pkg.version}\n`);
    }
    const stdout = new Capture();
    expect(await runCli(["--help"], { stdout, stderr: new Capture() })).toBe(0);
    expect(stdout.text).toMatch(/^Usage: testlane /);
    expect(stdout.text).not.toMatch(/agent-auth/);
  });
});
