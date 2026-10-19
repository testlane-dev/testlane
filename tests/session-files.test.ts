import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { open as openFile, unlink as unlinkFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SESSION_FILES, SessionFiles, type SessionFileSource } from "../src/session/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

let services: SessionFiles[] = [];
const service = () => { const value = new SessionFiles(); services.push(value); return value; };
const source = (overrides: Partial<SessionFileSource> = {}): SessionFileSource => ({ output: JSON.stringify({ cookies: [], origins: [] }), profile: "app:testing", format: "storage-state", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides });
beforeEach(() => {
  vi.mocked(openFile).mockReset().mockImplementation(fs.open);
  vi.mocked(unlinkFile).mockReset().mockImplementation(fs.unlink);
});
afterEach(async () => {
  vi.mocked(openFile).mockReset().mockImplementation(fs.open);
  vi.mocked(unlinkFile).mockReset().mockImplementation(fs.unlink);
  await Promise.all(services.map(s => s.close()));
  services = [];
  vi.restoreAllMocks();
});

describe("managed session files", () => {
  it("writes distinct create-only files with private POSIX modes and removes only owned ids", async () => {
    const files = service();
    const a = await files.create(async () => source());
    const b = await files.create(async () => source());
    expect(a.id).not.toBe(b.id);
    expect(path.dirname(a.path)).toBe(path.dirname(b.path));
    expect(JSON.parse(await fs.readFile(a.path, "utf8"))).toEqual({ cookies: [], origins: [] });
    if (process.platform !== "win32") {
      expect((await fs.stat(a.path)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(a.path))).mode & 0o777).toBe(0o700);
    }
    expect(await files.release(a.path)).toBe(false);
    expect(await service().release(a.id)).toBe(false);
    expect(await files.release(a.id)).toBe(true);
    expect(await files.release(a.id)).toBe(false);
    await expect(fs.access(a.path)).rejects.toThrow();
    await fs.access(b.path);
    await files.close();
    await expect(fs.access(path.dirname(b.path))).rejects.toThrow();
  });

  it("does not recursively remove a directory substituted for a delivered file", async () => {
    const files = service();
    const receipt = await files.create(async () => source());
    await fs.unlink(receipt.path);
    await fs.mkdir(receipt.path);
    try {
      await expect(files.release(receipt.id)).rejects.toMatchObject({ reason: "file-cleanup-failed" });
      expect((await fs.stat(receipt.path)).isDirectory()).toBe(true);
    } finally { await fs.rmdir(receipt.path); }
    expect(await files.release(receipt.id)).toBe(true);
  });

  it("accepts caller removal and removes the empty directory at shutdown", async () => {
    const files = service();
    const receipt = await files.create(async () => source());
    await fs.unlink(receipt.path);
    expect(await files.release(receipt.id)).toBe(true);
    await files.close();
    await expect(fs.access(path.dirname(receipt.path))).rejects.toThrow();
  });

  it("removes expired files without a client cleanup call", async () => {
    const files = service();
    const receipt = await files.create(async () => source({ expiresAt: new Date(Date.now() + 300).toISOString() }));
    await vi.waitFor(async () => expect(await fs.stat(receipt.path).catch(() => null)).toBeNull(), { timeout: 2_000 });
    expect(await files.release(receipt.id)).toBe(false);
  });

  it("refuses stale and oversized artifacts before creating a file", async () => {
    const files = service();
    await expect(files.create(async () => source({ expiresAt: new Date(0).toISOString() }))).rejects.toThrow(/expired/);
    await expect(files.create(async () => source({ output: "x".repeat(2 * 1024 * 1024 + 1) }))).rejects.toThrow(/limit/);
  });

  it("reserves capacity before concurrent issuers and recovers a slot after release", async () => {
    const files = service();
    let resolve!: () => void;
    const gate = new Promise<void>(done => { resolve = done; });
    const issue = vi.fn(async () => { await gate; return source(); });
    const pending = Array.from({ length: MAX_SESSION_FILES }, () => files.create(issue));
    try {
      await expect(files.create(issue)).rejects.toThrow(/capacity/);
      expect(issue).toHaveBeenCalledTimes(MAX_SESSION_FILES);
    } finally { resolve(); }
    const receipts = await Promise.all(pending);
    await files.release(receipts[0]!.id);
    await files.create(async () => source());
  });

  it("does not wait for a hung issuer on close and discards its late result", async () => {
    const files = service();
    let finish!: (value: SessionFileSource) => void;
    const pending = files.create(() => new Promise(resolve => { finish = resolve; }));
    const failure = expect(pending).rejects.toMatchObject({ reason: "file-closed" });
    await files.close();
    await failure;
    finish(source());
    await new Promise(resolve => setImmediate(resolve));
    expect(openFile).not.toHaveBeenCalled();
  });

  it("refuses an already cancelled request before sign-in and never writes a late cancelled result", async () => {
    const files = service();
    const controller = new AbortController();
    controller.abort();
    const issue = vi.fn(async () => source());
    await expect(files.create(issue, controller.signal)).rejects.toMatchObject({ reason: "file-cancelled" });
    expect(issue).not.toHaveBeenCalled();
    const active = new AbortController();
    let finish!: (value: SessionFileSource) => void;
    const pending = files.create(() => new Promise(resolve => { finish = resolve; }), active.signal);
    const failure = expect(pending).rejects.toMatchObject({ reason: "file-cancelled" });
    active.abort();
    await failure;
    finish(source());
    await new Promise(resolve => setImmediate(resolve));
    expect(openFile).not.toHaveBeenCalled();
    // Cancellation affects only this request, and frees its reserved slot.
    await files.create(async () => source());
  });

  it("cleans a file cancelled while the write is in progress", async () => {
    const files = service();
    const controller = new AbortController();
    let finish!: () => void;
    let started!: () => void;
    let artifactPath = "";
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(openFile).mockImplementationOnce(async (...args) => {
      artifactPath = String(args[0]);
      const handle = await fs.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data, options) => {
        await write(data, options);
        started();
        await gate;
      });
      return handle;
    });
    const pending = files.create(async () => source(), controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ reason: "file-cancelled" });
    await writing;
    controller.abort();
    finish();
    await failure;
    await expect(fs.access(artifactPath)).rejects.toThrow();
  });

  it("retains ownership after a partial write and failed unlink, and retries a failed close", async () => {
    const files = service();
    const token = randomBytes(24).toString("base64url");
    let artifactPath = "";
    vi.mocked(openFile).mockImplementationOnce(async (...args) => {
      artifactPath = String(args[0]);
      const handle = await fs.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data, options) => {
        await write(data, options);
        throw new Error(token);
      });
      return handle;
    });
    const denied = Object.assign(new Error(token), { code: "EACCES" });
    vi.mocked(unlinkFile).mockRejectedValueOnce(denied).mockRejectedValueOnce(denied);
    const failure = await files.create(async () => source({ output: token })).catch(error => error as Error);
    expect(failure).toMatchObject({ reason: "file-cleanup-failed" });
    expect(String(failure)).not.toContain(token);
    expect(await fs.readFile(artifactPath, "utf8")).toContain(token);
    await expect(files.close()).rejects.toMatchObject({ reason: "file-cleanup-failed" });
    await files.close();
    await expect(fs.access(artifactPath)).rejects.toThrow();
    await expect(fs.access(path.dirname(artifactPath))).rejects.toThrow();
    await expect(files.create(async () => source())).rejects.toMatchObject({ reason: "file-closed" });
  });

  it("closes during an in-flight sign-in without delivering a file", async () => {
    const files = service();
    let resolve!: (value: SessionFileSource) => void;
    const pending = files.create(() => new Promise(done => { resolve = done; }));
    const failure = expect(pending).rejects.toThrow(/closed/);
    const close = files.close();
    resolve(source());
    await failure;
    await close;
    await expect(files.create(async () => source())).rejects.toThrow(/closed/);
  });
});
