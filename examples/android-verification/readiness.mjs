/** Credential-free setup using the same installed driver and options as the proof workers. */
import { types } from 'node:util';
import { NativeDriverError } from './driver.mjs';
import { NATIVE_DRIVER_FAILURE_CODES } from './contracts.mjs';

const CODES = new Set([...NATIVE_DRIVER_FAILURE_CODES, 'NATIVE_DRIVER_CANCELLED']);
const fail = code => new NativeDriverError(code);
function failureCode(error) {
  try {
    if (!types.isProxy(error) && types.isNativeError(error) && Object.getPrototypeOf(error) === NativeDriverError.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && CODES.has(descriptor.value)) return descriptor.value;
    }
  } catch { /* Unknown callback values and their properties are never retained. */ }
  return 'NATIVE_DRIVER_COMMAND_FAILED';
}

export function androidProofDriverOptions(device) {
  const capabilities = Object.freeze({
    platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': device.serial,
    'appium:appPackage': 'dev.testlane.androidproof', 'appium:appActivity': '.MainActivity',
    'appium:remoteAdbHost': '127.0.0.1', 'appium:adbPort': device.adbPort, 'appium:systemPort': device.systemPort,
    'appium:skipLogcatCapture': true, 'appium:suppressKillServer': true,
    'appium:printPageSourceOnFindFailure': false, 'appium:noReset': true, 'appium:newCommandTimeout': 90,
  });
  return Object.freeze({ url: device.serverUrl, capabilities });
}

export function androidReadinessFailure(error) {
  return Object.freeze({ schemaVersion: 1, purpose: 'credential-free-native-readiness', runner: 'android-uiautomator2',
    status: 'failed', stage: 'android-readiness', code: failureCode(error) });
}

/** Unknown setup or close outcomes belong to the existing owned-device teardown. */
export async function verifyInstalledAndroidReadiness({ createNativeDriver, driverOptions, assertOwned, signal } = {}) {
  if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  if (typeof createNativeDriver !== 'function' || typeof assertOwned !== 'function' || !driverOptions ||
    !Object.isFrozen(driverOptions) || !Object.isFrozen(driverOptions.capabilities)) throw fail('NATIVE_DRIVER_CONFIGURATION_INVALID');
  let driver, error, failed = false, sessionSetupMs, readinessMs;
  const began = performance.now();
  try {
    driver = await createNativeDriver({ ...driverOptions, signal, assertOwned });
    sessionSetupMs = Math.max(0, Math.round(performance.now() - began));
    if (driver?.context !== 'NATIVE_APP') throw fail('NATIVE_DRIVER_CONTEXT_REFUSED');
    if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
    const waiting = performance.now();
    await driver.waitFor('session-status');
    readinessMs = Math.max(0, Math.round(performance.now() - waiting));
    if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  } catch (caught) { error = fail(failureCode(caught)); failed = true; }
  finally {
    if (driver) {
      try { await driver.close(); }
      catch (caught) { if (!failed) { error = fail(failureCode(caught)); failed = true; } }
    }
  }
  if (failed) throw error;
  if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  return Object.freeze({
    schemaVersion: 1, purpose: 'credential-free-native-readiness', runner: 'android-uiautomator2', installedDriver: true,
    sessionCreated: true, nativeContextVerified: true, appReadinessObserved: true, sessionCleanup: 'deleted', sessionSetupMs, readinessMs,
  });
}
