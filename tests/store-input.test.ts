import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_SECRET_FLAGS,
  SECRET_ON_ARGV_MESSAGE,
  assertNoSecretOnArgv,
  isForbiddenSecretFlag,
  readSecret,
} from "../src/store/input.js";

let home = "";
const savedHome = process.env["TESTLANE_HOME"];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-input-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

function piped(text: string): PassThrough {
  const s = new PassThrough();
  s.end(text);
  return s;
}

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("readSecret (piped)", () => {
  it("strips one trailing CRLF", async () => {
    expect(await readSecret({ stdin: piped("value\r\n"), isTTY: false })).toBe("value");
  });

  it("keeps trailing and interior spaces", async () => {
    expect(await readSecret({ stdin: piped("a b \n"), isTTY: false })).toBe("a b ");
  });

  it("rejects an empty value", async () => {
    await expect(readSecret({ stdin: piped(""), isTTY: false })).rejects.toThrow("empty secret");
    await expect(readSecret({ stdin: piped("\r\n"), isTTY: false })).rejects.toThrow("empty secret");
  });

  it("takes only the first line of multi-line input", async () => {
    expect(await readSecret({ stdin: piped("first\nsecond\nthird\n"), isTTY: false })).toBe("first");
  });

  it("handles unicode split across chunks and never writes to stdout", async () => {
    const value = `pässwörd ✓ ${randomBytes(4).toString("hex")}`;
    const bytes = Buffer.from(`${value}\n`, "utf8");
    const stdin = new PassThrough();
    const out = sink();
    const p = readSecret({ stdin, stdout: out.stream as unknown as NodeJS.WriteStream, isTTY: false });
    stdin.write(bytes.subarray(0, 2));
    stdin.write(bytes.subarray(2));
    stdin.end();
    expect(await p).toBe(value);
    expect(out.text()).toBe("");
  });
});

describe("readSecret (TTY, echo disabled)", () => {
  function fakeTty(): PassThrough & { isTTY: boolean; rawModes: boolean[]; setRawMode: (m: boolean) => void } {
    const s = new PassThrough() as PassThrough & {
      isTTY: boolean;
      rawModes: boolean[];
      setRawMode: (m: boolean) => void;
    };
    s.isTTY = true;
    s.rawModes = [];
    s.setRawMode = (m: boolean) => {
      s.rawModes.push(m);
    };
    return s;
  }

  it("reads one line with backspace support and never echoes it", async () => {
    const tty = fakeTty();
    const out = sink();
    const suffix = randomBytes(4).toString("hex");
    const p = readSecret({ stdin: tty, stdout: out.stream as unknown as NodeJS.WriteStream, prompt: "Secret: " });
    tty.write(`fake-${suffix}X\u007f`);
    tty.write("\r");
    expect(await p).toBe(`fake-${suffix}`);
    expect(tty.rawModes).toEqual([true, false]);
    expect(out.text()).toBe("Secret: \n");
    expect(out.text()).not.toContain(suffix);
  });

  it("rejects with 'cancelled' on Ctrl-C", async () => {
    const tty = fakeTty();
    const out = sink();
    const p = readSecret({ stdin: tty, stdout: out.stream as unknown as NodeJS.WriteStream });
    tty.write("abc\u0003");
    await expect(p).rejects.toThrow("cancelled");
    expect(tty.rawModes).toEqual([true, false]);
  });

  it("treats Ctrl-D on an empty line as empty", async () => {
    const tty = fakeTty();
    const out = sink();
    const p = readSecret({ stdin: tty, stdout: out.stream as unknown as NodeJS.WriteStream });
    tty.write("\u0004");
    await expect(p).rejects.toThrow("empty secret");
  });

  it("refuses to read with echo when raw mode is unavailable", async () => {
    const out = sink();
    await expect(
      readSecret({ stdin: piped("x\n"), stdout: out.stream as unknown as NodeJS.WriteStream, isTTY: true }),
    ).rejects.toThrow(/cannot disable echo/);
  });
});

describe("assertNoSecretOnArgv", () => {
  const shape = { positionals: 1, allowedFlags: ["--json", "-h", "--help"] };

  /** Run the guard and return the thrown message ("" when it did not throw). */
  function refusal(argv: string[]): string {
    try {
      assertNoSecretOnArgv(argv, shape);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("accepts just the profile", () => {
    expect(() => assertNoSecretOnArgv(["acme:local:admin"], shape)).not.toThrow();
  });

  it("rejects an extra positional argument", () => {
    expect(() => assertNoSecretOnArgv(["acme:local:admin", `extra-${randomBytes(4).toString("hex")}`], shape)).toThrow(
      SECRET_ON_ARGV_MESSAGE,
    );
  });

  it("(b)/(c) refuses any --flag=value and any unlisted flag, never echoing the value", () => {
    for (const make of [
      (v: string) => `--pw=${v}`,
      (v: string) => `-p=${v}`,
      (v: string) => `--passw0rd=${v}`,
      (v: string) => `--json=${v}`,
    ]) {
      const value = `fake-${randomBytes(4).toString("hex")}`;
      const message = refusal(["acme:local:admin", make(value)]);
      expect(message).toBe(SECRET_ON_ARGV_MESSAGE);
      expect(message).not.toContain(value);
    }
    for (const flag of ["--pw", "-p", "--passw0rd", "--verbose", "-J"]) {
      expect(refusal(["acme:local:admin", flag]), flag).toBe(SECRET_ON_ARGV_MESSAGE);
    }
  });

  it("(d) refuses forbidden flags in any spelling, even if listed as allowed", () => {
    const permissive = { positionals: 5, allowedFlags: ["--password", "-password", "--api_key"] };
    for (const arg of ["--password", "-password", "---PASSWORD", "--Api_Key", "--client_secret", "--PIN"]) {
      expect(() => assertNoSecretOnArgv(["acme:local:admin", arg], permissive), arg).toThrow(SECRET_ON_ARGV_MESSAGE);
    }
  });

  it("allows exactly the listed boolean flags", () => {
    for (const flag of ["--json", "-h", "--help"]) {
      expect(refusal(["acme:local:admin", flag]), flag).toBe("");
      expect(refusal([flag, "acme:local:admin"]), flag).toBe("");
    }
    // A value-taking option's value counts as a positional (fail closed).
    expect(
      refusal(["acme:local:admin", "--profiles", "x.json"]),
    ).toBe(SECRET_ON_ARGV_MESSAGE);
  });

  it("isForbiddenSecretFlag ignores dashes, case, underscores and =value", () => {
    expect(isForbiddenSecretFlag("--password=x")).toBe(true);
    expect(isForbiddenSecretFlag("-Secret")).toBe(true);
    expect(isForbiddenSecretFlag("--api_key")).toBe(true);
    expect(isForbiddenSecretFlag("--json")).toBe(false);
    expect(isForbiddenSecretFlag("password")).toBe(false);
    expect(isForbiddenSecretFlag("--")).toBe(false);
  });

  it("rejects secret-looking flags, with or without =value, and never echoes the arg", () => {
    expect(() => assertNoSecretOnArgv(["acme:local:admin", "--password", "x"], shape)).toThrow(SECRET_ON_ARGV_MESSAGE);
    for (const flag of FORBIDDEN_SECRET_FLAGS) {
      const fake = `fake-${randomBytes(4).toString("hex")}`;
      let message = "";
      try {
        assertNoSecretOnArgv(["acme:local:admin", `${flag.toUpperCase()}=${fake}`], shape);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(SECRET_ON_ARGV_MESSAGE);
      expect(message).not.toContain(fake);
    }
  });

  it("counts arguments after -- as positional", () => {
    expect(() => assertNoSecretOnArgv(["acme:local:admin", "--", "fake-extra"], shape)).toThrow(SECRET_ON_ARGV_MESSAGE);
  });

  it("allows the --json global flag", () => {
    expect(() => assertNoSecretOnArgv(["acme:local:admin", "--json"], shape)).not.toThrow();
  });

  it("exports the forbidden flag list", () => {
    expect(FORBIDDEN_SECRET_FLAGS).toEqual(expect.arrayContaining(["--value", "--password", "--secret", "--pin"]));
  });
});
