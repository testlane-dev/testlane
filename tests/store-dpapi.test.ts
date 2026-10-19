import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DpapiStore, sanitizeStderr, type SpawnLike } from "../src/store/dpapi.js";
import { encodeKeyForFile, secretKeyFor } from "../src/store/index.js";
import { selectStore } from "../src/store/select.js";

const isWin = process.platform === "win32";

/** Throwaway value generated at test time; never a real secret. */
function throwaway(): string {
  return `throwaway-${randomBytes(12).toString("hex")}`;
}

let home = "";
const savedHome = process.env["TESTLANE_HOME"];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-dpapi-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("selectStore", () => {
  it("throws for linux without a keychain (no plaintext fallback)", () => {
    expect(() => selectStore({ platform: "linux", env: {}, which: () => null })).toThrow(/no keychain available/);
  });

  it.skipIf(!isWin)("returns the dpapi store on win32", () => {
    const store = selectStore({ platform: "win32" });
    expect(store.kind).toBe("dpapi");
  });
});

describe("sanitizeStderr", () => {
  it("removes base64 blobs and known sensitive strings", () => {
    const blob = randomBytes(24).toString("base64");
    const val = throwaway();
    const out = sanitizeStderr(`DPAPI Protect failed: bad input ${blob} near ${val}`, [val]);
    expect(out).not.toContain(blob);
    expect(out).not.toContain(val);
    expect(out).toContain("DPAPI Protect failed");
  });
});

describe.skipIf(!isWin)("DpapiStore (Windows DPAPI)", { timeout: 90_000 }, () => {
  it("defaults to <TESTLANE_HOME>/store", () => {
    const store = new DpapiStore();
    expect(store.dir).toBe(path.join(home, "store"));
  });

  it("round-trips values exactly, without trimming", async () => {
    const store = new DpapiStore();
    const cases = [
      throwaway(),
      `with spaces ${randomBytes(4).toString("hex")} inside`,
      `pässwörd ✓ ${randomBytes(4).toString("hex")}`,
      `  leading and trailing ${randomBytes(4).toString("hex")}  `,
    ];
    for (const [i, value] of cases.entries()) {
      const key = secretKeyFor(`test:local:case${i}`);
      await store.set(key, value);
      expect(await store.get(key)).toBe(value);
    }
  });

  it("writes base64 ciphertext under the base64url key name, never the plaintext", async () => {
    const store = new DpapiStore();
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    await store.set(key, value);

    const file = path.join(home, "store", `${encodeKeyForFile(key)}.dpapi`);
    const contents = await fs.readFile(file, "utf8");
    expect(contents.length).toBeGreaterThan(0);
    expect(contents).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(contents).not.toContain(value);
    expect(contents).not.toContain(Buffer.from(value, "utf8").toString("base64"));
    expect(Buffer.from(contents, "base64").toString("latin1")).not.toContain(value);

    const names = await fs.readdir(path.join(home, "store"));
    expect(names).toEqual([`${encodeKeyForFile(key)}.dpapi`]);
  });

  it("lists keys, deletes, and returns null for missing keys", async () => {
    const store = new DpapiStore();
    const key = secretKeyFor("acme:local:sales");
    expect(await store.get(key)).toBeNull();
    expect(await store.list()).toEqual([]);

    await store.set(key, throwaway());
    expect(await store.list()).toEqual([key]);

    expect(await store.delete(key)).toBe(true);
    expect(await store.delete(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("overwriting a key replaces the value", async () => {
    const store = new DpapiStore();
    const key = secretKeyFor("acme:local:admin");
    const first = throwaway();
    const second = throwaway();
    await store.set(key, first);
    await store.set(key, second);
    expect(await store.get(key)).toBe(second);
    expect(await store.list()).toEqual([key]);
  });

  it("honours an explicit dir", async () => {
    const dir = path.join(home, "elsewhere");
    const store = new DpapiStore({ dir });
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    await store.set(key, value);
    expect(await fs.readdir(dir)).toEqual([`${encodeKeyForFile(key)}.dpapi`]);
    expect(await store.get(key)).toBe(value);
  });

  it("never places the secret or its base64 on any spawn argv or env", async () => {
    const calls: {
      command: string;
      args: string[];
      /** options.env exactly as passed (undefined = inherit). */
      rawEnv: NodeJS.ProcessEnv | undefined;
      /** Snapshot of the env the child actually receives, taken at spawn time. */
      effectiveEnv: Record<string, string | undefined>;
    }[] = [];
    const spy: SpawnLike = (command, args, options: SpawnOptions) => {
      calls.push({
        command,
        args: [...args],
        rawEnv: options.env === undefined ? undefined : { ...options.env },
        effectiveEnv: { ...(options.env ?? process.env) },
      });
      return spawn(command, args, options);
    };
    const store = new DpapiStore({ spawn: spy });
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    const valueB64 = Buffer.from(value, "utf8").toString("base64");

    await store.set(key, value);
    expect(await store.get(key)).toBe(value);

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(path.basename(call.command).toLowerCase()).toBe("powershell.exe");
      expect(call.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      expect(call.args).toHaveLength(4);
      expect(call.args.map((a) => a.toLowerCase())).not.toContain("-executionpolicy");
      const joined = [call.command, ...call.args].join(" ");
      expect(joined).not.toContain(value);
      expect(joined).not.toContain(valueB64);
      // The encoded script itself must not embed the value either.
      const script = Buffer.from(call.args[3] ?? "", "base64").toString("utf16le");
      expect(script).toContain("[Console]::In.ReadToEnd()");
      expect(script).not.toContain(value);
      expect(script).not.toContain(valueB64);
      // The environment the child really gets (options.env ?? process.env at spawn time).
      expect(Object.keys(call.effectiveEnv).length).toBeGreaterThan(0);
      const envDump = JSON.stringify(call.effectiveEnv);
      expect(envDump).not.toContain(value);
      expect(envDump).not.toContain(valueB64);
      // And options.env is either not passed at all, or carries no secret.
      const rawDump = call.rawEnv === undefined ? "" : JSON.stringify(call.rawEnv);
      expect(call.rawEnv === undefined || (!rawDump.includes(value) && !rawDump.includes(valueB64))).toBe(true);
    }
  });

  it("refuses keys outside agent-auth/<profile name> before spawning or touching disk", async () => {
    let spawned = 0;
    const spy: SpawnLike = (command, args, options: SpawnOptions) => {
      spawned += 1;
      return spawn(command, args, options);
    };
    const store = new DpapiStore({ spawn: spy });
    for (const key of ["", "agent-auth/", "other/acme:local:admin", "agent-auth/../x", "agent-auth/Acme:Local", "acme:local:admin"]) {
      await expect(store.set(key, throwaway()), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.get(key), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.delete(key), key).rejects.toThrow(/invalid secret store key/);
    }
    expect(spawned).toBe(0);
    await expect(fs.readdir(path.join(home, "store"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports DPAPI failures without leaking the stored blob", async () => {
    const store = new DpapiStore();
    const key = secretKeyFor("acme:local:broken");
    const junk = randomBytes(48).toString("base64");
    await fs.mkdir(path.join(home, "store"), { recursive: true });
    await fs.writeFile(path.join(home, "store", `${encodeKeyForFile(key)}.dpapi`), junk, "ascii");

    const err = await store.get(key).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/DPAPI Unprotect failed/);
    expect(message).not.toContain(junk);
  });
});

describe.skipIf(isWin)("DpapiStore on non-Windows", () => {
  it("refuses to construct", () => {
    expect(() => new DpapiStore()).toThrow(/requires Windows/);
  });
});
