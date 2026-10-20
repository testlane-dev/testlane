/** Credential-free setup using the same installed driver and options as the proof workers. */
import { IOS_DEVICE_SCOPE, validateIosDeviceBinding } from './device-scope.mjs';
import { NATIVE_DRIVER_FAILURE_CODES } from '../android-verification/contracts.mjs';

const fail = code => Object.assign(new Error(code), { code });
const fixedFailure = error => fail(NATIVE_DRIVER_FAILURE_CODES.includes(error?.code) || error?.code === 'NATIVE_DRIVER_CANCELLED' ? error.code : 'NATIVE_DRIVER_COMMAND_FAILED');

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
export async function verifyInstalledIosReadiness({ createNativeDriver, driverOptions, assertOwned, signal, appPrewarmed } = {}) {
  if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  if (typeof createNativeDriver !== 'function' || typeof assertOwned !== 'function' || appPrewarmed !== true ||
    driverOptions?.deviceBinding?.scope !== IOS_DEVICE_SCOPE) throw fail('NATIVE_DRIVER_CONFIGURATION_INVALID');
  let driver, error, failed = false, sessionSetupMs;
  const began = performance.now();
  try {
    driver = await createNativeDriver({ ...driverOptions, signal, assertOwned });
    sessionSetupMs = Math.max(0, Math.round(performance.now() - began));
    if (driver?.context !== 'NATIVE_APP') throw fail('NATIVE_DRIVER_CONTEXT_REFUSED');
    if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  } catch (caught) { error = fixedFailure(caught); failed = true; }
  finally {
    if (driver) {
      try { await driver.close(); }
      catch (caught) { if (!failed) { error = fixedFailure(caught); failed = true; } }
    }
  }
  if (failed) throw error;
  if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
  return Object.freeze({
    schemaVersion: 1, purpose: 'credential-free-native-readiness', runner: 'ios-xcuitest', deviceScope: IOS_DEVICE_SCOPE,
    installedDriver: true, appPrewarmed: true, sessionCreated: true, nativeContextVerified: true,
    sessionCleanup: 'deleted', sessionSetupMs,
  });
}
