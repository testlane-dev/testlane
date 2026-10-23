import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { assertBrowserPrivateDirectory, createBrowserPrivateDirectory } from "../src/provisioning/private-directory.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>(); return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const parent = await realpath(process.platform === "win32" ? process.env["LOCALAPPDATA"]! : os.tmpdir()), root = await mkdtemp(path.join(parent, "tl-browser-io-"));
  return { root, async close() {
    expect(path.dirname(await realpath(root))).toBe(parent);
    for (const name of await readdir(root)) {
      const file = path.join(root, name), info = await lstat(file);
      if (info.isDirectory()) {
        for (const child of await readdir(file)) {
          const nested = path.join(file, child), nestedInfo = await lstat(nested);
          if (nestedInfo.isDirectory() && !nestedInfo.isSymbolicLink()) {
            expect(name).toBe("parent"); expect(child).toBe("quoted '$() ; child");
            expect(await readdir(nested)).toEqual([]); await rmdir(nested);
          } else await unlink(nested);
        }
        await rmdir(file);
      } else if (info.isSymbolicLink()) await rmdir(file);
      else await unlink(file);
    }
    await rmdir(root);
  } };
}
const script = String.raw`$ErrorActionPreference='Stop';try{$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$d=New-Object IO.DirectoryInfo([string]$r.path);$a=$d.GetAccessControl();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;if($r.operation -eq 'inspect'){$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));[Console]::Out.Write(($a.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and -not $rules[0].IsInherited).ToString().ToLowerInvariant())}else{$e=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute;if($r.operation -eq 'unsafe'){$rights=[Security.AccessControl.FileSystemRights]::FullControl};$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($e,$rights,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)));$d.SetAccessControl($a);[Console]::Out.Write('done')};exit 0}catch{exit 1}`;
function windowsFixture(root: string, file: string, operation: "inspect" | "read" | "unsafe") {
  expect(path.dirname(file)).toBe(root);
  return execFileSync(path.join(process.env["SystemRoot"]!, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { input: JSON.stringify({ path: file, operation }), encoding: "utf8", timeout: 15000, windowsHide: true });
}

it("creates a private child under a read-accessible parent and never repairs an existing directory", async () => {
  const f = await fixture();
  try {
    const parent = path.join(f.root, "parent"); await mkdir(parent, { mode: 0o755 });
    if (process.platform === "win32") expect(windowsFixture(f.root, parent, "read")).toBe("done");
    const child = path.join(parent, "quoted '$() ; child");
    await expect(createBrowserPrivateDirectory(child)).resolves.toBe(child);
    await expect(assertBrowserPrivateDirectory(child)).resolves.toBe(child);
    if (process.platform === "win32") {
      // Independent .NET inspection of the actual resulting DACL.
      expect(windowsFixture(parent, child, "inspect")).toBe("true");
      expect(windowsFixture(parent, child, "read")).toBe("done");
    } else { expect((await lstat(child)).mode & 0o7777).toBe(0o700); await chmod(child, 0o750); }
    await expect(assertBrowserPrivateDirectory(child)).rejects.toThrow("BROWSER_PRIVATE_DIRECTORY_REFUSED");
    const before = await lstat(child);
    await expect(createBrowserPrivateDirectory(child)).rejects.toThrow("BROWSER_PRIVATE_DIRECTORY_EXISTS");
    expect((await lstat(child)).mode).toBe(before.mode);
    await rmdir(child);
  } finally { await f.close(); }
});

it("refuses unsafe parents and directory aliases before allocation", async () => {
  const f = await fixture();
  try {
    const actual = path.join(f.root, "actual"), alias = path.join(f.root, "alias"); await mkdir(actual);
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(createBrowserPrivateDirectory(path.join(alias, "child"))).rejects.toThrow("BROWSER_PRIVATE_DIRECTORY_REFUSED");
    await expect(lstat(path.join(actual, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform === "win32") expect(windowsFixture(f.root, actual, "unsafe")).toBe("done"); else await chmod(actual, 0o777);
    await expect(createBrowserPrivateDirectory(path.join(actual, "child"))).rejects.toThrow("BROWSER_PRIVATE_DIRECTORY_REFUSED");
    await expect(lstat(path.join(actual, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    await rmdir(alias);
  } finally { await f.close(); }
});

it("pre-cancelled creation allocates nothing and fixed errors contain no supplied path", async () => {
  const f = await fixture();
  try {
    const canary = randomUUID(), file = path.join(f.root, canary), controller = new AbortController(); controller.abort(Error(canary));
    let caught: unknown;
    try { await createBrowserPrivateDirectory(file, { signal: controller.signal }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error); expect((caught as Error).message).toBe("BROWSER_CANCELLED");
    expect((caught as Error).stack).not.toContain(canary); await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

function fakeChild(throwListener = false) {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new EventEmitter(), stderr = new EventEmitter();
  Object.assign(stdout, { destroy: vi.fn() }); Object.assign(stderr, { destroy: vi.fn() });
  if (throwListener) stdout.on = (() => { throw Error("private-synthetic-canary"); }) as typeof stdout.on;
  Object.assign(child, { stdin: { on: vi.fn(), end: vi.fn(), destroy: vi.fn() }, stdout, stderr, kill: vi.fn(() => true), unref: vi.fn() });
  return child;
}
it.skipIf(process.platform !== "win32")("a post-spawn setup exception must join the retained child before refusing", async () => {
  const f = await fixture(), child = fakeChild(true); let settled = false;
  try {
    vi.mocked(spawn).mockImplementationOnce(() => child);
    const operation = createBrowserPrivateDirectory(path.join(f.root, "absent")).finally(() => { settled = true; });
    const result = operation.catch(error => error as Error);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce()); expect(settled).toBe(false);
    child.emit("close", null); const error = await result;
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("BROWSER_PRIVATE_DIRECTORY_REFUSED");
    expect((error as Error).stack).not.toContain("private-synthetic-canary");
  } finally { await f.close(); }
});
it.skipIf(process.platform !== "win32")("abort at spawn destroys input without sending an operation and joins close", async () => {
  const f = await fixture(), child = fakeChild(), controller = new AbortController();
  try {
    vi.mocked(spawn).mockImplementationOnce(() => { controller.abort(); return child; });
    const result = createBrowserPrivateDirectory(path.join(f.root, "absent"), { signal: controller.signal }).catch(error => error as Error);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce()); expect(child.stdin!.end).not.toHaveBeenCalled();
    child.emit("close", null); expect((await result as Error).message).toBe("BROWSER_CANCELLED");
  } finally { await f.close(); }
});

it("directory options are own data and genuine signals without getter or proxy evaluation", async () => {
  const f = await fixture(); let reads = 0;
  try {
    const child = path.join(f.root, "absent"), controller = new AbortController();
    const getter = Object.defineProperty({}, "signal", { enumerable: true, get() { reads++; throw Error("synthetic-private-canary"); } });
    const proxy = new Proxy({}, { ownKeys() { reads++; throw Error("synthetic-private-canary"); } });
    for (const options of [getter, proxy, { signal: Object.create(AbortSignal.prototype) }, { signal: new Proxy(controller.signal, { get() { reads++; throw Error("synthetic-private-canary"); } }) }]) {
      await expect(createBrowserPrivateDirectory(child, options)).rejects.toThrow("BROWSER_PRIVATE_DIRECTORY_REFUSED");
      await expect(assertBrowserPrivateDirectory(f.root, options)).rejects.toThrow("BROWSER_PRIVATE_DIRECTORY_REFUSED");
    }
    expect(reads).toBe(0); await expect(lstat(child)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await createBrowserPrivateDirectory(child, { signal: undefined })).toBe(child);
  } finally { await f.close(); }
});
