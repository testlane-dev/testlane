/** Preserve fixed startup facts when cleanup must remain the primary failure. */
import { types } from 'node:util';

const STAGES = new Set(['owned-simulator-start', 'device-xcode-runtime-and-pinned-tools-validated',
  'device-owned-simulator-created', 'device-owned-simulator-boot-started', 'device-owned-simulator-booted',
  'device-wda-build-for-testing', 'device-wda-prepared', 'device-selected-runtime-cache-preparing',
  'device-selected-runtime-cache-prepared', 'device-private-appium-ready']);
const KINDS = new Set(['not-recorded', 'xcode-version', 'runtime-list', 'device-type-list', 'owned-device-list',
  'selected-runtime-cache-update', 'owned-device-create', 'owned-device-boot', 'owned-device-bootstatus', 'owned-device-shutdown', 'owned-device-delete',
  'owned-wda-prebuild', 'owned-app-install', 'owned-proof-app-prewarm', 'owned-app-container', 'loopback-listeners',
  'process-identity', 'owned-prewarm-stack-sample', 'owned-descendants', 'owned-process-group', 'other']);
const CODES = new Set(['IOS_APP_INPUT_INVALID', 'IOS_APP_INSTALL_FAILED', 'IOS_APP_LAUNCH_FAILED',
  'IOS_APPIUM_READY_TIMEOUT', 'IOS_APPIUM_START_FAILED', 'IOS_APPIUM_STOPPED', 'IOS_BOOTSTRAP_CLEANUP_UNCONFIRMED',
  'IOS_BOOTSTRAP_CONTAINER_REFUSED', 'IOS_BOOTSTRAP_CONTAINER_UNAVAILABLE', 'IOS_BOOTSTRAP_INPUT_INVALID', 'IOS_BOOTSTRAP_WRITE_FAILED',
  'IOS_CANCELLED', 'IOS_CAPTURE_LIMIT', 'IOS_COMMAND_START_FAILED', 'IOS_COMMAND_TIMEOUT', 'IOS_DEVICE_BINDING_REFUSED',
  'IOS_DEVICE_CLEANUP_UNCONFIRMED', 'IOS_DEVICE_ENV_INVALID', 'IOS_DEVICE_INPUT_INVALID', 'IOS_DEVICE_INVENTORY_INVALID',
  'IOS_DEVICE_START_FAILED', 'IOS_DEVICE_TYPE_UNAVAILABLE', 'IOS_FOREIGN_INVENTORY_CHANGED', 'IOS_HOSTED_CI_REQUIRED',
  'IOS_LISTENER_BINDING_REFUSED', 'IOS_LISTENER_STOP_UNCONFIRMED', 'IOS_MACOS_REQUIRED', 'IOS_OUTPUT_PATH_REFUSED',
  'IOS_OWNERSHIP_REFUSED', 'IOS_PREAUTH_DIAGNOSTIC_FAILED', 'IOS_PROCESS_OWNERSHIP_REFUSED', 'IOS_PROCESS_STOP_UNCONFIRMED',
  'IOS_PROCESS_TREE_LIMIT', 'IOS_RUNTIME_CACHE_PREPARE_FAILED', 'IOS_RUNTIME_METADATA_INVALID', 'IOS_RUNTIME_UNAVAILABLE', 'IOS_SIMCTL_SCOPE_REFUSED',
  'IOS_SIMULATOR_BOOT_FAILED', 'IOS_SIMULATOR_BOOT_TIMEOUT', 'IOS_SIMULATOR_CREATE_FAILED', 'IOS_SIMULATOR_CREATE_UNSETTLED',
  'IOS_SIMULATOR_DELETE_UNCONFIRMED', 'IOS_SIMULATOR_LIST_FAILED', 'IOS_SIMULATOR_SHUTDOWN_UNCONFIRMED',
  'IOS_STANDARD_DEVICE_SET_REFUSED', 'IOS_TARGET_INCOMPATIBLE', 'IOS_TARGET_SELECTOR_INVALID', 'IOS_TOOLS_MISSING',
  'IOS_TOOLS_VERSION_MISMATCH', 'IOS_WDA_ARTIFACT_CHANGED', 'IOS_WDA_ARTIFACT_INVALID', 'IOS_WDA_PREPARE_FAILED',
  'IOS_WDA_PREPARE_INPUT_INVALID', 'IOS_WDA_PROJECT_REFUSED', 'IOS_WDA_STARTUP_PATCH_REFUSED',
  'IOS_XCODE_PREREQUISITE_FAILED', 'IOS_XCODE_PREREQUISITE_MISSING', 'IOS_BUILD_TREE_INVALID', 'IOS_BUILD_TREE_LIMIT',
  'IOS_BUILD_TREE_LINK_INVALID', 'IOS_BUILD_TREE_CHANGED']);
const nativeError = value => value !== null && typeof value === 'object' && !types.isProxy(value) && types.isNativeError(value);
function ownValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

export function fixedIosDeviceFailureCode(error) {
  const message = nativeError(error) ? ownIosErrorString(error, 'message') : undefined;
  return typeof message === 'string' && CODES.has(message) ? message : 'IOS_DEVICE_START_FAILED';
}

export function ownIosErrorString(error, key) {
  if (error === null || typeof error !== 'object' || types.isProxy(error) || !['message', 'code'].includes(key)) return undefined;
  const value = ownValue(error, key);
  return typeof value === 'string' ? value : undefined;
}

export function tagIosCommandFailure(error, kind) {
  if (nativeError(error) && KINDS.has(kind)) {
    try { if (!Object.getOwnPropertyDescriptor(error, 'nativeCommandKind')) Object.defineProperty(error, 'nativeCommandKind', { value: kind }); } catch {}
  }
  return error;
}

function validatedFact(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== 3 || keys.some(key => !['stage', 'code', 'commandKind'].includes(key)) || Object.getOwnPropertySymbols(value).length) return undefined;
    const stage = ownValue(value, 'stage'), code = ownValue(value, 'code'), commandKind = ownValue(value, 'commandKind');
    if (!STAGES.has(stage) || !CODES.has(code) || !KINDS.has(commandKind)) return undefined;
    return Object.freeze({ stage, code, commandKind });
  } catch { return undefined; }
}

export function createIosStartupFailure({ stage, error }) {
  const kind = nativeError(error) ? ownValue(error, 'nativeCommandKind') : undefined;
  return Object.freeze({ stage: STAGES.has(stage) ? stage : 'owned-simulator-start',
    code: fixedIosDeviceFailureCode(error), commandKind: KINDS.has(kind) ? kind : 'not-recorded' });
}

export function readIosStartupFailure(error) {
  return nativeError(error) ? validatedFact(ownValue(error, 'startupFailure')) : undefined;
}

export function retainIosStartupFailure(error, fact) {
  const safe = validatedFact(fact);
  if (nativeError(error) && safe) {
    // An existing original fact is never replaced by a later cleanup failure.
    try { if (!Object.getOwnPropertyDescriptor(error, 'startupFailure')) Object.defineProperty(error, 'startupFailure', { value: safe }); } catch {}
  }
  return error;
}

// These are pattern observations in one accepted sample, never a root-cause or
// process/cleanup assertion. Unavailable flags mean no accepted observation.
const OBSERVATION_SCOPES = new Set(['cold-boot-first-owned-list', 'proof-app-prewarm']);
const OBSERVATION_KINDS = new Set(['owned-device-list', 'owned-proof-app-prewarm']);
const OBSERVATION_FIELDS = ['scope', 'commandKind', 'status', 'coreSimulatorObserved', 'xpcObserved', 'machMsgObserved', 'semaphoreObserved'];
export function normalizeIosStartupCommandObservation(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return undefined;
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== OBSERVATION_FIELDS.length || keys.some(key => !OBSERVATION_FIELDS.includes(key))) return undefined;
    const fields = Object.fromEntries(OBSERVATION_FIELDS.map(key => [key, ownValue(value, key)]));
    if (!OBSERVATION_SCOPES.has(fields.scope) || !OBSERVATION_KINDS.has(fields.commandKind) ||
        (fields.scope === 'cold-boot-first-owned-list' && fields.commandKind !== 'owned-device-list') ||
        !['captured', 'unavailable'].includes(fields.status) ||
        OBSERVATION_FIELDS.slice(3).some(key => typeof fields[key] !== 'boolean') ||
        (fields.status === 'unavailable' && OBSERVATION_FIELDS.slice(3).some(key => fields[key]))) return undefined;
    return Object.freeze(fields);
  } catch { return undefined; }
}
export function iosStartupCommandObservation(scope, commandKind, text) {
  const captured = typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= 8 * 1024 * 1024;
  return normalizeIosStartupCommandObservation({ scope, commandKind, status: captured ? 'captured' : 'unavailable',
    coreSimulatorObserved: captured && /CoreSimulator/.test(text),
    xpcObserved: captured && /\b(?:XPC|libxpc|xpc_[A-Za-z0-9_]+)\b/.test(text),
    machMsgObserved: captured && /\bmach_msg[A-Za-z0-9_]*\b/.test(text),
    semaphoreObserved: captured && /\bsemaphore(?:_[A-Za-z0-9_]+)?\b/.test(text) });
}
export function readIosStartupCommandObservation(error) {
  return nativeError(error) ? normalizeIosStartupCommandObservation(ownValue(error, 'startupCommandObservation')) : undefined;
}
export function retainIosStartupCommandObservation(error, fact) {
  const safe = normalizeIosStartupCommandObservation(fact);
  if (nativeError(error) && safe) {
    try { if (!Object.getOwnPropertyDescriptor(error, 'startupCommandObservation')) Object.defineProperty(error, 'startupCommandObservation', { value: safe }); } catch {}
  }
  return error;
}
