/** Test-only follow-up: one marked copy of the unchanged guard, never a product fix. */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const READY = "BROWSER_PRIVATE_DIRECTORY_READY", REFUSED = "BROWSER_PRIVATE_DIRECTORY_REFUSED";
const STAGES = ["entry", "input-begin", "input-end", "json-end", "identity-end", "parent-info-end", "parent-acl-begin", "parent-acl-end", "parent-rules-end", "create-begin", "create-end", "target-info-end", "target-acl-begin", "target-acl-end", "target-rules-end", "ready", "refused"] as const;
type Stage = typeof STAGES[number];
function fixed(): Error { const error = new Error("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED"); error.stack = error.message; return error; }
function once(text: string, from: string, to: string): string {
  const at = text.indexOf(from); if (at < 0 || text.indexOf(from, at + from.length) >= 0) throw fixed();
  return text.slice(0, at) + to + text.slice(at + from.length);
}
export function markedWindowsDirectoryScript(source: string): { script: string; original: string; reconstructed: string } {
  const match = [...source.matchAll(/const WINDOWS_PRIVATE_DIRECTORY = String\.raw`([^`]+)`;/g)];
  if (match.length !== 1 || !match[0]?.[1]) throw fixed();
  const original = match[0][1], nl = original.includes("\r\n") ? "\r\n" : "\n";
  const marker = (stage: Stage) => `[Console]::Error.WriteLine('TLACL:${stage}')`;
  const changes: [string, string][] = [];
  const edit = (from: string, to: string) => { changes.push([from, to]); };
  edit("$ErrorActionPreference='Stop'", marker("entry") + nl + "$ErrorActionPreference='Stop'");
  edit("  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json", "  " + marker("input-begin") + nl + "  $raw=[Console]::In.ReadToEnd()" + nl + "  " + marker("input-end") + nl + "  $request=$raw | ConvertFrom-Json" + nl + "  " + marker("json-end"));
  edit("  $inheritance=", "  " + marker("identity-end") + nl + "  $inheritance=");
  edit("  $parentSecurity=", "  " + marker("parent-info-end") + nl + "  " + marker("parent-acl-begin") + nl + "  $parentSecurity=");
  edit("  $trusted=@", "  " + marker("parent-acl-end") + nl + "  $trusted=@");
  edit("  if ($request.operation -eq 'create') {", "  " + marker("parent-rules-end") + nl + "  if ($request.operation -eq 'create') {");
  edit("    $null=[IO.Directory]::CreateDirectory($target,$security)", "    " + marker("create-begin") + nl + "    $null=[IO.Directory]::CreateDirectory($target,$security)" + nl + "    " + marker("create-end"));
  edit("  $actual=", "  " + marker("target-info-end") + nl + "  " + marker("target-acl-begin") + nl + "  $actual=");
  edit("  if (-not $actual.AreAccessRulesProtected", "  " + marker("target-acl-end") + nl + "  if (-not $actual.AreAccessRulesProtected");
  edit("  [Console]::Out.Write('" + READY + "')", "  " + marker("target-rules-end") + nl + "  " + marker("ready") + nl + "  [Console]::Out.Write('" + READY + "')");
  edit("} catch {", "} catch {" + nl + "  " + marker("refused"));
  let script = original; for (const [from, to] of changes) script = once(script, from, to);
  let reconstructed = script; for (const [from, to] of [...changes].reverse()) reconstructed = once(reconstructed, to, from);
  if (reconstructed !== original) throw fixed();
  return { script, original, reconstructed };
}
export async function retainFailedWindowsPreflight(passed: boolean, originalChildClosed: boolean, probe: () => Promise<void>): Promise<void> {
  if (passed) return;
  if (originalChildClosed) { try { await probe(); } catch { /* Diagnostic refusal must never replace the original failure. */ } }
  throw fixed();
}

/** Private seam for inert event controls only; normal call receives actual spawn. */
export async function observeWindowsAclStages(script: string, parent: string, system: string, spawn: typeof nodeSpawn): Promise<object> {
  const target = path.join(parent, "testlane-acl-stages-" + randomUUID());
  const began = performance.now(), elapsed = () => Math.max(0, Math.min(3600000, Math.round(performance.now() - began)));
  let spawned = false, stdinFinished = false, stdinClosed = false, exited = false, closed = false, code: number | null = null;
  let timeout = false, stopWaitExpired = false, unexpectedOutput = false, overflow = false, fixedRefusal = false;
  let stdoutBytes = 0, stderrBytes = 0, output = "", pending = "", next = 0, terminal = false;
  const stages: { stage: Stage; elapsedMs: number }[] = [];
  const take = (line: string) => {
    if (line === REFUSED) { fixedRefusal = true; return; }
    const stage = line.startsWith("TLACL:") ? line.slice(6) as Stage : undefined;
    if (!stage || !STAGES.includes(stage) || terminal || stages.length >= STAGES.length) { unexpectedOutput = true; return; }
    if (stage === "refused") terminal = true;
    else if (stage !== STAGES[next]) { unexpectedOutput = true; return; }
    else next++;
    stages.push({ stage, elapsedMs: elapsed() });
  };
  await new Promise<void>(resolve => {
    let child: ReturnType<typeof nodeSpawn> | undefined, timer: NodeJS.Timeout | undefined, stopTimer: NodeJS.Timeout | undefined, done = false, stopping = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(stopTimer); if (pending) take(pending); resolve(); };
    const stop = () => {
      if (done || stopping) return; stopping = true;
      try { child?.kill("SIGKILL"); } catch { /* Only close is acknowledgement. */ }
      stopTimer = setTimeout(() => { stopWaitExpired = true; child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); finish(); }, 5000);
    };
    try {
      child = spawn(path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        cwd: parent, env: { SystemRoot: system, windir: system, PATH: path.join(system, "System32") }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child.once("spawn", () => { if (!done) spawned = true; });
      child.once("exit", value => { if (!done) { exited = true; code = Number.isSafeInteger(value) ? value : null; } });
      child.once("close", value => { if (!done) { closed = true; code = Number.isSafeInteger(value) ? value : null; finish(); } });
      child.once("error", () => { unexpectedOutput = true; });
      child.stdin!.on("error", () => {});
      child.stdin!.once("finish", () => { if (!done) stdinFinished = true; });
      child.stdin!.once("close", () => { if (!done) stdinClosed = true; });
      child.stdout!.on("data", (bytes: Buffer) => {
        if (done) return; stdoutBytes += bytes.length;
        if (stdoutBytes + stderrBytes > 4096) { overflow = true; stop(); return; }
        output += bytes.toString("utf8");
      });
      child.stderr!.on("data", (bytes: Buffer) => {
        if (done) return; stderrBytes += bytes.length;
        if (stdoutBytes + stderrBytes > 4096) { overflow = true; stop(); return; }
        // Markers are ASCII. Non-ASCII data can only set the fixed unexpected flag.
        if (bytes.some(byte => byte > 127)) { unexpectedOutput = true; return; }
        pending += bytes.toString("ascii");
        let at: number; while ((at = pending.indexOf("\n")) >= 0) { take(pending.slice(0, at).replace(/\r$/, "")); pending = pending.slice(at + 1); }
      });
      timer = setTimeout(() => { timeout = true; stop(); }, 15000);
      child.stdin!.end(JSON.stringify({ operation: "create", path: target }));
    } catch { unexpectedOutput = true; if (child) stop(); else finish(); }
  });
  const readyEqual = output === READY;
  return { schemaVersion: 1, diagnostic: "windows-private-directory-stage-probe", originalPreflightPassed: false,
    executions: 1, scriptReconstructed: true, elapsedMs: elapsed(), spawned, stdinFinished, stdinClosed, exited, closed, code,
    timeout, stopWaitExpired, stdoutBytes: Math.min(stdoutBytes, 2147483647), stderrBytes: Math.min(stderrBytes, 2147483647),
    readyEqual, fixedRefusal, unexpectedOutput, overflow, stages, targetAlwaysRetained: true, rawOutputExported: false,
    diagnosticCompleted: closed && code === 0 && readyEqual && next === STAGES.length - 1 && !terminal && !fixedRefusal && !timeout && !stopWaitExpired && !unexpectedOutput && !overflow && elapsed() < 15000,
    leafTimeoutMs: 15000, leafStopWaitMs: 5000 };
}
export async function runWindowsAclStageProbe(spawn: typeof nodeSpawn): Promise<object> {
  const system = process.env["SystemRoot"], selected = process.env["LOCALAPPDATA"];
  if (typeof system !== "string" || !path.isAbsolute(system) || typeof selected !== "string" || !path.isAbsolute(selected)) throw fixed();
  const parent = await realpath(selected), info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fixed();
  const executable = path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"), executableInfo = await lstat(executable);
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink() || (await realpath(executable)).toLowerCase() !== executable.toLowerCase()) throw fixed();
  const source = await readFile(new URL("../src/provisioning/private-directory.ts", import.meta.url), "utf8");
  if (source.length > 65536) throw fixed();
  const { script } = markedWindowsDirectoryScript(source);
  return observeWindowsAclStages(script, parent, system, spawn);
}
