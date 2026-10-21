/** Credential-free setup using the same installed driver and options as the proof workers. */
import { IOS_DEVICE_SCOPE, validateIosDeviceBinding } from './device-scope.mjs';
import { NATIVE_DRIVER_FAILURE_CODES } from '../android-verification/contracts.mjs';
import { probeIosPreauthControls } from './preauth-controls.mjs';
import { NativeDriverError, readIosRequestFailure, readIosRequestProgress } from './driver.mjs';
import { types } from 'node:util';

const codes = new Set([...NATIVE_DRIVER_FAILURE_CODES, 'NATIVE_DRIVER_CANCELLED']);
const fail = (code, request, progress) => new NativeDriverError(code, request, progress);
function fixedFailure(error) {
  if (error !== null && typeof error === 'object' && !types.isProxy(error) && types.isNativeError(error)) {
    try {
      const code = Object.getOwnPropertyDescriptor(error, 'code');
      if (Object.getPrototypeOf(error) === NativeDriverError.prototype && code && Object.hasOwn(code, 'value') &&
          typeof code.value === 'string' && codes.has(code.value)) return fail(code.value, readIosRequestFailure(error), readIosRequestProgress(error));
    } catch { /* Getters, proxies and arbitrary error data never become facts. */ }
  }
  return fail('NATIVE_DRIVER_COMMAND_FAILED');
}

export function iosProofDriverOptions(device) {
  const capabilities = Object.freeze({
    platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': device.udid,
    'appium:bundleId': 'dev.testlane.iosproof', 'appium:simulatorDevicesSetPath': device.deviceSetPath,
    'appium:derivedDataPath': device.derivedDataPath, 'appium:wdaLocalPort': device.wdaPort,
    'appium:wdaRemotePort': device.wdaPort, 'appium:wdaBindingIP': '127.0.0.1',
    'appium:wdaBaseUrl': 'http://127.0.0.1', 'appium:mjpegServerPort': device.mjpegPort,
    'appium:skipLogCapture': true, 'appium:showIOSLog': false, 'appium:showXcodeLog': false,
    'appium:printPageSourceOnFindFailure': false, 'appium:disableAutomaticScreenshots': true,
    'appium:shutdownOtherSimulators': false, 'appium:resetLocationService': false, 'appium:noReset': true,
    'appium:isHeadless': true, 'appium:newCommandTimeout': 90, 'appium:waitForIdleTimeout': 1,
    'appium:wdaLaunchTimeout': 120000, 'appium:wdaConnectionTimeout': 5000, 'appium:wdaStartupRetries': 1,
    'appium:forceAppLaunch': false, 'appium:shouldTerminateApp': false, 'appium:usePrebuiltWDA': true,
  });
  const deviceBinding = validateIosDeviceBinding(device.deviceBinding, { capabilities });
  return Object.freeze({ url: device.serverUrl, deviceBinding, keyboardDismissId: 'dismiss-keyboard', capabilities });
}

/**
 * The caller loads createNativeDriver from its installed consumer package.
 * Construction must verify NATIVE_APP. Close is attempted exactly once for a
 * returned driver; unknown setup or close outcomes belong to device teardown.
 */
export async function verifyInstalledIosReadiness({ createNativeDriver, driverOptions, assertOwned, signal, appPrewarmed,
  preauthControls = false, onPreauthControls = () => {} } = {}) {
  if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  if (typeof createNativeDriver !== 'function' || typeof assertOwned !== 'function' || appPrewarmed !== true ||
    driverOptions?.deviceBinding?.scope !== IOS_DEVICE_SCOPE || typeof preauthControls !== 'boolean' ||
    typeof onPreauthControls !== 'function') throw fail('NATIVE_DRIVER_CONFIGURATION_INVALID');
  let driver, error, failed = false, sessionSetupMs, sessionCleanupAcknowledged = false;
  const steps = [];
  const began = performance.now();
  try {
    driver = await createNativeDriver({ ...driverOptions, signal, assertOwned });
    sessionSetupMs = Math.max(0, Math.round(performance.now() - began));
    if (driver?.context !== 'NATIVE_APP') throw fail('NATIVE_DRIVER_CONTEXT_REFUSED');
    if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
    if (preauthControls) await probeIosPreauthControls({ driver, signal, onStep: row => steps.push(row) });
  } catch (caught) { error = fixedFailure(caught); failed = true; }
  finally {
    if (driver) {
      try { await driver.close(); sessionCleanupAcknowledged = true; }
      catch (caught) { if (!failed) { error = fixedFailure(caught); failed = true; } }
    }
  }
  if (signal?.aborted && !failed) { error = fail('NATIVE_DRIVER_CANCELLED'); failed = true; }
  if (preauthControls) onPreauthControls(Object.freeze({ schemaVersion: 1, purpose: 'credential-free-fixed-controls',
    completed: !failed, sessionCleanupAcknowledged, steps: Object.freeze(steps) }));
  if (failed) throw error;
  return Object.freeze({
    schemaVersion: 1, purpose: 'credential-free-native-readiness', runner: 'ios-xcuitest', deviceScope: IOS_DEVICE_SCOPE,
    installedDriver: true, appPrewarmed: true, sessionCreated: true, nativeContextVerified: true,
    sessionCleanup: 'deleted', sessionSetupMs,
  });
}
