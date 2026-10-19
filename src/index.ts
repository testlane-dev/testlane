/**
 * Library entry for the `testlane` package: the public API shared by the CLI, the
 * MCP server (`testlane mcp`) and the localhost HTTP surface (`testlane serve`).
 *
 * Modules with generic helper names (store/keychain-macos.ts, strategies/form-post.ts,
 * mcp.ts, serve.ts) are re-exported by name so their internals do not collide.
 */
export * from "./types.js";
export * from "./env.js";
export * from "./paths.js";
export * from "./version.js";
export * from "./profiles.js";
export * from "./policy.js";
export * from "./deps.js";

// Secret stores and key providers
export * from "./store/index.js";
export * from "./store/select.js";
export * from "./store/input.js";
export * from "./store/dpapi.js";
export {
  KeychainMacosStore,
  KEYCHAIN_INDEX_FILE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_VALUE_PREFIX,
  SECURITY_PATH,
  type KeychainMacosStoreOptions,
} from "./store/keychain-macos.js";
export { SecretServiceStore, SECRET_SERVICE_ATTR, type SecretServiceStoreOptions } from "./store/secret-service.js";
export {
  EncryptedFileStore,
  ENCRYPTED_FILE_KEY_NAME,
  SALT_FILE_NAME,
  SCRYPT_PARAMS,
  defaultSaltFile,
  interactivePassphrase,
  keychainKeyProvider,
  passphraseKeyProvider,
  type EncryptedFileStoreOptions,
  type KeyProvider,
} from "./store/encrypted-file.js";

// Strategies
export * from "./strategies/index.js";
export { nextAuthCredentialsStrategy } from "./strategies/nextauth-credentials.js";
export { formPostStrategy, MAX_REDIRECTS } from "./strategies/form-post.js";
export { dependentTokenStrategy, DEFAULT_TOKEN_HEADER } from "./strategies/dependent-token.js";
export { appHandoffStrategy } from "./strategies/app-handoff.js";
export * from "./strategies/options.js";

export * from "./vault.js";

// Session output formats
export * from "./session/format.js";
export * from "./session/cookie.js";
export * from "./session/storage-state.js";
export * from "./session/json.js";
export * from "./session/curl-jar.js";
export * from "./session/headers.js";

export * from "./audit.js";
export * from "./redact.js";
export * from "./requester.js";
export * from "./commands.js";

// Authenticated smoke workflow contracts
export * from "./workflows/contracts.js";

// Feature-acceptance (two-role) workflow contracts
export * from "./workflows/feature-contracts.js";

// Agent surfaces
export * from "./handoff.js";
export {
  createMcpServer,
  runMcpStdio,
  MCP_ERROR_CODES,
  MCP_INSTRUCTIONS,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  type CreateMcpServerOptions,
  type RunMcpStdioOptions,
} from "./mcp.js";
export {
  startServer,
  runServe,
  httpTokenPath,
  BIND_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  type RunningServer,
  type RunServeOptions,
  type ServeOptions,
} from "./serve.js";
