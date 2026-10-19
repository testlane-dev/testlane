/**
 * Linux secret store backed by the freedesktop Secret Service (GNOME Keyring,
 * KWallet's Secret Service bridge, KeePassXC, ...) via libsecret's `secret-tool`.
 *
 * Items carry the attributes `service=agent-auth` and `key=<store key>`.
 *
 * Secret transport:
 *  - set: `secret-tool store --label=agent-auth <key> service agent-auth key <key>`;
 *    the value is written to the child's stdin (no trailing newline; secret-tool
 *    reads stdin to EOF when it is not a terminal, into an 8 KiB buffer, so
 *    values over SECRET_TOOL_MAX_VALUE_BYTES are refused). It never appears on argv.
 *  - get: `secret-tool lookup service agent-auth key <key>`; the value comes
 *    back only over stdout. Exit 1 with no output at all means "absent".
 *  - delete: a `lookup` runs first to decide true/false. `secret-tool clear` exits 0 when it
 *    removed an item and 1 with no output when nothing matched (verified in CI on
 *    ubuntu-latest, 2026-09-25); the latter is treated as "already gone" (a concurrent delete)
 *    to decide the boolean result (the looked-up value is zeroed, never used).
 *  - list: `secret-tool search --all service agent-auth`, parsing the
 *    `attribute.key = ...` lines (secret-tool prints attributes on stderr and
 *    label/secret lines on stdout, depending on version; both are scanned for
 *    attribute lines only). NOTE: `search` also prints `secret = <value>` for
 *    unlocked items, so secret values transit this process's stdout pipe; the
 *    buffers are only scanned for attribute lines and are then zeroed.
 *
 * Unlocking a locked collection may pop a desktop prompt. Setup failures that
 * secret-tool reports in its own words (no session D-Bus, no Secret Service
 * provider on the bus, a locked or missing default collection) are recognised
 * from that stderr (see KNOWN_FAILURES) and replaced with one fixed, actionable
 * message each, ending with a pointer to docs/platforms.md. secret-tool's own
 * text for these cases is discarded entirely, not merely sanitized, since it
 * carries nothing a user needs. Any other failure keeps secret-tool's sanitized
 * stderr.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnLike } from "./dpapi.js";
import { assertValidStoreKey, isValidStoreKey, type SecretStore } from "./index.js";
import { runTool, toolError, type ToolResult } from "./keychain-macos.js";

export interface SecretServiceStoreOptions {
  /** Test hook: replaces child_process.spawn. Never used to pass data. */
  spawn?: SpawnLike;
  /** Milliseconds before a `secret-tool` child is killed. Default 30 s. */
  timeoutMs?: number;
  /** Path to secret-tool (selectStore passes the PATH-resolved absolute path). Default "secret-tool". */
  command?: string;
  /** Test hook: skip the linux platform guard (only meaningful with a fake spawn). */
  allowAnyPlatform?: boolean;
}

/**
 * Value of the `service` attribute on every item. Stable storage identifier:
 * kept as "agent-auth" after the rename to Testlane for compatibility (lookups
 * and `search --all` match on it). The item label is cosmetic and keeps it too.
 */
export const SECRET_SERVICE_ATTR = "agent-auth";
/**
 * Largest value set() accepts. secret-tool reads a non-tty stdin into a fixed
 * 8192-byte buffer and silently truncates (exit 0, "password is too long" on
 * stderr) anything longer, so longer values are refused up front.
 */
export const SECRET_TOOL_MAX_VALUE_BYTES = 8191;

/**
 * Closing pointer of every actionable store message (this module, select.ts and
 * encrypted-file.ts): the per-platform setup page. The URL is spelled out
 * because a terminal that only has the installed binary may not have the file.
 */
export const PLATFORMS_DOC_POINTER =
  "see docs/platforms.md (https://github.com/testlane-dev/testlane/blob/main/docs/platforms.md)";

/** The packages that provide secret-tool and a Secret Service keyring, per distribution family. */
export const SECRET_SERVICE_PACKAGES =
  "Debian/Ubuntu: sudo apt install libsecret-tools gnome-keyring; Fedora: sudo dnf install libsecret gnome-keyring";

const NO_SESSION_BUS_MESSAGE =
  "No D-Bus session bus is reachable. On a headless machine, WSL or a devcontainer start one with " +
  "`dbus-run-session -- bash`, unlock a keyring in that shell, and start the agent from that same shell " +
  `so it shares the bus; ${PLATFORMS_DOC_POINTER}`;

const NO_SECRET_SERVICE_MESSAGE =
  "A D-Bus session bus is reachable, but no Secret Service keyring is running on it (nothing owns " +
  "org.freedesktop.secrets). Install gnome-keyring (Debian/Ubuntu: sudo apt install gnome-keyring; Fedora: " +
  `sudo dnf install gnome-keyring) or start your desktop's keyring, and unlock it; ${PLATFORMS_DOC_POINTER}`;

const LOCKED_COLLECTION_MESSAGE =
  "The Linux Secret Service keyring is locked (or has no default collection). Unlock it by logging " +
  "into your desktop session, or on a headless machine, WSL or a devcontainer unlock gnome-keyring in " +
  "your `dbus-run-session -- bash` shell with a password piped on stdin (never on argv) and start the " +
  `agent from that same shell; ${PLATFORMS_DOC_POINTER}`;

/**
 * Matches secret-tool's, GLib's and gnome-keyring's own fixed strings for each
 * known setup failure. These are fixed diagnostic strings, never user data, so
 * matching (and then discarding) them leaks nothing. Order matters only in that
 * the first match wins.
 *  - no session bus: no DBUS_SESSION_BUS_ADDRESS and no way to autolaunch one
 *    (`Cannot autolaunch D-Bus without X11 $DISPLAY`, or libdbus' own wording),
 *    or an address that points nowhere (`Could not connect: No such file or
 *    directory` / `Connection refused`), or a failed `dbus-launch`.
 *  - no Secret Service: a bus, but nothing owns org.freedesktop.secrets.
 *  - locked / missing collection: `Cannot create an item in a locked
 *    collection` (set), `Cannot get secret of a locked object` and
 *    `Object does not exist at path "/org/freedesktop/secrets/collection/..."`
 *    (lookup/clear/search, on backends that report it instead of failing
 *    silently). GLib quotes the path with curly quotes, which a non-UTF-8
 *    locale prints as `?`, so the character before the path is any 0-2
 *    non-space, non-slash characters.
 */
const KNOWN_FAILURES: readonly { readonly re: RegExp; readonly message: string }[] = [
  {
    re: /cannot autolaunch d-bus without x11|unable to autolaunch a dbus-daemon without a \$display|could not connect: (?:no such file or directory|connection refused)|error spawning command line .{0,100}dbus-launch/i,
    message: NO_SESSION_BUS_MESSAGE,
  },
  {
    re: /org\.freedesktop\.secrets was not provided by any \.service files|org\.freedesktop\.dbus\.error\.serviceunknown/i,
    message: NO_SECRET_SERVICE_MESSAGE,
  },
  {
    re: /cannot (?:create an item in|get secret of|set property on) a locked (?:collection|object)|the collection does not exist|object does not exist at path\s*[^\s/]{0,2}\/org\/freedesktop\/secrets\/collection\//i,
    message: LOCKED_COLLECTION_MESSAGE,
  },
];

/**
 * The fixed message for a known setup failure, or null when `stderr` matches
 * none of them. Callers use this in place of toolError() so secret-tool's
 * stderr for these specific cases never reaches the message.
 */
function knownFailure(stderr: string): string | null {
  for (const known of KNOWN_FAILURES) if (known.re.test(stderr)) return known.message;
  return null;
}

/**
 * A fixed, actionable error for a known setup failure, or null when `result`
 * doesn't match one. An exit status of 0 (a locked `search`) is left out: the
 * tool itself reported success.
 */
function knownFailureError(label: string, result: ToolResult): Error | null {
  const message = knownFailure(result.stderr);
  if (message === null) return null;
  const status = result.code === 0 ? "" : ` (exit ${String(result.code)})`;
  return new Error(`${label} failed${status}: ${message}`);
}

export class SecretServiceStore implements SecretStore {
  readonly kind = "secret-service";
  readonly command: string;
  private readonly spawnFn: SpawnLike;
  private readonly timeoutMs: number;

  constructor(opts: SecretServiceStoreOptions = {}) {
    if (process.platform !== "linux" && opts.allowAnyPlatform !== true) {
      throw new Error(
        `SecretServiceStore requires Linux (secret-tool / Secret Service); this platform is ${process.platform}. Use selectStore() to pick the platform's secret store.`,
      );
    }
    this.command = opts.command ?? "secret-tool";
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnLike);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    const result = await this.lookup(key);
    try {
      if (result.code === 0) return result.stdout.toString("utf8");
      if (isAbsent(result)) return null;
      throw (
        knownFailureError("secret-service get", result) ??
        toolError("secret-service get", result, [result.stdout.toString("utf8")])
      );
    } finally {
      result.stdout.fill(0);
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertValidStoreKey(key);
    if (typeof value !== "string") throw new Error("secret-service set failed: value must be a string");
    if (Buffer.byteLength(value, "utf8") > SECRET_TOOL_MAX_VALUE_BYTES) {
      throw new Error("secret-service set failed: value too long for secret-tool (8 KiB stdin limit)");
    }
    const valueB64 = Buffer.from(value, "utf8").toString("base64");
    const result = await this.run(
      "set",
      ["store", `--label=agent-auth ${key}`, "service", SECRET_SERVICE_ATTR, "key", key],
      Buffer.from(value, "utf8"),
    );
    result.stdout.fill(0);
    if (result.code !== 0) {
      throw (
        knownFailureError("secret-service set", result) ??
        toolError("secret-service set", result, [value, valueB64])
      );
    }
  }

  async delete(key: string): Promise<boolean> {
    assertValidStoreKey(key);
    const found = await this.lookup(key);
    const existed = found.code === 0;
    const foundText = found.stdout.toString("utf8");
    found.stdout.fill(0);
    if (!existed && !isAbsent(found)) {
      throw knownFailureError("secret-service delete", found) ?? toolError("secret-service delete", found, [foundText]);
    }
    if (!existed) return false;
    const result = await this.run("delete", ["clear", "service", SECRET_SERVICE_ATTR, "key", key]);
    result.stdout.fill(0);
    // Another process may have removed the item between the lookup and the clear.
    if (isAbsent(result)) return false;
    if (result.code !== 0) {
      throw knownFailureError("secret-service delete", result) ?? toolError("secret-service delete", result, [foundText]);
    }
    return true;
  }

  async list(): Promise<string[]> {
    const result = await this.run("list", ["search", "--all", "service", SECRET_SERVICE_ATTR]);
    const stdoutText = result.stdout.toString("utf8");
    result.stdout.fill(0);
    const keys = new Set<string>();
    for (const text of [stdoutText, result.stderr]) {
      for (const line of text.split(/\r?\n/)) {
        const m = /^attribute\.key = (.*)$/.exec(line);
        const candidate = m?.[1]?.trim();
        if (candidate !== undefined && isValidStoreKey(candidate)) keys.add(candidate);
      }
    }
    if (result.code !== 0) {
      // Some secret-tool versions exit 1 when nothing matched.
      const nothing = result.code === 1 && stdoutText.trim() === "" && result.stderr.trim() === "";
      if (!nothing) {
        throw (
          knownFailureError("secret-service list", result) ??
          toolError("secret-service list", result, [...secretLines(stdoutText), ...secretLines(result.stderr)])
        );
      }
    } else if (keys.size === 0) {
      // A locked keyring still lets `search` match our items by their hashed attributes: it exits 0, prints
      // them without attribute.key, and complains on stderr. Report that instead of an empty list.
      const locked = knownFailureError("secret-service list", result);
      if (locked !== null) throw locked;
    }
    return [...keys].sort();
  }

  private lookup(key: string): Promise<ToolResult> {
    return this.run("get", ["lookup", "service", SECRET_SERVICE_ATTR, "key", key]);
  }

  private run(op: string, args: readonly string[], input?: Buffer): Promise<ToolResult> {
    return runTool({
      spawn: this.spawnFn,
      command: this.command,
      args,
      ...(input === undefined ? {} : { input }),
      timeoutMs: this.timeoutMs,
      label: `secret-service ${op}`,
    });
  }
}

/** secret-tool's "nothing matched": exit 1 with no stdout and no stderr. */
function isAbsent(result: ToolResult): boolean {
  return result.code === 1 && result.stdout.length === 0 && result.stderr.trim() === "";
}

/** Values of any `secret = ...` lines, to scrub from error text. */
function secretLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^secret = (.*)$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}
