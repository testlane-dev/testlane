import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAudit,
  AuditRefusedError,
  formatAuditRow,
  readAuditTail,
  type AuditInput,
} from "../src/audit.js";
import { auditLogPath } from "../src/paths.js";
import { detectRequester, surfaceRequester } from "../src/requester.js";

const throwaway = (): string => `throwaway-${randomBytes(8).toString("hex")}`;

function baseRow(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    event: "session",
    profile: "acme:local:admin",
    host: "localhost:3000",
    environment: "sandbox",
    strategy: "nextauth-credentials",
    requester: "vitest",
    ok: true,
    ...overrides,
  };
}

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env["TESTLANE_HOME"];
  home = await mkdtemp(path.join(os.tmpdir(), "testlane-audit-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = previousHome;
  await rm(home, { recursive: true, force: true });
});

async function readLines(): Promise<string[]> {
  const text = await readFile(auditLogPath(), "utf8");
  return text.split("\n").filter((l) => l !== "");
}

describe("appendAudit", () => {
  it("appends one JSON line with ts filled in", async () => {
    const before = Date.now();
    const written = await appendAudit(baseRow());
    expect(auditLogPath().startsWith(home)).toBe(true);

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toEqual(written);
    expect(typeof parsed["ts"]).toBe("string");
    expect(Date.parse(parsed["ts"] as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed["profile"]).toBe("acme:local:admin");
  });

  it("keeps an explicit ts", async () => {
    const ts = "2026-09-23T10:00:00.000Z";
    const written = await appendAudit({ ...baseRow(), ts });
    expect(written.ts).toBe(ts);
  });

  it("two appends give two rows and readAuditTail(1) returns the latest", async () => {
    await appendAudit(baseRow({ event: "check" }));
    await appendAudit(baseRow({ event: "handoff", reason: "second" }));
    expect(await readLines()).toHaveLength(2);

    const tail = await readAuditTail(1);
    expect(tail.malformed).toBe(0);
    expect(tail.rows).toHaveLength(1);
    expect(tail.rows[0]?.event).toBe("handoff");
    expect(tail.rows[0]?.reason).toBe("second");

    const all = await readAuditTail(10);
    expect(all.rows.map((r) => r.event)).toEqual(["check", "handoff"]);
  });

  it("readAuditTail skips and counts malformed lines", async () => {
    await appendAudit(baseRow({ event: "check" }));
    await appendFile(auditLogPath(), "not json at all\n");
    await appendFile(auditLogPath(), `${JSON.stringify({ event: "session" })}\n`);
    await appendAudit(baseRow({ event: "session" }));

    const tail = await readAuditTail(5);
    expect(tail.malformed).toBe(2);
    expect(tail.rows.map((r) => r.event)).toEqual(["check", "session"]);
  });

  it("readAuditTail on a missing log returns nothing", async () => {
    expect(await readAuditTail(3)).toEqual({ rows: [], malformed: 0 });
  });

  it("refuses a row whose reason looks like a secret assignment and writes nothing", async () => {
    const value = throwaway();
    const err = await appendAudit(
      baseRow({ ok: false, reason: `sign-in failed password=${value}` }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditRefusedError);
    expect((err as Error).message).not.toContain(value);
    await expect(readFile(auditLogPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses token:/cookie = style values in the free-text fields (reason, format)", async () => {
    await expect(appendAudit(baseRow({ reason: `Token: ${throwaway()}` }))).rejects.toThrow(
      AuditRefusedError,
    );
    await expect(appendAudit(baseRow({ format: `cookie = ${throwaway()}` }))).rejects.toThrow(
      AuditRefusedError,
    );
  });

  it("does not apply the assignment heuristic to structured fields (profile, host, requester)", async () => {
    const row = await appendAudit(
      baseRow({ profile: "app:token:admin", host: "token:3000", requester: "mcp:secret:inspector" }),
    );
    expect(row.profile).toBe("app:token:admin");
    expect(await readLines()).toHaveLength(1);
  });

  it("refuses a row with a 600-char value in any string field", async () => {
    await appendAudit(baseRow());
    await expect(appendAudit(baseRow({ reason: "x".repeat(600) }))).rejects.toThrow(/512/);
    await expect(appendAudit(baseRow({ host: "h".repeat(600) }))).rejects.toThrow(/512/);
    await expect(appendAudit(baseRow({ requester: "r".repeat(600) }))).rejects.toThrow(/512/);
    expect(await readLines()).toHaveLength(1);
  });

  it("readAuditTail strips a leading BOM so the first row still parses", async () => {
    const row = await appendAudit(baseRow({ event: "check" }));
    await writeFile(auditLogPath(), `\uFEFF${JSON.stringify(row)}\n`, "utf8");
    const tail = await readAuditTail(5);
    expect(tail.malformed).toBe(0);
    expect(tail.rows).toEqual([row]);
  });

  it("readAuditTail treats a non-finite n as all rows and n <= 0 as none", async () => {
    for (let i = 0; i < 3; i++) await appendAudit(baseRow({ reason: `r${i}` }));
    expect((await readAuditTail(Number.POSITIVE_INFINITY)).rows).toHaveLength(3);
    expect((await readAuditTail(Number.NaN)).rows).toHaveLength(3);
    expect((await readAuditTail(0)).rows).toHaveLength(0);
    expect((await readAuditTail(-2)).rows).toHaveLength(0);
    expect((await readAuditTail(2)).rows.map((r) => r.reason)).toEqual(["r1", "r2"]);
  });

  it("refuses schema violations (empty profile, unknown event, extra field)", async () => {
    await expect(appendAudit(baseRow({ profile: "" }))).rejects.toThrow(AuditRefusedError);
    await expect(
      appendAudit(baseRow({ event: "bogus" as unknown as AuditInput["event"] })),
    ).rejects.toThrow(AuditRefusedError);
    await expect(
      appendAudit({ ...baseRow(), extra: "x" } as unknown as AuditInput),
    ).rejects.toThrow(AuditRefusedError);
  });

  it.skipIf(process.platform === "win32")("creates the log with mode 0o600", async () => {
    await appendAudit(baseRow());
    const st = await stat(auditLogPath());
    expect(st.mode & 0o777).toBe(0o600);
    const dir = await stat(home);
    expect(dir.isDirectory()).toBe(true);
  });
});

describe("formatAuditRow", () => {
  it("includes ts, event, status, profile and requester", async () => {
    const row = await appendAudit(
      baseRow({ event: "refused", ok: false, requester: "codex", reason: "production-refused" }),
    );
    const line = formatAuditRow(row);
    expect(line).toContain(row.ts);
    expect(line).toContain("refused");
    expect(line).toContain("REF");
    expect(line).toContain("acme:local:admin");
    expect(line).toContain("codex");
    expect(line).toContain("production-refused");
    expect(line).not.toContain("\n");

    const okLine = formatAuditRow({ ...row, ok: true, event: "check" });
    expect(okLine).toContain(`${"check".padEnd(12)}  ok `);
  });

  it("aligns every event name, including the 12-char store.delete", () => {
    const base = { ts: "2026-09-23T10:00:00.000Z", profile: "p", host: "h", environment: "sandbox", strategy: "nextauth-credentials", requester: "r", ok: true } as const;
    const columns = (["session", "store.set", "store.delete", "refused"] as const).map((event) =>
      formatAuditRow({ ...base, event }).indexOf("ok "),
    );
    expect(new Set(columns).size).toBe(1);
  });
});

describe("detectRequester", () => {
  beforeEach(() => {
    vi.stubEnv("TESTLANE_REQUESTER", undefined);
    vi.stubEnv("CLAUDECODE", undefined);
    vi.stubEnv("CODEX_SANDBOX", undefined);
    vi.stubEnv("CODEX_CI", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to cli", () => {
    expect(detectRequester()).toBe("cli");
  });

  it("uses codex markers", () => {
    vi.stubEnv("CODEX_CI", "1");
    expect(detectRequester()).toBe("codex");
  });

  it("CLAUDECODE beats codex markers and the default", () => {
    vi.stubEnv("CODEX_SANDBOX", "seatbelt");
    vi.stubEnv("CLAUDECODE", "1");
    expect(detectRequester()).toBe("claude-code");
  });

  it("TESTLANE_REQUESTER beats CLAUDECODE", () => {
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("TESTLANE_REQUESTER", "mcp:inspector");
    expect(detectRequester()).toBe("mcp:inspector");
  });

  it("explicit argument beats everything", () => {
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("TESTLANE_REQUESTER", "mcp:inspector");
    expect(detectRequester("http:127.0.0.1")).toBe("http:127.0.0.1");
  });

  it("blank values are treated as unset", () => {
    vi.stubEnv("TESTLANE_REQUESTER", "  ");
    expect(detectRequester("")).toBe("cli");
  });

  it("sanitises to [A-Za-z0-9:._-], trims, and caps at 64 characters", () => {
    expect(detectRequester("  mcp:inspector  ")).toBe("mcp:inspector");
    expect(detectRequester("evil\u001b[31m name\nx")).toBe("evil31mnamex");
    expect(detectRequester("http 127.0.0.1:8080/path?q=1")).toBe("http127.0.0.1:8080pathq1");
    expect(detectRequester("a".repeat(100))).toBe("a".repeat(64));
    vi.stubEnv("TESTLANE_REQUESTER", "codex/cli run");
    expect(detectRequester()).toBe("codexclirun");
  });

  it("falls back to cli when nothing is left after sanitising", () => {
    expect(detectRequester("@@@ !!!")).toBe("cli");
    vi.stubEnv("TESTLANE_REQUESTER", "\u0000\u0007");
    expect(detectRequester("/// ")).toBe("cli");
  });
});

describe("surfaceRequester (mcp / serve default)", () => {
  beforeEach(() => {
    vi.stubEnv("TESTLANE_REQUESTER", undefined);
    vi.stubEnv("CLAUDECODE", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the surface name when nothing else is set", () => {
    expect(surfaceRequester(undefined, "mcp")).toBe("mcp");
    expect(surfaceRequester(undefined, "http")).toBe("http");
  });

  it("TESTLANE_REQUESTER (trimmed) beats the surface name, and reaches the audit label", () => {
    vi.stubEnv("TESTLANE_REQUESTER", "  claude-code:pane  ");
    expect(surfaceRequester(undefined, "mcp")).toBe("claude-code:pane");
    expect(surfaceRequester(undefined, "http")).toBe("claude-code:pane");
    expect(detectRequester(surfaceRequester(undefined, "mcp"))).toBe("claude-code:pane");
  });

  it("a blank TESTLANE_REQUESTER falls back to the surface name; an explicit --requester wins", () => {
    vi.stubEnv("TESTLANE_REQUESTER", "   ");
    vi.stubEnv("CLAUDECODE", "1");
    expect(surfaceRequester(undefined, "http")).toBe("http");
    vi.stubEnv("TESTLANE_REQUESTER", "codex");
    expect(surfaceRequester("ops-script", "mcp")).toBe("ops-script");
  });
});
