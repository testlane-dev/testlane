/** Thin W3C native client. Never requests screenshots, source, logs or shell execution. */
import { loopbackOrigin } from './contracts.mjs';
import { combineDriverSignals, withDriverSignal, waitDriverSignal } from './driver-phase.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
export class NativeDriverError extends Error {
  constructor(code) { super(code); this.name = 'NativeDriverError'; this.code = code; }
}
const fail = code => new NativeDriverError(code);
const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
export async function createNativeDriver({ url, capabilities, signal, assertOwned } = {}) {
  let origin;
  try {
    origin = loopbackOrigin(url);
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) ||
      capabilities.platformName?.toLowerCase() !== 'android' || capabilities['appium:automationName']?.toLowerCase() !== 'uiautomator2' ||
      !identifier(capabilities['appium:udid']) || !identifier(capabilities['appium:appPackage']) ||
      capabilities['appium:remoteAdbHost'] !== '127.0.0.1' || !['appium:adbPort', 'appium:systemPort'].every(key =>
        Number.isSafeInteger(capabilities[key]) && capabilities[key] > 0 && capabilities[key] <= 65535) ||
      capabilities['appium:skipLogcatCapture'] !== true || capabilities['appium:suppressKillServer'] !== true ||
      capabilities['appium:printPageSourceOnFindFailure'] !== false || Object.hasOwn(capabilities, 'browserName') ||
      capabilities['appium:autoWebview'] === true || Object.hasOwn(capabilities, 'appium:options') ||
      (assertOwned !== undefined && typeof assertOwned !== 'function')) throw new Error();
  } catch { throw fail('NATIVE_DRIVER_CONFIGURATION_INVALID'); }
  let session, closed = false;
  async function verifyOwner(activeSignal) {
    if (!assertOwned) return;
    let timer;
    try {
      const allowed = await withDriverSignal(() => Promise.race([Promise.resolve().then(assertOwned),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail('NATIVE_DRIVER_OWNERSHIP_REFUSED')), 5000); })]), activeSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
      if (allowed === false) throw fail('NATIVE_DRIVER_OWNERSHIP_REFUSED');
    } catch { throw fail(activeSignal?.aborted ? 'NATIVE_DRIVER_CANCELLED' : 'NATIVE_DRIVER_OWNERSHIP_REFUSED'); }
    finally { clearTimeout(timer); }
  }
  async function request(method, route, body, requestSignal = signal, timeoutMs = 5000) {
    if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const operationSignal = requestSignal ? AbortSignal.any([requestSignal, timer.signal]) : timer.signal;
    try {
      await verifyOwner(operationSignal);
      if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
      if (timer.signal.aborted) throw fail('NATIVE_DRIVER_TIMEOUT');
      const response = await fetch(origin + route, { method,
        signal: operationSignal,
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error' });
      const reader = response.body?.getReader();
      let length = 0; const chunks = [];
      if (!reader) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 64 * 1024) { await reader.cancel(); throw fail('NATIVE_DRIVER_RESPONSE_INVALID'); }
        chunks.push(Buffer.from(value));
      }
      let decoded;
      try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('NATIVE_DRIVER_RESPONSE_INVALID'); }
      if (!decoded || typeof decoded !== 'object' || !Object.hasOwn(decoded, 'value')) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      if (!response.ok || decoded.value?.error !== undefined) {
        if (response.status === 404 && decoded.value?.error === 'no such element') return { missing: true };
        throw fail('NATIVE_DRIVER_COMMAND_FAILED');
      }
      return { value: decoded.value };
    } catch (error) {
      if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
      if (timer.signal.aborted) throw fail('NATIVE_DRIVER_TIMEOUT');
      if (error instanceof NativeDriverError) throw error;
      throw fail('NATIVE_DRIVER_COMMAND_FAILED');
    } finally { clearTimeout(timeout); }
  }
  let created;
  try {
    // Pinned UiAutomator2 cold setup includes helper/server installation,
    // instrumentation startup and app launch. Only session creation gets this
    // aggregate ceiling; ordinary requests and business budgets are unchanged.
    created = (await request('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, signal, 120_000)).value;
  } catch (error) {
    if (error instanceof NativeDriverError && error.code === 'NATIVE_DRIVER_TIMEOUT') throw fail('NATIVE_DRIVER_SESSION_TIMEOUT');
    throw error;
  }
  if (!created || typeof created.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,160}$/.test(created.sessionId)) throw fail('NATIVE_DRIVER_SESSION_INVALID');
  session = created.sessionId;
  const route = suffix => '/session/' + encodeURIComponent(session) + suffix;
  async function nativeContext(activeSignal = signal) {
    try {
      if ((await request('GET', route('/context'), undefined, activeSignal)).value !== 'NATIVE_APP') throw fail('NATIVE_DRIVER_CONTEXT_REFUSED');
    } catch (error) {
      if (error instanceof NativeDriverError && error.code === 'NATIVE_DRIVER_TIMEOUT') throw fail('NATIVE_DRIVER_CONTEXT_TIMEOUT');
      throw error;
    }
  }
  try { await nativeContext(); }
  catch (error) {
    await request('DELETE', route(''), undefined, null).catch(() => {});
    throw error;
  }
  function elementId(response) {
    const element = response.value?.[ELEMENT];
    if (!response.missing && typeof element === 'string' && /^[A-Za-z0-9-]{1,160}$/.test(element)) return element;
    throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
  }
  async function scrollIntoView(accessibilityId, activeSignal = signal) {
    if (closed || !identifier(accessibilityId)) throw fail('NATIVE_DRIVER_ELEMENT_INVALID');
    await nativeContext(activeSignal);
    // This is a fixed native selector, not an arbitrary UiAutomator program.
    // The only interpolated value is a JSON-escaped string literal.
    const value = 'new UiScrollable(new UiSelector().scrollable(true)).setMaxSearchSwipes(8).scrollIntoView(new UiSelector().description(' + JSON.stringify(accessibilityId) + '))';
    const response = await request('POST', route('/element'), { using: '-android uiautomator', value }, activeSignal);
    if (response.missing) throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
    const element = elementId(response);
    if ((await request('GET', route('/element/' + encodeURIComponent(element) + '/displayed'), undefined, activeSignal)).value !== true) throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
    return element;
  }
  async function find(accessibilityId, visible = false, activeSignal = signal) {
    if (closed || !identifier(accessibilityId)) throw fail('NATIVE_DRIVER_ELEMENT_INVALID');
    await nativeContext(activeSignal);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await request('POST', route('/element'), { using: 'accessibility id', value: accessibilityId }, activeSignal, Math.max(1, Math.min(5000, deadline - Date.now())));
      if (!response.missing) {
        const element = elementId(response);
        if (!visible) return element;
        const displayed = (await request('GET', route('/element/' + encodeURIComponent(element) + '/displayed'), undefined, activeSignal)).value;
        if (displayed === true) return element;
        if (displayed !== false) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
        return scrollIntoView(accessibilityId, activeSignal);
      }
      if (visible) return scrollIntoView(accessibilityId, activeSignal);
      await waitDriverSignal(Math.min(200, Math.max(0, deadline - Date.now())), activeSignal, () => fail('NATIVE_DRIVER_CANCELLED'));
    }
    throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
  }
  const actions = {
    async waitFor(id, activeSignal = signal) {
      try { await find(id, false, activeSignal); }
      catch (error) {
        if (error instanceof NativeDriverError && ['NATIVE_DRIVER_TIMEOUT', 'NATIVE_DRIVER_ELEMENT_TIMEOUT'].includes(error.code)) throw fail('NATIVE_DRIVER_READINESS_TIMEOUT');
        throw error;
      }
    },
    async click(id, activeSignal = signal) { const element = await find(id, true, activeSignal); await request('POST', route('/element/' + encodeURIComponent(element) + '/click'), {}, activeSignal); },
    async scrollIntoView(id, activeSignal = signal) { await scrollIntoView(id, activeSignal); },
    async text(id, activeSignal = signal) {
      const element = await find(id, true, activeSignal), base = '/element/' + encodeURIComponent(element);
      let value = (await request('GET', route(base + '/text'), undefined, activeSignal)).value;
      if (value === null || value === '') value = (await request('GET', route(base + '/attribute/text'), undefined, activeSignal)).value;
      if (typeof value !== 'string' || value.length > 8192) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      return value; // Trusted case code may compare this; the runner never retains it.
    },
    async type(id, value, activeSignal = signal) {
      if (typeof value !== 'string' || value.length > 4096) throw fail('NATIVE_DRIVER_INPUT_INVALID');
      const element = await find(id, true, activeSignal), base = '/element/' + encodeURIComponent(element);
      await request('POST', route(base + '/clear'), {}, activeSignal);
      await request('POST', route(base + '/value'), { text: value }, activeSignal);
    },
    async hideKeyboard(activeSignal = signal) {
      if (closed) throw fail('NATIVE_DRIVER_SESSION_INVALID');
      await nativeContext(activeSignal);
      const shown = (await request('GET', route('/appium/device/is_keyboard_shown'), undefined, activeSignal)).value;
      if (shown !== true && shown !== false) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      if (shown) await request('POST', route('/appium/device/hide_keyboard'), {}, activeSignal);
    },
    async close() {
      if (closed) return;
      // Cleanup is bounded independently of an already-aborted caller signal.
      await request('DELETE', route(''), undefined, null, 5000);
      closed = true;
    },
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
