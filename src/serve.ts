/**
 * Localhost HTTP surface (`testlane serve`, architecture doc 3.5): the same
 * operations as the CLI and MCP server for tools that can only `fetch`.
 *
 * Guardrails enforced here:
 * - Bound to 127.0.0.1 only (never 0.0.0.0 or ::).
 * - Every request needs `Authorization: Bearer <token>`; the token is 32
 *   random bytes generated per boot and written to a file only the user can
 *   read (mode 0600, directory 0700 on POSIX). It is compared in constant time.
 * - DNS-rebinding guard: the Host header must name 127.0.0.1 or localhost
 *   (optionally with the bound port). Any request carrying an Origin header is
 *   refused: browsers must never call this server.
 * - JSON bodies only, at most 64 KiB, validated with zod (unknown keys refused).
 * - There are NO store endpoints of any kind: seeding or deleting a secret is a
 *   human action on the CLI (`testlane store set`). `/store` and everything
 *   under it answer 404 explicitly. There is no rotate endpoint either
 *   (`testlane rotate` is a human command); `GET /status` reports secret
 *   metadata and alerts only.
 * - Every response body (session artifacts, JSON bodies, error bodies) passes
 *   through the process-wide redactor, like CLI stdout / `--out` and MCP.
 * - Error bodies are `{ error, code }` with `code` mirroring the CLI exit codes;
 *   messages go through safeError (redacted, never a stack).
 * - One log line per request (method, pathname, status, ms). Never bodies,
 *   never headers, never the query string, host or userinfo of the target.
 * - The token file is `<TESTLANE_HOME>/http-token` for the default port and
 *   `http-token-<port>` for any other, so two servers never overwrite (or, on
 *   shutdown, delete) each other's token.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import {
  checkProfile,
  issueSession,
  listProfiles,
  MissingSecretError,
  profileStatus,
  type CommandDeps,
  type IssueSessionOptions,
  type StatusOptions,
} from "./commands.js";
import { resolveCommandDeps, type ResolveDepsOptions } from "./deps.js";
import { issueHandoff } from "./handoff.js";
import { agentAuthHome } from "./paths.js";
import { redactor, redactValue, safeError } from "./redact.js";
import { surfaceRequester } from "./requester.js";
import { COOKIE_ONLY_FORMATS, SESSION_FORMATS } from "./session/format.js";
import { extraHeaderNames } from "./session/headers.js";
import { PolicyError, SignInError } from "./types.js";
import { OriginMismatchError } from "./vault.js";

export const DEFAULT_PORT = 4711;
export const BIND_HOST = "127.0.0.1";
/** Maximum accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024;
/** After a body overflows, drain at most this much more before dropping the connection. */
const MAX_DRAIN_BYTES = 1024 * 1024;

/**
 * Location of the per-boot bearer token for a server bound to `port`:
 * `<TESTLANE_HOME>/http-token` for DEFAULT_PORT, `http-token-<port>` otherwise.
 */
export function httpTokenPath(port: number = DEFAULT_PORT): string {
  return path.join(agentAuthHome(), port === DEFAULT_PORT ? "http-token" : `http-token-${port}`);
}

/** Response header naming artifact headers that the chosen format could not carry (names only). */
export const DROPPED_HEADERS_HEADER = "X-Agent-Auth-Dropped-Headers";

/** Response header set to "unresolved" when a session was issued while a pending rotation exists. */
export const PENDING_ROTATION_HEADER = "X-Agent-Auth-Pending-Rotation";

/** RFC 9110 field-name token; anything else is left out of DROPPED_HEADERS_HEADER. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;

export interface ServeOptions {
  /** TCP port on 127.0.0.1. Default 4711; 0 picks a free port (tests). */
  port?: number;
  /** Resolved fresh for every request (so registry edits are seen). */
  deps: () => Promise<CommandDeps>;
  /** Where the bearer token is written. Default httpTokenPath(bound port). */
  tokenFile?: string;
  /** Test injection; otherwise 32 random bytes (base64url) per boot. */
  token?: string;
  /** Request log sink (one line per request). Defaults to process.stderr. */
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  token: string;
  tokenFile: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const profileName = z.string().min(1).max(200);

const sessionBody = z
  .object({
    profile: profileName,
    format: z.enum(SESSION_FORMATS).optional(),
    ttlMinutes: z.number().int().positive().optional(),
    target: z.string().min(1).max(2048).optional(),
  })
  .strict();

const profileBody = z.object({ profile: profileName }).strict();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error that maps to a fixed status; its message is our own text (safe). */
class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** Status + CLI-mirroring code for an error thrown by a command. */
function classify(err: unknown): { status: number; code: number } {
  if (err instanceof HttpError) return { status: err.status, code: err.code };
  if (err instanceof OriginMismatchError) return { status: 409, code: 6 };
  if (err instanceof PolicyError) return { status: 403, code: 2 };
  if (err instanceof SignInError) return { status: 502, code: 3 };
  if (err instanceof MissingSecretError) return { status: 409, code: 4 };
  return { status: 500, code: 1 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Every JSON body goes through the redactor (string values only, so it stays valid JSON). */
function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(redactValue(body));
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...extra,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
  });
  res.end(text);
}

/** Every text body goes through the redactor, like CLI stdout and MCP text. */
function sendText(
  res: http.ServerResponse,
  status: number,
  rawText: string,
  extra: Record<string, string>,
  contentType = "text/plain; charset=utf-8",
): void {
  const text = redactor.redact(rawText);
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...extra,
    "Content-Type": contentType,
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
  });
  res.end(text);
}

/** Constant-time bearer check. A length mismatch is a plain failure. */
function bearerOk(header: string | undefined, expected: Buffer): boolean {
  if (typeof header !== "string") return false;
  const m = /^Bearer +(\S+) *$/i.exec(header);
  if (m === null || m[1] === undefined) return false;
  const got = Buffer.from(m[1], "utf8");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/** Host must be 127.0.0.1 or localhost, optionally with the bound port. */
function hostOk(header: string | undefined, port: number): boolean {
  if (typeof header !== "string") return false;
  const host = header.trim().toLowerCase();
  for (const name of ["127.0.0.1", "localhost"]) {
    if (host === name || host === `${name}:${port}`) return true;
  }
  return false;
}

function isJsonContentType(header: string | undefined): boolean {
  if (typeof header !== "string") return false;
  const mediaType = header.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * Read a JSON body of at most MAX_BODY_BYTES. On overflow the request is
 * rejected at once (413); the rest is drained up to MAX_DRAIN_BYTES so the
 * client can read the response, then the connection is dropped.
 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (!isJsonContentType(req.headers["content-type"])) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    drain(req);
    throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        cleanup();
        drain(req);
        reject(new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

/** Discard the rest of an oversized body, dropping the connection past MAX_DRAIN_BYTES. */
function drain(req: http.IncomingMessage): void {
  let drained = 0;
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > MAX_DRAIN_BYTES) req.destroy();
  });
  req.resume();
}

/** Validate with zod; the error names fields only, never echoes values. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))]
      .map((f) => f.replace(/[^A-Za-z0-9_.()-]/g, "?").slice(0, 64))
      .join(", ");
    throw new HttpError(400, `invalid request body: ${fields}`);
  }
  return parsed.data;
}

/**
 * Path for the log line: the parsed pathname only, so an absolute-form or
 * protocol-relative request target never logs its host, userinfo or query.
 * No control characters, capped.
 */
export function logPath(rawUrl: string | undefined): string {
  let p: string;
  try {
    p = new URL(rawUrl ?? "/", `http://${BIND_HOST}`).pathname;
  } catch {
    return "(unparseable)";
  }
  // eslint-disable-next-line no-control-regex
  return p.replace(/[\u0000- \u007f-\u009f]/g, "?").slice(0, 200) || "/";
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  opts: ServeOptions,
): Promise<void> {
  const method = req.method ?? "";

  // No store endpoints exist, by design: storing or deleting a secret is a
  // human action on the CLI. Refuse the whole namespace explicitly.
  if (pathname === "/store" || pathname.startsWith("/store/")) {
    throw new HttpError(404, "not found");
  }

  if (method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/profiles") {
    const deps = await opts.deps();
    sendJson(res, 200, listProfiles(deps));
    return;
  }

  if (method === "GET" && pathname === "/status") {
    // The only query parameter anywhere: maxAgeDays (positive whole days). Never echoed.
    const params = new URL(req.url ?? "/", `http://${BIND_HOST}`).searchParams;
    const statusOpts: StatusOptions = {};
    for (const key of params.keys()) {
      if (key !== "maxAgeDays") throw new HttpError(400, "unknown query parameter (only maxAgeDays is accepted)");
    }
    const raw = params.getAll("maxAgeDays");
    if (raw.length > 1) throw new HttpError(400, "maxAgeDays given more than once");
    if (raw.length === 1) {
      const value = raw[0] ?? "";
      if (!/^[1-9]\d{0,4}$/.test(value)) throw new HttpError(400, "maxAgeDays must be a positive whole number of days");
      statusOpts.maxAgeDays = Number(value);
    }
    const deps = await opts.deps();
    sendJson(res, 200, await profileStatus(deps, statusOpts));
    return;
  }

  if (method === "POST" && pathname === "/session") {
    const body = parseBody(sessionBody, await readJsonBody(req));
    const deps = await opts.deps();
    const format = body.format ?? "cookie";
    const sessionOpts: IssueSessionOptions = { format };
    if (body.ttlMinutes !== undefined) sessionOpts.ttlMinutes = body.ttlMinutes;
    if (body.target !== undefined) sessionOpts.targetUrl = body.target;
    const { output, artifact, warnings } = await issueSession(deps, body.profile, sessionOpts);
    const headers: Record<string, string> = {
      "X-Agent-Auth-Profile": artifact.profile,
      "X-Agent-Auth-Format": format,
      "X-Agent-Auth-Expires": artifact.expiresAt,
    };
    if (warnings.length > 0) headers[PENDING_ROTATION_HEADER] = "unresolved";
    // Header NAMES the chosen format could not carry (e.g. x-device-access); never values.
    if (COOKIE_ONLY_FORMATS.includes(format)) {
      const dropped = extraHeaderNames(artifact).filter((n) => HEADER_NAME_RE.test(n));
      if (dropped.length > 0) headers[DROPPED_HEADERS_HEADER] = dropped.join(",");
    }
    // The formatted session is the deliverable, but it is redacted like every
    // other surface (CLI stdout and --out, MCP): a stored secret that the app
    // echoed back inside the session material (a "remember me" cookie holding
    // the password) is replaced by [REDACTED], never delivered. sendText does it.
    // `json` is already the pretty-printed object as text: send it as such (not
    // re-stringified) but with an application/json Content-Type; every other
    // format keeps text/plain.
    sendText(res, 200, output, headers, format === "json" ? "application/json; charset=utf-8" : undefined);
    return;
  }

  if (method === "POST" && pathname === "/check") {
    const body = parseBody(profileBody, await readJsonBody(req));
    const deps = await opts.deps();
    const result = await checkProfile(deps, body.profile);
    if (!result.ok) {
      // Identity mismatch: a sign-in class failure, like the CLI's exit 3.
      sendJson(res, 502, { error: result.message ?? "identity mismatch", code: 3 });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && pathname === "/handoff") {
    const body = parseBody(profileBody, await readJsonBody(req));
    const deps = await opts.deps();
    const out = await issueHandoff(deps, body.profile);
    sendJson(res, 200, { url: out.url, expiresAt: out.expiresAt, profile: out.profile });
    return;
  }

  throw new HttpError(404, "not found");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

async function writeTokenFile(file: string, token: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
  // Tighten a pre-existing file too; chmod is a no-op on Windows (ACLs of the user profile apply).
  if (process.platform !== "win32") await chmod(file, 0o600);
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const port = opts.port ?? DEFAULT_PORT;
  if (!validPort(port)) throw new Error("port must be an integer between 0 and 65535");
  const token = opts.token ?? randomBytes(32).toString("base64url");
  if (typeof token !== "string" || token === "" || /\s/.test(token)) {
    throw new Error("token must be a non-empty string without whitespace");
  }
  const log = opts.log ?? ((line: string): void => void process.stderr.write(line));
  const expected = Buffer.from(token, "utf8");
  let boundPort = port;

  const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const method = (req.method ?? "?").replace(/[^A-Z]/g, "?").slice(0, 16);
    const pathForLog = logPath(req.url);
    let logged = false;
    const writeLog = (): void => {
      if (logged) return;
      logged = true;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const status = res.headersSent ? res.statusCode : 0;
      try {
        log(`testlane serve: ${method} ${pathForLog} ${status} ${ms.toFixed(1)}ms\n`);
      } catch {
        // Logging must never break a response.
      }
    };
    res.on("finish", writeLog);
    res.on("close", writeLog);

    void (async () => {
      try {
        // (1) Browsers must never call this server; (2) DNS-rebinding guard.
        if (req.headers.origin !== undefined || !hostOk(req.headers.host, boundPort)) {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
        // (3) Bearer, constant time. No detail on failure.
        if (!bearerOk(req.headers.authorization, expected)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        let pathname: string;
        try {
          pathname = new URL(req.url ?? "/", `http://${BIND_HOST}`).pathname;
        } catch {
          throw new HttpError(400, "bad request target");
        }
        await route(req, res, pathname, opts);
      } catch (err) {
        const { status, code } = classify(err);
        const extra: Record<string, string> = status === 413 ? { Connection: "close" } : {};
        if (!res.headersSent) sendJson(res, status, { error: safeError(err), code }, extra);
        else res.destroy();
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen({ port, host: BIND_HOST, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null || address.address !== BIND_HOST) {
    server.close();
    throw new Error("server did not bind to 127.0.0.1");
  }
  boundPort = address.port;
  const tokenFile = opts.tokenFile ?? httpTokenPath(boundPort);

  const shutdown = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  try {
    await writeTokenFile(tokenFile, token);
  } catch (err) {
    await shutdown();
    throw err;
  }

  let closing: Promise<void> | null = null;
  return {
    port: boundPort,
    token,
    tokenFile,
    close: () => {
      closing ??= (async () => {
        await shutdown();
        await rm(tokenFile, { force: true });
      })();
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export interface RunServeOptions {
  port?: number;
  profilesFile?: string;
  requester?: string;
  cwd?: string;
}

/**
 * `testlane serve`: install the redactor on stdout/stderr, start the server,
 * print one line, and resolve after SIGINT/SIGTERM once the server is closed
 * and the token file removed.
 */
export async function runServe(opts: RunServeOptions = {}): Promise<void> {
  redactor.install();
  const depsOpts: ResolveDepsOptions = { requester: surfaceRequester(opts.requester, "http") };
  if (opts.profilesFile !== undefined) depsOpts.profilesFile = opts.profilesFile;
  if (opts.cwd !== undefined) depsOpts.cwd = opts.cwd;

  const serveOpts: ServeOptions = { deps: () => resolveCommandDeps(depsOpts) };
  if (opts.port !== undefined) serveOpts.port = opts.port;
  const server = await startServer(serveOpts);
  process.stdout.write(
    `testlane serve listening on http://${BIND_HOST}:${server.port} (token in ${server.tokenFile})\n`,
  );

  await new Promise<void>((resolve, reject) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      server.close().then(resolve, reject);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
