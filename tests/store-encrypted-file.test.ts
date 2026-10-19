import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENCRYPTED_FILE_KEY_NAME,
  EncryptedFileStore,
  PASSPHRASE_CHECK_PLAINTEXT,
  SALT_FILE_NAME,
  defaultSaltFile,
  interactivePassphrase,
  keychainKeyProvider,
  passphraseKeyProvider,
  type KeyProvider,
  type PassphraseReader,
} from "../src/store/encrypted-file.js";
import { assertValidStoreKey, encodeKeyForFile, secretKeyFor, type SecretStore } from "../src/store/index.js";

/** Throwaway value generated at test time; never a real secret. */
function throwaway(): string {
  return `throwaway-${randomBytes(12).toString("hex")}`;
}

/** Tiny in-memory SecretStore standing in for an OS keychain (deliberately not tests/helpers/memory-store.ts). */
class TinyMemoryStore implements SecretStore {
  readonly kind = "tiny-memory";
  readonly data = new Map<string, string>();
  sets = 0;
  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    assertValidStoreKey(key);
    this.sets += 1;
    this.data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    assertValidStoreKey(key);
    return this.data.delete(key);
  }
  async list(): Promise<string[]> {
    return [...this.data.keys()].sort();
  }
}

function fixedKeyProvider(key: Buffer = randomBytes(32)): KeyProvider {
  return { kind: "fixed", getKey: async () => Buffer.from(key) };
}

let home = "";
let storeDirPath = "";
const savedHome = process.env["TESTLANE_HOME"];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-encfile-"));
  process.env["TESTLANE_HOME"] = home;
  storeDirPath = path.join(home, "store");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

function fileFor(key: string, dir = storeDirPath): string {
  return path.join(dir, `${encodeKeyForFile(key)}.enc`);
}

function flipFirstBit(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[0] = (buf[0] ?? 0) ^ 0x01;
  return buf.toString("base64");
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe("EncryptedFileStore", () => {
  it("defaults to <TESTLANE_HOME>/store and requires a key provider", () => {
    const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
    expect(store.kind).toBe("encrypted-file");
    expect(store.dir).toBe(storeDirPath);
    expect(() => new EncryptedFileStore(undefined as unknown as { keyProvider: KeyProvider })).toThrow(/keyProvider/);
  });

  it("round-trips values exactly, without trimming", async () => {
    const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
    const cases = [
      throwaway(),
      `pässwörd ✓ 🔑 ${randomBytes(4).toString("hex")}`,
      `  leading and trailing ${randomBytes(4).toString("hex")}  `,
      `two\nlines ${randomBytes(4).toString("hex")}\n`,
      "",
    ];
    for (const [i, value] of cases.entries()) {
      const key = secretKeyFor(`test:local:case${i}`);
      await store.set(key, value);
      expect(await store.get(key)).toBe(value);
    }
  });

  it("writes {v,iv,tag,ct} JSON with no plaintext, under the base64url key name", async () => {
    const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    await store.set(key, value);

    const raw = await fs.readFile(fileFor(key));
    const text = raw.toString("utf8");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ct", "iv", "tag", "v"]);
    expect(body["v"]).toBe(1);
    expect(Buffer.from(String(body["iv"]), "base64")).toHaveLength(12);
    expect(Buffer.from(String(body["tag"]), "base64")).toHaveLength(16);
    expect(text).not.toContain(value);
    expect(text).not.toContain(Buffer.from(value, "utf8").toString("base64"));
    expect(raw.toString("latin1")).not.toContain(value);
    expect(Buffer.from(String(body["ct"]), "base64").toString("latin1")).not.toContain(value);

    expect(await fs.readdir(storeDirPath)).toEqual([`${encodeKeyForFile(key)}.enc`]);
  });

  it.skipIf(process.platform === "win32")("creates the directory 0700 and files 0600", async () => {
    const dir = path.join(home, "fresh-store");
    const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider(), dir });
    const key = secretKeyFor("acme:local:admin");
    await store.set(key, throwaway());
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(fileFor(key, dir))).mode & 0o777).toBe(0o600);
  });

  it("uses a fresh IV per write", async () => {
    const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    await store.set(key, value);
    const first = JSON.parse(await fs.readFile(fileFor(key), "utf8")) as { iv: string; ct: string };
    await store.set(key, value);
    const second = JSON.parse(await fs.readFile(fileFor(key), "utf8")) as { iv: string; ct: string };
    expect(second.iv).not.toBe(first.iv);
    expect(second.ct).not.toBe(first.ct);
  });

  it("lists keys, deletes true/false, returns null for missing keys, leaves no temp files", async () => {
    const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
    const a = secretKeyFor("acme:local:admin");
    const b = secretKeyFor("acme:local:sales");
    expect(await store.get(a)).toBeNull();
    expect(await store.list()).toEqual([]);
    await store.set(b, throwaway());
    await store.set(a, throwaway());
    // Unrelated files (salt, index, junk) are ignored by list().
    await fs.writeFile(path.join(storeDirPath, SALT_FILE_NAME), "{}");
    await fs.writeFile(path.join(storeDirPath, `${encodeKeyForFile("not/a-store-key")}.enc`), "{}");
    expect(await store.list()).toEqual([a, b]);
    expect(await store.delete(a)).toBe(true);
    expect(await store.delete(a)).toBe(false);
    expect(await store.get(a)).toBeNull();
    expect(await store.list()).toEqual([b]);
    expect((await fs.readdir(storeDirPath)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses invalid keys before touching the key provider or disk", async () => {
    let asked = 0;
    const store = new EncryptedFileStore({
      keyProvider: {
        getKey: async () => {
          asked += 1;
          return randomBytes(32);
        },
      },
    });
    for (const key of ["", "agent-auth/", "other/acme:local:admin", "agent-auth/../x", "agent-auth/Acme"]) {
      await expect(store.set(key, throwaway()), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.get(key), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.delete(key), key).rejects.toThrow(/invalid secret store key/);
    }
    expect(asked).toBe(0);
    await expect(fs.readdir(storeDirPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a key provider that returns the wrong length", async () => {
    const store = new EncryptedFileStore({ keyProvider: { getKey: async () => randomBytes(16) } });
    await expect(store.set(secretKeyFor("acme:local:admin"), throwaway())).rejects.toThrow(/exactly 32 bytes/);
  });

  describe("tamper detection (errors never carry plaintext)", () => {
    for (const field of ["ct", "tag", "iv"] as const) {
      it(`rejects a modified ${field}`, async () => {
        const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
        const key = secretKeyFor("acme:local:admin");
        const value = throwaway();
        await store.set(key, value);
        const body = JSON.parse(await fs.readFile(fileFor(key), "utf8")) as Record<string, string>;
        body[field] = flipFirstBit(body[field] ?? "");
        await fs.writeFile(fileFor(key), JSON.stringify(body));
        const err = await errorOf(store.get(key));
        expect(err.message).toMatch(/cannot decrypt .*tampered/);
        expect(err.message).not.toContain(value);
      });
    }

    it("rejects a file copied onto another key (key is bound as AAD)", async () => {
      const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
      const a = secretKeyFor("acme:local:admin");
      const b = secretKeyFor("acme:local:sales");
      const value = throwaway();
      await store.set(a, value);
      await fs.copyFile(fileFor(a), fileFor(b));
      const err = await errorOf(store.get(b));
      expect(err.message).toMatch(/cannot decrypt/);
      expect(err.message).not.toContain(value);
    });

    it("rejects the wrong data key", async () => {
      const key = secretKeyFor("acme:local:admin");
      const value = throwaway();
      await new EncryptedFileStore({ keyProvider: fixedKeyProvider() }).set(key, value);
      const err = await errorOf(new EncryptedFileStore({ keyProvider: fixedKeyProvider() }).get(key));
      expect(err.message).toMatch(/wrong key/);
      expect(err.message).not.toContain(value);
    });

    it("rejects corrupt JSON, wrong version and non-base64 fields", async () => {
      const store = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
      const key = secretKeyFor("acme:local:admin");
      await fs.mkdir(storeDirPath, { recursive: true });
      for (const junk of ["not json", JSON.stringify({ v: 2, iv: "", tag: "", ct: "" }), JSON.stringify({ v: 1, iv: "!!", tag: "", ct: "" }), "null"]) {
        await fs.writeFile(fileFor(key), junk);
        await expect(store.get(key), junk).rejects.toThrow(/corrupt/);
      }
    });
  });
});

describe("keychainKeyProvider", () => {
  it("generates 32 random bytes once, stores them base64 in the inner store, and reuses them", async () => {
    const inner = new TinyMemoryStore();
    const provider = keychainKeyProvider(inner);
    expect(provider.kind).toBe("keychain:tiny-memory");
    const k1 = await provider.getKey();
    expect(k1).toHaveLength(32);
    expect([...inner.data.keys()]).toEqual([ENCRYPTED_FILE_KEY_NAME]);
    expect(Buffer.from(inner.data.get(ENCRYPTED_FILE_KEY_NAME) ?? "", "base64").equals(k1)).toBe(true);

    // Cached in memory, returned as a copy (the store zeroes what it gets).
    const k2 = await provider.getKey();
    expect(k2.equals(k1)).toBe(true);
    k2.fill(0);
    expect((await provider.getKey()).equals(k1)).toBe(true);

    // A second provider over the same keychain reads the same key without re-seeding.
    const again = await keychainKeyProvider(inner).getKey();
    expect(again.equals(k1)).toBe(true);
    expect(inner.sets).toBe(1);
  });

  it("round-trips an encrypted-file store across provider instances", async () => {
    const inner = new TinyMemoryStore();
    const key = secretKeyFor("acme:local:admin");
    const value = `pässwörd ✓ ${throwaway()}  `;
    await new EncryptedFileStore({ keyProvider: keychainKeyProvider(inner) }).set(key, value);
    const reader = new EncryptedFileStore({ keyProvider: keychainKeyProvider(inner) });
    expect(await reader.get(key)).toBe(value);
    // The keychain holds only the data key, never the value.
    expect(JSON.stringify([...inner.data.values()])).not.toContain(value);
    // A different keychain cannot decrypt.
    await expect(new EncryptedFileStore({ keyProvider: keychainKeyProvider(new TinyMemoryStore()) }).get(key)).rejects.toThrow(
      /cannot decrypt/,
    );
  });

  it("honours a custom key name and rejects invalid ones", async () => {
    const inner = new TinyMemoryStore();
    await keychainKeyProvider(inner, "agent-auth/custom.key").getKey();
    expect([...inner.data.keys()]).toEqual(["agent-auth/custom.key"]);
    expect(() => keychainKeyProvider(inner, "not-namespaced")).toThrow(/invalid secret store key/);
  });

  it("rejects corrupt key material in the keychain", async () => {
    const inner = new TinyMemoryStore();
    inner.data.set(ENCRYPTED_FILE_KEY_NAME, randomBytes(16).toString("base64"));
    await expect(keychainKeyProvider(inner).getKey()).rejects.toThrow(/corrupt/);
    inner.data.set(ENCRYPTED_FILE_KEY_NAME, "not base64 at all!");
    await expect(keychainKeyProvider(inner).getKey()).rejects.toThrow(/corrupt/);
  });

  it("refuses to nest inside another encrypted-file store", () => {
    const nested = new EncryptedFileStore({ keyProvider: fixedKeyProvider() });
    expect(() => keychainKeyProvider(nested)).toThrow(/OS keychain/);
  });
});

describe("passphraseKeyProvider", () => {
  const reader = (passphrase: string, counter?: { n: number }) => async (): Promise<string> => {
    if (counter) counter.n += 1;
    return passphrase;
  };

  it("derives the same key for the same passphrase + salt, a different key otherwise", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    expect(saltFile).toBe(path.join(storeDirPath, SALT_FILE_NAME));
    const pass = `pass phrase ${throwaway()} ✓`;
    const counter = { n: 0 };
    const p1 = passphraseKeyProvider(reader(pass, counter), saltFile);
    expect(p1.kind).toBe("passphrase");
    const k1 = await p1.getKey();
    expect(k1).toHaveLength(32);
    expect((await p1.getKey()).equals(k1)).toBe(true);
    expect(counter.n).toBe(2); // a new passphrase is typed twice (choose + confirm), once per provider

    // Salt persisted (not secret), 16 random bytes, and does not contain the passphrase.
    const saltText = await fs.readFile(saltFile, "utf8");
    const salt = JSON.parse(saltText) as { v: number; kdf: string; N: number; r: number; p: number; salt: string };
    expect(salt).toMatchObject({ v: 1, kdf: "scrypt", N: 2 ** 15, r: 8, p: 1 });
    expect(Buffer.from(salt.salt, "base64")).toHaveLength(16);
    expect(saltText).not.toContain(pass);

    const same = await passphraseKeyProvider(reader(pass), saltFile).getKey();
    expect(same.equals(k1)).toBe(true);
    expect(await fs.readFile(saltFile, "utf8")).toBe(saltText); // salt reused, not rewritten

    // A different passphrase no longer yields a (useless) different key: the check value refuses it.
    await expect(passphraseKeyProvider(reader(`${pass}x`), saltFile).getKey()).rejects.toThrow(/wrong passphrase/);

    const otherSalt = await passphraseKeyProvider(reader(pass), path.join(home, "other", SALT_FILE_NAME)).getKey();
    expect(otherSalt.equals(k1)).toBe(false);
  });

  it("round-trips an encrypted-file store; the wrong passphrase cannot decrypt", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const pass = `pass phrase ${throwaway()}`;
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    await new EncryptedFileStore({ keyProvider: passphraseKeyProvider(reader(pass), saltFile) }).set(key, value);
    expect(await new EncryptedFileStore({ keyProvider: passphraseKeyProvider(reader(pass), saltFile) }).get(key)).toBe(value);
    const err = await errorOf(
      new EncryptedFileStore({ keyProvider: passphraseKeyProvider(reader(`${pass}!`), saltFile) }).get(key),
    );
    expect(err.message).toMatch(/wrong passphrase/);
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain(pass);
  });

  it("writes a check value on first use and refuses a wrong passphrase before any read or write", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const pass = `pass phrase ${throwaway()}`;
    const key = secretKeyFor("acme:local:admin");
    const value = throwaway();
    const good = new EncryptedFileStore({ dir: storeDirPath, keyProvider: passphraseKeyProvider(reader(pass), saltFile) });
    await good.set(key, value);

    const salt = JSON.parse(await fs.readFile(saltFile, "utf8")) as { check?: { iv: string; tag: string; ct: string } };
    expect(salt.check).toBeDefined();
    expect(Buffer.from(salt.check?.iv ?? "", "base64")).toHaveLength(12);
    expect(Buffer.from(salt.check?.tag ?? "", "base64")).toHaveLength(16);
    const saltText = await fs.readFile(saltFile, "utf8");
    expect(saltText).not.toContain(pass);
    expect(saltText).not.toContain(PASSPHRASE_CHECK_PLAINTEXT);

    const encBefore = await fs.readFile(fileFor(key), "utf8");
    const bad = new EncryptedFileStore({ dir: storeDirPath, keyProvider: passphraseKeyProvider(reader(`${pass}?`), saltFile) });
    // set: refused before anything is written (the existing entry is untouched).
    const setErr = await errorOf(bad.set(key, throwaway()));
    expect(setErr.message).toMatch(/wrong passphrase/);
    expect(await fs.readFile(fileFor(key), "utf8")).toBe(encBefore);
    // set of a new key: no file created.
    const other = secretKeyFor("acme:local:sales");
    expect((await errorOf(bad.set(other, throwaway()))).message).toMatch(/wrong passphrase/);
    await expect(fs.stat(fileFor(other))).rejects.toMatchObject({ code: "ENOENT" });
    // get: refused even for a missing entry (no oracle, nothing read).
    expect((await errorOf(bad.get(other))).message).toMatch(/wrong passphrase/);
    expect(await fs.readFile(saltFile, "utf8")).toBe(saltText); // the check is never rewritten

    expect(await good.get(key)).toBe(value);
  });

  it("adds a check to a salt file that predates it, then enforces it", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    await fs.mkdir(storeDirPath, { recursive: true });
    await fs.writeFile(
      saltFile,
      JSON.stringify({ v: 1, kdf: "scrypt", N: 2 ** 15, r: 8, p: 1, salt: randomBytes(16).toString("base64") }),
    );
    const pass = `pass phrase ${throwaway()}`;
    const k1 = await passphraseKeyProvider(reader(pass), saltFile).getKey();
    const upgraded = JSON.parse(await fs.readFile(saltFile, "utf8")) as { check?: unknown };
    expect(upgraded.check).toBeDefined();
    expect((await passphraseKeyProvider(reader(pass), saltFile).getKey()).equals(k1)).toBe(true);
    await expect(passphraseKeyProvider(reader(`x${pass}`), saltFile).getKey()).rejects.toThrow(/wrong passphrase/);
  });

  it("rejects a salt file with a malformed check value", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    await fs.mkdir(storeDirPath, { recursive: true });
    await fs.writeFile(
      saltFile,
      JSON.stringify({
        v: 1,
        kdf: "scrypt",
        N: 2 ** 15,
        r: 8,
        p: 1,
        salt: randomBytes(16).toString("base64"),
        check: { iv: "short", tag: "x", ct: "y" },
      }),
    );
    await expect(passphraseKeyProvider(reader("x"), saltFile).getKey()).rejects.toThrow(/salt file is corrupt/);
  });

  it("rejects an empty passphrase and a corrupt salt file", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    await expect(passphraseKeyProvider(reader(""), saltFile).getKey()).rejects.toThrow(/empty passphrase/);
    await expect(fs.readdir(storeDirPath)).rejects.toMatchObject({ code: "ENOENT" }); // nothing written for it
    await fs.mkdir(storeDirPath, { recursive: true });
    await fs.writeFile(saltFile, JSON.stringify({ v: 1, kdf: "scrypt", N: 1024, r: 8, p: 1, salt: randomBytes(16).toString("base64") }));
    await expect(passphraseKeyProvider(reader("x"), saltFile).getKey()).rejects.toThrow(/salt file is corrupt/);
  });

  it("never reads process.env (a passphrase planted in env is ignored)", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const planted = `planted ${throwaway()}`;
    const typed = `typed ${throwaway()}`;
    const plantedNames = ["TESTLANE_PASSPHRASE", "AGENT_AUTH_PASSPHRASE", "AGENT_AUTH_VAULT_PASSPHRASE", "PASSPHRASE"];
    const realEnv = process.env;
    const accessed: string[] = [];
    process.env = new Proxy(
      { ...realEnv, ...Object.fromEntries(plantedNames.map((n) => [n, planted])) },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") accessed.push(prop);
          return Reflect.get(target, prop, receiver) as unknown;
        },
        has(target, prop) {
          if (typeof prop === "string") accessed.push(prop);
          return Reflect.has(target, prop);
        },
        ownKeys(target) {
          accessed.push("<ownKeys>");
          return Reflect.ownKeys(target);
        },
      },
    );
    let viaEnv: Buffer;
    let viaTyped: Buffer;
    try {
      // Control: the spy really is installed and records reads.
      expect(process.env["AGENT_AUTH_PASSPHRASE"]).toBe(planted);
      expect(accessed).toEqual(["AGENT_AUTH_PASSPHRASE"]);
      accessed.length = 0;

      viaTyped = await passphraseKeyProvider(reader(typed), saltFile).getKey();
      // The planted value is just a wrong passphrase to this provider: refused by the check value.
      viaEnv = await passphraseKeyProvider(reader(planted), saltFile)
        .getKey()
        .catch((e: unknown) => {
          expect(String(e)).toMatch(/wrong passphrase/);
          return Buffer.alloc(0);
        });
      const again = await passphraseKeyProvider(reader(typed), saltFile).getKey();
      expect(again.equals(viaTyped)).toBe(true);
    } finally {
      process.env = realEnv;
    }
    expect(accessed).toEqual([]);
    expect(viaEnv).toHaveLength(0);
    expect(viaTyped.equals(viaEnv)).toBe(false);

    // Belt and braces: the module source never mentions process.env at all.
    const src = await fs.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "store", "encrypted-file.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/process\.env/);
  });

  it("interactivePassphrase refuses a non-TTY stdin, saying what to do instead", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    stdin.end("piped passphrase\n");
    const err = await interactivePassphrase({ stdin })().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe(
      "the encrypted-file passphrase must be typed at an interactive terminal, but stdin is not one (piped input " +
        "cannot supply it). An unattended agent cannot type it and needs a keychain-backed key instead; " +
        "see docs/platforms.md (https://github.com/testlane-dev/testlane/blob/main/docs/platforms.md)",
    );
    expect(err?.message).not.toContain("piped passphrase");
    // Every purpose (enter / new / confirm) is refused the same way.
    for (const purpose of ["enter", "new", "confirm"] as const) {
      await expect(interactivePassphrase({ stdin })(purpose)).rejects.toThrow(/must be typed at an interactive terminal/);
    }
  });

  it("a non-TTY stdin writes nothing: no salt file, no entry", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    const saltFile = defaultSaltFile(storeDirPath);
    const store = new EncryptedFileStore({
      dir: storeDirPath,
      keyProvider: passphraseKeyProvider(interactivePassphrase({ stdin }), saltFile),
    });
    await expect(store.set(secretKeyFor("acme:local:admin"), throwaway())).rejects.toThrow(/interactive terminal/);
    await expect(fs.readdir(storeDirPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("passphraseKeyProvider: confirming a new passphrase", () => {
  /** Records what was asked, answering from `answers` in order. */
  function scripted(answers: string[]): { read: PassphraseReader; asked: (string | undefined)[] } {
    const asked: (string | undefined)[] = [];
    const queue = [...answers];
    return {
      asked,
      read: async (purpose) => {
        asked.push(purpose);
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected extra passphrase prompt");
        return next;
      },
    };
  }

  it("asks twice on first use, writes the salt and check only after they match, then asks once", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const pass = `pass phrase ${throwaway()}`;
    const first = scripted([pass, pass]);
    const k1 = await passphraseKeyProvider(first.read, saltFile).getKey();
    expect(first.asked).toEqual(["new", "confirm"]);
    expect(JSON.parse(await fs.readFile(saltFile, "utf8"))).toHaveProperty("check");

    const later = scripted([pass]);
    expect((await passphraseKeyProvider(later.read, saltFile).getKey()).equals(k1)).toBe(true);
    expect(later.asked).toEqual(["enter"]);
  });

  it("refuses a mismatch without writing anything, then lets a retry succeed", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const pass = `pass phrase ${throwaway()}`;
    const typo = `${pass}x`;
    const key = secretKeyFor("acme:local:admin");
    const script = scripted([pass, typo, pass, pass]);
    const store = new EncryptedFileStore({ dir: storeDirPath, keyProvider: passphraseKeyProvider(script.read, saltFile) });

    const err = await errorOf(store.set(key, throwaway()));
    expect(err.message).toBe("passphrases do not match; nothing was written");
    expect(err.message).not.toContain(pass);
    expect(script.asked).toEqual(["new", "confirm"]);
    // Nothing on disk: not the salt, not a check value, not the entry (the directory was never created).
    await expect(fs.readdir(storeDirPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The provider did not cache the failure: the next attempt prompts afresh and now succeeds.
    const value = throwaway();
    await store.set(key, value);
    expect(script.asked).toEqual(["new", "confirm", "new", "confirm"]);
    expect(await store.get(key)).toBe(value);
  });

  it("a mismatch leaves an existing salt file without a check byte-identical (and never writes a check)", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    await fs.mkdir(storeDirPath, { recursive: true });
    const legacy = `${JSON.stringify({ v: 1, kdf: "scrypt", N: 2 ** 15, r: 8, p: 1, salt: randomBytes(16).toString("base64") })}\n`;
    await fs.writeFile(saltFile, legacy);
    const pass = `pass phrase ${throwaway()}`;
    const script = scripted([pass, `${pass}!`]);
    await expect(passphraseKeyProvider(script.read, saltFile).getKey()).rejects.toThrow(
      "passphrases do not match; nothing was written",
    );
    expect(script.asked).toEqual(["new", "confirm"]);
    expect(await fs.readFile(saltFile, "utf8")).toBe(legacy);
    expect(await fs.readdir(storeDirPath)).toEqual([SALT_FILE_NAME]);
  });

  it("an empty first entry is refused before any confirmation is asked", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const script = scripted([""]);
    await expect(passphraseKeyProvider(script.read, saltFile).getKey()).rejects.toThrow(/empty passphrase/);
    expect(script.asked).toEqual(["new"]);
    await expect(fs.readdir(storeDirPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not ask for a confirmation once a check value exists (a wrong passphrase is just refused)", async () => {
    const saltFile = defaultSaltFile(storeDirPath);
    const pass = `pass phrase ${throwaway()}`;
    await passphraseKeyProvider(scripted([pass, pass]).read, saltFile).getKey();
    const wrong = scripted([`${pass}?`]);
    await expect(passphraseKeyProvider(wrong.read, saltFile).getKey()).rejects.toThrow(/wrong passphrase/);
    expect(wrong.asked).toEqual(["enter"]);
  });

  describe("which prompts are shown", () => {
    const legacySalt = (): string =>
      `${JSON.stringify({ v: 1, kdf: "scrypt", N: 2 ** 15, r: 8, p: 1, salt: randomBytes(16).toString("base64") })}\n`;

    it("no salt file: new + confirm", async () => {
      const pass = `pass phrase ${throwaway()}`;
      const script = scripted([pass, pass]);
      await passphraseKeyProvider(script.read, defaultSaltFile(storeDirPath)).getKey();
      expect(script.asked).toEqual(["new", "confirm"]);
    });

    it("a salt file without a check and no entries: new + confirm", async () => {
      const saltFile = defaultSaltFile(storeDirPath);
      await fs.mkdir(storeDirPath, { recursive: true });
      await fs.writeFile(saltFile, legacySalt());
      // Leftovers that are not entries (a temp file, an unrelated file) do not make it an existing vault.
      await fs.writeFile(`${fileFor(secretKeyFor("acme:local:admin"))}.0123456789ab.tmp`, "{}");
      await fs.writeFile(path.join(storeDirPath, "notes.txt"), "x");
      const pass = `pass phrase ${throwaway()}`;
      const script = scripted([pass, pass]);
      await passphraseKeyProvider(script.read, saltFile).getKey();
      expect(script.asked).toEqual(["new", "confirm"]);
      expect(JSON.parse(await fs.readFile(saltFile, "utf8"))).toHaveProperty("check");
    });

    it("a salt file without a check next to existing entries: enter once, the entry still decrypts", async () => {
      const saltFile = defaultSaltFile(storeDirPath);
      const key = secretKeyFor("acme:local:admin");
      const value = throwaway();
      const pass = `pass phrase ${throwaway()}`;
      await new EncryptedFileStore({
        dir: storeDirPath,
        keyProvider: passphraseKeyProvider(scripted([pass, pass]).read, saltFile),
      }).set(key, value);
      // Simulate a salt file from a build before the check value existed.
      const salt = JSON.parse(await fs.readFile(saltFile, "utf8")) as Record<string, unknown>;
      delete salt["check"];
      await fs.writeFile(saltFile, `${JSON.stringify(salt)}\n`);

      const script = scripted([pass]);
      const store = new EncryptedFileStore({ dir: storeDirPath, keyProvider: passphraseKeyProvider(script.read, saltFile) });
      expect(await store.get(key)).toBe(value);
      expect(script.asked).toEqual(["enter"]); // never "new", never a confirmation
      // The first passphrase typed after the upgrade became the check value, which is now enforced.
      expect(JSON.parse(await fs.readFile(saltFile, "utf8"))).toHaveProperty("check");
      const wrong = scripted([`${pass}?`]);
      await expect(passphraseKeyProvider(wrong.read, saltFile).getKey()).rejects.toThrow(/wrong passphrase/);
      expect(wrong.asked).toEqual(["enter"]);
    });

    it("a salt file with a check: enter once", async () => {
      const saltFile = defaultSaltFile(storeDirPath);
      const pass = `pass phrase ${throwaway()}`;
      await passphraseKeyProvider(scripted([pass, pass]).read, saltFile).getKey();
      const script = scripted([pass]);
      await passphraseKeyProvider(script.read, saltFile).getKey();
      expect(script.asked).toEqual(["enter"]);
    });
  });

  describe("on an interactive terminal", () => {
    function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void } {
      const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };
      s.isTTY = true;
      s.setRawMode = () => undefined;
      return s;
    }
    function sink(): { stream: NodeJS.WriteStream; text: () => string } {
      let text = "";
      const stream = { write: (chunk: string | Buffer): boolean => ((text += chunk.toString()), true) };
      return { stream: stream as unknown as NodeJS.WriteStream, text: () => text };
    }
    /** Type `line` once the terminal has shown `prompt` (so each read sees only its own line). */
    async function typeAfter(out: { text: () => string }, tty: PassThrough, prompt: string, line: string): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!out.text().includes(prompt) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(out.text()).toContain(prompt);
      tty.write(`${line}\r`);
    }

    it("shows a distinct prompt for choosing, confirming and entering, and never echoes the passphrase", async () => {
      const saltFile = defaultSaltFile(storeDirPath);
      const pass = `pass phrase ${throwaway()}`;
      const tty = fakeTty();
      const out = sink();
      const reader = interactivePassphrase({ stdin: tty as unknown as NodeJS.ReadStream, stdout: out.stream });

      const created = passphraseKeyProvider(reader, saltFile).getKey();
      await typeAfter(out, tty, "new testlane vault passphrase: ", pass);
      await typeAfter(out, tty, "confirm new passphrase: ", pass);
      const k1 = await created;
      expect(out.text()).not.toContain(pass);

      // A later run (fresh output, since "testlane vault passphrase: " is a suffix of the "new" prompt).
      const out2 = sink();
      const reader2 = interactivePassphrase({ stdin: tty as unknown as NodeJS.ReadStream, stdout: out2.stream });
      const again = passphraseKeyProvider(reader2, saltFile).getKey();
      await typeAfter(out2, tty, "testlane vault passphrase: ", pass);
      expect((await again).equals(k1)).toBe(true);
      expect(out2.text()).toBe("testlane vault passphrase: \n"); // asked once, nothing echoed
    });

    it("refuses two different typed entries with the mismatch message and writes nothing", async () => {
      const saltFile = defaultSaltFile(storeDirPath);
      const pass = `pass phrase ${throwaway()}`;
      const tty = fakeTty();
      const out = sink();
      const reader = interactivePassphrase({ stdin: tty as unknown as NodeJS.ReadStream, stdout: out.stream });

      const attempt = passphraseKeyProvider(reader, saltFile).getKey();
      const settled = attempt.then(
        () => null,
        (e: unknown) => e as Error,
      );
      await typeAfter(out, tty, "new testlane vault passphrase: ", pass);
      await typeAfter(out, tty, "confirm new passphrase: ", `${pass}x`);
      expect((await settled)?.message).toBe("passphrases do not match; nothing was written");
      await expect(fs.readdir(storeDirPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
