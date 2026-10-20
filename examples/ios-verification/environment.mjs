/** Minimal environment for owned macOS native tools; never copy ambient credentials. */
import path from 'node:path';

const OWNED_KEYS = ['APPIUM_HOME', 'TMPDIR', 'XDG_CACHE_HOME'];
const BINDING_KEYS = ['nativeHome', ...OWNED_KEYS];
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const fail = () => new Error('IOS_DEVICE_ENV_INVALID');
const clean = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f\\]/.test(value);
function absolute(value, { trailingSlash = false } = {}) {
  if (!clean(value) || value.length > 4096 || !path.posix.isAbsolute(value)) throw fail();
  const normalized = trailingSlash && value.endsWith('/') ? value.slice(0, -1) : value;
  if (normalized.endsWith('/') || path.posix.normalize(normalized) !== normalized) throw fail();
  return normalized;
}

/**
 * The caller must establish actual filesystem ownership. These checks only bind
 * the canonical OS-account home and explicit private sibling directories.
 * nativeHome is supplied only by the device factory, never inherited from source.
 * PATH and DEVELOPER_DIR remain trusted executable/toolchain configuration.
 */
export function createIosDeviceEnvironment(binding, source = process.env) {
  try {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).length !== BINDING_KEYS.length || Object.keys(binding).some(key => !BINDING_KEYS.includes(key)) ||
        !source || typeof source !== 'object' || Array.isArray(source)) throw fail();
    const nativeHome = absolute(binding.nativeHome);
    const paths = Object.fromEntries(OWNED_KEYS.map(key => [key, absolute(binding[key], { trailingSlash: key === 'TMPDIR' })]));
    const privatePaths = OWNED_KEYS.map(key => paths[key]);
    if (privatePaths.includes(nativeHome) || new Set(privatePaths).size !== privatePaths.length ||
        new Set(privatePaths.map(value => path.posix.dirname(value))).size !== 1) throw fail();
    const searchPath = source.PATH === undefined ? SYSTEM_PATH : source.PATH;
    if (!clean(searchPath) || searchPath.length > 32768 ||
        searchPath.split(':').some(value => !clean(value) || !path.posix.isAbsolute(value) ||
          path.posix.normalize(value).replace(/\/$/, '') !== value.replace(/\/$/, ''))) throw fail();
    const environment = {
      PATH: searchPath,
      HOME: nativeHome,
      ...Object.fromEntries(OWNED_KEYS.map(key => [key, binding[key]])),
      LANG: 'C', LC_ALL: 'C',
      APPIUM_SKIP_EXTENSIONS_INSTALL: '1', DEBUG: '', NODE_DEBUG: '', VERBOSE_LOGGING: '0',
    };
    if (source.DEVELOPER_DIR !== undefined) {
      absolute(source.DEVELOPER_DIR); environment.DEVELOPER_DIR = source.DEVELOPER_DIR;
    }
    return Object.freeze(environment);
  } catch { throw fail(); }
}
