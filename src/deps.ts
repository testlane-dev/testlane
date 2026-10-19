/**
 * Shared construction of CommandDeps for every agent surface (CLI, MCP,
 * localhost HTTP). Keeps one definition of "which registry, which store, who
 * is asking" so the surfaces cannot drift apart.
 */
import type { CommandDeps } from "./commands.js";
import { loadProfiles } from "./profiles.js";
import { detectRequester } from "./requester.js";
import type { SecretStore } from "./store/index.js";
import { selectStore } from "./store/select.js";
import type { ProfileRegistry } from "./types.js";

export interface ResolveDepsOptions {
  /** Explicit registry file (the CLI's --profiles). */
  profilesFile?: string;
  /** Directory the registry walk-up starts from. Defaults to process.cwd(). */
  cwd?: string;
  /** Requester label; passed through detectRequester(). */
  requester?: string;
  /** Test injection points. */
  store?: SecretStore;
  /** Pre-loaded registry; used only when `profilesFile` is not given. */
  registry?: ProfileRegistry;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * A SecretStore that picks the platform adapter on first use, so surfaces
 * that never touch a secret (e.g. `profiles`) work on every platform.
 */
export class LazyStore implements SecretStore {
  #inner: SecretStore | null = null;
  #resolve(): SecretStore {
    this.#inner ??= selectStore();
    return this.#inner;
  }
  get kind(): string {
    return this.#resolve().kind;
  }
  get(key: string): Promise<string | null> {
    return this.#resolve().get(key);
  }
  set(key: string, value: string): Promise<void> {
    return this.#resolve().set(key, value);
  }
  delete(key: string): Promise<boolean> {
    return this.#resolve().delete(key);
  }
  list(): Promise<string[]> {
    return this.#resolve().list();
  }
}

/** Load the registry fresh (so edits are seen) and assemble CommandDeps. */
export async function resolveCommandDeps(opts: ResolveDepsOptions = {}): Promise<CommandDeps> {
  const cwd = opts.cwd ?? process.cwd();
  const registry =
    opts.profilesFile !== undefined
      ? await loadProfiles({ cwd, repoFile: opts.profilesFile })
      : (opts.registry ?? (await loadProfiles({ cwd })));
  const deps: CommandDeps = {
    store: opts.store ?? new LazyStore(),
    registry,
    requester: detectRequester(opts.requester),
  };
  if (opts.fetchImpl !== undefined) deps.fetchImpl = opts.fetchImpl;
  if (opts.now !== undefined) deps.now = opts.now;
  return deps;
}
