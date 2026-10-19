/**
 * Output redaction: scrub registered secret values (and their common encoded
 * forms) from any text before it is printed.
 *
 * Limits (documented, by design):
 * - Values shorter than 4 characters are ignored by `register` - they would
 *   shred ordinary output and are not meaningful secrets.
 * - Callers that load stored secrets (src/vault.ts) register a value only when
 *   `isRedactable(value)`: short all-digit values (PINs, < 12 digits) are
 *   skipped. A PIN is never printed by the broker, and scrubbing its digits
 *   would corrupt cookie values, ports and timestamps that happen to contain them.
 * - Matching is exact per registered form. A secret embedded mid-way inside a
 *   larger base64 blob (non-aligned) or split across two separate `write`
 *   calls is not detected.
 */

const REPLACEMENT = "[REDACTED]";
const MIN_SECRET_LENGTH = 4;
/** All-digit values shorter than 12 characters (PINs) are not registered by the vault. */
const SHORT_DIGITS_RE = /^\d{1,11}$/;

/**
 * Whether a stored secret should be registered with the output redactor:
 * at least 4 characters and not a short all-digit value (a PIN).
 */
export function isRedactable(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH && !SHORT_DIGITS_RE.test(secret);
}

interface InstalledWrap {
  original: NodeJS.WriteStream["write"];
  wrapper: NodeJS.WriteStream["write"];
  active: boolean;
}

export class Redactor {
  readonly #secrets = new Set<string>();
  readonly #forms = new Set<string>();
  #pattern: RegExp | null = null;
  readonly #installed = new WeakMap<NodeJS.WriteStream, InstalledWrap>();

  /** Register a secret value. null/undefined and values shorter than 4 chars are ignored. */
  register(secret: string | null | undefined): void {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return;
    if (this.#secrets.has(secret)) return;
    this.#secrets.add(secret);
    for (const form of derivedForms(secret)) {
      if (form.length >= MIN_SECRET_LENGTH) this.#forms.add(form);
    }
    this.#pattern = null;
  }

  /** Number of distinct secrets registered (derived forms are not counted). */
  get count(): number {
    return this.#secrets.size;
  }

  /** Replace every registered secret (and its derived forms) with "[REDACTED]". */
  redact(text: string): string {
    if (this.#forms.size === 0 || text === "") return text;
    const pattern = this.#compile();
    pattern.lastIndex = 0;
    return text.replace(pattern, REPLACEMENT);
  }

  /**
   * Wrap `write` on the given streams (default: process.stdout and
   * process.stderr) so every chunk is scrubbed first. Idempotent per stream.
   * Returns an uninstall function that restores the original `write` for the
   * streams this call wrapped.
   */
  install(streams?: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream }): () => void {
    const targets: NodeJS.WriteStream[] =
      streams === undefined
        ? [process.stdout, process.stderr]
        : [streams.stdout, streams.stderr].filter(
            (s): s is NodeJS.WriteStream => s !== undefined,
          );

    const wrappedHere: NodeJS.WriteStream[] = [];
    for (const stream of new Set(targets)) {
      const existing = this.#installed.get(stream);
      if (existing?.active) continue; // already wrapped by this redactor
      this.#wrap(stream);
      wrappedHere.push(stream);
    }

    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const stream of wrappedHere) {
        const entry = this.#installed.get(stream);
        if (entry === undefined || !entry.active) continue;
        entry.active = false; // wrapper becomes a pass-through if someone wrapped on top of it
        if (stream.write === entry.wrapper) stream.write = entry.original;
        this.#installed.delete(stream);
      }
    };
  }

  #wrap(stream: NodeJS.WriteStream): void {
    const original = stream.write;
    const self = this;
    const entry: InstalledWrap = {
      original,
      wrapper: original, // replaced below
      active: true,
    };
    const wrapper = function (this: unknown, ...args: unknown[]): boolean {
      if (entry.active && args.length > 0) {
        args[0] = self.#scrubChunk(args[0], args[1]);
      }
      return (original as (...a: unknown[]) => boolean).apply(this, args);
    } as NodeJS.WriteStream["write"];
    entry.wrapper = wrapper;
    this.#installed.set(stream, entry);
    stream.write = wrapper;
  }

  #scrubChunk(chunk: unknown, encoding: unknown): unknown {
    if (this.#forms.size === 0) return chunk;
    if (typeof chunk === "string") {
      const enc = typeof encoding === "string" ? encoding.toLowerCase() : "utf8";
      if (enc === "utf8" || enc === "utf-8" || !Buffer.isEncoding(enc)) {
        return this.redact(chunk);
      }
      // A string in a non-utf8 encoding (hex, base64, latin1, ...) denotes bytes.
      const bytes = Buffer.from(chunk, enc);
      const decoded = bytes.toString("utf8");
      const scrubbed = this.redact(decoded);
      if (scrubbed === decoded) return this.redact(chunk);
      // Buffers ignore the encoding argument, so the call signature stays valid.
      return Buffer.from(scrubbed, "utf8");
    }
    if (chunk instanceof Uint8Array) {
      const decoded = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(
        "utf8",
      );
      const scrubbed = this.redact(decoded);
      // Pass untouched bytes through unchanged so binary output is not mangled.
      return scrubbed === decoded ? chunk : Buffer.from(scrubbed, "utf8");
    }
    return chunk;
  }

  #compile(): RegExp {
    if (this.#pattern === null) {
      // Longest first: regex alternation takes the first alternative that
      // matches, so overlapping/substring secrets are scrubbed as a whole.
      const alternatives = [...this.#forms]
        .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
        .map(escapeRegExp);
      this.#pattern = new RegExp(alternatives.join("|"), "g");
    }
    return this.#pattern;
  }
}

function derivedForms(secret: string): string[] {
  const utf8 = Buffer.from(secret, "utf8");
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    // application/x-www-form-urlencoded (spaces as "+"), as used by form-post bodies.
    new URLSearchParams({ v: secret }).toString().slice(2),
    utf8.toString("base64"),
    utf8.toString("base64url"),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Process-wide redactor. Secrets are registered here by src/vault.ts:
 * getProfileSecret() (the single place a secret is loaded from the store)
 * registers every redactable value (see isRedactable) before returning it, and
 * putProfileSecret() registers one before storing it. Strategies do not
 * register anything themselves.
 */
export const redactor = new Redactor();

/**
 * A copy of a JSON-compatible value with every string value redacted (object
 * keys, numbers, booleans and nulls are left alone, so the result is still the
 * same shape and valid JSON). For structured results (MCP `structuredContent`,
 * HTTP JSON bodies) that never pass through the stdout/stderr wrapper.
 */
export function redactValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? redactor.redact(v) : v)),
  ) as T;
}

/**
 * User-facing error text: the redacted `message` of an Error (never its stack),
 * or the redacted String(err) for non-Error values.
 */
export function safeError(err: unknown): string {
  if (err instanceof Error) {
    return redactor.redact(err.message !== "" ? err.message : err.name);
  }
  let text: string;
  try {
    text = String(err);
  } catch {
    text = "unknown error";
  }
  return redactor.redact(text);
}
