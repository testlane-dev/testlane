/**
 * Encrypted-file secret store: the fallback when no OS keychain adapter fits.
 *
 * Each key is kept in `<dir>/<encodeKeyForFile(key)>.enc`, a JSON document
 * `{ "v": 1, "iv": <b64>, "tag": <b64>, "ct": <b64> }` holding the AES-256-GCM
 * encryption of the UTF-8 value under a fresh random 96-bit IV. The store key
 * is bound as additional authenticated data, so a file copied or renamed onto
 * another key fails authentication instead of decrypting. Writes are atomic
 * (temp file + rename); the directory is created 0o700 and files 0o600 (POSIX
 * modes; Windows ignores them and relies on the profile directory ACL).
 *
 * The 32-byte data key comes from an injected KeyProvider:
 *  - keychainKeyProvider(inner): 32 random bytes generated on first use and
 *    kept (base64) in an OS keychain store. Works unattended. This is the only
 *    option for agents.
 *  - passphraseKeyProvider(readPassphrase, saltFile): scrypt over a passphrase
 *    that is PROMPTED for (never read from an environment variable, argv or a
 *    file). It is interactive-only by design: an unattended agent cannot
 *    supply it, so unattended use needs the keychain-backed key. The salt
 *    file also holds a check value (the AES-256-GCM encryption of a fixed
 *    constant under the derived key), so a mistyped passphrase is refused as
 *    "wrong passphrase" before any entry is read or written. While there is
 *    no check value and no entry yet (first use), the passphrase is asked for
 *    twice and a mismatch is refused before anything is written, so a typo
 *    cannot become the passphrase.
 *
 * There is no plaintext mode.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { storeDir } from "../paths.js";
import {
  assertValidStoreKey,
  decodeKeyFromFile,
  encodeKeyForFile,
  isValidStoreKey,
  type SecretStore,
} from "./index.js";
import { readSecret } from "./input.js";
import { isErrno } from "./keychain-macos.js";
import { PLATFORMS_DOC_POINTER } from "./secret-service.js";

/** Supplies the 32-byte AES-256 data key. Implementations should return a fresh copy each call (the store zeroes it). */
export interface KeyProvider {
  getKey(): Promise<Buffer>;
  /** Human-readable description of where the key comes from (no key material). */
  readonly kind?: string;
}

export interface EncryptedFileStoreOptions {
  keyProvider: KeyProvider;
  /** Directory holding the `.enc` files. Defaults to storeDir(). */
  dir?: string;
}

const FILE_SUFFIX = ".enc";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
// Stable storage identifiers (AAD_PREFIX, ENCRYPTED_FILE_KEY_NAME,
// PASSPHRASE_CHECK_PLAINTEXT): kept verbatim after the rename to Testlane for
// compatibility; changing any of them makes existing `.enc` files, data keys
// or salt files unreadable.
const AAD_PREFIX = "agent-auth/encrypted-file/v1\u0000";
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Default key name for keychainKeyProvider. A valid store key, so every adapter accepts it. */
export const ENCRYPTED_FILE_KEY_NAME = "agent-auth/encrypted-file.key.v1";
/** Default salt file name for passphraseKeyProvider, next to the `.enc` files. */
export const SALT_FILE_NAME = "encrypted-file.salt.json";

export function defaultSaltFile(dir: string = storeDir()): string {
  return path.join(dir, SALT_FILE_NAME);
}

interface EncFile {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export class EncryptedFileStore implements SecretStore {
  readonly kind = "encrypted-file";
  readonly dir: string;
  readonly keyProvider: KeyProvider;

  constructor(opts: EncryptedFileStoreOptions) {
    if (!opts || typeof opts.keyProvider?.getKey !== "function") {
      throw new Error("EncryptedFileStore requires a keyProvider");
    }
    this.keyProvider = opts.keyProvider;
    this.dir = opts.dir ?? storeDir();
  }

  private fileFor(key: string): string {
    assertValidStoreKey(key);
    return path.join(this.dir, `${encodeKeyForFile(key)}${FILE_SUFFIX}`);
  }

  async get(key: string): Promise<string | null> {
    const file = this.fileFor(key);
    // The key (and, for a passphrase, its check value) is established before any entry is read.
    const dataKey = await this.dataKey();
    let plain: Buffer | undefined;
    try {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch (err) {
        if (isErrno(err, "ENOENT")) return null;
        throw err;
      }
      const parsed = parseEncFile(text, path.basename(file));
      const iv = Buffer.from(parsed.iv, "base64");
      const tag = Buffer.from(parsed.tag, "base64");
      const ct = Buffer.from(parsed.ct, "base64");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error(`encrypted-file store: file for this key is corrupt: ${path.basename(file)}`);
      }
      const decipher = createDecipheriv("aes-256-gcm", dataKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadFor(key));
      decipher.setAuthTag(tag);
      try {
        plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      } catch {
        throw new Error(
          `encrypted-file store: cannot decrypt ${path.basename(file)} (wrong key/passphrase, or the file was tampered with)`,
        );
      }
      return plain.toString("utf8");
    } finally {
      plain?.fill(0);
      dataKey.fill(0);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.fileFor(key);
    if (typeof value !== "string") throw new Error("encrypted-file set failed: value must be a string");
    const dataKey = await this.dataKey();
    const iv = randomBytes(IV_BYTES);
    const plain = Buffer.from(value, "utf8");
    let body: EncFile;
    try {
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadFor(key));
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      body = {
        v: FORMAT_VERSION,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      };
    } finally {
      plain.fill(0);
      dataKey.fill(0);
    }

    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const file = this.fileFor(key);
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
    const keys: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const stem = name.slice(0, -FILE_SUFFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(stem)) continue;
      const key = decodeKeyFromFile(stem);
      if (encodeKeyForFile(key) !== stem) continue;
      if (!isValidStoreKey(key)) continue;
      keys.push(key);
    }
    return keys.sort();
  }

  private async dataKey(): Promise<Buffer> {
    const k = await this.keyProvider.getKey();
    if (!Buffer.isBuffer(k) || k.length !== KEY_BYTES) {
      if (Buffer.isBuffer(k)) k.fill(0);
      throw new Error(`encrypted-file store: key provider must return exactly ${KEY_BYTES} bytes`);
    }
    return k;
  }
}

function aadFor(key: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${key}`, "utf8");
}

function parseEncFile(text: string, name: string): EncFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`encrypted-file store: file for this key is corrupt (not JSON): ${name}`);
  }
  const o = parsed as Partial<Record<keyof EncFile, unknown>> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    o.v !== FORMAT_VERSION ||
    typeof o.iv !== "string" ||
    typeof o.tag !== "string" ||
    typeof o.ct !== "string" ||
    !BASE64_RE.test(o.iv) ||
    !BASE64_RE.test(o.tag) ||
    !BASE64_RE.test(o.ct)
  ) {
    throw new Error(`encrypted-file store: file for this key is corrupt or an unsupported version: ${name}`);
  }
  return { v: FORMAT_VERSION, iv: o.iv, tag: o.tag, ct: o.ct };
}

// ---------------------------------------------------------------------------
// Key providers
// ---------------------------------------------------------------------------

/**
 * Data key kept in an OS keychain store (`inner`), generated on first use.
 * Suitable for unattended agents. The key is cached in memory for the life of
 * the provider; getKey() returns a copy.
 *
 * Limitations: two processes seeding the key at the same instant could race
 * (the provider re-reads after writing and uses whatever the keychain holds,
 * which narrows but does not close the window). The key entry is a valid
 * store key, so it shows up in `inner.list()`.
 */
export function keychainKeyProvider(inner: SecretStore, key: string = ENCRYPTED_FILE_KEY_NAME): KeyProvider {
  if (inner.kind === "encrypted-file") {
    throw new Error("keychainKeyProvider needs an OS keychain store, not another encrypted-file store");
  }
  assertValidStoreKey(key);
  let cached: Promise<Buffer> | null = null;
  const load = async (): Promise<Buffer> => {
    let stored = await inner.get(key);
    if (stored === null) {
      const fresh = randomBytes(KEY_BYTES);
      await inner.set(key, fresh.toString("base64"));
      fresh.fill(0);
      stored = await inner.get(key);
      if (stored === null) throw new Error("encrypted-file key could not be stored in the keychain");
    }
    const trimmed = stored.trim();
    const bytes = BASE64_RE.test(trimmed) ? Buffer.from(trimmed, "base64") : Buffer.alloc(0);
    if (bytes.length !== KEY_BYTES) {
      bytes.fill(0);
      throw new Error("encrypted-file key in the keychain is corrupt (expected 32 bytes, base64)");
    }
    return bytes;
  };
  return {
    kind: `keychain:${inner.kind}`,
    async getKey(): Promise<Buffer> {
      cached ??= load();
      try {
        return Buffer.from(await cached);
      } catch (err) {
        cached = null;
        throw err;
      }
    },
  };
}

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLength: KEY_BYTES } as const;
const SALT_BYTES = 16;

/** Plaintext of the passphrase check value (not secret; it only proves the derived key). */
export const PASSPHRASE_CHECK_PLAINTEXT = "agent-auth-passphrase-check";

/** AES-256-GCM encryption of PASSPHRASE_CHECK_PLAINTEXT under the derived key (random IV). */
interface PassphraseCheck {
  iv: string;
  tag: string;
  ct: string;
}

interface SaltFile {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  /** Written on first use; absent only in a salt file that was never used (or predates the check). */
  check?: PassphraseCheck;
}

interface SaltState {
  body: SaltFile;
  salt: Buffer;
  check: PassphraseCheck | null;
}

const WRONG_PASSPHRASE_MESSAGE =
  "encrypted-file store: wrong passphrase (it does not match the check value in the salt file); nothing was read or written";

/** Refusal when the two entries of a new passphrase differ. Nothing has been written at that point. */
export const PASSPHRASE_MISMATCH_MESSAGE = "passphrases do not match; nothing was written";

/** Refusal when stdin is not a terminal, so no passphrase can be typed. */
export const PASSPHRASE_NEEDS_TERMINAL_MESSAGE =
  "the encrypted-file passphrase must be typed at an interactive terminal, but stdin is not one (piped input " +
  `cannot supply it). An unattended agent cannot type it and needs a keychain-backed key instead; ${PLATFORMS_DOC_POINTER}`;

/**
 * Why a passphrase is being read: `enter` an existing one, choose a `new` one
 * (first use), or `confirm` the new one by typing it again.
 */
export type PassphrasePurpose = "enter" | "new" | "confirm";

/** Obtains a passphrase from a human. Implementations must not read it from env, argv or a file. */
export type PassphraseReader = (purpose?: PassphrasePurpose) => Promise<string>;

/**
 * Data key derived with scrypt (N=2^15, r=8, p=1, 32 bytes) from a passphrase
 * obtained by calling `readPassphrase()`, i.e. by prompting a human. The
 * passphrase is never taken from the environment. A random 16-byte salt is
 * persisted in `saltFile` (created exclusively on first use; the salt is not
 * secret). The salt file also carries a check value: the AES-256-GCM
 * encryption of PASSPHRASE_CHECK_PLAINTEXT under the derived key, written on
 * first use. Every derivation verifies it and throws "wrong passphrase" before
 * the key is handed to the store, so no entry is read or written under a
 * mistyped passphrase. The derived key is cached in memory so a process
 * prompts once.
 *
 * First use (no salt file, or one without a check value next to no encrypted
 * entries) establishes the passphrase: it is asked for twice ("new", then
 * "confirm") and a mismatch throws PASSPHRASE_MISMATCH_MESSAGE before the salt
 * or check value is written, so a typo cannot become the passphrase. Later
 * uses ask once.
 *
 * Limitation: a salt file from before the check existed, next to entries that
 * are already encrypted, is not a first use: the existing passphrase is asked
 * for once ("enter"), and the first one typed after the upgrade becomes the
 * check value; type the right one.
 *
 * Interactive only: unattended agents must use keychainKeyProvider instead.
 */
export function passphraseKeyProvider(readPassphrase: PassphraseReader, saltFile: string): KeyProvider {
  let cached: Promise<Buffer> | null = null;
  const load = async (): Promise<Buffer> => {
    // Read-only until the passphrase is settled: nothing is written before both entries matched.
    const existing = await readSalt(saltFile);
    // A salt file without a check value only means "new" when no entry was ever encrypted under it.
    const establishing =
      existing === null || (existing.check === null && !(await hasEncryptedEntries(path.dirname(saltFile))));
    const passphrase = await readPassphrase(establishing ? "new" : "enter");
    if (typeof passphrase !== "string" || passphrase === "") throw new Error("empty passphrase");
    if (establishing && (await readPassphrase("confirm")) !== passphrase) {
      throw new Error(PASSPHRASE_MISMATCH_MESSAGE);
    }
    const state = existing ?? (await createSalt(saltFile));
    const pw = Buffer.from(passphrase, "utf8");
    let key: Buffer;
    try {
      key = await scrypt(pw, state.salt, SCRYPT_PARAMS.keyLength, {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        maxmem: 64 * 1024 * 1024,
      });
    } finally {
      pw.fill(0);
    }
    try {
      if (state.check !== null) {
        if (!checkMatches(key, state.check)) throw new Error(WRONG_PASSPHRASE_MESSAGE);
      } else {
        await persistCheck(saltFile, state.salt, key);
      }
    } catch (err) {
      key.fill(0);
      throw err;
    }
    return key;
  };
  return {
    kind: "passphrase",
    async getKey(): Promise<Buffer> {
      cached ??= load();
      try {
        return Buffer.from(await cached);
      } catch (err) {
        cached = null;
        throw err;
      }
    },
  };
}

/**
 * A readPassphrase for passphraseKeyProvider that only works on an interactive
 * terminal (echo disabled). Piped stdin is refused so the passphrase provider
 * cannot be driven unattended. `prompt` replaces the prompt for an existing
 * passphrase; choosing a new one and confirming it have their own prompts.
 */
export function interactivePassphrase(
  opts: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; prompt?: string } = {},
): PassphraseReader {
  const prompts: Record<PassphrasePurpose, string> = {
    enter: opts.prompt ?? "testlane vault passphrase: ",
    new: "new testlane vault passphrase: ",
    confirm: "confirm new passphrase: ",
  };
  return async (purpose = "enter") => {
    const stdin = opts.stdin ?? process.stdin;
    if (!stdin.isTTY) throw new Error(PASSPHRASE_NEEDS_TERMINAL_MESSAGE);
    return readSecret({
      stdin,
      stdout: opts.stdout ?? process.stdout,
      prompt: prompts[purpose],
      isTTY: true,
    });
  };
}

function makeCheck(key: Buffer): PassphraseCheck {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(PASSPHRASE_CHECK_PLAINTEXT, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function checkMatches(key: Buffer, check: PassphraseCheck): boolean {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(check.iv, "base64"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(Buffer.from(check.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(check.ct, "base64")), decipher.final()]);
    return plain.toString("utf8") === PASSPHRASE_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * First use: add the check value to the salt file (atomic rewrite). If another
 * process wrote one in the meantime, verify against theirs instead.
 */
async function persistCheck(saltFile: string, salt: Buffer, key: Buffer): Promise<void> {
  const current = parseSalt(await fs.readFile(saltFile, "utf8"), saltFile);
  if (!current.salt.equals(salt)) {
    throw new Error(`encrypted-file salt file changed while the key was derived; retry: ${path.basename(saltFile)}`);
  }
  if (current.check !== null) {
    if (!checkMatches(key, current.check)) throw new Error(WRONG_PASSPHRASE_MESSAGE);
    return;
  }
  const body: SaltFile = { ...current.body, check: makeCheck(key) };
  const tmp = `${saltFile}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, saltFile);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** True when `dir` holds at least one `.enc` entry file. A missing directory holds none. Never writes. */
async function hasEncryptedEntries(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((name) => name.endsWith(FILE_SUFFIX));
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

/** The salt file's state, or null when there is none yet. Never writes. */
async function readSalt(saltFile: string): Promise<SaltState | null> {
  try {
    return parseSalt(await fs.readFile(saltFile, "utf8"), saltFile);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/** Create the salt file (exclusively); if another process created it first, use theirs. */
async function createSalt(saltFile: string): Promise<SaltState> {
  const salt = randomBytes(SALT_BYTES);
  const body: SaltFile = {
    v: 1,
    kdf: "scrypt",
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    salt: salt.toString("base64"),
  };
  await fs.mkdir(path.dirname(saltFile), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(saltFile, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { body, salt, check: null };
  } catch (err) {
    // Another process created it first: use theirs.
    if (isErrno(err, "EEXIST")) return parseSalt(await fs.readFile(saltFile, "utf8"), saltFile);
    throw err;
  }
}

/** null = no check yet; undefined = present but malformed. */
function parseCheck(value: unknown): PassphraseCheck | null | undefined {
  if (value === undefined) return null;
  const c = value as Partial<Record<keyof PassphraseCheck, unknown>> | null;
  if (typeof c !== "object" || c === null) return undefined;
  const { iv, tag, ct } = c;
  if (typeof iv !== "string" || typeof tag !== "string" || typeof ct !== "string") return undefined;
  if (!BASE64_RE.test(iv) || !BASE64_RE.test(tag) || !BASE64_RE.test(ct)) return undefined;
  if (Buffer.from(iv, "base64").length !== IV_BYTES || Buffer.from(tag, "base64").length !== TAG_BYTES) {
    return undefined;
  }
  return { iv, tag, ct };
}

function parseSalt(text: string, saltFile: string): SaltState {
  let o: Partial<SaltFile> | null = null;
  try {
    o = JSON.parse(text) as Partial<SaltFile>;
  } catch {
    // fall through
  }
  if (
    !o ||
    o.v !== 1 ||
    o.kdf !== "scrypt" ||
    o.N !== SCRYPT_PARAMS.N ||
    o.r !== SCRYPT_PARAMS.r ||
    o.p !== SCRYPT_PARAMS.p ||
    typeof o.salt !== "string" ||
    !BASE64_RE.test(o.salt)
  ) {
    throw new Error(`encrypted-file salt file is corrupt or uses unsupported parameters: ${path.basename(saltFile)}`);
  }
  const salt = Buffer.from(o.salt, "base64");
  const check = parseCheck(o.check);
  if (salt.length !== SALT_BYTES || check === undefined) {
    throw new Error(`encrypted-file salt file is corrupt: ${path.basename(saltFile)}`);
  }
  const body: SaltFile = { v: 1, kdf: "scrypt", N: o.N, r: o.r, p: o.p, salt: o.salt };
  if (check !== null) body.check = check;
  return { body, salt, check };
}

function scrypt(password: Buffer, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
