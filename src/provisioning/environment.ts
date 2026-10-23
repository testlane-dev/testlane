/** Pure child environment construction. Trusted local workers are not sandboxed. */
import path from "node:path";
import { types } from "node:util";
import { absoluteLocalPath, boundedDataString, copyOwnDataRecord, provisioningRefusal } from "./worker-contracts.js";

type Platform = "win32" | "linux" | "darwin";
type Store = "dpapi" | "secret-service" | "keychain-macos";
const COMMON = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "PLAYWRIGHT_BROWSERS_PATH"];
const WINDOWS = ["SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];
const LINUX = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"];
const PATH_VALUES = new Set(["HOME", "PLAYWRIGHT_BROWSERS_PATH", "SystemRoot", "ComSpec", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_RUNTIME_DIR"]);

function localSessionBus(value: string): string {
  const match = /^unix:path=(\/[A-Za-z0-9_./-]{1,1023})(?:,guid=[a-fA-F0-9]{32})?$/.exec(value);
  if (!match || !match[1] || path.posix.normalize(match[1]) !== match[1]) provisioningRefusal();
  return value;
}

/**
 * Copy only explicitly named runtime/OS settings, then derive all broker/temp
 * paths from the parent-owned run directory. runtime is an explicit ordinary
 * own-data snapshot (not the exotic process.env object). No ambient object is spread.
 * This validates data, not directory privacy or native keychain authorization.
 */
export function createBrowserWorkerEnvironment(value: unknown): Readonly<NodeJS.ProcessEnv> {
  const data = copyOwnDataRecord(value, ["platform", "runtime", "runDirectory", "store"]);
  if (!["win32", "linux", "darwin"].includes(data["platform"] as string)) provisioningRefusal();
  const platform = data["platform"] as Platform, store = data["store"] as Store;
  if (store !== ({ win32: "dpapi", linux: "secret-service", darwin: "keychain-macos" } as const)[platform]) provisioningRefusal();
  const root = absoluteLocalPath(data["runDirectory"]), runtime = data["runtime"];
  if (runtime === null || typeof runtime !== "object" || types.isProxy(runtime) || Object.getPrototypeOf(runtime) !== Object.prototype) provisioningRefusal();
  const descriptors = Object.getOwnPropertyDescriptors(runtime), keys = Reflect.ownKeys(descriptors);
  if (keys.length > 512) provisioningRefusal();
  const allowed = [...COMMON, ...(platform === "win32" ? WINDOWS : platform === "linux" ? LINUX : [])];
  const names = new Set<string>(), result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    // Native Windows snapshots include non-identifier names. Unknown names
    // remain unforwarded; still reject ambiguous casing and hostile descriptors.
    if (typeof key !== "string" || key.length < 1 || key.length > 256 || /[\x00-\x1f\x7f]/.test(key)) provisioningRefusal();
    const folded = key.toUpperCase(), field = descriptors[key];
    if (names.has(folded) || !field || !Object.hasOwn(field, "value") || field.enumerable !== true) provisioningRefusal();
    names.add(folded);
    const canonical = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? allowed.find(name => name.toUpperCase() === folded) : undefined;
    if (canonical === undefined || field.value === undefined || field.value === "") continue;
    const text = boundedDataString(field.value as unknown, 8192);
    result[canonical] = PATH_VALUES.has(canonical) ? absoluteLocalPath(text) : canonical === "DBUS_SESSION_BUS_ADDRESS" ? localSessionBus(text) : text;
  }
  if (!result["PATH"] || (platform === "win32" ? !result["SystemRoot"] : !result["HOME"])) provisioningRefusal();
  return Object.freeze({ ...result,
    TESTLANE_HOME: path.join(root, "broker-home"), TESTLANE_PROFILES: path.join(root, "profiles.json"), TESTLANE_STORE: store,
    TESTLANE_REQUESTER: "testlane-disposable-browser", TESTLANE_BROWSER_WORKER_BINDING: path.join(root, "worker-binding.json"),
    TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp"),
    DEBUG: "", PWDEBUG: "", NODE_DEBUG: "", FORCE_COLOR: "0", NODE_DISABLE_COMPILE_CACHE: "1", PLAYWRIGHT_NO_COPY_PROMPT: "1" });
}
