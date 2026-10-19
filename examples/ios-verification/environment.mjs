/** Minimal environment for owned macOS native tools; never copy ambient credentials. */
import path from 'node:path';

const OWNED_KEYS = ['HOME', 'CFFIXED_USER_HOME', 'APPIUM_HOME', 'TMPDIR', 'XDG_CACHE_HOME'];
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
 * explicit private sibling directories; no inherited HOME/cache/temp is accepted.
 * PATH and DEVELOPER_DIR remain trusted executable/toolchain configuration.
 */
export function createIosDeviceEnvironment(owned, source = process.env) {
  try {
    if (!owned || typeof owned !== 'object' || Array.isArray(owned) ||
        Object.keys(owned).length !== OWNED_KEYS.length || Object.keys(owned).some(key => !OWNED_KEYS.includes(key)) ||
        !source || typeof source !== 'object' || Array.isArray(source)) throw fail();
    const paths = Object.fromEntries(OWNED_KEYS.map(key => [key, absolute(owned[key], { trailingSlash: key === 'TMPDIR' })]));
    if (paths.CFFIXED_USER_HOME !== paths.HOME) throw fail();
    const privatePaths = [paths.HOME, paths.APPIUM_HOME, paths.TMPDIR, paths.XDG_CACHE_HOME];
    if (new Set(privatePaths).size !== privatePaths.length ||
        new Set(privatePaths.map(value => path.posix.dirname(value))).size !== 1) throw fail();
    const searchPath = source.PATH === undefined ? SYSTEM_PATH : source.PATH;
    if (!clean(searchPath) || searchPath.length > 32768 ||
        searchPath.split(':').some(value => !clean(value) || !path.posix.isAbsolute(value) ||
          path.posix.normalize(value).replace(/\/$/, '') !== value.replace(/\/$/, ''))) throw fail();
    const environment = {
      PATH: searchPath,
      ...Object.fromEntries(OWNED_KEYS.map(key => [key, owned[key]])),
      LANG: 'C', LC_ALL: 'C',
      APPIUM_SKIP_EXTENSIONS_INSTALL: '1', DEBUG: '', NODE_DEBUG: '', VERBOSE_LOGGING: '0',
    };
    if (source.DEVELOPER_DIR !== undefined) {
      absolute(source.DEVELOPER_DIR); environment.DEVELOPER_DIR = source.DEVELOPER_DIR;
    }
    return Object.freeze(environment);
  } catch { throw fail(); }
}
