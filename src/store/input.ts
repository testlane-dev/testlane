/**
 * Reading a secret from the human, never from argv.
 *
 * `readSecret` reads from an interactive prompt with echo disabled, or from
 * piped stdin. `assertNoSecretOnArgv` lets the CLI refuse any invocation that
 * tries to pass the secret as an argument (which would land in shell history,
 * process listings and agent transcripts).
 */
import { StringDecoder } from "node:string_decoder";

/** Flags that look like an attempt to pass a secret on the command line. Matched case-insensitively, with or without `=value`. */
export const FORBIDDEN_SECRET_FLAGS: readonly string[] = [
  "--value",
  "--password",
  "--passwd",
  "--pass",
  "--secret",
  "--pin",
  "--token",
  "--api-key",
  "--apikey",
  "--client-secret",
];

export const SECRET_ON_ARGV_MESSAGE =
  "testlane store set reads the secret from the prompt or stdin; never pass it as an argument.";

/** Canonical form for comparing flags: lowercase, no leading dashes, no `=value`, `_` as `-`. */
function canonicalFlag(arg: string): string {
  const name = arg.split("=", 1)[0] ?? arg;
  return name.toLowerCase().replace(/^-+/, "").replace(/_/g, "-");
}

const FORBIDDEN_CANONICAL: ReadonlySet<string> = new Set(FORBIDDEN_SECRET_FLAGS.map(canonicalFlag));

/**
 * True when `arg` names a FORBIDDEN_SECRET_FLAGS flag in any spelling: any
 * number of leading dashes, any case, `_` for `-`, with or without `=value`
 * (e.g. `--PASSWORD=x`, `-password`, `--api_key`).
 */
export function isForbiddenSecretFlag(arg: string): boolean {
  if (!arg.startsWith("-") || arg === "-" || arg === "--") return false;
  return FORBIDDEN_CANONICAL.has(canonicalFlag(arg));
}

/** Throw when any argument anywhere is a forbidden secret flag (see isForbiddenSecretFlag). */
export function assertNoForbiddenSecretFlags(argv: readonly string[]): void {
  for (const arg of argv) {
    if (isForbiddenSecretFlag(arg)) throw new Error(SECRET_ON_ARGV_MESSAGE);
  }
}

export interface ArgvShape {
  /** How many positional arguments the command takes (e.g. 1 for `store set <profile>`). */
  positionals: number;
  /**
   * Exact flag tokens that may appear, e.g. ["--json", "-h", "--help"]. These
   * are treated as boolean: a value-taking option cannot be allowed here,
   * because its value would be counted as a positional (fail closed).
   */
  allowedFlags: readonly string[];
}

/**
 * Fail-closed argv guard for commands that read a secret. Throws (with a
 * message that never includes the offending argument) when `argv` (the
 * arguments after the subcommand, e.g. after `store set`) contains:
 *  (a) more than `shape.positionals` positional arguments (everything after
 *      `--`, and every non-dash token, counts as positional);
 *  (b) a flag containing "=" (`--opt=value` could carry anything);
 *  (c) a flag not listed in `shape.allowedFlags`;
 *  (d) a FORBIDDEN_SECRET_FLAGS flag in any spelling.
 */
export function assertNoSecretOnArgv(argv: readonly string[], shape: ArgvShape): void {
  const allowed = new Set(shape.allowedFlags);
  let positional = 0;
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith("-") && arg !== "-") {
      if (isForbiddenSecretFlag(arg)) throw new Error(SECRET_ON_ARGV_MESSAGE); // (d)
      if (arg.includes("=")) throw new Error(SECRET_ON_ARGV_MESSAGE); // (b)
      if (!allowed.has(arg)) throw new Error(SECRET_ON_ARGV_MESSAGE); // (c)
      continue;
    }
    positional += 1;
    if (positional > shape.positionals) throw new Error(SECRET_ON_ARGV_MESSAGE); // (a)
  }
}

export interface ReadSecretOptions {
  stdin?: NodeJS.ReadStream | NodeJS.ReadableStream;
  stdout?: NodeJS.WriteStream | NodeJS.WritableStream;
  prompt?: string;
  /** Override TTY detection (defaults to stdin.isTTY). */
  isTTY?: boolean;
}

/** Read one secret value. Rejects with "empty secret" when nothing was entered. */
export async function readSecret(opts: ReadSecretOptions = {}): Promise<string> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const isTTY = opts.isTTY ?? Boolean((stdin as Partial<NodeJS.ReadStream>).isTTY);
  const value = isTTY
    ? await readHidden(stdin, stdout, opts.prompt ?? "Secret: ")
    : await readPiped(stdin);
  if (value === "") throw new Error("empty secret");
  return value;
}

/** Piped mode: read all of stdin, return the first line minus one trailing \r?\n. No trimming. */
async function readPiped(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  const all = Buffer.concat(chunks);
  let text = all.toString("utf8");
  all.fill(0);
  for (const c of chunks) c.fill(0);
  // A leading byte-order mark is an encoding artifact, not part of the secret.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const nl = text.indexOf("\n");
  let line = nl === -1 ? text : text.slice(0, nl);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return line;
}

/** Interactive mode: raw mode, no echo, one line. */
function readHidden(
  stdin: NodeJS.ReadStream | NodeJS.ReadableStream,
  stdout: NodeJS.WriteStream | NodeJS.WritableStream,
  prompt: string,
): Promise<string> {
  const tty = stdin as Partial<NodeJS.ReadStream> & NodeJS.ReadableStream;
  if (typeof tty.setRawMode !== "function") {
    return Promise.reject(
      new Error("cannot disable echo on this terminal; pipe the secret on stdin instead"),
    );
  }
  const setRawMode = tty.setRawMode.bind(tty);

  return new Promise<string>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const chars: string[] = [];
    let inEscape = false;
    let done = false;

    const cleanup = (): void => {
      tty.removeListener("data", onData);
      tty.removeListener("end", onEnd);
      tty.removeListener("error", onError);
      try {
        setRawMode(false);
      } catch {
        // terminal already gone
      }
      tty.pause();
      stdout.write("\n");
    };
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      cleanup();
      const value = chars.join("");
      chars.length = 0;
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const ch of text) {
        if (done) return;
        if (inEscape) {
          // Swallow ANSI escape sequences (arrow keys etc.) up to their final byte.
          if (/[A-Za-z~]/.test(ch)) inEscape = false;
          continue;
        }
        switch (ch) {
          case "\r":
          case "\n":
          case "\u0004": // Ctrl-D: end of input
            finish(null);
            return;
          case "\u0003": // Ctrl-C
            finish(new Error("cancelled"));
            return;
          case "\u007f":
          case "\b":
            chars.pop();
            break;
          case "\u001b":
            inEscape = true;
            break;
          default:
            if (ch >= " ") chars.push(ch);
        }
      }
    };
    const onEnd = (): void => finish(null);
    const onError = (err: Error): void => finish(new Error(`failed to read secret: ${err.name}`));

    stdout.write(prompt);
    setRawMode(true);
    tty.on("data", onData);
    tty.once("end", onEnd);
    tty.once("error", onError);
    tty.resume();
  });
}
