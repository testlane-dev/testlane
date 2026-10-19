import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnLike } from "../src/store/dpapi.js";
import { EncryptedFileStore, SALT_FILE_NAME } from "../src/store/encrypted-file.js";
import { encodeKeyForFile, secretKeyFor, type SecretStore } from "../src/store/index.js";
import { KeychainMacosStore } from "../src/store/keychain-macos.js";
import { SecretServiceStore } from "../src/store/secret-service.js";
import { STORE_KINDS, selectStore, whichSync, type SelectStoreOptions } from "../src/store/select.js";

const isWin = process.platform === "win32";

/** Throwaway value generated at test time; never a real secret. */
function throwaway(): string {
  return `throwaway-${randomBytes(12).toString("hex")}`;
}

let home = "";
const savedHome = process.env["TESTLANE_HOME"];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-select-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

/** Spawn that must never be called by selection itself. */
const noSpawn: SpawnLike = () => {
  throw new Error("selectStore must not spawn anything");
};
const hasSecretTool = (cmd: string): string | null => (cmd === "secret-tool" ? "/usr/bin/secret-tool" : null);
const noSecretTool = (): string | null => null;

/** The pointer every actionable message ends with, spelled out so a changed URL fails a test. */
const POINTER = "see docs/platforms.md (https://github.com/testlane-dev/testlane/blob/main/docs/platforms.md)";
const BUS = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

/** The message selectStore throws, or "" when it does not throw. */
function selectError(extra: SelectStoreOptions): string {
  try {
    selectStore(opts(extra));
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

function opts(extra: SelectStoreOptions): SelectStoreOptions {
  return { env: {}, spawn: noSpawn, allowAnyPlatform: true, ...extra };
}

describe("selectStore platform mapping", () => {
  it.skipIf(!isWin)("win32 -> dpapi", () => {
    expect(selectStore(opts({ platform: "win32" })).kind).toBe("dpapi");
  });

  it.skipIf(isWin)("win32 off Windows fails loudly (DpapiStore guard)", () => {
    expect(() => selectStore(opts({ platform: "win32" }))).toThrow(/requires Windows/);
  });

  it("darwin -> keychain-macos (index under the store dir)", () => {
    const store = selectStore(opts({ platform: "darwin", which: noSecretTool }));
    expect(store).toBeInstanceOf(KeychainMacosStore);
    expect((store as KeychainMacosStore).indexFile).toBe(path.join(home, "store", "keychain-macos.index.json"));
  });

  it("linux with secret-tool on PATH -> secret-service using the resolved absolute path", () => {
    const store = selectStore(opts({ platform: "linux", which: hasSecretTool }));
    expect(store).toBeInstanceOf(SecretServiceStore);
    expect((store as SecretServiceStore).command).toBe("/usr/bin/secret-tool");
  });

  it("linux without secret-tool throws a no-keychain error (no plaintext fallback)", () => {
    expect(() => selectStore(opts({ platform: "linux", which: noSecretTool }))).toThrow(/^no keychain available: /);
    expect(() => selectStore(opts({ platform: "freebsd", which: noSecretTool }))).toThrow(/^no keychain available: /);
  });

  it("secret-tool missing, session bus set: names the packages, nothing about starting a bus, ends with the pointer", () => {
    for (const platform of ["linux", "freebsd"] as const) {
      const message = selectError({ platform, which: noSecretTool, env: BUS });
      expect(message).toMatch(/^no keychain available: secret-tool is not on PATH\. /);
      expect(message).toContain("Debian/Ubuntu: sudo apt install libsecret-tools gnome-keyring");
      expect(message).toContain("Fedora: sudo dnf install libsecret gnome-keyring");
      expect(message).toContain("unlock the keyring");
      expect(message).not.toContain("dbus-run-session");
      expect(message).not.toContain("DBUS_SESSION_BUS_ADDRESS");
      expect(message.endsWith(POINTER)).toBe(true);
    }
  });

  it("secret-tool missing, no session bus: also says how to start one and that the agent must share it", () => {
    for (const env of [{}, { DBUS_SESSION_BUS_ADDRESS: "" }, { DBUS_SESSION_BUS_ADDRESS: "   " }]) {
      const message = selectError({ platform: "linux", which: noSecretTool, env });
      expect(message).toMatch(
        /^no keychain available: secret-tool is not on PATH and there is no D-Bus session bus \(DBUS_SESSION_BUS_ADDRESS is unset\)\. /,
      );
      expect(message).toContain("libsecret-tools gnome-keyring");
      expect(message).toContain("libsecret gnome-keyring");
      expect(message).toContain("headless machine, WSL or a devcontainer");
      expect(message).toContain("`dbus-run-session -- bash`");
      expect(message).toContain("unlock a keyring");
      expect(message).toContain("start the agent from that same shell");
      expect(message.endsWith(POINTER)).toBe(true);
    }
  });

  it("never mentions the store variable when the user did not set it", () => {
    for (const env of [{}, BUS]) {
      for (const platform of ["linux", "freebsd"] as const) {
        const message = selectError({ platform, which: noSecretTool, env });
        expect(message).not.toMatch(/TESTLANE_STORE|AGENT_AUTH_STORE|encrypted-file/);
      }
    }
  });

  it("the session bus only shapes the message: with secret-tool on PATH selection never depends on it", () => {
    for (const env of [{}, BUS]) {
      const store = selectStore(opts({ platform: "linux", which: hasSecretTool, env }));
      expect(store).toBeInstanceOf(SecretServiceStore);
    }
  });

  it("keychain adapters keep their own platform guards when not told otherwise", () => {
    if (process.platform !== "darwin") {
      expect(() => selectStore({ env: {}, platform: "darwin" })).toThrow(/requires macOS/);
    }
    if (process.platform !== "linux") {
      expect(() => selectStore({ env: {}, platform: "linux", which: hasSecretTool })).toThrow(/requires Linux/);
    }
  });

  it("honours an explicit dir", () => {
    const dir = path.join(home, "elsewhere");
    const store = selectStore(opts({ platform: "darwin", dir }));
    expect((store as KeychainMacosStore).dir).toBe(dir);
  });

  it("every combination yields a known adapter or throws; never anything else", () => {
    const platforms: NodeJS.Platform[] = ["win32", "darwin", "linux", "freebsd", "aix"];
    const overrides = [undefined, ...STORE_KINDS, "plaintext", "none", ""];
    for (const platform of platforms) {
      for (const which of [hasSecretTool, noSecretTool]) {
        for (const override of overrides) {
          const env = override === undefined ? {} : { TESTLANE_STORE: override };
          let kind: string | null = null;
          try {
            kind = selectStore({ env, platform, which, spawn: noSpawn, allowAnyPlatform: true, readPassphrase: async () => "x" }).kind;
          } catch {
            kind = null;
          }
          if (kind !== null) expect(STORE_KINDS as readonly string[]).toContain(kind);
        }
      }
    }
  });
});

describe("selectStore TESTLANE_STORE override", () => {
  it("keychain-macos / secret-service regardless of platform", () => {
    expect(selectStore(opts({ platform: "linux", which: hasSecretTool, env: { TESTLANE_STORE: "keychain-macos" } })).kind).toBe(
      "keychain-macos",
    );
    expect(selectStore(opts({ platform: "darwin", which: hasSecretTool, env: { TESTLANE_STORE: "secret-service" } })).kind).toBe(
      "secret-service",
    );
  });

  it("secret-service override without secret-tool on PATH throws, naming the variable the user set", () => {
    const withBus = selectError({
      platform: "linux",
      which: noSecretTool,
      env: { TESTLANE_STORE: "secret-service", ...BUS },
    });
    expect(withBus).toMatch(/^TESTLANE_STORE=secret-service: secret-tool is not on PATH\. /);
    expect(withBus).toContain("libsecret-tools gnome-keyring");
    expect(withBus).not.toContain("dbus-run-session");
    expect(withBus.endsWith(POINTER)).toBe(true);

    const noBus = selectError({ platform: "linux", which: noSecretTool, env: { TESTLANE_STORE: "secret-service" } });
    expect(noBus).toMatch(/^TESTLANE_STORE=secret-service: secret-tool is not on PATH and there is no D-Bus session bus /);
    expect(noBus).toContain("`dbus-run-session -- bash`");
    expect(noBus.endsWith(POINTER)).toBe(true);

    // The pre-rename variable is named as set, and TESTLANE_STORE is not claimed.
    const legacy = selectError({ platform: "linux", which: noSecretTool, env: { AGENT_AUTH_STORE: "secret-service" } });
    expect(legacy).toMatch(/^AGENT_AUTH_STORE=secret-service: secret-tool is not on PATH/);
    expect(legacy).not.toContain("TESTLANE_STORE");
  });

  it.skipIf(!isWin)("dpapi override on Windows", () => {
    expect(selectStore(opts({ platform: "win32", env: { TESTLANE_STORE: "dpapi" } })).kind).toBe("dpapi");
  });

  it.skipIf(isWin)("dpapi override off Windows fails loudly", () => {
    expect(() => selectStore(opts({ platform: "linux", env: { TESTLANE_STORE: "dpapi" } }))).toThrow(/requires Windows/);
  });

  it("encrypted-file keys from the platform keychain when there is one", () => {
    const env = { TESTLANE_STORE: "encrypted-file" };
    const onMac = selectStore(opts({ platform: "darwin", env }));
    expect(onMac).toBeInstanceOf(EncryptedFileStore);
    expect((onMac as EncryptedFileStore).keyProvider.kind).toBe("keychain:keychain-macos");
    const onLinux = selectStore(opts({ platform: "linux", which: hasSecretTool, env }));
    expect((onLinux as EncryptedFileStore).keyProvider.kind).toBe("keychain:secret-service");
  });

  it.skipIf(!isWin)("encrypted-file on Windows keys from DPAPI", () => {
    const store = selectStore(opts({ platform: "win32", env: { TESTLANE_STORE: "encrypted-file" } }));
    expect((store as EncryptedFileStore).keyProvider.kind).toBe("keychain:dpapi");
  });

  it("encrypted-file without a keychain uses the interactive passphrase and round-trips", async () => {
    const pass = `pass phrase ${throwaway()}`;
    const purposes: (string | undefined)[] = [];
    const readPassphrase = async (purpose?: string): Promise<string> => {
      purposes.push(purpose);
      return pass;
    };
    const select = (): SecretStore =>
      selectStore(
        opts({ platform: "linux", which: noSecretTool, env: { TESTLANE_STORE: "encrypted-file" }, readPassphrase }),
      );
    const store = select();
    expect(store).toBeInstanceOf(EncryptedFileStore);
    expect((store as EncryptedFileStore).keyProvider.kind).toBe("passphrase");
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    await store.set(key, value);
    expect(await store.get(key)).toBe(value);
    // First use chooses the passphrase (typed twice); a new process then types it once.
    expect(purposes).toEqual(["new", "confirm"]);
    purposes.length = 0;
    expect(await select().get(key)).toBe(value);
    expect(purposes).toEqual(["enter"]);
    const names = (await fs.readdir(path.join(home, "store"))).sort();
    expect(names).toEqual([`${encodeKeyForFile(key)}.enc`, SALT_FILE_NAME].sort());
    const contents = await fs.readFile(path.join(home, "store", `${encodeKeyForFile(key)}.enc`), "utf8");
    expect(contents).not.toContain(value);
  });

  it("the default passphrase prompt refuses non-interactive stdin (never reads env), writing nothing", async () => {
    const store = selectStore(
      opts({
        platform: "linux",
        which: noSecretTool,
        env: { TESTLANE_STORE: "encrypted-file", AGENT_AUTH_PASSPHRASE: throwaway() },
      }),
    );
    // Under vitest stdin is not a TTY, so the interactive-only provider refuses.
    const err = await store.set(secretKeyFor("acme:local:admin"), throwaway()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/must be typed at an interactive terminal/);
    expect(err?.message).toContain("unattended agent");
    expect(err?.message).toContain("keychain-backed key");
    expect(err?.message.endsWith(POINTER)).toBe(true);
    await expect(fs.stat(path.join(home, "store", SALT_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unknown values and ignores an empty one", () => {
    for (const bad of ["plaintext", "none", "DPAPI", "file"]) {
      expect(() => selectStore(opts({ platform: "darwin", env: { TESTLANE_STORE: bad } })), bad).toThrow(
        /TESTLANE_STORE must be one of dpapi, keychain-macos, secret-service, encrypted-file/,
      );
    }
    expect(selectStore(opts({ platform: "darwin", env: { TESTLANE_STORE: "  " } })).kind).toBe("keychain-macos");
  });

  it("reads TESTLANE_STORE from process.env by default", () => {
    const saved = process.env["TESTLANE_STORE"];
    process.env["TESTLANE_STORE"] = "keychain-macos";
    try {
      expect(selectStore({ platform: "linux", which: hasSecretTool, spawn: noSpawn, allowAnyPlatform: true }).kind).toBe(
        "keychain-macos",
      );
    } finally {
      if (saved === undefined) delete process.env["TESTLANE_STORE"];
      else process.env["TESTLANE_STORE"] = saved;
    }
  });
});

describe("whichSync", () => {
  it("finds an executable file on an absolute PATH entry, ignoring empty and relative entries", async () => {
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    const tool = path.join(bin, "secret-tool");
    await fs.writeFile(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.mkdir(path.join(home, "dir-not-file", "secret-tool"), { recursive: true });

    expect(whichSync("secret-tool", [path.join(home, "dir-not-file"), bin].join(path.delimiter))).toBe(tool);
    expect(whichSync("secret-tool", ["", "relative/bin", path.join(home, "nothing")].join(path.delimiter))).toBeNull();
    expect(whichSync("secret-tool", "")).toBeNull();
  });

  it.skipIf(isWin)("skips files without the execute bit", async () => {
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "secret-tool"), "", { mode: 0o644 });
    expect(whichSync("secret-tool", bin)).toBeNull();
  });
});
