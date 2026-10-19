/**
 * Pick the secret store for the current (or given) platform.
 *
 * Order:
 *  1. Explicit override: TESTLANE_STORE (else the pre-rename AGENT_AUTH_STORE)
 *     in {dpapi, keychain-macos,
 *     secret-service, encrypted-file}. Any other non-empty value is an error.
 *  2. win32 -> DpapiStore; darwin -> KeychainMacosStore; linux (and other
 *     Unix-likes) -> SecretServiceStore when `secret-tool` is on PATH.
 *  3. Otherwise EncryptedFileStore keyed from the platform keychain when one is
 *     available, else a clear error.
 *
 * The errors name the actual cause (secret-tool missing, and whether a D-Bus
 * session bus is set), the packages or commands that fix it, and end with a
 * pointer to docs/platforms.md. TESTLANE_STORE is mentioned only when the user
 * set it.
 *
 * TESTLANE_STORE only chooses HOW secrets are protected at rest. It never
 * changes WHETHER policy applies: production refusal, host allowlists, TTL caps
 * and origin binding are enforced above the store and are unaffected by it.
 *
 * There is deliberately no plaintext fallback: every branch either returns an
 * adapter that encrypts (or delegates to an OS keychain) or throws.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { lookupEnv } from "../env.js";
import { storeDir } from "../paths.js";
import { DpapiStore, type SpawnLike } from "./dpapi.js";
import {
  EncryptedFileStore,
  defaultSaltFile,
  interactivePassphrase,
  keychainKeyProvider,
  passphraseKeyProvider,
  type KeyProvider,
  type PassphraseReader,
} from "./encrypted-file.js";
import type { SecretStore } from "./index.js";
import { KeychainMacosStore } from "./keychain-macos.js";
import { PLATFORMS_DOC_POINTER, SECRET_SERVICE_PACKAGES, SecretServiceStore } from "./secret-service.js";

export const STORE_KINDS = ["dpapi", "keychain-macos", "secret-service", "encrypted-file"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export const STORE_ENV_VAR = "TESTLANE_STORE";
/** Pre-rename name of STORE_ENV_VAR, read when TESTLANE_STORE is unset. */
export const LEGACY_STORE_ENV_VAR = "AGENT_AUTH_STORE";

/** Environment variable naming the D-Bus session bus; secret-tool needs one to reach a keyring. */
const SESSION_BUS_ENV_VAR = "DBUS_SESSION_BUS_ADDRESS";

/**
 * Why there is no keychain on Linux: `secret-tool` is not on PATH. `lead` names
 * what failed (the default path or an explicit override). When no D-Bus
 * session bus is set either (headless machine, WSL, devcontainer, a plain
 * ssh login) the message also says how to start one; otherwise it only names
 * the packages. The bus only shapes this message, never the selection: a
 * desktop session may reach its bus without the variable, and secret-tool
 * reports a real bus failure when it is used (see secret-service.ts).
 */
function noSecretToolMessage(lead: string, env: NodeJS.ProcessEnv): string {
  const noBus = (env[SESSION_BUS_ENV_VAR] ?? "").trim() === "";
  if (!noBus) {
    return (
      `${lead}: secret-tool is not on PATH. Install it with a Secret Service keyring ` +
      `(${SECRET_SERVICE_PACKAGES}) and unlock the keyring; ${PLATFORMS_DOC_POINTER}`
    );
  }
  return (
    `${lead}: secret-tool is not on PATH and there is no D-Bus session bus (${SESSION_BUS_ENV_VAR} is unset). ` +
    `Install the packages (${SECRET_SERVICE_PACKAGES}), then on a headless machine, WSL or a devcontainer ` +
    "start a session with `dbus-run-session -- bash`, unlock a keyring in that shell, and start the agent " +
    `from that same shell so it shares the bus; ${PLATFORMS_DOC_POINTER}`
  );
}

export interface SelectStoreOptions {
  platform?: NodeJS.Platform;
  dir?: string;
  /** Environment consulted for TESTLANE_STORE / AGENT_AUTH_STORE (and PATH for the default `which`). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Resolve a command on PATH to an absolute path, or null. Defaults to whichSync over env.PATH. */
  which?: (command: string) => string | null;
  /** Test hook passed to the keychain adapters. */
  spawn?: SpawnLike;
  /** Test hook: let keychain adapters be constructed off their platform (fake spawn only). */
  allowAnyPlatform?: boolean;
  /** Passphrase prompt for encrypted-file without a keychain. Defaults to an interactive TTY prompt. */
  readPassphrase?: PassphraseReader;
}

export function isStoreKind(value: string): value is StoreKind {
  return (STORE_KINDS as readonly string[]).includes(value);
}

/**
 * First absolute PATH entry holding an executable file named `command`.
 * Empty and relative PATH entries are ignored (they would resolve against the
 * current directory, which an attacker may control).
 */
export function whichSync(command: string, pathVar: string = process.env["PATH"] ?? ""): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export function selectStore(opts: SelectStoreOptions = {}): SecretStore {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const which = opts.which ?? ((cmd: string) => whichSync(cmd, env["PATH"] ?? ""));
  const dir = opts.dir ?? storeDir();

  const adapterOpts = {
    ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
    ...(opts.allowAnyPlatform === undefined ? {} : { allowAnyPlatform: opts.allowAnyPlatform }),
  };

  const dpapi = (): SecretStore => new DpapiStore({ dir });
  const keychainMacos = (): SecretStore => new KeychainMacosStore({ dir, ...adapterOpts });
  const secretService = (command: string): SecretStore => new SecretServiceStore({ command, ...adapterOpts });

  /** The OS keychain for this platform, or null when there is none. */
  const platformKeychain = (): SecretStore | null => {
    if (platform === "win32") return dpapi();
    if (platform === "darwin") return keychainMacos();
    const secretTool = which("secret-tool");
    return secretTool === null ? null : secretService(secretTool);
  };

  const encryptedFile = (allowPassphrase: boolean): SecretStore => {
    const keychain = platformKeychain();
    let keyProvider: KeyProvider;
    if (keychain !== null) {
      keyProvider = keychainKeyProvider(keychain);
    } else if (allowPassphrase) {
      // Interactive only: the passphrase is prompted for, never read from env.
      keyProvider = passphraseKeyProvider(opts.readPassphrase ?? interactivePassphrase(), defaultSaltFile(dir));
    } else {
      throw new Error(noSecretToolMessage("no keychain available", env));
    }
    return new EncryptedFileStore({ dir, keyProvider });
  };

  // How secrets are protected; never whether policy applies (see module comment).
  const fromEnv = lookupEnv("TESTLANE_STORE", env);
  const override = (fromEnv?.value ?? "").trim();
  const envName = fromEnv?.source ?? STORE_ENV_VAR;
  if (override !== "") {
    if (!isStoreKind(override)) {
      throw new Error(`${envName} must be one of ${STORE_KINDS.join(", ")}`);
    }
    switch (override) {
      case "dpapi":
        return dpapi();
      case "keychain-macos":
        return keychainMacos();
      case "secret-service": {
        const secretTool = which("secret-tool");
        if (secretTool === null) throw new Error(noSecretToolMessage(`${envName}=secret-service`, env));
        return secretService(secretTool);
      }
      case "encrypted-file":
        return encryptedFile(true);
    }
  }

  switch (platform) {
    case "win32":
      return dpapi();
    case "darwin":
      return keychainMacos();
    default: {
      const secretTool = which("secret-tool");
      if (secretTool !== null) return secretService(secretTool);
      return encryptedFile(false);
    }
  }
}
