/**
 * Append-only audit log at ~/.testlane/audit.ndjson (one JSON object per line).
 *
 * The audit log must never become a secret sink: rows are schema-validated,
 * every string is length-capped, and a free-text field (reason, format) that
 * looks like a `password=` / `token:` style assignment is refused outright
 * (the row is not written and the error message never echoes the value).
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { z } from "zod";
import { agentAuthHome, auditLogPath } from "./paths.js";
import { ENVIRONMENTS, STRATEGIES, type AuditRow } from "./types.js";

export const AUDIT_EVENTS = [
  "session",
  "check",
  "handoff",
  "refused",
  "store.set",
  "store.delete",
  "rotate",
] as const satisfies readonly AuditRow["event"][];

// Compile-time guard: AUDIT_EVENTS must cover every AuditRow["event"] member.
type MissingEvents = Exclude<AuditRow["event"], (typeof AUDIT_EVENTS)[number]>;
const _eventsExhaustive: [MissingEvents] extends [never] ? true : never = true;
void _eventsExhaustive;

/** Maximum length of any string value in an audit row. */
export const AUDIT_MAX_STRING = 512;

/** Values matching this are treated as a probable secret assignment and refused. */
const SECRET_ASSIGNMENT = /(password|passwd|secret|token|cookie)\s*[=:]/i;

/** True when `value` would be refused as a probable secret assignment in a free-text field. */
export function looksLikeSecretAssignment(value: string): boolean {
  return SECRET_ASSIGNMENT.test(value);
}

/** Fields that carry free text and are therefore screened with SECRET_ASSIGNMENT. */
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(["reason", "format"]);

const auditRowSchema = z
  .object({
    ts: z.string().datetime({ offset: true }),
    event: z.enum(AUDIT_EVENTS),
    profile: z.string().min(1),
    host: z.string().min(1),
    environment: z.enum(ENVIRONMENTS),
    strategy: z.enum(STRATEGIES),
    requester: z.string().min(1),
    format: z.string().optional(),
    ok: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();

/** Thrown when a row is refused. The message never contains the offending value. */
export class AuditRefusedError extends Error {
  override readonly name = "AuditRefusedError";
}

export type AuditInput = Omit<AuditRow, "ts"> & { ts?: string };

export async function appendAudit(row: AuditInput): Promise<AuditRow> {
  const candidate: Record<string, unknown> = { ...row };
  if (candidate["ts"] === undefined) candidate["ts"] = new Date().toISOString();

  // Guard checks run on the raw input, before schema validation, so that a
  // secret never reaches a zod error message either. The length cap applies to
  // every string; the assignment heuristic only to the free-text fields
  // (profile names, hosts and requesters are validated/sanitised elsewhere,
  // and e.g. a profile named "app:token:admin" must not make auditing fail).
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== "string") continue;
    if (value.length > AUDIT_MAX_STRING) {
      throw new AuditRefusedError(
        `audit row refused: field "${safeKey(key)}" is longer than ${AUDIT_MAX_STRING} characters`,
      );
    }
    if (FREE_TEXT_FIELDS.has(key) && SECRET_ASSIGNMENT.test(value)) {
      throw new AuditRefusedError(
        `audit row refused: field "${safeKey(key)}" looks like it contains a secret assignment`,
      );
    }
  }

  const parsed = auditRowSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(row)"))]
      .map(safeKey)
      .join(", ");
    throw new AuditRefusedError(`audit row refused: invalid field(s): ${fields}`);
  }
  const clean = toAuditRow(parsed.data);

  await mkdir(agentAuthHome(), { recursive: true, mode: 0o700 });
  const fh = await open(auditLogPath(), "a", 0o600);
  try {
    // Tighten a pre-existing file too; chmod is a no-op on Windows.
    if (process.platform !== "win32") await fh.chmod(0o600);
    await fh.write(`${JSON.stringify(clean)}\n`, null, "utf8");
  } finally {
    await fh.close();
  }
  return clean;
}

export interface AuditTail {
  /** The last n well-formed rows, oldest first. */
  rows: AuditRow[];
  /** Number of malformed (unparseable or schema-invalid) non-blank lines in the whole file. */
  malformed: number;
}

/** Last `n` well-formed rows. A non-finite `n` (NaN, Infinity) means "all rows"; n <= 0 means none. */
export async function readAuditTail(n: number): Promise<AuditTail> {
  let text: string;
  try {
    text = await readFile(auditLogPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], malformed: 0 };
    throw err;
  }
  // A leading byte-order mark (e.g. after a manual edit) is not part of the first row.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: AuditRow[] = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const parsed = auditRowSchema.safeParse(json);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    rows.push(toAuditRow(parsed.data));
  }

  if (!Number.isFinite(n)) return { rows, malformed };
  const count = Math.max(0, Math.floor(n));
  return { rows: count === 0 ? [] : rows.slice(-count), malformed };
}

/**
 * One aligned human-readable line:
 * `<ts>  <event:12>  <ok|REF>  <profile>  <strategy>  <host>  <requester>  <reason?>`
 * (12 = the longest event name, "store.delete").
 * Control characters (C0, DEL, C1) and U+2028/U+2029 are replaced with spaces
 * so a tampered log cannot inject terminal escapes or extra lines.
 */
export function formatAuditRow(row: AuditRow): string {
  const parts = [
    row.ts,
    row.event.padEnd(12),
    row.ok ? "ok " : "REF",
    row.profile,
    row.strategy,
    row.host,
    row.requester,
  ];
  if (row.reason !== undefined && row.reason !== "") parts.push(row.reason);
  return parts.map(stripControl).join("  ");
}

function toAuditRow(data: z.infer<typeof auditRowSchema>): AuditRow {
  const row: AuditRow = {
    ts: data.ts,
    event: data.event,
    profile: data.profile,
    host: data.host,
    environment: data.environment,
    strategy: data.strategy,
    requester: data.requester,
    ok: data.ok,
  };
  if (data.format !== undefined) row.format = data.format;
  if (data.reason !== undefined) row.reason = data.reason;
  return row;
}

/** Same set as printable() in src/cli.ts: C0, DEL, C1 and the Unicode line/paragraph separators. */
function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(auditRowSchema.shape));

/** Keys are caller-controlled too: only ever echo known field names. */
function safeKey(key: string): string {
  return KNOWN_KEYS.has(key) ? key : "(unknown field)";
}
