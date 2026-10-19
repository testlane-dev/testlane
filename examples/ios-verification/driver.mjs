/** Narrow XCUITest W3C client for an already-owned local Simulator. */
import path from 'node:path';
import { loopbackOrigin } from '../android-verification/contracts.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
export class NativeDriverError extends Error {
  constructor(code) { super(code); this.name = 'NativeDriverError'; this.code = code; }
}
const fail = code => new NativeDriverError(code);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const port = value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;
const optionalCaps = ['appium:deviceName', 'appium:platformVersion', 'appium:newCommandTimeout', 'appium:waitForIdleTimeout',
  'appium:wdaLaunchTimeout', 'appium:wdaConnectionTimeout'];
const requiredCaps = ['platformName', 'appium:automationName', 'appium:udid', 'appium:bundleId', 'appium:simulatorDevicesSetPath',
  'appium:derivedDataPath', 'appium:wdaLocalPort', 'appium:wdaRemotePort', 'appium:wdaBindingIP', 'appium:wdaBaseUrl', 'appium:mjpegServerPort',
  'appium:skipLogCapture', 'appium:showIOSLog', 'appium:showXcodeLog', 'appium:printPageSourceOnFindFailure',
  'appium:disableAutomaticScreenshots', 'appium:shutdownOtherSimulators', 'appium:resetLocationService', 'appium:noReset'];
function ownedPaths(caps) {
  const devices = caps['appium:simulatorDevicesSetPath'], derived = caps['appium:derivedDataPath'];
  if (![devices, derived].every(value => typeof value === 'string' && value.length <= 1024 && path.posix.isAbsolute(value) &&
    path.posix.resolve(value) === value && !/[\u0000-\u001f\u007f\\]/.test(value))) return false;
  const root = path.posix.dirname(devices);
  return path.posix.basename(devices) === 'devices' && derived === path.posix.join(root, 'derived-data') &&
    /^tld-ios-[A-Za-z0-9]+$/.test(path.posix.basename(root));
}
export async function createNativeDriver({ url, capabilities: supplied, signal, assertOwned } = {}) {
  let origin, capabilities;
  try {
    origin = loopbackOrigin(url);
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
      supplied.platformName?.toLowerCase() !== 'ios' || supplied['appium:automationName']?.toLowerCase() !== 'xcuitest' ||
      !uuid(supplied['appium:udid']) || !identifier(supplied['appium:bundleId']) || !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/.test(supplied['appium:bundleId']) ||
      !ownedPaths(supplied) || !port(supplied['appium:wdaLocalPort']) || supplied['appium:wdaRemotePort'] !== supplied['appium:wdaLocalPort'] ||
      !port(supplied['appium:mjpegServerPort']) || supplied['appium:mjpegServerPort'] === supplied['appium:wdaLocalPort'] ||
      supplied['appium:wdaBindingIP'] !== '127.0.0.1' || supplied['appium:wdaBaseUrl'] !== 'http://127.0.0.1' ||
      !['appium:skipLogCapture', 'appium:disableAutomaticScreenshots', 'appium:noReset'].every(key => supplied[key] === true) ||
      !['appium:showIOSLog', 'appium:showXcodeLog', 'appium:printPageSourceOnFindFailure', 'appium:shutdownOtherSimulators', 'appium:resetLocationService'].every(key => supplied[key] === false) ||
      Object.keys(supplied).some(key => !requiredCaps.includes(key) && !optionalCaps.includes(key)) || typeof assertOwned !== 'function') throw new Error();
    for (const key of ['appium:deviceName', 'appium:platformVersion']) if (supplied[key] !== undefined && !identifier(supplied[key])) throw new Error();
    for (const key of ['appium:newCommandTimeout', 'appium:waitForIdleTimeout', 'appium:wdaLaunchTimeout', 'appium:wdaConnectionTimeout']) {
      if (supplied[key] !== undefined && (!Number.isFinite(supplied[key]) || supplied[key] < 0 || supplied[key] > 240_000)) throw new Error();
    }
    capabilities = structuredClone(supplied);
  } catch { throw fail('NATIVE_DRIVER_CONFIGURATION_INVALID'); }
  let session, closed = false;
  async function request(method, route, body, requestSignal = signal, timeoutMs = 5000) {
    if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
    const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), timeoutMs);
    let ownerTimer;
    try {
      const allowed = await Promise.race([Promise.resolve().then(assertOwned), new Promise((_, reject) => {
        ownerTimer = setTimeout(() => reject(fail('NATIVE_DRIVER_OWNERSHIP_REFUSED')), 5000);
      })]).catch(() => { throw fail('NATIVE_DRIVER_OWNERSHIP_REFUSED'); });
      clearTimeout(ownerTimer);
      if (allowed !== true) throw fail('NATIVE_DRIVER_OWNERSHIP_REFUSED');
      if (requestSignal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
      if (timer.signal.aborted) throw fail('NATIVE_DRIVER_TIMEOUT');
      const response = await fetch(origin + route, { method, redirect: 'error', signal: requestSignal ? AbortSignal.any([requestSignal, timer.signal]) : timer.signal,
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const reader = response.body?.getReader(); if (!reader) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      let length = 0; const chunks = [];
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 64 * 1024) { await reader.cancel(); throw fail('NATIVE_DRIVER_RESPONSE_INVALID'); }
        chunks.push(Buffer.from(value));
      }
      let decoded; try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('NATIVE_DRIVER_RESPONSE_INVALID'); }
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
    } finally { clearTimeout(timeout); clearTimeout(ownerTimer); }
  }
  let created;
  try { created = (await request('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, signal, 240_000)).value; }
  catch (error) { if (error.code === 'NATIVE_DRIVER_TIMEOUT') throw fail('NATIVE_DRIVER_SESSION_TIMEOUT'); throw error; }
  if (!created || typeof created.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,160}$/.test(created.sessionId)) throw fail('NATIVE_DRIVER_SESSION_INVALID');
  session = created.sessionId;
  const route = suffix => '/session/' + encodeURIComponent(session) + suffix;
  async function nativeContext() {
    try { if ((await request('GET', route('/context'))).value !== 'NATIVE_APP') throw fail('NATIVE_DRIVER_CONTEXT_REFUSED'); }
    catch (error) { if (error.code === 'NATIVE_DRIVER_TIMEOUT') throw fail('NATIVE_DRIVER_CONTEXT_TIMEOUT'); throw error; }
  }
  try { await nativeContext(); }
  catch (error) { await request('DELETE', route(''), undefined, null).catch(() => {}); throw error; }
  function elementId(result) {
    const id = result.value?.[ELEMENT];
    if (result.missing || typeof id !== 'string' || !/^[A-Za-z0-9-]{1,160}$/.test(id)) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
    return id;
  }
  async function find(id) {
    if (closed || !identifier(id)) throw fail('NATIVE_DRIVER_ELEMENT_INVALID');
    await nativeContext(); const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await request('POST', route('/element'), { using: 'accessibility id', value: id }, signal, Math.max(1, Math.min(5000, deadline - Date.now())));
      if (!result.missing) return elementId(result);
      await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
    }
    throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
  }
  async function visible(id) {
    let element = await find(id);
    const deadline = Date.now() + 10_000;
    for (let swipe = 0; swipe <= 6 && Date.now() < deadline; swipe++) {
      const shown = (await request('GET', route('/element/' + encodeURIComponent(element) + '/displayed'))).value;
      if (shown === true) return element;
      if (shown !== false) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      if (swipe === 6) break;
      await nativeContext();
      const frame = (await request('GET', route('/window/rect'))).value;
      const rect = (await request('GET', route('/element/' + encodeURIComponent(element) + '/rect'))).value;
      if (![frame, rect].every(value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) ||
        frame.width < 20 || frame.height < 40 || frame.width > 5000 || frame.height > 5000) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      const x = Math.round(frame.x + frame.width / 2), top = Math.round(frame.y + frame.height * 0.25), bottom = Math.round(frame.y + frame.height * 0.75);
      const upward = rect.y >= frame.y + frame.height / 2;
      await request('POST', route('/actions'), { actions: [{ type: 'pointer', id: 'owned-native-scroll', parameters: { pointerType: 'touch' }, actions: [
        { type: 'pointerMove', duration: 0, x, y: upward ? bottom : top }, { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 }, { type: 'pointerMove', duration: 200, x, y: upward ? top : bottom }, { type: 'pointerUp', button: 0 },
      ] }] });
      element = await find(id);
    }
    throw fail('NATIVE_DRIVER_ELEMENT_TIMEOUT');
  }
  return Object.freeze({ context: 'NATIVE_APP',
    async waitFor(id) { try { await find(id); } catch (error) { if (['NATIVE_DRIVER_TIMEOUT', 'NATIVE_DRIVER_ELEMENT_TIMEOUT'].includes(error.code)) throw fail('NATIVE_DRIVER_READINESS_TIMEOUT'); throw error; } },
    async scrollIntoView(id) { await visible(id); },
    async click(id) { const element = await visible(id); await request('POST', route('/element/' + encodeURIComponent(element) + '/click'), {}); },
    async text(id) {
      const element = await visible(id), base = '/element/' + encodeURIComponent(element);
      let value = (await request('GET', route(base + '/attribute/value'))).value;
      if (value === null || value === '') value = (await request('GET', route(base + '/text'))).value;
      if (typeof value !== 'string' || value.length > 8192) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      return value;
    },
    async type(id, value) {
      if (typeof value !== 'string' || value.length > 4096) throw fail('NATIVE_DRIVER_INPUT_INVALID');
      const element = await visible(id), base = '/element/' + encodeURIComponent(element);
      await request('POST', route(base + '/clear'), {}); await request('POST', route(base + '/value'), { text: value });
    },
    async hideKeyboard() {
      if (closed) throw fail('NATIVE_DRIVER_SESSION_INVALID'); await nativeContext();
      const shown = (await request('GET', route('/appium/device/is_keyboard_shown'))).value;
      if (shown !== true && shown !== false) throw fail('NATIVE_DRIVER_RESPONSE_INVALID');
      if (shown) await request('POST', route('/appium/device/hide_keyboard'), {});
    },
    async close() { if (!closed) { await request('DELETE', route(''), undefined, null); closed = true; } },
  });
}
