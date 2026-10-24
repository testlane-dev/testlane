/** Worker-safe mapping and own-run revocation handshake; no provider adapter. */
export { loadBrowserWorkerBinding, requestBrowserRunRevocation } from "./provisioning/worker-io.js";
export { browserFixtureOptions, type BrowserWorkerBinding } from "./provisioning/worker-contracts.js";
