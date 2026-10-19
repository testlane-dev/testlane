/**
 * Per-process configuration for the demo app.
 *
 * Secret values are installed once by scripts/app.mjs before Next imports any
 * route modules. They intentionally never come from process.env, argv, or a
 * file. Keeping the provider on globalThis also lets Next dev's module reloads
 * share the same values without re-reading a transport.
 */
const state = (globalThis.__demoRuntimeState ??= { config: null });

function requiredString(config, key) {
  const value = config?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function initializeRuntimeConfig(config) {
  if (state.config !== null) throw new Error("demo runtime configuration already initialized");
  const normalized = {
    nextAuthSecret: requiredString(config, "nextAuthSecret"),
    handoffSecret: requiredString(config, "handoffSecret"),
    adminPassword: requiredString(config, "adminPassword"),
    qaPassword: requiredString(config, "qaPassword"),
  };
  if (
    normalized.nextAuthSecret === null ||
    normalized.handoffSecret === null ||
    normalized.handoffSecret.length < 32 ||
    normalized.adminPassword === null ||
    normalized.qaPassword === null
  ) {
    throw new Error("demo runtime configuration is incomplete");
  }
  state.config = Object.freeze(normalized);
}

/** Returns null until the bootstrap has installed the one-shot configuration. */
export function getRuntimeConfig() {
  return state.config;
}

/** Throws a generic error without including configuration values. */
export function requireRuntimeConfig() {
  const config = getRuntimeConfig();
  if (config === null) throw new Error("demo runtime configuration is unavailable");
  return config;
}
