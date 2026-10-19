/**
 * MCP server surface (architecture doc 3.5): `testlane mcp`.
 *
 * Server name "testlane". Tools (names exactly; plain [a-z_] names that every
 * MCP client accepts, so Claude Code exposes e.g. mcp__testlane__session):
 *   list_profiles  registry summary (no secrets; profiles hold none)
 *   session        sign in, return an inline session artifact
 *   session_file   sign in, deliver a local temporary file and metadata
 *   release_session_file  remove a file owned by this MCP connection
 *   check          sign in, report identity only (nothing reusable)
 *   handoff        one-time handoff URL for an app-handoff profile
 *   status         per-profile secret health and alerts (metadata only)
 *
 * The pre-rename dotted names (agent_auth.session, ...) are gone: the SDK
 * lists every callable registered tool, so they could not be kept as hidden
 * aliases (a disabled tool is unlisted but also uncallable).
 *
 * There is deliberately NO store tool: no MCP call can store, overwrite,
 * delete, list values of, or read a stored password. Seeding the vault is a human
 * action (`testlane store set <profile>` at a prompt); an agent must never
 * be able to do it, so the capability simply does not exist on this surface.
 * Likewise there is no rotate tool: `testlane rotate` changes a password in
 * the app and is a human command (or a human's scheduled task).
 *
 * Every call resolves CommandDeps fresh through `opts.deps()`, so registry
 * edits are seen and policy (production refusal, host allowlist, TTL caps)
 * runs on every call. Errors never carry a stack: they are mapped to
 * `isError: true` results with the safe (redacted) message and a `code`
 * matching the CLI exit codes. All returned text and structured content pass
 * through the process-wide redactor as a last line of defence. Invalid tool
 * input is reported as "invalid input: <field names>" (code 1), never with the
 * received values.
 */
import { Console } from "node:console";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  checkProfile,
  issueSession,
  listProfiles,
  MissingSecretError,
  profileStatus,
  type CommandDeps,
  type StatusOptions,
} from "./commands.js";
import { LazyStore, resolveCommandDeps, type ResolveDepsOptions } from "./deps.js";
import { issueHandoff } from "./handoff.js";
import { redactor, redactValue, safeError } from "./redact.js";
import { surfaceRequester } from "./requester.js";
import { COOKIE_ONLY_FORMATS, SESSION_FORMATS } from "./session/format.js";
import { SessionFileError, SessionFiles } from "./session/files.js";
import { extraHeaderNames } from "./session/headers.js";
import { PolicyError, SignInError } from "./types.js";
import { OriginMismatchError } from "./vault.js";
import { VERSION } from "./version.js";

export const MCP_SERVER_NAME = "testlane";

/** Exit-code equivalents carried as `code` in error results (same numbers as the CLI). */
export const MCP_ERROR_CODES = {
  error: 1,
  policy: 2,
  signIn: 3,
  missingSecret: 4,
  originMismatch: 6,
} as const;

export const MCP_TOOL_NAMES = ["list_profiles", "session", "session_file", "release_session_file", "check", "handoff", "status"] as const;

export const MCP_INSTRUCTIONS = [
  "Testlane: a local credential broker for SANDBOX and TEST apps.",
  "The broker signs in itself using a human-seeded password. Normal tool results contain session material or metadata, with stored-password output redaction and its documented limits.",
  "Use list_profiles to discover profiles and check to verify sign-in. When the browser/CLI shares this server filesystem, prefer session_file (default storage-state): its result is a local path and expiry, with no session values. Release it with release_session_file after loading it. Files are removed on expiry or normal disconnect; forced termination can leave files. Use session only when inline live credentials are needed; handoff is a one-time browser URL. status reports secret metadata.",
  "Profiles tagged production and hosts declared by production profiles are refused. Keep registry and environment selection human-controlled; undeclared production cannot be discovered automatically.",
  "There is no tool to store, change, rotate or read a secret, by design. If a result says no secret is stored, ask the human to run `testlane store set <profile>` themselves; if status reports an overdue or pending rotation, tell the human (`testlane rotate <profile>` is theirs to run).",
].join("\n");


// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function jsonResult(value: Record<string, unknown>, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: redactor.redact(JSON.stringify(value, null, 2)) }],
    structuredContent: redactValue(value),
  };
  if (isError) result.isError = true;
  return result;
}

/** Map any thrown value to a stack-free error result with a CLI-equivalent `code`. */
export function toolError(err: unknown): CallToolResult {
  let code: number;
  let text: string;
  let reason: string | undefined;
  if (err instanceof OriginMismatchError) {
    code = MCP_ERROR_CODES.originMismatch;
    text = `refused: ${safeError(err)}`;
    reason = err.reason;
  } else if (err instanceof PolicyError) {
    code = MCP_ERROR_CODES.policy;
    text = `refused: ${safeError(err)}`;
    reason = err.code;
  } else if (err instanceof SignInError) {
    code = MCP_ERROR_CODES.signIn;
    text = safeError(err);
  } else if (err instanceof MissingSecretError) {
    code = MCP_ERROR_CODES.missingSecret;
    text = safeError(err);
    reason = "missing-secret";
  } else {
    code = MCP_ERROR_CODES.error;
    text = safeError(err);
  }
  const structured: Record<string, unknown> = { code, error: text };
  if (reason !== undefined) structured["reason"] = reason;
  return { content: [{ type: "text", text }], structuredContent: structured, isError: true };
}

/** Field names only (never received values) for a zod validation failure. */
export function invalidInputMessage(error: z.ZodError): string {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      // The unknown key names are caller-supplied: count them, do not echo them.
      fields.add("(unknown field)");
      continue;
    }
    const name = issue.path.map(String).join(".") || "(input)";
    fields.add(name.replace(/[^A-Za-z0-9_.()-]/g, "?").slice(0, 64));
  }
  return `invalid input: ${[...fields].join(", ")}`;
}

/** An input-validation failure whose message names fields only. */
class InvalidToolInputError extends Error {
  override readonly name = "InvalidToolInputError";
}

/**
 * The SDK validates tool arguments itself and reports zod's full message,
 * which quotes received values (e.g. an invalid enum value). Replace its
 * validator and error formatter on this instance so a validation failure
 * becomes a field-names-only error with `code: 1`. (Both are private SDK
 * methods; tests/mcp.test.ts pins the behaviour.)
 */
function installInputValidation(server: McpServer, schemas: ReadonlyMap<string, z.ZodTypeAny>): void {
  const internals = server as unknown as {
    validateToolInput: (tool: unknown, args: unknown, toolName: string) => Promise<unknown>;
    createToolError: (message: string) => CallToolResult;
  };
  const original = internals.validateToolInput.bind(server);
  internals.validateToolInput = async (tool: unknown, args: unknown, toolName: string): Promise<unknown> => {
    const schema = schemas.get(toolName);
    if (schema === undefined) return original(tool, args, toolName);
    const parsed = await schema.safeParseAsync(args ?? {});
    if (!parsed.success) throw new InvalidToolInputError(invalidInputMessage(parsed.error));
    return parsed.data;
  };
  internals.createToolError = (message: string): CallToolResult => {
    const text = redactor.redact(message);
    return {
      content: [{ type: "text", text }],
      structuredContent: { code: MCP_ERROR_CODES.error, error: text },
      isError: true,
    };
  };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return toolError(err);
  }
}

// ---------------------------------------------------------------------------
// Input schemas (strict: unknown keys, e.g. a "password", are rejected)
// ---------------------------------------------------------------------------

const profileField = z.string().min(1).max(256).describe('Profile name from list_profiles, e.g. "acme:local:admin".');

const sessionInput = z
  .object({
    profile: profileField,
    format: z.enum(SESSION_FORMATS).optional().describe('Output format; default "cookie".'),
    ttlMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Requested lifetime; refused (not capped) above the profile's limit."),
    target: z.string().min(1).max(2048).optional().describe("URL the session will be used against (host allowlist check)."),
  })
  .strict();

const releaseFileInput = z.object({ id: z.string().regex(/^[0-9a-f]{48}$/).describe("Opaque id returned by session_file on this MCP connection.") }).strict();

const sessionFileInput = sessionInput.extend({ format: z.enum(SESSION_FORMATS).optional().describe('Output format; default "storage-state".') }).strict();

const profileOnlyInput = z.object({ profile: profileField }).strict();

const statusInput = z
  .object({
    maxAgeDays: z
      .number()
      .int()
      .positive()
      .max(36_500)
      .optional()
      .describe("Age limit in days for profiles without options.rotateEveryDays; default 90."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface CreateMcpServerOptions {
  /** Called once per tool call: fresh registry, same store. */
  deps: () => Promise<CommandDeps>;
}

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );

  const files = new SessionFiles();
  const close = server.close.bind(server);
  server.close = async () => { try { await close(); } finally { await files.close(); } };
  server.server.onclose = () => {
    void files.close().catch(() => process.stderr.write("testlane mcp: session-file cleanup was incomplete; inspect delivered paths.\n"));
  };

  installInputValidation(
    server,
    new Map<string, z.ZodTypeAny>([
      ["session", sessionInput],
      ["session_file", sessionFileInput],
      ["release_session_file", releaseFileInput],
      ["check", profileOnlyInput],
      ["handoff", profileOnlyInput],
      ["status", statusInput],
    ]),
  );

  server.registerTool(
    "list_profiles",
    {
      title: "List profiles",
      description: "List the sign-in profiles in the registry (name, app, environment, baseUrl, strategy, account email/role, TTL). Contains no secrets.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        const deps = await opts.deps();
        const { profiles, sources } = listProfiles(deps);
        return jsonResult({ profiles, sources });
      }),
  );

  server.registerTool(
    "session",
    {
      title: "Issue session",
      description:
        "Sign in to a sandbox/test profile and return a session artifact: a Cookie header (default), Playwright storageState JSON, a curl cookie jar, raw header lines (format \"headers\": Cookie plus any extra headers such as x-device-access), or the same headers as a JSON object (format \"json\": { profile, format, expiresAt, headers, droppedHeaders }). The text content is exactly the artifact. For an app-handoff profile that opted in with options.mePath the broker opens its own one-time handoff URL and returns the session cookies the app set (the URL is never returned); without mePath use the handoff tool. Production is always refused.",
      inputSchema: sessionInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const deps = await opts.deps();
        const format = args.format ?? "cookie";
        const sessionOpts: Parameters<typeof issueSession>[2] = { format };
        if (args.ttlMinutes !== undefined) sessionOpts.ttlMinutes = args.ttlMinutes;
        if (args.target !== undefined) sessionOpts.targetUrl = args.target;
        const { output, artifact, warnings } = await issueSession(deps, args.profile, sessionOpts);
        const structured: Record<string, unknown> = { profile: artifact.profile, format, expiresAt: artifact.expiresAt };
        if (warnings.length > 0) structured["warnings"] = warnings;
        // Header NAMES the chosen format could not carry (e.g. x-device-access); never values.
        const dropped = COOKIE_ONLY_FORMATS.includes(format) ? extraHeaderNames(artifact) : [];
        if (dropped.length > 0) structured["droppedHeaders"] = dropped;
        return {
          content: [{ type: "text", text: redactor.redact(output) }],
          structuredContent: redactValue(structured),
        };
      }),
  );

  server.registerTool(
    "session_file",
    {
      title: "Issue local session file",
      description: "Sign in and write a create-only private temporary session file. Defaults to Playwright storage-state. Returns only id, absolute local path and expiry metadata, never cookie/header values. Browser or CLI must share this server's filesystem. No caller-selected paths. Release after loading; expiry/disconnect cleanup does not revoke copied sessions. Forced termination can leave files.",
      inputSchema: sessionFileInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const receipt = await files.create(async () => {
          const deps = await opts.deps();
          extra.signal.throwIfAborted();
          const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
          // Closing/cancelling the MCP request also stops broker network work.
          // SessionFiles still rejects promptly if a custom fetch ignores abort.
          const requestDeps: CommandDeps = { ...deps, fetchImpl: (input, init) => {
            const previousSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const signal = previousSignal ? AbortSignal.any([extra.signal, previousSignal]) : extra.signal;
            signal.throwIfAborted();
            return fetchImpl(input, { ...init, signal });
          } };
          const format = args.format ?? "storage-state";
          const sessionOpts: Parameters<typeof issueSession>[2] = { format };
          if (args.ttlMinutes !== undefined) sessionOpts.ttlMinutes = args.ttlMinutes;
          if (args.target !== undefined) sessionOpts.targetUrl = args.target;
          const { output, artifact, warnings } = await issueSession(requestDeps, args.profile, sessionOpts);
          const droppedHeaders = COOKIE_ONLY_FORMATS.includes(format) ? extraHeaderNames(artifact) : [];
          return { output, profile: artifact.profile, format, issuedAt: artifact.issuedAt, expiresAt: artifact.expiresAt, warnings, droppedHeaders };
        }, extra.signal);
        return jsonResult({ ...receipt });
      } catch (error) {
        // App/OS error text may contain a live token not registered as a stored password.
        // Preserve error classes, but never forward that text from file delivery.
        const code = error instanceof OriginMismatchError ? 6 : error instanceof MissingSecretError ? 4 : error instanceof PolicyError ? 2 : error instanceof SignInError ? 3 : 1;
        const cleanupFailed = error instanceof SessionFileError && error.reason === "file-cleanup-failed";
        const message = cleanupFailed ? "Temporary session-file cleanup was incomplete; inspect testlane-session-files-* in the system temporary directory in a normal terminal." : code === 4 ? "No stored credential; ask the human to run testlane store set for the approved profile." : code === 6 ? "Stored credential origin mismatch; ask the human to review and re-seed." : code === 2 ? "Session file refused by policy; inspect the approved profile, target and TTL." : code === 3 ? "Session sign-in failed; check the app and approved account in a normal terminal." : "Session-file delivery failed; check setup with testlane doctor, or release an existing file and retry. No session value is returned.";
        const reason = error instanceof SessionFileError ? error.reason : error instanceof PolicyError ? error.code : error instanceof OriginMismatchError ? error.reason : error instanceof MissingSecretError ? "missing-secret" : undefined;
        return jsonResult({ code, error: message, ...(reason === undefined ? {} : { reason }) }, true);
      }
    },
  );

  server.registerTool(
    "release_session_file",
    {
      title: "Release local session file",
      description: "Delete a temporary session file using its opaque id from this server. Unknown/already released ids return released:false. Never accepts paths, deletes stored credentials or revokes a copied session.",
      inputSchema: releaseFileInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    args => guarded(async () => jsonResult({ released: await files.release(args.id) })),
  );

  server.registerTool(
    "check",
    {
      title: "Check profile",
      description:
        "Sign in and report who the app says we are (email, role). Returns nothing reusable; the proving session is discarded.",
      inputSchema: profileOnlyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const deps = await opts.deps();
        const r = await checkProfile(deps, args.profile);
        const value: Record<string, unknown> = {
          ok: r.ok,
          profile: r.profile,
          email: r.email ?? null,
          role: r.role ?? null,
          roleSource: r.roleSource,
          expiresAt: r.expiresAt,
        };
        if (r.message !== undefined) value["message"] = r.message;
        if (r.warnings !== undefined) value["warnings"] = r.warnings;
        // An identity mismatch is a failed check, sign-in class (the CLI exits 3).
        if (!r.ok) value["code"] = MCP_ERROR_CODES.signIn;
        return jsonResult(value, !r.ok);
      }),
  );

  server.registerTool(
    "handoff",
    {
      title: "One-time handoff URL",
      description:
        "Mint a one-time, 60-second sign-in URL for an app-handoff profile. Navigate a browser to it once; it cannot be reused.",
      inputSchema: profileOnlyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      guarded(async () => {
        const deps = await opts.deps();
        const h = await issueHandoff(deps, args.profile);
        return jsonResult({ url: h.url, expiresAt: h.expiresAt, profile: h.profile });
      }),
  );

  server.registerTool(
    "status",
    {
      title: "Secret status",
      description:
        "Per-profile secret health: whether a secret is stored, when (age in days), whether a rotation is pending, whether the account comes from an override, and alerts (no-secret, rotation-overdue, pending-rotation, legacy-envelope, secret-refused, store-error). Never returns a secret. Production profiles are listed but never read.",
      inputSchema: statusInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(async () => {
        const deps = await opts.deps();
        const statusOpts: StatusOptions = {};
        if (args.maxAgeDays !== undefined) statusOpts.maxAgeDays = args.maxAgeDays;
        const report = await profileStatus(deps, statusOpts);
        return jsonResult({ ...report });
      }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// stdio entry point
// ---------------------------------------------------------------------------

/** Console methods that write to stdout; routed to stderr while the MCP server runs. */
export const STDOUT_CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "dirxml",
  "table",
  "count",
  "countReset",
  "group",
  "groupCollapsed",
  "groupEnd",
  "time",
  "timeLog",
  "timeEnd",
] as const;

/**
 * Point every stdout-writing console method at a Console bound to stderr
 * (group indentation and counters keep working). Returns a restore function.
 */
export function routeConsoleToStderr(stderr: NodeJS.WritableStream = process.stderr): () => void {
  const errConsole = new Console({ stdout: stderr, stderr });
  const target = console as unknown as Record<string, unknown>;
  const source = errConsole as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of STDOUT_CONSOLE_METHODS) {
    saved.set(name, target[name]);
    const fn = source[name];
    if (typeof fn === "function") target[name] = (fn as (...a: unknown[]) => unknown).bind(errConsole);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, fn] of saved) target[name] = fn;
  };
}

/** After stdin ends, how long in-flight calls may take before the server closes anyway. */
const EOF_GRACE_MS = 30_000;

export interface RunMcpStdioOptions {
  profilesFile?: string;
  requester?: string;
  cwd?: string;
}

/**
 * Serve MCP over stdin/stdout until the transport closes (stdin ends or the
 * client disconnects). stdout is the protocol channel: the redactor is
 * installed on both streams before anything else, and every console method
 * that writes to stdout (log, info, debug, dir, dirxml, table, count,
 * countReset, group, groupCollapsed, groupEnd, time, timeLog, timeEnd) is
 * routed to a stderr console for the lifetime of the server, so no stray
 * write can corrupt the channel. (warn, error, trace and assert already
 * write to stderr.)
 */
export async function runMcpStdio(opts: RunMcpStdioOptions = {}): Promise<void> {
  const uninstall = redactor.install();

  const restoreConsole = routeConsoleToStderr();

  // One store for the whole session (platform adapter picked on first use);
  // the registry is reloaded on every call.
  const store = new LazyStore();
  const depsOpts: ResolveDepsOptions = { store, requester: surfaceRequester(opts.requester, "mcp") };
  if (opts.profilesFile !== undefined) depsOpts.profilesFile = opts.profilesFile;
  if (opts.cwd !== undefined) depsOpts.cwd = opts.cwd;

  const server = createMcpServer({ deps: () => resolveCommandDeps(depsOpts) });
  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    const onclose = server.server.onclose;
    server.server.onclose = () => { onclose?.(); resolve(); };
  });
  server.server.onerror = (err: Error) => {
    process.stderr.write(`testlane mcp: ${safeError(err)}\n`);
  };
  // stdin EOF: stop reading, but let requests already received finish and
  // their responses flush before closing (a client may write its last request
  // and close stdin right away). Bounded so a hung call cannot keep us alive.
  const pending = new Set<string | number>();
  let ended = false;
  let closing = false;
  let graceTimer: NodeJS.Timeout | undefined;
  const closeNow = (): void => {
    if (closing) return;
    closing = true;
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    void transport.close();
  };
  const maybeClose = (): void => {
    if (ended && pending.size === 0) closeNow();
  };
  const onEnd = (): void => {
    if (ended) return;
    ended = true;
    graceTimer = setTimeout(closeNow, EOF_GRACE_MS);
    // Keep the process alive until cleanup runs even when a pending callback
    // has no active socket/child handle. A bare Promise cannot do that.
    maybeClose();
  };
  process.once("SIGINT", closeNow);
  process.once("SIGTERM", closeNow);
  process.stdin.once("end", onEnd);
  process.stdin.once("close", onEnd);

  try {
    await server.connect(transport);
    // Track request ids in flight (Protocol calls these hooks dynamically).
    const onmessage = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage): void => {
      if ("method" in message && "id" in message) pending.add(message.id);
      onmessage?.(message);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage): Promise<void> => {
      await send(message);
      if ("id" in message && ("result" in message || "error" in message) && message.id !== undefined) {
        pending.delete(message.id);
        maybeClose();
      }
    };
    await closed;
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    process.off("SIGINT", closeNow);
    process.off("SIGTERM", closeNow);
    process.stdin.off("end", onEnd);
    process.stdin.off("close", onEnd);
    try { await server.close(); }
    finally { restoreConsole(); uninstall(); }
  }
}
