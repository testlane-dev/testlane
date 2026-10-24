/** Parent process leaf. Captured output and OS exceptions are never printed. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { types } from "node:util";
import { absoluteLocalPath, boundedDataString, copyDenseDataArray, copyOwnDataRecord } from "./worker-contracts.js";

type ChildCode = "BROWSER_CHILD_INPUT_REFUSED" | "BROWSER_CHILD_START_FAILED" | "BROWSER_CHILD_CANCELLED" |
  "BROWSER_CHILD_TIMEOUT" | "BROWSER_CHILD_OUTPUT_LIMIT" | "BROWSER_CHILD_STOP_UNKNOWN" | "BROWSER_CHILD_OUTPUT_INVALID";

export class BrowserChildError extends Error {
  constructor(readonly code: ChildCode, readonly terminationConfirmed: boolean) {
    super(code); this.name = "BrowserChildError";
  }
}
export interface BrowserChildOptions {
  readonly entry: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Explicit parent-built environment. No ambient environment is inherited. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Generated secret goes through stdin only. Never use argv or environment. */
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}
export interface BrowserChildResult { readonly code: number | null; readonly stdout: string; readonly stderrEmpty: boolean }

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const signalAborted = (signal?: AbortSignal): boolean => signal !== undefined && Reflect.apply(abortedGetter, signal, []) === true;
const onAbort = (signal: AbortSignal | undefined, listener: () => void): void => {
  if (signal) Reflect.apply(EventTarget.prototype.addEventListener, signal, ["abort", listener, { once: true }]);
};
const offAbort = (signal: AbortSignal | undefined, listener: () => void): void => {
  if (signal) Reflect.apply(EventTarget.prototype.removeEventListener, signal, ["abort", listener]);
};

/** JS callers receive the same fixed refusal, without getters or coercion. */
function normalizeOptions(value: unknown): BrowserChildOptions {
  try {
    const data = copyOwnDataRecord(value, ["entry", "args", "cwd", "env", "input", "signal", "timeoutMs", "maxOutputBytes"], ["entry", "args", "cwd", "env", "timeoutMs"]);
    const source = data["args"];
    if (types.isProxy(source) || !Array.isArray(source)) throw new Error();
    const length = Object.getOwnPropertyDescriptor(source, "length")?.value as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 128) throw new Error();
    const args = copyDenseDataArray(source, length).map(arg => boundedDataString(arg, 8192));
    if (args.reduce((total, arg) => total + arg.length, 0) > 65536) throw new Error();
    const runtime = data["env"];
    if (!runtime || typeof runtime !== "object" || types.isProxy(runtime) || Object.getPrototypeOf(runtime) !== Object.prototype) throw new Error();
    const keys = Reflect.ownKeys(runtime);
    if (keys.length > 512 || keys.some(key => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(key))) throw new Error();
    const fields = copyOwnDataRecord(runtime, keys as string[]), names = new Set<string>(), env: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(fields)) {
      const folded = key.toUpperCase(), text = fields[key];
      if (names.has(folded) || typeof text !== "string" || text.length > 32768 || /[\x00-\x1f\x7f]/.test(text)) throw new Error();
      names.add(folded); env[key] = text;
    }
    const timeoutMs = data["timeoutMs"], maximum = data["maxOutputBytes"] ?? 256 * 1024;
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 220_000 ||
        typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024) throw new Error();
    const input = data["input"], signal = data["signal"];
    if (input !== undefined && (typeof input !== "string" || input.length > 512 || /[\r\n\0]/.test(input))) throw new Error();
    if (signal !== undefined && (!signal || typeof signal !== "object" || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype)) throw new Error();
    if (signal !== undefined) signalAborted(signal as AbortSignal); // Native brand check; never a caller getter.
    return Object.freeze({ entry: absoluteLocalPath(data["entry"]), cwd: absoluteLocalPath(data["cwd"]),
      args: Object.freeze(args), env: Object.freeze(env), timeoutMs, maxOutputBytes: maximum,
      ...(input === undefined ? {} : { input: input as string }), ...(signal === undefined ? {} : { signal: signal as AbortSignal }) });
  } catch { throw new BrowserChildError("BROWSER_CHILD_INPUT_REFUSED", true); }
}

/**
 * Stop the owned process group/tree, then require the original child's close.
 * A fallback root kill alone never proves descendant termination. A normal
 * successful close relies on the trusted runner's own descendant finalization.
 */
async function stopOwnedTree(child: ChildProcessWithoutNullStreams, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  if (!child.pid) return false;
  let closed = false;
  const observed = () => { closed = true; };
  child.once("close", observed);
  const killRoot = () => { try { child.kill("SIGKILL"); } catch { /* Unknown remains nonpassing. */ } };
  let treeStopped = false;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); treeStopped = true; } catch { killRoot(); }
  } else {
    const system = env["SystemRoot"];
    if (!system || !path.isAbsolute(system)) killRoot();
    else treeStopped = await new Promise<boolean>(resolve => {
      let killer: ReturnType<typeof spawn> | undefined;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (!ok) killRoot();
        resolve(ok);
      };
      const timer = setTimeout(() => { try { killer?.kill("SIGKILL"); } catch { /* Preserve unknown. */ } finish(false); }, 5000);
      try {
        killer = spawn(path.join(system, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
          cwd: path.dirname(system), env, shell: false, windowsHide: true, stdio: "ignore",
        });
        killer.once("error", () => finish(false));
        killer.once("close", code => finish(code === 0));
      } catch { finish(false); }
    });
  }
  if (!closed) await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); child.off("close", finish); resolve(); };
    const timer = setTimeout(finish, 5000);
    child.once("close", finish);
    if (closed) finish();
  });
  child.off("close", observed);
  if (!closed) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  return treeStopped && closed;
}

/** Internal managed launcher; only trusted parent code chooses commands. */
export async function runBrowserChild(value: BrowserChildOptions): Promise<BrowserChildResult> {
  const options = normalizeOptions(value), maximum = options.maxOutputBytes!;
  if (signalAborted(options.signal)) throw new BrowserChildError("BROWSER_CHILD_CANCELLED", true);
  const deadline = performance.now() + options.timeoutMs;
  return new Promise<BrowserChildResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false, stopping = false, startFailed = false, stderrEmpty = true, bytes = 0;
    const output: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const finish = () => { clearTimeout(timer); offAbort(options.signal, abort); };
    const refuse = (code: ChildCode, confirmed: boolean) => {
      if (settled) return;
      settled = true; finish(); output.length = 0;
      reject(new BrowserChildError(code, confirmed));
    };
    const stop = (code: ChildCode) => {
      if (settled || stopping) return;
      stopping = true;
      if (!child) { refuse("BROWSER_CHILD_START_FAILED", true); return; }
      void stopOwnedTree(child, options.env).then(
        confirmed => refuse(confirmed ? code : "BROWSER_CHILD_STOP_UNKNOWN", confirmed),
        () => refuse("BROWSER_CHILD_STOP_UNKNOWN", false),
      );
    };
    const abort = () => stop("BROWSER_CHILD_CANCELLED");
    try {
      child = spawn(options.entry, [...options.args], { cwd: options.cwd, env: options.env, shell: false,
        windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => { /* close/exit determines the nonpassing outcome. */ });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || stopping) return;
        bytes += chunk.length;
        if (bytes > maximum) stop("BROWSER_CHILD_OUTPUT_LIMIT"); else output.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled || stopping) return;
        stderrEmpty = false; bytes += chunk.length;
        if (bytes > maximum) stop("BROWSER_CHILD_OUTPUT_LIMIT");
      });
      child.once("error", () => { startFailed = true; });
      child.once("close", code => {
        if (settled || stopping) return;
        if (startFailed) { refuse("BROWSER_CHILD_START_FAILED", true); return; }
        if (signalAborted(options.signal)) { refuse("BROWSER_CHILD_CANCELLED", true); return; }
        if (performance.now() >= deadline) { refuse("BROWSER_CHILD_TIMEOUT", true); return; }
        let stdout: string;
        try { stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)); }
        catch { refuse("BROWSER_CHILD_OUTPUT_INVALID", true); return; }
        settled = true; finish(); output.length = 0;
        resolve(Object.freeze({ code, stdout, stderrEmpty }));
      });
      timer = setTimeout(() => stop("BROWSER_CHILD_TIMEOUT"), options.timeoutMs);
      onAbort(options.signal, abort);
      if (signalAborted(options.signal)) abort();
      if (!stopping) child.stdin.end(options.input === undefined ? undefined : options.input + "\n");
      else child.stdin.destroy();
    } catch { if (child) stop("BROWSER_CHILD_START_FAILED"); else refuse("BROWSER_CHILD_START_FAILED", true); }
  });
}
