/**
 * Parent-side disposable browser workflow. Import this only from the reviewed
 * application wrapper that already holds authority over its test account store.
 */
export {
  runDisposableBrowserVerification,
  recoverDisposableBrowserVerification,
  type DisposableBrowserOptions,
  type RecoverDisposableBrowserOptions,
  type ManagedBrowserReport,
  type ManagedCode,
  type CleanupState,
  type VerificationState,
} from "./provisioning/managed-run.js";
export {
  BROWSER_ADAPTER_PROTOCOL,
  BROWSER_ACCOUNT_ROLES,
  BROWSER_ACCOUNT_TTL_MS,
  normalizeBrowserAccountBinding,
  type BrowserAccountBinding,
  type BrowserAuthTemplate,
} from "./provisioning/contracts.js";
export type {
  BrowserAccountAdapter,
  BrowserAccountOwner,
  BrowserAccountRole,
  BrowserCoordinatorBinding,
  BrowserOwnedInspection,
  BrowserTargetVerification,
} from "./provisioning/adapter.js";
