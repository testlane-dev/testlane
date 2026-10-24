import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, realpath, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createBrowserPrivateDirectory } from "../src/provisioning/private-directory.js";
import { createBrowserWorkerBinding, type BrowserWorkerBinding } from "../src/provisioning/worker-contracts.js";
import { BROWSER_WORKER_BINDING_ENV, loadBrowserWorkerBinding, requestBrowserRunRevocation, readBrowserBarrierFile } from "../src/provisioning/worker-io.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, open: vi.fn(actual.open) };
});
let parent: string;
beforeAll(async () => { parent = await createBrowserPrivateDirectory(path.join(await realpath(process.platform === "win32" ? process.env["LOCALAPPDATA"]! : os.tmpdir()), "tl-worker-io-" + randomUUID())); });
afterAll(async () => { if (!parent) return; expect(await readdir(parent)).toEqual([]); await rmdir(parent); });
async function fixture() {
  const runId = randomUUID(), root = await createBrowserPrivateDirectory(path.join(parent, runId));
  const revocation = await createBrowserPrivateDirectory(path.join(root, "revocation"));
  const now = Date.now(), value = createBrowserWorkerBinding({ targetId: randomUUID(), runId, expiresAt: now + 600000,
    cliPath: path.join(parent, "installed", "dist", "cli.js"), baseURL: "http://127.0.0.1:4555", runDirectory: root, nonce: "a".repeat(48) }, now);
  const file = path.join(root, "worker-binding.json"), request = path.join(revocation, "request.json"), response = path.join(revocation, "response.json");
  await writeFile(file, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  return { root, revocation, value, file, request, response,
    async load() { return loadBrowserWorkerBinding(file); },
    async close() {
      vi.restoreAllMocks();
      // Remove only this fixture's finite named files, never recursive trees.
      for (const dir of [revocation, root]) for (const name of await readdir(dir)) {
        if (name === "revocation") continue;
        expect(["request.json", "response.json", "worker-binding.json", "binding-original.json", "link.json"]).toContain(name);
        await unlink(path.join(dir, name));
      }
      await rmdir(revocation); await rmdir(root);
    },
  };
}
async function caught(operation: Promise<unknown>): Promise<Error> { try { await operation; } catch (error) { return error as Error; } throw Error("TEST_EXPECTED_REFUSAL"); }
async function waitRequest(file: string): Promise<Record<string, unknown>> {
  const deadline = performance.now() + 15000;
  for (;;) {
    let text = "";
    try { text = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (text.endsWith("\n")) return JSON.parse(text) as Record<string, unknown>;
    if (performance.now() >= deadline) throw Error("TEST_REQUEST_NOT_OBSERVED"); await pause(10);
  }
}
async function respond(f: Awaited<ReturnType<typeof fixture>>, request: Record<string, unknown>, status: "success" | "failed", extra = {}) {
  const handle = await open(f.response, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ ...request, status, ...extra }) + "\n"); await handle.sync(); } finally { await handle.close(); }
}

it("loads only a run-owned private binding, including the explicit environment entry", async () => {
  const f = await fixture(), old = process.env[BROWSER_WORKER_BINDING_ENV];
  try {
    process.env[BROWSER_WORKER_BINDING_ENV] = f.file;
    const binding = await loadBrowserWorkerBinding(); expect(binding).toEqual(f.value); expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding).sort()).toEqual(["expiresAt", "fixture", "revocation", "runId", "schemaVersion", "targetId"]);
    await expect(loadBrowserWorkerBinding("./worker-binding.json")).rejects.toThrow("BROWSER_ACCOUNT_BINDING_REFUSED");
    await expect(loadBrowserWorkerBinding(path.join(f.root, "other.json"))).rejects.toThrow("BROWSER_ACCOUNT_BINDING_REFUSED");
    expect(await readdir(f.revocation)).toEqual([]);
  } finally { if (old === undefined) delete process.env[BROWSER_WORKER_BINDING_ENV]; else process.env[BROWSER_WORKER_BINDING_ENV] = old; await f.close(); }
});

it("refuses hardlinked or symlinked binding files and another run's revocation directory", async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, "link.json"); await link(f.file, alias);
    await expect(f.load()).rejects.toThrow("BROWSER_ACCOUNT_BINDING_REFUSED"); await unlink(alias);
    const original = path.join(f.root, "binding-original.json"); await rename(f.file, original); await symlink(original, f.file, "file");
    await expect(f.load()).rejects.toThrow("BROWSER_ACCOUNT_BINDING_REFUSED"); await unlink(f.file); await rename(original, f.file);
    await writeFile(f.file, JSON.stringify({ ...f.value, revocation: { ...f.value.revocation, directory: parent } }), { mode: 0o600 });
    await expect(f.load()).rejects.toThrow("BROWSER_ACCOUNT_BINDING_REFUSED"); expect(await readdir(f.revocation)).toEqual([]);
  } finally { await f.close(); }
});

it("refuses bounded malformed/oversized binding bytes without copying raw or encoded canaries", async () => {
  const f = await fixture(), canary = "synthetic-private-canary/+=?" + randomUUID();
  try {
    for (const text of [JSON.stringify({ ...f.value, password: canary }), "x".repeat(16385), "{\"secret\":", JSON.stringify({ ...f.value, expiresAt: 0 })]) {
      await writeFile(f.file, text, { mode: 0o600 }); const error = await caught(f.load());
      expect(error.message).toBe("BROWSER_ACCOUNT_BINDING_REFUSED");
      for (const secret of [canary, encodeURIComponent(canary), Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("base64url"), f.file]) expect(error.stack).not.toContain(secret);
    }
  } finally { await f.close(); }
});

it("one genuine binding publishes one fixed request and repeated calls join verified success", async () => {
  const f = await fixture();
  try {
    const binding = await f.load(), operation = requestBrowserRunRevocation(binding);
    expect(requestBrowserRunRevocation(binding)).toBe(operation);
    const request = await waitRequest(f.request);
    expect(request).toEqual({ schemaVersion: 1, targetId: binding.targetId, runId: binding.runId, expiresAt: binding.expiresAt, nonce: binding.revocation.nonce });
    await respond(f, request, "success"); expect(await operation).toEqual({ status: "success" });
    expect(requestBrowserRunRevocation(binding)).toBe(operation);
    const before = await readFile(f.request); await expect(requestBrowserRunRevocation(await f.load())).rejects.toThrow("BROWSER_REVOCATION_REFUSED");
    expect(await readFile(f.request)).toEqual(before);
  } finally { await f.close(); }
});

it("an in-progress exclusive response is not accepted before its LF commit", async () => {
  const f = await fixture();
  try {
    const binding = await f.load(); let settled = false;
    const operation = requestBrowserRunRevocation(binding).finally(() => { settled = true; });
    const request = await waitRequest(f.request), response = JSON.stringify({ ...request, status: "success" }) + "\n";
    const handle = await open(f.response, "wx", 0o600);
    try { await pause(75); expect(settled).toBe(false); expect(await readBrowserBarrierFile(f.response)).toBeUndefined(); await handle.writeFile(response.slice(0, 10)); await pause(75); expect(settled).toBe(false); await handle.writeFile(response.slice(10)); await handle.sync(); }
    finally { await handle.close(); }
    expect(await operation).toEqual({ status: "success" });
  } finally { await f.close(); }
});

it("a same-run failed acknowledgement and a foreign or extra-field reply remain fixed failures", async () => {
  for (const mode of ["failed", "foreign", "extra"] as const) {
    const f = await fixture();
    try {
      const operation = requestBrowserRunRevocation(await f.load()), outcome = operation.catch(error => error as Error);
      const request = await waitRequest(f.request);
      await respond(f, request, mode === "failed" ? "failed" : "success", mode === "foreign" ? { runId: randomUUID() } : mode === "extra" ? { raw: "synthetic-private-canary" } : {});
      const error = await outcome as Error; expect(error.message).toBe(mode === "failed" ? "BROWSER_REVOCATION_FAILED" : "BROWSER_REVOCATION_REFUSED");
      expect(error.stack).not.toContain("synthetic-private-canary"); expect(error.stack).not.toContain(f.response);
    } finally { await f.close(); }
  }
});

it("pre-existing barrier files are never overwritten and plain/proxy bindings acquire no authority", async () => {
  const f = await fixture();
  try {
    let reads = 0; const proxy = new Proxy(f.value, { get() { reads++; throw Error("synthetic-private-canary"); } });
    await expect(requestBrowserRunRevocation(f.value)).rejects.toThrow("BROWSER_REVOCATION_REFUSED");
    await expect(requestBrowserRunRevocation(proxy as BrowserWorkerBinding)).rejects.toThrow("BROWSER_REVOCATION_REFUSED"); expect(reads).toBe(0);
    await writeFile(f.response, "foreign-existing-record\n", { flag: "wx", mode: 0o600 });
    await expect(requestBrowserRunRevocation(await f.load())).rejects.toThrow("BROWSER_REVOCATION_REFUSED");
    expect(await readFile(f.response, "utf8")).toBe("foreign-existing-record\n"); await expect(lstat(f.request)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

it("cancellation retains the one request, ignores raw abort reasons and cannot retry", async () => {
  const f = await fixture();
  try {
    const binding = await f.load(), controller = new AbortController();
    const operation = requestBrowserRunRevocation(binding, { signal: controller.signal }), outcome = operation.catch(error => error as Error);
    await waitRequest(f.request); const bytes = await readFile(f.request); let reads = 0;
    Object.defineProperty(controller.signal, "aborted", { get() { reads++; throw Error("synthetic-private-canary"); } });
    controller.abort(Error("synthetic-private-canary"));
    const error = await outcome as Error; expect(error.message).toBe("BROWSER_CANCELLED"); expect(error.stack).not.toContain("synthetic-private-canary"); expect(reads).toBe(0);
    expect(requestBrowserRunRevocation(binding)).toBe(operation); expect(await readFile(f.request)).toEqual(bytes);
  } finally { await f.close(); }
});

it("a changed binding or replaced revocation directory cannot inherit loaded write authority", async () => {
  const f = await fixture();
  try {
    const binding = await f.load(); await writeFile(f.file, JSON.stringify({ ...f.value, revocation: { ...f.value.revocation, nonce: "b".repeat(48) } }), { mode: 0o600 });
    await expect(requestBrowserRunRevocation(binding)).rejects.toThrow("BROWSER_REVOCATION_REFUSED"); await expect(lstat(f.request)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(f.file, JSON.stringify(f.value), { mode: 0o600 }); const second = await f.load();
    const moved = path.join(f.root, "revocation-old"); await rename(f.revocation, moved);
    try { await createBrowserPrivateDirectory(f.revocation); await expect(requestBrowserRunRevocation(second)).rejects.toThrow("BROWSER_REVOCATION_REFUSED"); await rmdir(f.revocation); }
    finally { await rename(moved, f.revocation); }
  } finally { await f.close(); }
});

it("expiry before acknowledgement cannot convert a valid fixed response into success", async () => {
  const f = await fixture();
  try {
    const binding = await f.load(), operation = requestBrowserRunRevocation(binding), outcome = operation.catch(error => error as Error);
    const request = await waitRequest(f.request); await respond(f, request, "success");
    vi.spyOn(Date, "now").mockReturnValue(binding.expiresAt + 1);
    expect((await outcome as Error).message).toBe("BROWSER_REVOCATION_TIMEOUT");
  } finally { await f.close(); }
});

it("a bounded read overlapping a real exclusive write stays pending until a stable final record", async () => {
  const f = await fixture();
  try {
    const text = JSON.stringify({ ...f.value.revocation, status: "success" }) + "\n";
    const writer = await open(f.response, "wx", 0o600);
    try {
      await writer.writeFile(text.slice(0, 5));
      const actualOpen = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actualOpen.open(...args), originalRead = handle.read.bind(handle); let first = true;
        handle.read = (async (...readArgs: unknown[]) => {
          if (first) { first = false; await writer.writeFile(text.slice(5)); await writer.sync(); }
          return Reflect.apply(originalRead, handle, readArgs);
        }) as typeof handle.read;
        return handle;
      });
      expect(await readBrowserBarrierFile(f.response)).toBeUndefined();
      expect((await readBrowserBarrierFile(f.response))?.bytes.toString()).toBe(text);
    } finally { await writer.close(); }
    await link(f.response, path.join(f.root, "link.json"));
    await expect(readBrowserBarrierFile(f.response)).rejects.toThrow("BROWSER_REVOCATION_REFUSED");
  } finally { await f.close(); }
});

it("request options and signals reject accessors, proxies and forgeries without invoking them", async () => {
  const f = await fixture(); let reads = 0;
  try {
    const binding = await f.load(), getter = Object.defineProperty({}, "signal", { enumerable: true, get() { reads++; throw Error("synthetic-private-canary"); } });
    const proxy = new Proxy({}, { ownKeys() { reads++; throw Error("synthetic-private-canary"); } });
    const controller = new AbortController();
    const shadowed = new AbortController().signal;
    Object.defineProperty(shadowed, "aborted", { get() { reads++; throw Error("synthetic-private-canary"); } });
    for (const options of [getter, proxy, { signal: shadowed }, { signal: Object.create(AbortSignal.prototype) }, { signal: new Proxy(controller.signal, { get() { reads++; throw Error("synthetic-private-canary"); } }) }]) {
      const error = await caught(requestBrowserRunRevocation(binding, options));
      expect(error.message).toBe("BROWSER_REVOCATION_REFUSED"); expect(error.stack).not.toContain("synthetic-private-canary");
    }
    expect(reads).toBe(0); expect(await readdir(f.revocation)).toEqual([]);
    controller.abort(Error("synthetic-private-canary"));
    expect((await caught(requestBrowserRunRevocation(binding, { signal: controller.signal }))).message).toBe("BROWSER_CANCELLED");
    expect(await readdir(f.revocation)).toEqual([]);
  } finally { await f.close(); }
});
