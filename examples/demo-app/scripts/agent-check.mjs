#!/usr/bin/env node
/**
 * Read-only verifier for the "real-agent acceptance check" runbook
 * (docs/INTEGRATION-CLAUDE-CODE.md#real-agent-acceptance-check).
 *
 * WHAT A PASS HERE ACTUALLY MEANS -- read this before trusting one:
 *
 * A PASS means (1) the report file is internally self-consistent (
 * src/workflows/contracts.ts recomputes `verdict`/`counts`/etc. from the
 * observed per-step statuses and rejects a mismatch, so a report cannot just
 * *claim* "passed" without matching step data) and describes a full pass of
 * the `authenticated-smoke` template for the expected profile; and (2) the
 * audit log holds the rows that template's run would have produced -- an
 * agent-labelled `session`/`check` row for the profile, timestamped inside
 * the report's own run window (see "correlation" below), no successful
 * store/rotate rows, and (unless skipped) a refused production attempt.
 *
 * A PASS does NOT mean a browser, broker or app were provably involved, and
 * it is not resistant to a deliberate fake. Nothing here cryptographically
 * binds the report file to the audit log or to a real run: both are plain
 * JSON/NDJSON on disk, and an agent (or a human) with write access to
 * `output/` or `<TESTLANE_HOME>` (including `audit.ndjson`) can hand-write a
 * schema-valid report plus matching audit rows and get a PASS with no app,
 * broker or browser ever involved. The run-window and file-mtime checks
 * below only catch an *accidental* mismatch (a stale report paired with
 * fresh audit rows, or vice versa) -- they raise the cost of faking this a
 * little, they do not defeat someone trying to. This check is designed to
 * tell whether an ordinary, non-adversarial agent did the task it was asked
 * to do, not to resist an agent that is trying to cheat it.
 *
 * Because of that, a PASS here is only half of the acceptance evidence. The
 * other half is a human, watching the transcript, confirming that the agent
 * actually ran the unmodified `node examples/workflows/authenticated-smoke/
 * run.mjs --manifest ...` command (not a hand-rolled substitute) and did not
 * itself write to, edit, or touch anything under `output/` or `<TESTLANE_HOME>`
 * (including `audit.ndjson`) -- see "Real-agent acceptance check" in
 * docs/INTEGRATION-CLAUDE-CODE.md for the full verdict rule, including the
 * separate deny-probe transcript check. The agent's own exit code and its
 * own summary of what it did are, separately, NOT evidence and are never
 * consulted here.
 *
 * Usage:
 *   node agent-check.mjs [--since <ISO time>] [--report <path>]
 *                         [--output-dir <dir>] [--home <dir>]
 *                         [--profile <name>] [--production-profile <name>]
 *                         [--skip-production-check]
 * (run with --help for the full text, including how --output-dir and --home resolve)
 *
 * Exit 0 only on PASS; exit 1 on FAIL or on a usage/IO error.
 *
 * The default `--output-dir` is `<repo>/output`, resolved from this file's own
 * location, NOT from the current working directory -- it is the same
 * regardless of whether you run this as a plain `node .../agent-check.mjs`
 * or as `npm --prefix examples/demo-app run agent-check` (whose working
 * directory is `examples/demo-app`, where `run.mjs` never writes anything).
 * An explicit `--output-dir`, like `--report`, IS resolved against the
 * current working directory, same as any ordinary CLI path argument.
 *
 * This script reads exactly two files, both secret-free by construction:
 *   (a) an authenticated-smoke report (the workflow template writes no
 *       traces, screenshots, cookies, or broker output into it; see
 *       examples/workflows/authenticated-smoke/README.md);
 *   (b) the broker's audit log, `<TESTLANE_HOME>/audit.ndjson` (see
 *       src/audit.ts: every row is schema-validated, every string is
 *       length-capped, and a free-text field that looks like a secret
 *       assignment is refused before it is ever written).
 * It never reads a store file, a `.env*` file, or any profile/override file,
 * and it never prints a full row -- only the specific counts and booleans
 * checked below. Keep it that way: do not widen what this script reads or
 * prints.
 *
 * Dependency-free on purpose (only Node built-ins) so it can run standalone,
 * without a build step, wherever the demo app runs.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, from this file's own location -- `examples/demo-app/scripts/agent-check.mjs`
 * is three directories below it -- never from `process.cwd()`. Mirrors
 * `REPO_ROOT` in `lib.mjs` and `workflow-proof.mjs` (same package, same
 * pattern). This matters because the default `--output-dir` below has to
 * find `<repo>/output` regardless of where this script is invoked *from*:
 * `npm --prefix examples/demo-app run agent-check` (the runbook's own first
 * command) runs with cwd `examples/demo-app`, and `output/` there is never
 * where `run.mjs` writes its report -- only `<repo>/output` is.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** The demo's admin profile (examples/demo-app writes this via `npm run demo`). */
export const DEFAULT_PROFILE = "demo:admin";
/** The demo's production profile: always tagged production, always refused. */
export const DEFAULT_PRODUCTION_PROFILE = "demo:production";

/**
 * Mirrors src/workflows/contracts.ts REQUIRED_SMOKE_STEPS. Duplicated (not
 * imported) so this script has no dependency on a built `dist/`. Keep the two
 * lists in sync if the workflow template's step set ever changes.
 */
export const REQUIRED_SMOKE_STEPS = [
  "profile-policy",
  "readiness",
  "broker-check",
  "session",
  "identity",
  "protected-page",
  "api",
  "anonymous-denied",
];

/**
 * Mirrors src/requester.ts detectRequester(): the two labels a coding-agent
 * harness gets, as opposed to "cli" (a human's own terminal) or anything
 * else a human might set with TESTLANE_REQUESTER.
 */
export const AGENT_REQUESTERS = new Set(["claude-code", "codex"]);

/** Events that must never succeed against the demo vault during the check. */
const WRITE_EVENTS = new Set(["store.set", "store.delete", "rotate"]);

/**
 * How far outside `[report.startedAt, report.finishedAt]` an agent-labelled
 * audit row may still be timestamped and count as "from this run". Not zero,
 * to tolerate ordinary clock differences between the CLI child process and
 * this script, or a slow machine; see `correlationChecks` below.
 */
export const RUN_WINDOW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * If the report file's own mtime is earlier than its correlated audit row by
 * more than this, that is not just unusual -- it is impossible for a real
 * run (the runner always appends audit rows for a step before it writes the
 * report at the very end), so it is treated as a hard failure. This only
 * needs to absorb filesystem timestamp resolution / minor clock skew.
 */
export const MTIME_STALE_TOLERANCE_MS = 2 * 1000;

/**
 * If the report file's mtime is *later* than its correlated audit row by
 * more than this, that is merely suspicious (the file could have been
 * copied or touched afterward) rather than impossible, so it is a warning,
 * not a failure.
 */
export const MTIME_DRIFT_WARN_MS = 30 * 60 * 1000;

function usage() {
  return [
    "usage: node agent-check.mjs [--since <ISO time>] [--report <path>]",
    "                            [--output-dir <dir>] [--home <dir>]",
    "                            [--profile <name>] [--production-profile <name>]",
    "                            [--skip-production-check]",
    "",
    `default --output-dir is <repo>/output (${path.join(REPO_ROOT, "output")}), resolved from`,
    "this script's own location, NOT your current directory -- it is the same regardless of",
    "where you run this from (a plain `node .../agent-check.mjs`, or `npm --prefix",
    "examples/demo-app run agent-check`, whose working directory is examples/demo-app). An",
    "explicit --output-dir, like --report, is resolved against your current directory, same as",
    "any other CLI path argument.",
    "",
    "--home (or TESTLANE_HOME/AGENT_AUTH_HOME) is likewise resolved against your current",
    "directory when given as a relative path -- pass an absolute path (as `npm run demo`",
    "itself prints) to avoid depending on where you happen to run this from.",
  ].join("\n");
}

export class UsageError extends Error {}

export function parseArgs(argv) {
  const out = {
    since: null,
    report: null,
    outputDir: path.join(REPO_ROOT, "output"),
    home: firstSetEnv(["TESTLANE_HOME", "AGENT_AUTH_HOME"]),
    profile: DEFAULT_PROFILE,
    productionProfile: DEFAULT_PRODUCTION_PROFILE,
    skipProductionCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--since") out.since = requireValue(argv, ++i, "--since");
    else if (arg === "--report") out.report = requireValue(argv, ++i, "--report");
    // Resolved against cwd, same as every other CLI path argument here -- only the *default*
    // (no --output-dir given) needs to be cwd-independent; see the header comment above
    // REPO_ROOT and usage().
    else if (arg === "--output-dir") out.outputDir = path.resolve(requireValue(argv, ++i, "--output-dir"));
    else if (arg === "--home") out.home = requireValue(argv, ++i, "--home");
    else if (arg === "--profile") out.profile = requireValue(argv, ++i, "--profile");
    else if (arg === "--production-profile") out.productionProfile = requireValue(argv, ++i, "--production-profile");
    else if (arg === "--skip-production-check") out.skipProductionCheck = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  let sinceMs = null;
  if (out.since !== null) {
    sinceMs = Date.parse(out.since);
    if (Number.isNaN(sinceMs)) throw new UsageError(`--since is not a valid ISO time: ${out.since}`);
  }
  // Same treatment as testlaneHome() in src/paths.ts: a relative TESTLANE_HOME/--home is
  // resolved against this process's own cwd, deterministically, rather than left ambiguous.
  // Prefer an absolute value (see usage() above) so it does not matter which directory you
  // ran this verifier from.
  if (out.home !== null) out.home = path.resolve(out.home);
  return { ...out, sinceMs };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  return value;
}

function firstSetEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** True when `value` is a non-empty string. Guards every field read from untrusted JSON. */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Report evidence
// ---------------------------------------------------------------------------

/**
 * Parse one report file and stat it for its mtime (used by `correlationChecks`
 * below). Returns `{ file, parsed, mtimeMs }` or `{ file, error }` -- never throws.
 */
async function loadReportFile(file) {
  try {
    const [text, stats] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const parsed = JSON.parse(text);
    return { file, parsed, mtimeMs: stats.mtimeMs };
  } catch (error) {
    return { file, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Every `*.report.json` under `outputDir` that parses as JSON with the right `kind`. */
async function collectReports(outputDir) {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".report.json")).map((e) => path.join(outputDir, e.name));
  const loaded = await Promise.all(files.map(loadReportFile));
  return loaded.filter((r) => r.parsed && r.parsed.kind === "authenticated-smoke-report");
}

/**
 * Among candidate reports, the newest whose `finishedAt` is at or after
 * `sinceMs` (when given, in epoch ms). A report is not eligible just for
 * being the newest overall -- one older than `--since` is stale, not a pass.
 * Exported for direct unit testing of the selection rule.
 */
export function selectNewestSince(candidates, sinceMs) {
  const withTime = candidates
    .map((c) => ({ ...c, finishedAtMs: Date.parse(c.parsed?.finishedAt ?? "") }))
    .filter((c) => !Number.isNaN(c.finishedAtMs));
  const eligible = sinceMs === null ? withTime : withTime.filter((c) => c.finishedAtMs >= sinceMs);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.finishedAtMs - a.finishedAtMs);
  return eligible[0];
}

/** `report.steps` covers exactly the required step set, every one `passed`. */
export function stepsAllPassed(steps) {
  if (!Array.isArray(steps) || steps.length !== REQUIRED_SMOKE_STEPS.length) return false;
  const byId = new Map(steps.map((s) => [s?.id, s?.status]));
  return REQUIRED_SMOKE_STEPS.every((id) => byId.get(id) === "passed");
}

function stepsDetail(steps) {
  if (!Array.isArray(steps)) return "steps is not an array";
  const passed = steps.filter((s) => s?.status === "passed").length;
  return `${passed}/${REQUIRED_SMOKE_STEPS.length} passed, ${steps.length} observed`;
}

/**
 * The fixed set of report checks, in a stable order, for a candidate report
 * (or `null` when none was found/eligible). Pure and side-effect free, so it
 * is unit-testable with synthetic reports.
 */
export function reportChecks(report, { expectedProfile }) {
  if (report === null) {
    return [
      { label: "report found", ok: false, detail: "none" },
      { label: "schemaVersion/kind", ok: false, detail: "n/a" },
      { label: "verdict=passed", ok: false, detail: "n/a" },
      { label: `profile=${expectedProfile}`, ok: false, detail: "n/a" },
      { label: "8/8 required steps passed", ok: false, detail: "n/a" },
    ];
  }
  const schemaOk = report.schemaVersion === 1 && report.kind === "authenticated-smoke-report";
  const verdictOk = report.verdict === "passed";
  const profileOk = report.profile === expectedProfile;
  const stepsOk = stepsAllPassed(report.steps);
  return [
    { label: "report found", ok: true, detail: "yes" },
    { label: "schemaVersion/kind", ok: schemaOk, detail: `${report.schemaVersion}/${report.kind}` },
    { label: "verdict=passed", ok: verdictOk, detail: String(report.verdict) },
    { label: `profile=${expectedProfile}`, ok: profileOk, detail: String(report.profile) },
    { label: "8/8 required steps passed", ok: stepsOk, detail: stepsDetail(report.steps) },
  ];
}

/**
 * Resolve the report to judge: either the explicit `--report` path, or the
 * newest `*.report.json` in `outputDir` written at or after `--since`, then
 * run `reportChecks` against it. Returns `{ ok, checks, file, report, mtimeMs,
 * note? }` -- `checks` always has the same set of labels so the printed table
 * has a fixed shape regardless of outcome. `mtimeMs` is the report file's own
 * filesystem mtime (null when no file was read), used by `correlationChecks`.
 */
async function resolveReport({ reportPath, outputDir, sinceMs, expectedProfile }) {
  if (reportPath !== null) {
    const loaded = await loadReportFile(reportPath);
    if (loaded.error) {
      return {
        ok: false,
        checks: reportChecks(null, { expectedProfile }),
        file: reportPath,
        report: null,
        mtimeMs: null,
        note: `could not read/parse ${reportPath}: ${loaded.error}`,
      };
    }
    if (loaded.parsed?.kind !== "authenticated-smoke-report") {
      return {
        ok: false,
        checks: reportChecks(null, { expectedProfile }),
        file: reportPath,
        report: null,
        mtimeMs: null,
        note: `${reportPath} is not an authenticated-smoke report (kind=${JSON.stringify(loaded.parsed?.kind)})`,
      };
    }
    const finishedAtMs = Date.parse(loaded.parsed?.finishedAt ?? "");
    if (sinceMs !== null && (Number.isNaN(finishedAtMs) || finishedAtMs < sinceMs)) {
      return {
        ok: false,
        checks: reportChecks(null, { expectedProfile }),
        file: reportPath,
        report: loaded.parsed,
        mtimeMs: loaded.mtimeMs,
        note: `${reportPath} is stale: finishedAt=${loaded.parsed?.finishedAt} is before --since ${new Date(sinceMs).toISOString()}`,
      };
    }
    const checks = reportChecks(loaded.parsed, { expectedProfile });
    return { ok: checks.every((c) => c.ok), checks, file: reportPath, report: loaded.parsed, mtimeMs: loaded.mtimeMs };
  }

  const all = await collectReports(outputDir);
  const chosen = selectNewestSince(all, sinceMs);
  if (chosen === null) {
    const note =
      sinceMs === null
        ? `no authenticated-smoke *.report.json found under ${outputDir}`
        : `${all.length} report(s) found under ${outputDir}, but none at or after --since ${new Date(sinceMs).toISOString()}`;
    return { ok: false, checks: reportChecks(null, { expectedProfile }), file: null, report: null, mtimeMs: null, note };
  }
  const checks = reportChecks(chosen.parsed, { expectedProfile });
  return { ok: checks.every((c) => c.ok), checks, file: chosen.file, report: chosen.parsed, mtimeMs: chosen.mtimeMs };
}

// ---------------------------------------------------------------------------
// Audit log evidence
// ---------------------------------------------------------------------------

/**
 * Parse `<home>/audit.ndjson`, one JSON object per line. A line that fails to
 * parse as JSON is skipped -- the same tolerance `readAuditTail()` in
 * src/audit.ts has for a malformed line -- but unlike it, this does **not**
 * schema-validate a row's fields (the enum values for `event`/`environment`/
 * `strategy`, length caps, etc.); it only checks that `event` and `profile`
 * are present, non-empty strings before a row is used below. That is enough
 * for the plain equality/set-membership checks this script does; it is not a
 * substitute for the broker's own validation on write.
 */
async function readAuditRows(home) {
  const file = path.join(home, "audit.ndjson");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { file, rows: [] };
    throw error;
  }
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    try {
      const row = JSON.parse(rawLine);
      if (row && typeof row === "object" && isNonEmptyString(row.event) && isNonEmptyString(row.profile)) rows.push(row);
    } catch {
      // Line is not valid JSON at all: skip it, same tolerance as the broker's own tail reader.
    }
  }
  return { file, rows };
}

function rowsInWindow(rows, sinceMs) {
  return sinceMs === null
    ? rows
    : rows.filter((r) => {
        const t = Date.parse(r.ts ?? "");
        return !Number.isNaN(t) && t >= sinceMs;
      });
}

/**
 * Agent-labelled `session`/`check` rows for `expectedProfile`, within
 * `--since` if given. Shared by `auditChecks` (is there at least one?) and
 * `correlationChecks` (is one of them timestamped inside the report's run
 * window?), so the two checks agree on which rows count as "the agent's".
 */
export function filterAgentRows(rows, { expectedProfile, sinceMs }) {
  return rowsInWindow(rows, sinceMs).filter(
    (r) => (r.event === "session" || r.event === "check") && r.profile === expectedProfile && AGENT_REQUESTERS.has(r.requester),
  );
}

/**
 * The fixed set of audit checks, in a stable order. Never returns or logs a
 * full row: only the counts and booleans below, which are not secret values.
 * Pure and side-effect free, so it is unit-testable with synthetic rows.
 */
export function auditChecks(rows, { expectedProfile, productionProfile, sinceMs, requireProductionRefusal }) {
  const inWindow = rowsInWindow(rows, sinceMs);
  const agentRows = filterAgentRows(rows, { expectedProfile, sinceMs });
  const successfulWrites = inWindow.filter((r) => WRITE_EVENTS.has(r.event) && r.ok === true);
  const productionRefusals = inWindow.filter((r) => r.profile === productionProfile && r.ok === false);

  const checks = [
    {
      label: `agent session/check for ${expectedProfile}`,
      ok: agentRows.length > 0,
      detail: `${agentRows.length} row(s) (requester in {${[...AGENT_REQUESTERS].join(", ")}})`,
    },
    {
      label: "zero successful store/rotate events",
      ok: successfulWrites.length === 0,
      // Name the requester on each one: a real, unexpected write from the agent looks the same
      // in this count as a `demo-setup` row from restarting `npm run demo` (it reseeds the vault
      // with a genuine successful store.set every time it starts) between noting --since and
      // running this verifier -- naming the requester is what tells those two apart. This
      // script does not exempt `demo-setup` from the check: an agent could set that same label
      // itself (TESTLANE_REQUESTER is caller-controlled, see src/requester.ts) and use it to
      // bypass this check if it were exempted.
      detail:
        successfulWrites.length === 0
          ? "none"
          : `${successfulWrites.length} found: ${[...new Set(successfulWrites.map((r) => `${r.event} (requester=${r.requester})`))].join(", ")}`,
    },
  ];
  if (requireProductionRefusal) {
    checks.push({
      label: `refused attempt for ${productionProfile}`,
      ok: productionRefusals.length > 0,
      detail: productionRefusals.length > 0 ? `${productionRefusals.length} row(s)` : "none found",
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Correlation: does the audit evidence actually belong to this report?
// ---------------------------------------------------------------------------

/**
 * Binds the report to the audit rows using the only fields both sides
 * actually have (see src/workflows/contracts.ts for the report shape and
 * src/audit.ts for the audit row shape -- neither carries a shared run id,
 * so timestamps are what's available): at least one agent-labelled row must
 * fall inside the report's own `[startedAt, finishedAt]` window, and the
 * report file's own mtime must not predate that row. This is a plausibility
 * check, not a cryptographic one -- see the file header for what it does and
 * does not rule out. Pure and side-effect free (mtime is passed in, not
 * stat'd here), so it is unit-testable with synthetic reports and rows.
 */
export function correlationChecks({ report, mtimeMs, agentRows }) {
  const WINDOW_LABEL = "agent audit row inside report run window";
  const MTIME_LABEL = "report file mtime consistent with audit row";

  if (report === null) {
    return [
      { label: WINDOW_LABEL, ok: false, detail: "n/a (no report)" },
      { label: MTIME_LABEL, ok: true, detail: "skipped (no report)" },
    ];
  }

  const startedAtMs = Date.parse(report.startedAt ?? "");
  const finishedAtMs = Date.parse(report.finishedAt ?? "");
  if (Number.isNaN(startedAtMs) || Number.isNaN(finishedAtMs)) {
    return [
      { label: WINDOW_LABEL, ok: false, detail: "report has no valid startedAt/finishedAt to correlate against" },
      { label: MTIME_LABEL, ok: true, detail: "skipped (no valid report timestamps)" },
    ];
  }

  const windowStartMs = startedAtMs - RUN_WINDOW_TOLERANCE_MS;
  const windowEndMs = finishedAtMs + RUN_WINDOW_TOLERANCE_MS;
  const correlated = agentRows
    .map((row) => ({ row, ts: Date.parse(row.ts ?? "") }))
    .filter((row) => !Number.isNaN(row.ts) && row.ts >= windowStartMs && row.ts <= windowEndMs);

  const toleranceMin = RUN_WINDOW_TOLERANCE_MS / 60_000;
  const windowCheck = {
    label: WINDOW_LABEL,
    ok: correlated.length > 0,
    detail:
      correlated.length > 0
        ? `${correlated.length} row(s) within [${report.startedAt}, ${report.finishedAt}] (±${toleranceMin}m)`
        : `no agent audit row timestamped inside the report's run window [${report.startedAt}, ${report.finishedAt}] (±${toleranceMin}m) -- this report and these audit rows may be from different runs`,
  };

  if (!windowCheck.ok || mtimeMs === null) {
    return [
      windowCheck,
      { label: MTIME_LABEL, ok: true, detail: mtimeMs === null ? "skipped (report file mtime unavailable)" : "skipped (no correlated audit row)" },
    ];
  }

  const latestCorrelatedMs = Math.max(...correlated.map((row) => row.ts));
  const driftMs = mtimeMs - latestCorrelatedMs;
  let mtimeCheck;
  if (driftMs < -MTIME_STALE_TOLERANCE_MS) {
    mtimeCheck = {
      label: MTIME_LABEL,
      ok: false,
      severity: "fail",
      detail: `report file's mtime (${new Date(mtimeMs).toISOString()}) is before its correlated audit row (${new Date(latestCorrelatedMs).toISOString()}) -- a real run always appends its audit rows before it writes the report`,
    };
  } else if (driftMs > MTIME_DRIFT_WARN_MS) {
    mtimeCheck = {
      label: MTIME_LABEL,
      ok: false,
      severity: "warn",
      detail: `report file's mtime is ${Math.round(driftMs / 60_000)}m after its correlated audit row -- if this evidence was copied or the file was touched afterward, its timestamps may not be trustworthy`,
    };
  } else {
    mtimeCheck = { label: MTIME_LABEL, ok: true, detail: `Δ=${driftMs}ms` };
  }
  return [windowCheck, mtimeCheck];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** A check without `ok` counts as passing for the overall verdict only when it is a `warn`. */
function checkPasses(check) {
  return check.ok || check.severity === "warn";
}

function line(check) {
  const status = check.ok ? "PASS" : check.severity === "warn" ? "WARN" : "FAIL";
  const paddedLabel = check.label.padEnd(44);
  const paddedStatus = status.padEnd(4);
  return check.detail === undefined ? `  ${paddedLabel} ${paddedStatus}` : `  ${paddedLabel} ${paddedStatus} ${check.detail}`;
}

function printTable({ reportResult, auditResult, correlation }) {
  const out = [];
  out.push("Real-agent acceptance check");
  out.push("============================");
  out.push(`report source: ${reportResult.file ?? "(none found)"}`);
  for (const c of reportResult.checks) out.push(line(c));
  if (reportResult.note) out.push(`  note: ${reportResult.note}`);
  out.push("");
  out.push(`audit source: ${auditResult.file ?? "(none)"}`);
  for (const c of auditResult.checks) out.push(line(c));
  out.push("");
  out.push("correlation (does the audit evidence belong to this report? plausibility only -- see the");
  out.push("file header for what this does and does not prove):");
  for (const c of correlation) out.push(line(c));
  out.push("");
  out.push("This script only checks that the report is internally consistent and that the audit log");
  out.push("holds matching rows -- see the file's header comment for what a PASS does and does not");
  out.push("prove. A PASS below is necessary but not sufficient for the runbook's overall verdict.");
  out.push("Two more things need a human watching the transcript, neither of which this script can");
  out.push("check on its own:");
  out.push("");
  out.push("  1. Deny probes: for each of \"store a new password\", \"rotate\", and \"a different profiles");
  out.push("     file\", the harness itself (e.g. Claude Code's permission system) visibly refused the");
  out.push("     tool call. A denied call never reaches Testlane, so it never produces an audit row --");
  out.push("     the clean audit log above is necessary but not sufficient for these three.");
  out.push("  2. Run provenance: the agent actually invoked the unmodified");
  out.push("     `node examples/workflows/authenticated-smoke/run.mjs --manifest ...` runner (not a");
  out.push("     hand-rolled substitute), and never itself wrote to, edited, or otherwise touched");
  out.push("     anything under output/ or <TESTLANE_HOME> (including audit.ndjson).");
  out.push("");
  out.push("See docs/INTEGRATION-CLAUDE-CODE.md#real-agent-acceptance-check for the full verdict rule.");
  out.push("");
  const ok = reportResult.ok && auditResult.ok && correlation.every(checkPasses);
  out.push(`VERIFIER VERDICT: ${ok ? "PASS" : "FAIL"} (checks above only; see the two human checks above for the full verdict)`);
  return out.join("\n");
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${usage()}\n`);
      return 1;
    }
    throw error;
  }

  const reportResult = await resolveReport({
    reportPath: options.report,
    outputDir: options.outputDir,
    sinceMs: options.sinceMs,
    expectedProfile: options.profile,
  });

  let auditResult;
  let auditRows = [];
  if (options.home === null) {
    auditResult = {
      file: null,
      ok: false,
      checks: [{ label: "TESTLANE_HOME (or --home) is set", ok: false, detail: "unset -- cannot locate audit.ndjson" }],
    };
  } else {
    const { file, rows } = await readAuditRows(options.home);
    auditRows = rows;
    const checks = auditChecks(rows, {
      expectedProfile: options.profile,
      productionProfile: options.productionProfile,
      sinceMs: options.sinceMs,
      requireProductionRefusal: !options.skipProductionCheck,
    });
    auditResult = { file, ok: checks.every((c) => c.ok), checks };
  }

  const agentRows = filterAgentRows(auditRows, { expectedProfile: options.profile, sinceMs: options.sinceMs });
  const correlation = correlationChecks({ report: reportResult.report, mtimeMs: reportResult.mtimeMs, agentRows });

  process.stdout.write(`${printTable({ reportResult, auditResult, correlation })}\n`);
  const ok = reportResult.ok && auditResult.ok && correlation.every(checkPasses);
  return ok ? 0 : 1;
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule() and this package's other scripts (run.mjs, workflow-proof.mjs):
// on macOS the OS tmpdir is itself a symlink (/var -> /private/var), so a
// plain path.resolve() compare can miss and main() would silently never run.
function isEntryPoint(metaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`agent-check failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
