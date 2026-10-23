import path from "node:path";
import { expect, it } from "vitest";
import { createBrowserWorkerEnvironment } from "../src/provisioning/environment.js";

const base = path.join(path.parse(process.cwd()).root, "private-synthetic-run");
const runtime = () => ({ PATH: path.join(base, "bin"), HOME: base, SystemRoot: path.parse(process.cwd()).root });
const input = () => ({ platform: "win32", runtime: runtime(), runDirectory: base, store: "dpapi" });
const refused = (operation: () => unknown) => expect(operation).toThrow(/^BROWSER_ACCOUNT_BINDING_REFUSED$/);

it("copies only the allowlisted OS snapshot and derives all owned paths consistently", () => {
  const source = { ...runtime(), "SyntheticRuntime(x86)": "private-synthetic-canary", PathIgnored: "private-synthetic-canary", APP_API_KEY: "private-synthetic-canary", AWS_SECRET_ACCESS_KEY: "private-synthetic-canary", HTTPS_PROXY: "private-synthetic-canary", NODE_OPTIONS: "private-synthetic-canary", NODE_PATH: "private-synthetic-canary", npm_config_registry: "private-synthetic-canary", TESTLANE_HOME: "private-synthetic-canary", AGENT_AUTH_HOME: "private-synthetic-canary", DEBUG: "private-synthetic-canary" };
  const result = createBrowserWorkerEnvironment({ ...input(), runtime: source });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.keys(result).sort()).toEqual(["PATH", "HOME", "SystemRoot", "TESTLANE_HOME", "TESTLANE_PROFILES", "TESTLANE_STORE", "TESTLANE_REQUESTER", "TESTLANE_BROWSER_WORKER_BINDING", "TMP", "TEMP", "TMPDIR", "DEBUG", "PWDEBUG", "NODE_DEBUG", "FORCE_COLOR", "NODE_DISABLE_COMPILE_CACHE", "PLAYWRIGHT_NO_COPY_PROMPT"].sort());
  expect(JSON.stringify(result).includes("private-synthetic-canary")).toBe(false);
  expect(result["TESTLANE_HOME"]).toBe(path.join(base, "broker-home")); expect(result["TESTLANE_PROFILES"]).toBe(path.join(base, "profiles.json"));
  expect(result["TESTLANE_BROWSER_WORKER_BINDING"]).toBe(path.join(base, "worker-binding.json"));
  expect(result["TMP"]).toBe(result["TEMP"]); expect(result["TEMP"]).toBe(result["TMPDIR"]);
  source.PATH = "changed"; expect(result["PATH"]).not.toBe("changed");
});

it("normalizes casing but refuses case-insensitive duplicates before selecting values", () => {
  const result = createBrowserWorkerEnvironment({ ...input(), runtime: { path: runtime().PATH, systemroot: runtime().SystemRoot } });
  expect(Object.hasOwn(result, "PATH")).toBe(true); expect(Object.hasOwn(result, "path")).toBe(false);
  refused(() => createBrowserWorkerEnvironment({ ...input(), runtime: { ...runtime(), Path: "other" } }));
  refused(() => createBrowserWorkerEnvironment({ ...input(), runtime: { ...runtime(), APP_KEY: "one", app_key: "two" } }));
});

it("does not promote Unicode confusable environment names into the ASCII allowlist", () => {
  refused(() => createBrowserWorkerEnvironment({ ...input(), runtime: { PATH: runtime().PATH, "\u017fystemroot": runtime().SystemRoot } }));
  const result = createBrowserWorkerEnvironment({ ...input(), runtime: { path: runtime().PATH, systemroot: runtime().SystemRoot, "NativeRuntime(x86)": "private-synthetic-canary" } });
  expect(Object.hasOwn(result, "SystemRoot") && Object.hasOwn(result, "PATH")).toBe(true);
  expect(Object.hasOwn(result, "NativeRuntime(x86)")).toBe(false);
});

it("keeps native-store selection platform-specific with no inherited legacy aliases", () => {
  for (const [platform, store] of [["linux", "secret-service"], ["darwin", "keychain-macos"]]) {
    const result = createBrowserWorkerEnvironment({ ...input(), platform, store, runtime: { ...runtime(), DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus", AGENT_AUTH_STORE: "other" } });
    expect(result["TESTLANE_STORE"]).toBe(store); expect(Object.hasOwn(result, "AGENT_AUTH_STORE")).toBe(false);
    expect(Object.hasOwn(result, "SystemRoot")).toBe(false);
    expect(Object.hasOwn(result, "DBUS_SESSION_BUS_ADDRESS")).toBe(platform === "linux");
  }
  refused(() => createBrowserWorkerEnvironment({ ...input(), store: "secret-service" }));
  refused(() => createBrowserWorkerEnvironment({ ...input(), platform: "freebsd" }));
});

it("admits a single Unix session-bus path without asserting socket ownership", () => {
  for (const address of ["unix:path=/run/user/1000/bus", "unix:path=/tmp/private-synthetic/bus,guid=" + "a".repeat(32)]) {
    const result = createBrowserWorkerEnvironment({ ...input(), platform: "linux", store: "secret-service", runtime: { ...runtime(), DBUS_SESSION_BUS_ADDRESS: address } });
    expect(result["DBUS_SESSION_BUS_ADDRESS"] === address).toBe(true);
  }
  for (const address of ["tcp:host=127.0.0.1,port=4555", "nonce-tcp:host=127.0.0.1,port=4555", "autolaunch:", "unix:path=/tmp/bus;tcp:host=other", "unix:path=/tmp/bus,unknown=private-synthetic-canary", "unix:path=/tmp/../bus", "unix:path=/tmp/bus\nprivate-synthetic-canary"]) refused(() => createBrowserWorkerEnvironment({ ...input(), platform: "linux", store: "secret-service", runtime: { ...runtime(), DBUS_SESSION_BUS_ADDRESS: address } }));
});

it("refuses hostile descriptors/proxies/noncanonical paths without evaluating them", () => {
  let invoked = false;
  const getter = { ...runtime() }; Object.defineProperty(getter, "APP_API_KEY", { enumerable: true, get() { invoked = true; throw Error("private-synthetic-canary"); } });
  const proxy = new Proxy(runtime(), { getPrototypeOf() { invoked = true; throw Error("private-synthetic-canary"); } });
  for (const candidate of [getter, proxy, { ...runtime(), PATH: { toString() { invoked = true; return "private-synthetic-canary"; } } }, { ...runtime(), [Symbol("private")]: "private-synthetic-canary" }]) refused(() => createBrowserWorkerEnvironment({ ...input(), runtime: candidate }));
  refused(() => createBrowserWorkerEnvironment({ ...input(), runDirectory: "./private" }));
  refused(() => createBrowserWorkerEnvironment({ ...input(), runtime: {} }));
  expect(invoked).toBe(false);
});

it("accepts a trusted own-data snapshot of the actual native environment without exposing its contents", () => {
  // process.env itself has an exotic native prototype on supported Node builds.
  // Copy descriptors, not values through getters, into the explicit parent input.
  const descriptors = Object.getOwnPropertyDescriptors(process.env);
  expect(Reflect.ownKeys(descriptors).every(key => typeof key === "string" && descriptors[key] !== undefined && Object.hasOwn(descriptors[key], "value"))).toBe(true);
  const snapshot = Object.defineProperties({}, descriptors);
  const platform = process.platform;
  expect(["win32", "linux", "darwin"].includes(platform)).toBe(true);
  const store = platform === "win32" ? "dpapi" : platform === "linux" ? "secret-service" : "keychain-macos";
  const result = createBrowserWorkerEnvironment({ platform, store, runtime: snapshot, runDirectory: base });
  // Assert booleans only: no native environment value is printed or persisted.
  expect(typeof result["PATH"] === "string").toBe(true);
  expect(platform === "win32" ? typeof result["SystemRoot"] === "string" : typeof result["HOME"] === "string").toBe(true);
  expect(["NODE_OPTIONS", "NODE_PATH", "HTTPS_PROXY", "HTTP_PROXY", "AGENT_AUTH_HOME", "AGENT_AUTH_PROFILES"].some(key => Object.hasOwn(result, key))).toBe(false);
});
