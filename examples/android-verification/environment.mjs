/** Explicit environments for owned Android tools; no ambient credential forwarding. */
import path from 'node:path';

const fail = () => new Error('ANDROID_DEVICE_ENV_INVALID');
const clean = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f"%]/.test(value);
const supported = platform => ['win32', 'linux', 'darwin'].includes(platform);
const pathsFor = platform => platform === 'win32' ? path.win32 : path.posix;
const equivalent = (left, right, platform) => platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** A conservative host policy, not an attestation or same-user security boundary. */
export function requireAndroidProofHost(source = process.env, { platform = process.platform } = {}) {
  try {
    if (!supported(platform) || !object(source)) throw new Error('ANDROID_HOST_POLICY_REFUSED');
    if (platform === 'win32' && (selected(source, 'GITHUB_ACTIONS', platform) !== 'true' ||
      selected(source, 'RUNNER_ENVIRONMENT', platform) !== 'github-hosted' ||
      selected(source, 'TESTLANE_ANDROID_PROOF_CI', platform) !== '1')) throw new Error('ANDROID_HOST_POLICY_REFUSED');
    return true;
  } catch { throw new Error('ANDROID_HOST_POLICY_REFUSED'); }
}

function absolute(value, platform) {
  const paths = pathsFor(platform);
  if (!clean(value) || value.length > 4096 || value.includes(platform === 'win32' ? ';' : ':')) throw fail();
  if (platform === 'win32' ? !/^[A-Za-z]:[\\/]/.test(value) : !paths.isAbsolute(value) || value.includes('\\')) throw fail();
  const spelling = platform === 'win32' ? value.replaceAll('/', '\\') : value;
  const trimmed = spelling.endsWith(paths.sep) ? spelling.slice(0, -1) : spelling;
  if (!trimmed || trimmed.endsWith(paths.sep) || paths.normalize(trimmed) !== trimmed || paths.parse(trimmed).root === trimmed) throw fail();
  return trimmed;
}

function selected(source, key, platform) {
  const matches = Object.keys(source).filter(name => platform === 'win32' ? name.toUpperCase() === key.toUpperCase() : name === key);
  if (matches.length > 1) throw fail();
  return matches.length ? source[matches[0]] : undefined;
}

/** Windows cleanup uses only fixed OS executable configuration, never user PATH. */
export function createAndroidControlEnvironment(source = process.env, { platform = process.platform } = {}) {
  try {
    if (!object(source) || platform !== 'win32') throw fail();
    const systemValue = selected(source, 'SystemRoot', platform), windowsValue = selected(source, 'windir', platform);
    const system = absolute(systemValue ?? windowsValue, platform);
    if (windowsValue !== undefined && !equivalent(absolute(windowsValue, platform), system, platform)) throw fail();
    const shell = path.win32.join(system, 'System32', 'cmd.exe'), suppliedShell = selected(source, 'ComSpec', platform);
    if (suppliedShell !== undefined && !equivalent(absolute(suppliedShell, platform), shell, platform)) throw fail();
    return Object.freeze({ SystemRoot: system, windir: system, SystemDrive: path.win32.parse(system).root.slice(0, -1),
      ComSpec: shell, PATH: path.win32.join(system, 'System32') });
  } catch { throw fail(); }
}

/** The device factory establishes canonical tool paths and owns the marked root. */
export function androidDeviceDirectories(root, { platform = process.platform } = {}) {
  try {
    if (!supported(platform)) throw fail();
    const paths = pathsFor(platform), owned = absolute(root, platform);
    if (!/^tld-android-[A-Za-z0-9]+$/.test(paths.basename(owned))) throw fail();
    const home = paths.join(owned, 'home');
    return Object.freeze({ home, temporary: paths.join(owned, 'tmp'), cache: paths.join(owned, 'cache'),
      ...(platform === 'win32' ? { roaming: paths.join(home, 'AppData', 'Roaming'), local: paths.join(home, 'AppData', 'Local') } : {}) });
  } catch { throw fail(); }
}

export function createAndroidDeviceEnvironment(binding, source = process.env, { platform = process.platform } = {}) {
  try {
    const keys = ['root', 'sdkRoot', 'javaHome', 'nodeExecutable', 'adbPort'];
    if (!supported(platform) || !object(source) || !object(binding) || Object.keys(binding).length !== keys.length ||
      Object.keys(binding).some(key => !keys.includes(key))) throw fail();
    const paths = pathsFor(platform), root = absolute(binding.root, platform), sdk = absolute(binding.sdkRoot, platform), java = absolute(binding.javaHome, platform);
    const nodeExecutable = absolute(binding.nodeExecutable, platform);
    if (!Number.isSafeInteger(binding.adbPort) || binding.adbPort < 1024 || binding.adbPort > 65535 || binding.adbPort === 5037) throw fail();
    const directories = androidDeviceDirectories(root, { platform }), androidHome = paths.join(root, 'android');
    const osEnvironment = platform === 'win32' ? createAndroidControlEnvironment(source, { platform }) : {};
    const suppliedPath = selected(source, 'PATH', platform);
    const fallback = platform === 'win32' ? [osEnvironment.PATH, osEnvironment.SystemRoot].join(';') : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const searchPath = suppliedPath === undefined ? fallback : suppliedPath;
    if (!clean(searchPath)) throw fail();
    const executableDirectories = searchPath.split(paths.delimiter).map(value => absolute(value, platform));
    const search = [paths.dirname(nodeExecutable), paths.join(java, 'bin'), paths.join(sdk, 'platform-tools'), paths.join(sdk, 'emulator'), ...executableDirectories].join(paths.delimiter);
    if (search.length > 32768) throw fail();
    const environment = {
      ...osEnvironment, PATH: search,
      ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, JAVA_HOME: java,
      ANDROID_USER_HOME: androidHome, ANDROID_EMULATOR_HOME: androidHome, ANDROID_AVD_HOME: paths.join(androidHome, 'avd'),
      ADB_VENDOR_KEYS: paths.join(androidHome, 'adbkey'), ADB_SERVER_SOCKET: 'tcp:127.0.0.1:' + binding.adbPort,
      ANDROID_ADB_SERVER_PORT: String(binding.adbPort), ADB_MDNS_AUTO_CONNECT: '0', ADB_USB: '0', ADB_EMU: '0',
      APPIUM_HOME: paths.join(root, 'appium'), APPIUM_TMP_DIR: directories.temporary,
      HOME: directories.home, TMP: directories.temporary, TEMP: directories.temporary, TMPDIR: directories.temporary, XDG_CACHE_HOME: directories.cache,
      LANG: 'C', LC_ALL: 'C', DEBUG: '', NODE_DEBUG: '', ANDROID_VERBOSE: '', APPIUM_SKIP_EXTENSIONS_INSTALL: '1',
    };
    if (platform === 'win32') Object.assign(environment, { PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: directories.home,
      HOMEDRIVE: paths.parse(directories.home).root.slice(0, -1), HOMEPATH: directories.home.slice(paths.parse(directories.home).root.length - 1),
      APPDATA: directories.roaming, LOCALAPPDATA: directories.local });
    return Object.freeze(environment);
  } catch { throw fail(); }
}
