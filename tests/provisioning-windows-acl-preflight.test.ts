/** Fixed-only evidence for the first real Windows ACL path; no provider/browser/store. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { it, vi } from "vitest";
import { createBrowserPrivateDirectory } from "../src/provisioning/private-directory.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
type Event = "start" | "stdin-finished" | "error" | "exit" | "close" | "timeout" | "stop-wait-expired";
interface Observation {
  ordinal: number; operation: "create" | "verify"; began: number;
  argumentsFixed: boolean; environmentFixed: boolean; cwdFixed: boolean; pipeStdio: boolean;
  spawned: boolean; stdinFinished: boolean; exited: boolean; closed: boolean; code: number | null;
  stdoutBytes: number; stderrBytes: number; stderrEmpty: boolean; readyEqual: boolean;
  timeout: boolean; stopWaitExpired: boolean; observationOverflow: boolean;
  events: { event: Event; elapsedMs: number; code: number | null }[];
}
const READY = Buffer.from("BROWSER_PRIVATE_DIRECTORY_READY");
const REFUSALS = ["BROWSER_PRIVATE_DIRECTORY_REFUSED", "BROWSER_PRIVATE_DIRECTORY_STOP_UNCONFIRMED", "BROWSER_PRIVATE_DIRECTORY_EXISTS", "BROWSER_CANCELLED"];
function fixed(): Error { const error = new Error("BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED"); error.stack = error.message; return error; }
function fixedFailure(value: unknown): string {
  if (value === null || typeof value !== "object" || types.isProxy(value) || !types.isNativeError(value)) return "BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED";
  const descriptor = Object.getOwnPropertyDescriptor(value, "message");
  return descriptor && Object.hasOwn(descriptor, "value") && REFUSALS.includes(descriptor.value as string) ? descriptor.value as string : "BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED";
}

it.skipIf(process.platform !== "win32")("the first real Windows private-directory path has bounded fixed-only subprocess evidence", async () => {
  const originalSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
  const originalTimeout = globalThis.setTimeout, began = performance.now();
  const observations: Observation[] = []; let spawnTimerAdmission: Observation | undefined, stopTimerAdmission: Observation | undefined, frozen = false;
  let passed = false, failureCode = "BROWSER_WINDOWS_ACL_PREFLIGHT_FAILED", fixtureRemoved = false;
  let root: string | undefined, parent: string | undefined;
  const elapsed = (start: number) => Math.max(0, Math.min(3600000, Math.round(performance.now() - start)));
  const event = (row: Observation, kind: Event, code: number | null = null) => {
    if (frozen) return;
    if (row.events.length >= 16) { row.observationOverflow = true; return; }
    row.events.push({ event: kind, elapsedMs: elapsed(row.began), code: Number.isSafeInteger(code) ? code : null });
  };
  try {
    const selected = process.env["LOCALAPPDATA"], system = process.env["SystemRoot"];
    if (typeof selected !== "string" || !path.isAbsolute(selected) || typeof system !== "string" || !path.isAbsolute(system)) throw fixed();
    parent = await realpath(selected); root = path.join(parent, "testlane-acl-preflight-" + randomUUID());
    vi.mocked(spawn).mockImplementation((executable, args, options) => {
      if (observations.length >= 2) throw fixed();
      const actualArgs = args as readonly string[], actualOptions = options!;
      const row: Observation = { ordinal: observations.length + 1, operation: observations.length === 0 ? "create" : "verify", began: performance.now(),
        argumentsFixed: executable === path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe") && actualArgs.length === 5 &&
          actualArgs.slice(0, 4).join("|") === "-NoLogo|-NoProfile|-NonInteractive|-Command" && typeof actualArgs[4] === "string",
        environmentFixed: Object.keys(actualOptions.env ?? {}).sort().join("|") === "PATH|SystemRoot|windir" &&
          actualOptions.env?.["SystemRoot"] === system && actualOptions.env?.["windir"] === system && actualOptions.env?.["PATH"] === path.join(system, "System32"),
        cwdFixed: actualOptions.cwd === parent, pipeStdio: Array.isArray(actualOptions.stdio) && actualOptions.stdio.join("|") === "pipe|pipe|pipe",
        spawned: false, stdinFinished: false, exited: false, closed: false, code: null, stdoutBytes: 0, stderrBytes: 0,
        stderrEmpty: true, readyEqual: false, timeout: false, stopWaitExpired: false, observationOverflow: false, events: [] };
      observations.push(row); spawnTimerAdmission = row; queueMicrotask(() => { if (spawnTimerAdmission === row) spawnTimerAdmission = undefined; }); event(row, "start");
      if (!row.argumentsFixed || !row.environmentFixed || !row.cwdFixed || !row.pipeStdio) throw fixed();
      const child = Reflect.apply(originalSpawn, undefined, [executable, args, options]); let prefix = Buffer.alloc(0);
      const originalKill = child.kill;
      child.kill = function (this: typeof child, signal?: NodeJS.Signals | number) {
        stopTimerAdmission = row; queueMicrotask(() => { if (stopTimerAdmission === row) stopTimerAdmission = undefined; });
        return Reflect.apply(originalKill, this, [signal]);
      };
      child.once("spawn", () => { if (!frozen) row.spawned = true; });
      child.once("error", () => event(row, "error"));
      child.once("exit", code => { if (!frozen) { row.exited = true; row.code = Number.isSafeInteger(code) ? code : null; event(row, "exit", code); } });
      child.once("close", code => { if (!frozen) { row.closed = true; row.code = Number.isSafeInteger(code) ? code : null; row.readyEqual = row.stdoutBytes === READY.length && prefix.equals(READY); event(row, "close", code); } });
      child.stdin?.once("finish", () => { if (!frozen) { row.stdinFinished = true; event(row, "stdin-finished"); } });
      child.stdout?.on("data", (chunk: Buffer) => { if (!frozen) { row.stdoutBytes = Math.min(2147483647, row.stdoutBytes + chunk.length); if (prefix.length < READY.length) prefix = Buffer.concat([prefix, chunk.subarray(0, READY.length - prefix.length)]); } });
      child.stderr?.on("data", (chunk: Buffer) => { if (!frozen) { row.stderrBytes = Math.min(2147483647, row.stderrBytes + chunk.length); row.stderrEmpty = false; } });
      return child;
    });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      // Only the synchronous leaf scheduling windows are eligible. A timer from
      // another callback with the same delay must never become leaf evidence.
      const row = delay === 15000 ? spawnTimerAdmission : delay === 5000 ? stopTimerAdmission : undefined;
      if (!row) return Reflect.apply(originalTimeout, globalThis, [callback, delay, ...args]);
      if (delay === 15000) spawnTimerAdmission = undefined; else stopTimerAdmission = undefined;
      return Reflect.apply(originalTimeout, globalThis, [() => {
        if (!frozen) { if (delay === 15000) row.timeout = true; else row.stopWaitExpired = true; event(row, delay === 15000 ? "timeout" : "stop-wait-expired"); }
        callback(...args);
      }, delay]);
    }) as typeof setTimeout);
    const accepted = await createBrowserPrivateDirectory(root);
    if (accepted !== root || observations.length !== 2 || observations.some(row => !row.closed || row.code !== 0 || !row.readyEqual || !row.stderrEmpty || row.observationOverflow)) throw fixed();
    const before = await lstat(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root || path.dirname(root) !== parent || (await readdir(root)).length) throw fixed();
    const after = await lstat(root, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) throw fixed();
    await rmdir(root); fixtureRemoved = true; passed = true; failureCode = "COMPLETED";
  } catch (error) { failureCode = fixedFailure(error); }
  finally {
    frozen = true; vi.restoreAllMocks();
    // No arbitrary strings, source script/input/output, errors, path, PID, SID or
    // environment values are exported. Stdin finish does not prove PS parsed it.
    const runtime = process.versions.node.split(".").map(Number);
    console.info(JSON.stringify({ schemaVersion: 1, diagnostic: "windows-private-directory-preflight", passed, failureCode,
      elapsedMs: elapsed(began), runtime: runtime.length === 3 && runtime.every(Number.isSafeInteger) ? runtime : [],
      operations: observations.map(({ began: _began, ...row }) => row), fixtureRemoved,
      cleanupSkippedAfterRefusal: !passed, rawOutputExported: false, leafTimeoutMs: 15000, leafStopWaitMs: 5000 }));
  }
  if (!passed) throw fixed();
}, 45000);
