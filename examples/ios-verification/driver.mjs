/** Narrow XCUITest W3C client for an already-owned local Simulator. */
import { loopbackOrigin, normalizeIosRequestFact } from '../android-verification/contracts.mjs';
import { combineDriverSignals, withDriverSignal, waitDriverSignal } from '../android-verification/driver-phase.mjs';
import { validateIosDeviceBinding } from './device-scope.mjs';
import { stabilizeIosSetupOwnership, readIosSetupOwnershipResult } from './setup-ownership.mjs';
import { normalizeIosSetupOwnership } from './failure-facts.mjs';
import { types } from 'node:util';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const READ_OPERATIONS = new Set(['native-context', 'element-find', 'element-displayed', 'element-rect',
  'window-rect', 'keyboard-state', 'text-read', 'value-read']);
function requestOperation(method, route) {
  if (method === 'POST' && route === '/session') return 'session-create';
  if (/^\/session\/[A-Za-z0-9-]{1,160}$/.test(route) && method === 'DELETE') return 'session-delete';
  const suffix = /^\/session\/[A-Za-z0-9-]{1,160}(\/.*)$/.exec(route)?.[1];
  const direct = { 'GET /context': 'native-context', 'POST /element': 'element-find', 'GET /window/rect': 'window-rect',
    'POST /actions': 'scroll', 'GET /appium/device/is_keyboard_shown': 'keyboard-state', 'POST /appium/device/hide_keyboard': 'keyboard-hide' };
  if (direct[method + ' ' + suffix]) return direct[method + ' ' + suffix];
  const element = /^\/element\/[A-Za-z0-9-]{1,160}\/(displayed|rect|click|clear|value|text|attribute\/value)$/.exec(suffix ?? '')?.[1];
  return ({ 'GET displayed': 'element-displayed', 'GET rect': 'element-rect', 'POST click': 'click', 'POST clear': 'clear',
    'POST value': 'type', 'GET text': 'text-read', 'GET attribute/value': 'value-read' })[method + ' ' + element] ?? 'unclassified';
}
export class NativeDriverError extends Error {
  constructor(code, requestFact, requestProgress, startupResponse) { super(code); this.name = 'NativeDriverError'; this.code = code; retainRequestFact(this, requestFact); retainRequestProgress(this, requestProgress); retainStartupResponse(this, startupResponse); }
}
const setupOwnershipErrors = new WeakMap();
/** Only this driver's actual post-session failed check can supply this fact. */
export function readIosSetupOwnership(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error) || !types.isNativeError(error)) return undefined;
  try { return Object.getPrototypeOf(error) === NativeDriverError.prototype ? normalizeIosSetupOwnership(setupOwnershipErrors.get(error)) : undefined; }
  catch { return undefined; }
}
const remoteUnsettledErrors = new WeakSet();
/** A private driver-created failure marker, never caller-supplied cleanup authority. */
export function readIosRemoteUnsettled(error) {
  return !!error && typeof error === 'object' && !types.isProxy(error) && types.isNativeError(error) &&
    Object.getPrototypeOf(error) === NativeDriverError.prototype && remoteUnsettledErrors.has(error);
}
function retainRequestFact(error, fact) {
  const safe = normalizeIosRequestFact(fact);
  if (safe && error && typeof error === 'object' && !types.isProxy(error) && types.isNativeError(error) && Object.getPrototypeOf(error) === NativeDriverError.prototype) {
    try { if (!Object.getOwnPropertyDescriptor(error, 'requestFailure')) Object.defineProperty(error, 'requestFailure', { value: safe }); } catch {}
  }
  return error;
}
export function readIosRequestFailure(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error) || !types.isNativeError(error)) return undefined;
  try {
    if (Object.getPrototypeOf(error) !== NativeDriverError.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'requestFailure');
    return descriptor && Object.hasOwn(descriptor, 'value') ? normalizeIosRequestFact(descriptor.value) : undefined;
  } catch { return undefined; }
}
function normalizeRequestProgress(value) {
  const names = ['ownershipElapsedMs', 'effectiveHttpBudgetMs', 'httpBodyElapsedMs', 'budgetSource', 'fetchInvoked', 'responseHeadersObserved'];
  if (!value || typeof value !== 'object' || types.isProxy(value)) return;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertyNames(value).length !== names.length || Object.getOwnPropertySymbols(value).length) return;
    const data = {};
    for (const name of names) { const property = Object.getOwnPropertyDescriptor(value, name); if (!property || !Object.hasOwn(property, 'value')) return; data[name] = property.value; }
    if (!['ownershipElapsedMs', 'effectiveHttpBudgetMs', 'httpBodyElapsedMs'].every(name => typeof data[name] === 'number' && Number.isFinite(data[name]) && data[name] >= 0 && data[name] <= 3_600_000) ||
      data.effectiveHttpBudgetMs > 240_000 || !['http-body', 'caller-outer', 'request-total'].includes(data.budgetSource) ||
      typeof data.fetchInvoked !== 'boolean' || typeof data.responseHeadersObserved !== 'boolean' || (data.responseHeadersObserved && !data.fetchInvoked)) return;
    return Object.freeze(data);
  } catch { /* Only own primitive data becomes a progress snapshot. */ }
}
function retainRequestProgress(error, value) {
  const progress = normalizeRequestProgress(value), fact = readIosRequestFailure(error);
  if (progress && ['http', 'response'].includes(fact?.phase)) {
    try { if (!Object.getOwnPropertyDescriptor(error, 'requestProgress')) Object.defineProperty(error, 'requestProgress', { value: progress }); } catch {}
  }
  return error;
}
export function readIosRequestProgress(error) {
  if (!readIosRequestFailure(error)) return;
  try {
    const property = Object.getOwnPropertyDescriptor(error, 'requestProgress');
    return property && Object.hasOwn(property, 'value') && ['http', 'response'].includes(readIosRequestFailure(error)?.phase) ? normalizeRequestProgress(property.value) : undefined;
  } catch { return undefined; }
}
const STARTUP_STATES = ['not-observed', 'headers-observed', 'body-reading', 'body-ended', 'json-decoded'];
const STARTUP_W3C = ['unavailable', 'none', 'unknown-error', 'session-not-created', 'invalid-argument', 'timeout', 'other'];
const STARTUP_CATEGORIES = ['unmatched', 'startup-scope-signature', 'device-discovery-signature', 'wda-readiness-timeout-signature', 'downstream-proxy-signature', 'wda-session-signature', 'wda-launch-signature'];
/** Fixed data only; this snapshot grants no session or cleanup authority. */
export function normalizeIosStartupResponse(value) {
  const names = ['httpStatus', 'responseState', 'w3cError', 'startupCategory'];
  if (!value || typeof value !== 'object' || types.isProxy(value)) return;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertyNames(value).length !== names.length || Object.getOwnPropertySymbols(value).length) return;
    const data = {};
    for (const name of names) { const field = Object.getOwnPropertyDescriptor(value, name); if (!field || !Object.hasOwn(field, 'value')) return; data[name] = field.value; }
    if (!Number.isSafeInteger(data.httpStatus) || !STARTUP_STATES.includes(data.responseState) || !STARTUP_W3C.includes(data.w3cError) || !STARTUP_CATEGORIES.includes(data.startupCategory)) return;
    if (data.responseState === 'not-observed' ? data.httpStatus !== 0 : data.httpStatus < 100 || data.httpStatus > 599) return;
    if (data.responseState !== 'json-decoded' && (data.w3cError !== 'unavailable' || data.startupCategory !== 'unmatched')) return;
    if (data.startupCategory !== 'unmatched' && data.w3cError === 'unavailable') return;
    return Object.freeze(data);
  } catch { /* No getter, proxy or arbitrary value becomes diagnostic data. */ }
}
function retainStartupResponse(error, value) {
  const data = normalizeIosStartupResponse(value);
  if (data && readIosRequestFailure(error)?.operation === 'session-create') {
    try { if (!Object.getOwnPropertyDescriptor(error, 'startupResponse')) Object.defineProperty(error, 'startupResponse', { value: data }); } catch {}
  }
  return error;
}
export function readIosStartupResponse(error) {
  if (readIosRequestFailure(error)?.operation !== 'session-create') return;
  try { const field = Object.getOwnPropertyDescriptor(error, 'startupResponse'); return field && Object.hasOwn(field, 'value') ? normalizeIosStartupResponse(field.value) : undefined; }
  catch { return undefined; }
}
// Only actual failed click requests can populate this private diagnostic store.
const commandResponseErrors = new WeakMap();
const COMMAND_W3C = [...STARTUP_W3C, 'no-such-element', 'stale-element-reference', 'element-not-interactable', 'invalid-element-state'];
const COMMAND_PROXY_CATEGORIES = ['unmatched', 'downstream-proxy-signature', 'downstream-5000-timeout-signature'];
/** Fixed response observations only; no remote outcome or cleanup authority. */
export function normalizeIosCommandResponse(value) {
  const names = ['httpStatus', 'responseState', 'w3cError', 'proxyCategory'];
  if (!value || typeof value !== 'object' || types.isProxy(value)) return;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertyNames(value).length !== names.length || Object.getOwnPropertySymbols(value).length) return;
    const data = {};
    for (const name of names) { const field = Object.getOwnPropertyDescriptor(value, name); if (!field || !Object.hasOwn(field, 'value')) return; data[name] = field.value; }
    if (!Number.isSafeInteger(data.httpStatus) || !STARTUP_STATES.includes(data.responseState) || !COMMAND_W3C.includes(data.w3cError) || !COMMAND_PROXY_CATEGORIES.includes(data.proxyCategory)) return;
    if (data.responseState === 'not-observed' ? data.httpStatus !== 0 : data.httpStatus < 100 || data.httpStatus > 599) return;
    if (data.responseState !== 'json-decoded' && (data.w3cError !== 'unavailable' || data.proxyCategory !== 'unmatched')) return;
    if (data.proxyCategory !== 'unmatched' && data.w3cError === 'unavailable') return;
    return Object.freeze(data);
  } catch { /* No getter, proxy or arbitrary value becomes response facts. */ }
}
function retainCommandResponse(error, value) {
  const request = readIosRequestFailure(error), data = normalizeIosCommandResponse(value);
  if (data && request?.operation === 'click' && ['http', 'response'].includes(request.phase) && !commandResponseErrors.has(error)) commandResponseErrors.set(error, data);
  return error;
}
export function readIosCommandResponse(error) {
  const request = readIosRequestFailure(error);
  if (request?.operation !== 'click' || !['http', 'response'].includes(request.phase)) return;
  return normalizeIosCommandResponse(commandResponseErrors.get(error));
}
function commandProxySignature(message) {
  if (typeof message !== 'string' || message.length > 64 * 1024) return 'unmatched';
  const prefix = 'Could not proxy command to the remote server. Original error: ';
  if (message.includes(prefix + 'timeout of 5000ms exceeded')) return 'downstream-5000-timeout-signature';
  return message.includes(prefix) ? 'downstream-proxy-signature' : 'unmatched';
}
function startupSignature(message) {
  // These exact public pinned-source signatures classify a match, not its cause.
  if (typeof message !== 'string' || message.length > 64 * 1024) return 'unmatched';
  if (message.includes('TESTLANE_WDA_STARTUP_SCOPE_REFUSED')) return 'startup-scope-signature';
  if (message.includes('Unknown device or simulator UDID: ')) return 'device-discovery-signature';
  if (/WDA was not ready in [0-9]{1,9} ms\./.test(message)) return 'wda-readiness-timeout-signature';
  if (message.includes('Could not proxy command to the remote server. Original error: ')) return 'downstream-proxy-signature';
  if (message.includes('Unable to start WebDriverAgent session. Original error: ')) return 'wda-session-signature';
  if (message.includes('Unable to launch WebDriverAgent. Original error: ')) return 'wda-launch-signature';
  return 'unmatched';
}
const fail = (code, requestFact, requestProgress, startupResponse) => new NativeDriverError(code, requestFact, requestProgress, startupResponse);
function reclassified(code, error) {
  const result = fail(code, readIosRequestFailure(error), readIosRequestProgress(error), readIosStartupResponse(error));
  if (readIosRemoteUnsettled(error)) remoteUnsettledErrors.add(result);
  return result;
}
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const port = value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;
const optionalCaps = ['appium:deviceName', 'appium:platformVersion', 'appium:newCommandTimeout', 'appium:waitForIdleTimeout',
  'appium:wdaLaunchTimeout', 'appium:wdaConnectionTimeout', 'appium:isHeadless', 'appium:wdaStartupRetries',
  'appium:forceAppLaunch', 'appium:shouldTerminateApp', 'appium:usePrebuiltWDA'];
const requiredCaps = ['platformName', 'appium:automationName', 'appium:udid', 'appium:bundleId', 'appium:simulatorDevicesSetPath',
  'appium:derivedDataPath', 'appium:wdaLocalPort', 'appium:wdaRemotePort', 'appium:wdaBindingIP', 'appium:wdaBaseUrl', 'appium:mjpegServerPort',
  'appium:skipLogCapture', 'appium:showIOSLog', 'appium:showXcodeLog', 'appium:printPageSourceOnFindFailure',
  'appium:disableAutomaticScreenshots', 'appium:shutdownOtherSimulators', 'appium:resetLocationService', 'appium:noReset'];
export async function createNativeDriver({ url, capabilities: supplied, deviceBinding, signal, assertOwned, keyboardDismissId } = {}) {
  let origin, capabilities;
  try {
    origin = loopbackOrigin(url);
    // This strict binding describes an exceptional hosted device-set location.
    // It grants no authority: every request still asks the parent to inspect
    // its live marker, canonical paths and unchanged foreign inventory.
    validateIosDeviceBinding(deviceBinding, { capabilities: supplied });
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
      supplied.platformName?.toLowerCase() !== 'ios' || supplied['appium:automationName']?.toLowerCase() !== 'xcuitest' ||
      !uuid(supplied['appium:udid']) || !identifier(supplied['appium:bundleId']) || !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/.test(supplied['appium:bundleId']) ||
      !port(supplied['appium:wdaLocalPort']) || supplied['appium:wdaRemotePort'] !== supplied['appium:wdaLocalPort'] ||
      !port(supplied['appium:mjpegServerPort']) || supplied['appium:mjpegServerPort'] === supplied['appium:wdaLocalPort'] ||
      supplied['appium:wdaBindingIP'] !== '127.0.0.1' || supplied['appium:wdaBaseUrl'] !== 'http://127.0.0.1' ||
      !['appium:skipLogCapture', 'appium:disableAutomaticScreenshots', 'appium:noReset'].every(key => supplied[key] === true) ||
      !['appium:showIOSLog', 'appium:showXcodeLog', 'appium:printPageSourceOnFindFailure', 'appium:shutdownOtherSimulators', 'appium:resetLocationService'].every(key => supplied[key] === false) ||
      Object.keys(supplied).some(key => !requiredCaps.includes(key) && !optionalCaps.includes(key)) || typeof assertOwned !== 'function' ||
      (keyboardDismissId !== undefined && !identifier(keyboardDismissId)) ||
      (supplied['appium:isHeadless'] !== undefined && supplied['appium:isHeadless'] !== true) ||
      (supplied['appium:wdaStartupRetries'] !== undefined && supplied['appium:wdaStartupRetries'] !== 1) ||
      (supplied['appium:wdaConnectionTimeout'] !== undefined && supplied['appium:wdaConnectionTimeout'] !== 5000) ||
      (supplied['appium:usePrebuiltWDA'] !== undefined && supplied['appium:usePrebuiltWDA'] !== true) ||
      ['appium:forceAppLaunch', 'appium:shouldTerminateApp'].some(key => supplied[key] !== undefined && supplied[key] !== false)) throw new Error();
    for (const key of ['appium:deviceName', 'appium:platformVersion']) if (supplied[key] !== undefined && !identifier(supplied[key])) throw new Error();
    for (const key of ['appium:newCommandTimeout', 'appium:waitForIdleTimeout', 'appium:wdaLaunchTimeout', 'appium:wdaConnectionTimeout']) {
      if (supplied[key] !== undefined && (!Number.isFinite(supplied[key]) || supplied[key] < 0 || supplied[key] > 240_000)) throw new Error();
    }
    // The owner has already booted this owned Simulator without a UI client.
    // Avoid Appium rebooting it just to make a Simulator window visible.
    capabilities = { ...structuredClone(supplied), 'appium:isHeadless': true, 'appium:wdaStartupRetries': 1,
      'appium:wdaConnectionTimeout': 5000, 'appium:forceAppLaunch': false, 'appium:shouldTerminateApp': false, 'appium:usePrebuiltWDA': true };
  } catch { throw fail('NATIVE_DRIVER_CONFIGURATION_INVALID'); }
  let session, closed = false;
  const ownershipFence = new AbortController();
  const remoteFence = new AbortController();
  const remoteFailure = requestFact => { const error = fail('NATIVE_DRIVER_REMOTE_UNSETTLED', requestFact); remoteUnsettledErrors.add(error); return error; };
  async function request(method, route, body, requestSignal = signal, timeoutMs, outerDeadline) {
    const operation = requestOperation(method, route); let phase = 'ownership';
    if (remoteFence.signal.aborted) throw remoteFailure();
    if (ownershipFence.signal.aborted) throw fail('NATIVE_DRIVER_OWNERSHIP_REFUSED');
    if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
    const began = performance.now(), sessionCreate = operation === 'session-create';
    const semanticAction = ['click', 'clear', 'type'].includes(operation), httpBudget = semanticAction || READ_OPERATIONS.has(operation) ? 10_000 : 5000;
    // Semantic element mutations retain the inner WDA5000 response ceiling and
    // allow one additional5000 client observation/body window. Read-only routes
    // may consume the unused ordinary10000 aggregate after ownership settles.
    // Session creation still spends at most its original 240 seconds in total.
    const requestDeadline = began + (sessionCreate ? 240_000 : semanticAction ? 15_000 : 10_000), deadline = Math.min(requestDeadline, outerDeadline ?? Infinity);
    let phaseDeadline = Math.min(began + 5000, deadline), timeout, timedOut = false, ownerStarted = false, ownerSettled = false;
    let ownerAllowed = false, httpStarted, effectiveHttpBudgetMs, budgetSource, fetchInvoked = false, responseHeadersObserved = false;
    const commandResponse = operation === 'click' ? { httpStatus: 0, responseState: 'not-observed', w3cError: 'unavailable', proxyCategory: 'unmatched' } : undefined;
    const startupResponse = { httpStatus: 0, responseState: 'not-observed', w3cError: 'unavailable', startupCategory: 'unmatched' };
    const timer = new AbortController();
    const operationSignal = AbortSignal.any([timer.signal, ownershipFence.signal, remoteFence.signal, ...(requestSignal ? [requestSignal] : [])]);
    const fencePendingOwner = () => { if (ownerStarted && !ownerSettled) ownershipFence.abort(); };
    operationSignal.addEventListener('abort', fencePendingOwner, { once: true });
    const checkDeadline = () => {
      if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
      if (timedOut || performance.now() >= phaseDeadline || performance.now() >= deadline) {
        timedOut = true; timer.abort(); throw fail('NATIVE_DRIVER_TIMEOUT');
      }
      if (ownershipFence.signal.aborted) throw fail('NATIVE_DRIVER_OWNERSHIP_REFUSED');
      if (remoteFence.signal.aborted) throw remoteFailure();
    };
    const armDeadline = () => {
      clearTimeout(timeout); checkDeadline();
      timeout = setTimeout(() => { timedOut = true; timer.abort(); }, Math.max(0, phaseDeadline - performance.now()));
    };
    try {
      armDeadline();
      const allowed = await withDriverSignal(() => {
        checkDeadline(); ownerStarted = true;
        try {
          return Promise.resolve(assertOwned()).then(value => { ownerSettled = true; return value; }, error => { ownerSettled = true; throw error; });
        } catch (error) { ownerSettled = true; throw error; }
      }, operationSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
      checkDeadline(); clearTimeout(timeout);
      if (allowed !== true) throw fail('NATIVE_DRIVER_OWNERSHIP_REFUSED');
      ownerAllowed = true;
      phase = 'http';
      httpStarted = performance.now();
      phaseDeadline = Math.min(httpStarted + (sessionCreate ? timeoutMs : Math.min(timeoutMs ?? httpBudget, httpBudget)), deadline);
      effectiveHttpBudgetMs = Math.max(0, phaseDeadline - httpStarted);
      // Exact ties select caller-outer, then request-total; this identifies a
      // limiting bound, not a uniquely established cause of expiry.
      budgetSource = outerDeadline === phaseDeadline ? 'caller-outer' : requestDeadline === phaseDeadline ? 'request-total' : 'http-body';
      armDeadline();
      const response = await withDriverSignal(() => {
        checkDeadline(); const encoded = body === undefined ? undefined : JSON.stringify(body); checkDeadline();
        fetchInvoked = true;
        return fetch(origin + route, { method, redirect: 'error', signal: operationSignal,
          headers: { 'Content-Type': 'application/json' }, ...(encoded === undefined ? {} : { body: encoded }) });
      }, operationSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
      responseHeadersObserved = true;
      if (commandResponse) { commandResponse.httpStatus = response.status; commandResponse.responseState = 'headers-observed'; }
      if (sessionCreate) { startupResponse.httpStatus = response.status; startupResponse.responseState = 'headers-observed'; }
      checkDeadline(); phase = 'response';
      const reader = response.body?.getReader(); if (!reader) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      let length = 0; const chunks = [];
      for (;;) {
        checkDeadline();
        const { value, done } = await withDriverSignal(() => { checkDeadline(); if (sessionCreate) startupResponse.responseState = 'body-reading'; if (commandResponse) commandResponse.responseState = 'body-reading'; return reader.read(); }, operationSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
        if (sessionCreate && done === true) startupResponse.responseState = 'body-ended';
        if (commandResponse && done === true) commandResponse.responseState = 'body-ended';
        checkDeadline(); if (done) break;
        length += value.byteLength;
        if (length > 64 * 1024) { await withDriverSignal(() => reader.cancel(), operationSignal, () => fail('NATIVE_DRIVER_CANCELLED')); throw fail('NATIVE_DRIVER_RESPONSE_INVALID'); }
        chunks.push(Buffer.from(value));
      }
      let decoded; try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('NATIVE_DRIVER_RESPONSE_INVALID'); }
      if (commandResponse) {
        commandResponse.responseState = 'json-decoded';
        if (decoded && typeof decoded === 'object' && Object.hasOwn(decoded, 'value')) {
          const value = decoded.value;
          commandResponse.w3cError = 'none';
          if (value && typeof value === 'object' && Object.hasOwn(value, 'error')) {
            commandResponse.w3cError = typeof value.error === 'string' ? new Map([['unknown error', 'unknown-error'], ['session not created', 'session-not-created'], ['invalid argument', 'invalid-argument'], ['timeout', 'timeout'], ['no such element', 'no-such-element'], ['stale element reference', 'stale-element-reference'], ['element not interactable', 'element-not-interactable'], ['invalid element state', 'invalid-element-state']]).get(value.error) ?? 'other' : 'other';
          }
          if ((!response.ok || (value && typeof value === 'object' && Object.hasOwn(value, 'error'))) && value && typeof value === 'object') commandResponse.proxyCategory = commandProxySignature(value.message);
        }
      }
      if (sessionCreate) {
        startupResponse.responseState = 'json-decoded';
        if (decoded && typeof decoded === 'object' && Object.hasOwn(decoded, 'value')) {
          const value = decoded.value;
          startupResponse.w3cError = 'none';
          if (value && typeof value === 'object' && Object.hasOwn(value, 'error')) {
            const errorCode = value.error;
            startupResponse.w3cError = typeof errorCode === 'string' ? new Map([['unknown error', 'unknown-error'], ['session not created', 'session-not-created'], ['invalid argument', 'invalid-argument'], ['timeout', 'timeout']]).get(errorCode) ?? 'other' : 'other';
          }
          if ((!response.ok || (value && typeof value === 'object' && Object.hasOwn(value, 'error'))) && value && typeof value === 'object') startupResponse.startupCategory = startupSignature(value.message);
        }
      }
      checkDeadline();
      if (!decoded || typeof decoded !== 'object' || !Object.hasOwn(decoded, 'value')) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      if (!response.ok || decoded.value?.error !== undefined) {
        if (operation === 'element-find' && response.status === 404 && decoded.value?.error === 'no such element') return { missing: true };
        throw fail('NATIVE_DRIVER_COMMAND_FAILED');
      }
      if (semanticAction && decoded.value !== null) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      return { value: decoded.value };
    } catch (error) {
      fencePendingOwner();
      const progress = failure => ownerAllowed && ownerSettled && !ownershipFence.signal.aborted && httpStarted !== undefined ?
        retainRequestProgress(failure, { ownershipElapsedMs: httpStarted - began, effectiveHttpBudgetMs,
          httpBodyElapsedMs: performance.now() - httpStarted, budgetSource, fetchInvoked, responseHeadersObserved }) : failure;
      const failed = failure => {
        const result = progress(failure);
        if (commandResponse) retainCommandResponse(result, commandResponse);
        if (sessionCreate) retainStartupResponse(result, startupResponse);
        // A returned local promise or proxy error does not prove the native
        // mutation stopped. Never replay or race DELETE/another action with it.
        if (semanticAction && fetchInvoked) { remoteUnsettledErrors.add(result); remoteFence.abort(); }
        else if (remoteFence.signal.aborted) remoteUnsettledErrors.add(result);
        return result;
      };
      if (requestSignal?.aborted) throw failed(fail('NATIVE_DRIVER_CANCELLED', { operation, phase }));
      if (timedOut || performance.now() >= phaseDeadline || performance.now() >= deadline) throw failed(fail('NATIVE_DRIVER_TIMEOUT', { operation, phase }));
      if (remoteFence.signal.aborted) throw failed(remoteFailure({ operation, phase }));
      if (ownershipFence.signal.aborted || phase === 'ownership') throw failed(fail('NATIVE_DRIVER_OWNERSHIP_REFUSED', { operation, phase }));
      if (error instanceof NativeDriverError) throw failed(retainRequestFact(error, { operation, phase }));
      throw failed(fail('NATIVE_DRIVER_COMMAND_FAILED', { operation, phase }));
    } finally { clearTimeout(timeout); operationSignal.removeEventListener('abort', fencePendingOwner); }
  }
  const setupDeadline = performance.now() + 240_000;
  let created;
  try { created = (await request('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, signal, 240_000, setupDeadline)).value; }
  catch (error) { if (error.code === 'NATIVE_DRIVER_TIMEOUT') throw reclassified('NATIVE_DRIVER_SESSION_TIMEOUT', error); throw error; }
  if (!created || typeof created.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,160}$/.test(created.sessionId)) throw fail('NATIVE_DRIVER_SESSION_INVALID');
  session = created.sessionId;
  const route = suffix => '/session/' + encodeURIComponent(session) + suffix;
  async function nativeContext(activeSignal = signal, timeoutMs, outerDeadline) {
    try { if ((await request('GET', route('/context'), undefined, activeSignal, timeoutMs, outerDeadline)).value !== 'NATIVE_APP') throw fail('NATIVE_DRIVER_CONTEXT_REFUSED'); }
    catch (error) { if (error.code === 'NATIVE_DRIVER_TIMEOUT') throw reclassified('NATIVE_DRIVER_CONTEXT_TIMEOUT', error); throw error; }
  }
  try {
    const owned = await stabilizeIosSetupOwnership({ assertOwned, signal, deadline: setupDeadline });
    if (!owned.completed) {
      ownershipFence.abort();
      const error = fail(owned.status === 'cancelled' ? 'NATIVE_DRIVER_CANCELLED' : performance.now() >= setupDeadline ? 'NATIVE_DRIVER_SESSION_TIMEOUT' : 'NATIVE_DRIVER_OWNERSHIP_REFUSED');
      const observation = readIosSetupOwnershipResult(owned);
      if (observation) setupOwnershipErrors.set(error, observation);
      throw error;
    }
    const remaining = setupDeadline - performance.now();
    if (remaining <= 0) { ownershipFence.abort(); throw fail('NATIVE_DRIVER_SESSION_TIMEOUT'); }
    try { await nativeContext(signal, Math.min(5000, remaining), setupDeadline); }
    catch (error) { if (performance.now() >= setupDeadline) throw reclassified('NATIVE_DRIVER_SESSION_TIMEOUT', error); throw error; }
    if (performance.now() >= setupDeadline) throw fail('NATIVE_DRIVER_SESSION_TIMEOUT');
  } catch (error) {
    // A failed setup callback may still run in the parent. Never start another
    // ownership callback or native request after that uncertain outcome.
    if (!ownershipFence.signal.aborted) await request('DELETE', route(''), undefined, null).catch(() => {});
    throw error;
  }
  function elementId(result) {
    const id = result.value?.[ELEMENT];
    if (result.missing || typeof id !== 'string' || !/^[A-Za-z0-9-]{1,160}$/.test(id)) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
    return id;
  }
  async function find(id, activeSignal = signal) {
    if (closed || !identifier(id)) throw fail('NATIVE_DRIVER_ELEMENT_INVALID');
    const deadline = performance.now() + 10_000;
    const remaining = () => {
      const value = deadline - performance.now(); if (value <= 0) throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT'); return value;
    };
    // The presence window includes its initial native-context check as well.
    await nativeContext(activeSignal, remaining(), deadline);
    while (performance.now() < deadline) {
      const result = await request('POST', route('/element'), { using: 'accessibility id', value: id }, activeSignal, remaining(), deadline);
      remaining(); if (!result.missing) return elementId(result);
      await waitDriverSignal(Math.min(200, Math.max(0, deadline - performance.now())), activeSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
    }
    throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
  }
  async function visible(id, activeSignal = signal) {
    if (closed || !identifier(id)) throw fail('NATIVE_DRIVER_ELEMENT_INVALID');
    const deadline = performance.now() + 10_000;
    const remaining = () => {
      const value = deadline - performance.now();
      if (value <= 0) throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
      return value;
    };
    const bounded = (method, suffix, body) => request(method, route(suffix), body, activeSignal, remaining(), deadline);
    let frame;
    // A missing snapshot target cannot be made visible by repeatedly finding it.
    // Search both directions within the same ten-second/six-swipe allowance.
    // This fixed finite span can still fail; it is not an exhaustive UI search.
    const missingDirections = [true, false, false, true, true, true];
    try {
      await nativeContext(activeSignal, remaining(), deadline);
      for (let swipe = 0; swipe <= 6; swipe++) {
        const found = await bounded('POST', '/element', { using: 'accessibility id', value: id });
        let rect;
        if (!found.missing) {
          const element = elementId(found);
          const shown = (await bounded('GET', '/element/' + encodeURIComponent(element) + '/displayed')).value;
          if (shown === true) { remaining(); return element; }
          if (shown !== false) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
          rect = (await bounded('GET', '/element/' + encodeURIComponent(element) + '/rect')).value;
          if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
        }
        if (swipe === 6) break;
        if (!frame) {
          frame = (await bounded('GET', '/window/rect')).value;
          if (!frame || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame[key])) ||
            frame.width < 20 || frame.height < 40 || frame.width > 5000 || frame.height > 5000) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
        }
        await nativeContext(activeSignal, remaining(), deadline);
        const upward = rect ? rect.y >= frame.y + frame.height / 2 : missingDirections[swipe];
        const x = Math.round(frame.x + frame.width / 2), top = Math.round(frame.y + frame.height * 0.25), bottom = Math.round(frame.y + frame.height * 0.75);
        await bounded('POST', '/actions', { actions: [{ type: 'pointer', id: 'owned-native-scroll', parameters: { pointerType: 'touch' }, actions: [
          { type: 'pointerMove', duration: 0, x, y: upward ? bottom : top }, { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 }, { type: 'pointerMove', duration: 200, x, y: upward ? top : bottom }, { type: 'pointerUp', button: 0 },
        ] }] });
      }
      throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
    } catch (error) {
      if (error.code === 'NATIVE_DRIVER_REMOTE_UNSETTLED' && readIosRemoteUnsettled(error)) throw error;
      if (activeSignal?.aborted) throw reclassified('NATIVE_DRIVER_CANCELLED', error);
      if (performance.now() >= deadline) throw reclassified('NATIVE_DRIVER_ELEMENT_TIMEOUT', error);
      throw error;
    }
  }
  const actions = {
    async waitFor(id, activeSignal = signal) { try { await find(id, activeSignal); } catch (error) { if (['NATIVE_DRIVER_TIMEOUT', 'NATIVE_DRIVER_ELEMENT_TIMEOUT'].includes(error.code)) throw reclassified('NATIVE_DRIVER_READINESS_TIMEOUT', error); throw error; } },
    async scrollIntoView(id, activeSignal = signal) { await visible(id, activeSignal); },
    async click(id, activeSignal = signal) { const element = await visible(id, activeSignal); await request('POST', route('/element/' + encodeURIComponent(element) + '/click'), {}, activeSignal); },
    async text(id, activeSignal = signal) {
      const element = await visible(id, activeSignal), base = '/element/' + encodeURIComponent(element);
      let value = (await request('GET', route(base + '/attribute/value'), undefined, activeSignal)).value;
      if (value === null || value === '') value = (await request('GET', route(base + '/text'), undefined, activeSignal)).value;
      if (typeof value !== 'string' || value.length > 8192) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      return value;
    },
    async type(id, value, activeSignal = signal) {
      if (typeof value !== 'string' || value.length > 4096) throw fail('NATIVE_DRIVER_INPUT_INVALID');
      const element = await visible(id, activeSignal), base = '/element/' + encodeURIComponent(element);
      await request('POST', route(base + '/clear'), {}, activeSignal); await request('POST', route(base + '/value'), { text: value }, activeSignal);
    },
    async hideKeyboard(activeSignal = signal) {
      if (closed) throw fail('NATIVE_DRIVER_SESSION_INVALID'); await nativeContext(activeSignal);
      const isShown = async (timeoutMs, outerDeadline) => {
        const shown = (await request('GET', route('/appium/device/is_keyboard_shown'), undefined, activeSignal, timeoutMs, outerDeadline)).value;
        if (shown !== true && shown !== false) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
        return shown;
      };
      if (!await isShown()) return;
      // An iPhone number pad has no system Done key. Use only the explicitly
      // configured app-owned control; issue that action once, then observe.
      if (keyboardDismissId !== undefined) await actions.click(keyboardDismissId, activeSignal);
      else await request('POST', route('/appium/device/hide_keyboard'), {}, activeSignal);
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const shown = await isShown(Math.min(5000, deadline - performance.now()), deadline);
        if (performance.now() >= deadline) throw fail('NATIVE_DRIVER_TIMEOUT');
        if (!shown) return;
        await waitDriverSignal(Math.min(100, Math.max(0, deadline - performance.now())), activeSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
      }
      throw fail('NATIVE_DRIVER_TIMEOUT');
    },
    async close() { if (!closed) { await request('DELETE', route(''), undefined, null); closed = true; } },
  };
  const scoped = activeSignal => Object.freeze({
    context: 'NATIVE_APP',
    withSignal(phaseSignal) { try { return scoped(combineDriverSignals(activeSignal, phaseSignal)); } catch { throw fail('NATIVE_DRIVER_INPUT_INVALID'); } },
    waitFor: id => actions.waitFor(id, activeSignal), click: id => actions.click(id, activeSignal),
    scrollIntoView: id => actions.scrollIntoView(id, activeSignal), text: id => actions.text(id, activeSignal),
    type: (id, value) => actions.type(id, value, activeSignal), hideKeyboard: () => actions.hideKeyboard(activeSignal),
    close: actions.close,
  });
  return scoped(signal);
}
