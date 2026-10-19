import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redactor, redactor, safeError } from "../src/redact.js";

const hex = (): string => randomBytes(8).toString("hex");
const throwaway = (): string => `throwaway-${hex()}`;

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env["TESTLANE_HOME"];
  home = await mkdtemp(path.join(os.tmpdir(), "testlane-redact-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("Redactor.redact", () => {
  it("scrubs a plain occurrence", () => {
    const r = new Redactor();
    const secret = throwaway();
    r.register(secret);
    expect(r.count).toBe(1);
    const out = r.redact(`before ${secret} middle ${secret} after`);
    expect(out).toBe("before [REDACTED] middle [REDACTED] after");
  });

  it("scrubs the JSON-escaped form (quote and backslash)", () => {
    const r = new Redactor();
    const secret = `throw"away\\${hex()}`;
    r.register(secret);
    const json = JSON.stringify({ password: secret });
    expect(json).not.toContain(secret);
    const out = r.redact(json);
    expect(out).toBe('{"password":"[REDACTED]"}');
  });

  it("scrubs the URL-encoded forms (spaces and &)", () => {
    const r = new Redactor();
    const secret = `throw away & ${hex()}`;
    r.register(secret);
    const query = `user=a&pw=${encodeURIComponent(secret)}&x=1`;
    expect(r.redact(query)).toBe("user=a&pw=[REDACTED]&x=1");
    const form = new URLSearchParams({ pw: secret }).toString();
    expect(r.redact(form)).toBe("pw=[REDACTED]");
  });

  it("scrubs base64 and base64url forms", () => {
    const r = new Redactor();
    const secret = `throwaway-${randomBytes(12).toString("base64")}`;
    r.register(secret);
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const b64url = Buffer.from(secret, "utf8").toString("base64url");
    expect(r.redact(`Authorization: Basic ${b64}`)).toBe("Authorization: Basic [REDACTED]");
    expect(r.redact(`t=${b64url}`)).toBe("t=[REDACTED]");
  });

  it("handles multiple secrets where one is a substring of another", () => {
    const r = new Redactor();
    const short = throwaway();
    const long = `${short}-longer-${hex()}`;
    const other = throwaway();
    r.register(short);
    r.register(long);
    r.register(other);
    expect(r.count).toBe(3);
    const out = r.redact(`a=${long} b=${short} c=${other}`);
    expect(out).toBe("a=[REDACTED] b=[REDACTED] c=[REDACTED]");
    expect(out).not.toContain("longer");
  });

  it("ignores values shorter than 4 chars, null and undefined", () => {
    const r = new Redactor();
    r.register("abc");
    r.register("");
    r.register(null);
    r.register(undefined);
    expect(r.count).toBe(0);
    expect(r.redact("abc abc")).toBe("abc abc");
  });

  it("treats regex metacharacters literally", () => {
    const r = new Redactor();
    const secret = `a.*+?(${hex()})[x]`;
    r.register(secret);
    expect(r.redact(`aXXX ${secret}`)).toBe("aXXX [REDACTED]");
  });
});

describe("Redactor.install", () => {
  it("scrubs strings and Buffers written to stdout and restores on uninstall", () => {
    const realWrite = process.stdout.write;
    const spy = vi.fn((..._args: unknown[]) => true);
    process.stdout.write = spy as unknown as typeof process.stdout.write;
    try {
      const r = new Redactor();
      const secret = throwaway();
      r.register(secret);
      const uninstall = r.install({ stdout: process.stdout });
      expect(process.stdout.write).not.toBe(spy);

      const cb = (): void => {};
      const ret = process.stdout.write(`value=${secret}\n`, "utf8", cb);
      expect(ret).toBe(true);
      expect(spy).toHaveBeenLastCalledWith("value=[REDACTED]\n", "utf8", cb);

      process.stdout.write(Buffer.from(`buf ${secret}`, "utf8"));
      const bufArg = spy.mock.calls.at(-1)?.[0];
      expect(Buffer.isBuffer(bufArg)).toBe(true);
      expect((bufArg as Buffer).toString("utf8")).toBe("buf [REDACTED]");

      const hexChunk = Buffer.from(`hex ${secret}`, "utf8").toString("hex");
      process.stdout.write(hexChunk, "hex");
      const hexArg = spy.mock.calls.at(-1)?.[0];
      expect(Buffer.from(hexArg as Buffer).toString("utf8")).toBe("hex [REDACTED]");

      const clean = Buffer.from("nothing to hide", "utf8");
      process.stdout.write(clean);
      expect(spy.mock.calls.at(-1)?.[0]).toBe(clean);

      for (const call of spy.mock.calls) {
        const chunk = call[0];
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString("utf8");
        expect(text).not.toContain(secret);
      }

      uninstall();
      expect(process.stdout.write).toBe(spy);
      process.stdout.write(`raw ${secret}`);
      expect(spy).toHaveBeenLastCalledWith(`raw ${secret}`);
    } finally {
      process.stdout.write = realWrite;
    }
  });

  it("is idempotent: installing twice does not double-wrap", () => {
    const realWrite = process.stdout.write;
    const spy = vi.fn((..._args: unknown[]) => true);
    process.stdout.write = spy as unknown as typeof process.stdout.write;
    try {
      const r = new Redactor();
      const secret = throwaway();
      r.register(secret);
      const uninstallA = r.install({ stdout: process.stdout });
      const wrapped = process.stdout.write;
      const uninstallB = r.install({ stdout: process.stdout });
      expect(process.stdout.write).toBe(wrapped);

      process.stdout.write(secret);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith("[REDACTED]");

      uninstallB(); // no-op: B wrapped nothing
      expect(process.stdout.write).toBe(wrapped);
      uninstallA();
      expect(process.stdout.write).toBe(spy);
    } finally {
      process.stdout.write = realWrite;
    }
  });
});

describe("safeError", () => {
  it("returns the redacted message and never the stack", () => {
    const secret = throwaway();
    redactor.register(secret);
    const err = new Error(`sign-in failed for ${secret}`);
    expect(err.stack).toBeDefined();
    const out = safeError(err);
    expect(out).toBe("sign-in failed for [REDACTED]");
    expect(out).not.toContain("at ");
    expect(out).not.toContain(secret);
  });

  it("handles non-Error values", () => {
    const secret = throwaway();
    redactor.register(secret);
    expect(safeError(`plain ${secret}`)).toBe("plain [REDACTED]");
    expect(safeError(42)).toBe("42");
  });
});
