/**
 * In-memory SecretStore for tests. Values live only in this process's memory
 * and are never logged. `gets` counts reads so tests can prove a refusal
 * happened before the store was touched. Keys are validated like the real
 * adapters (agent-auth/<profile name> only).
 */
import { assertValidStoreKey, type SecretStore } from "../../src/store/index.js";

export class MemoryStore implements SecretStore {
  readonly kind = "memory";
  readonly #data = new Map<string, string>();
  gets = 0;

  async get(key: string): Promise<string | null> {
    assertValidStoreKey(key);
    this.gets += 1;
    return this.#data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    assertValidStoreKey(key);
    this.#data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    assertValidStoreKey(key);
    return this.#data.delete(key);
  }

  async list(): Promise<string[]> {
    return [...this.#data.keys()].sort();
  }

  get size(): number {
    return this.#data.size;
  }
}
