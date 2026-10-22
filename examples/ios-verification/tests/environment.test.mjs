import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIosDeviceEnvironment } from '../environment.mjs';

const owned = () => ({
  nativeHome: '/Users/testlane-proof-host',
  APPIUM_HOME: '/private/tmp/tld-ios-unit/appium', TMPDIR: '/private/tmp/tld-ios-unit/tmp/',
  XDG_CACHE_HOME: '/private/tmp/tld-ios-unit/cache',
});
const privateKeys = ['APPIUM_HOME', 'TMPDIR', 'XDG_CACHE_HOME'];

test('device child environment binds the native account HOME and omits inherited overrides and credentials', () => {
  const canary = randomBytes(32).toString('base64url');
  const omitted = ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'UNRECOGNIZED',
    'TESTLANE_PROFILE', 'TESTLANE_HOME', 'SIMCTL_CHILD_TESTLANE_BOOTSTRAP', 'NODE_OPTIONS',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'CFFIXED_USER_HOME',
    'USE_PORT', 'USE_IP', 'MJPEG_SERVER_PORT', 'USER', 'LOGNAME', 'SHELL'];
  const source = Object.freeze({ PATH: '/opt/hostedtoolcache/node/22/bin:/usr/bin:/bin/',
    DEVELOPER_DIR: '/Applications/Xcode_26.6.app/Contents/Developer',
    ...Object.fromEntries(omitted.map(key => [key, canary])), HOME: canary, APPIUM_HOME: canary,
    TMPDIR: canary, XDG_CACHE_HOME: canary, nativeHome: canary,
    DEBUG: canary, NODE_DEBUG: canary, VERBOSE_LOGGING: canary, LANG: canary, LC_ALL: canary });
  const before = JSON.stringify(source), binding = Object.freeze(owned()), boundBefore = JSON.stringify(binding);
  const result = createIosDeviceEnvironment(binding, source);
  for (const key of omitted) assert.equal(Object.hasOwn(result, key), false, key);
  for (const value of [canary, encodeURIComponent(canary), Buffer.from(canary).toString('base64')]) assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal(JSON.stringify(source), before); assert.equal(JSON.stringify(binding), boundBefore);
  assert.equal(result.HOME, binding.nativeHome); assert.equal(Object.hasOwn(result, 'nativeHome'), false);
  for (const key of privateKeys) assert.equal(result[key], binding[key], key);
  assert.equal(result.PATH, source.PATH); assert.equal(result.DEVELOPER_DIR, source.DEVELOPER_DIR);
  assert.equal(result.LANG, 'C'); assert.equal(result.LC_ALL, 'C');
  assert.equal(result.DEBUG, ''); assert.equal(result.NODE_DEBUG, ''); assert.equal(result.VERBOSE_LOGGING, '0');
  assert.equal(result.APPIUM_SKIP_EXTENSIONS_INSTALL, '1'); assert.equal(Object.isFrozen(result), true);
});

test('missing optional toolchain configuration uses fixed PATH while keeping native HOME and private paths explicit', () => {
  const result = createIosDeviceEnvironment(owned(), Object.freeze({}));
  assert.equal(result.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(result.HOME, owned().nativeHome);
  assert.equal(Object.hasOwn(result, 'DEVELOPER_DIR'), false);
  assert.equal(Object.hasOwn(result, 'CFFIXED_USER_HOME'), false);
  assert.deepEqual(Object.keys(result).sort(), ['PATH', 'HOME', ...privateKeys, 'LANG', 'LC_ALL',
    'APPIUM_SKIP_EXTENSIONS_INSTALL', 'DEBUG', 'NODE_DEBUG', 'VERBOSE_LOGGING'].sort());
});

test('missing, unexpected, aliased or non-private bindings fail with one fixed code', () => {
  const { nativeHome: missing, ...withoutNativeHome } = owned();
  const variants = [undefined, null, [], {}, withoutNativeHome, { ...owned(), NODE_OPTIONS: 'unexpected' },
    { ...owned(), HOME: owned().nativeHome }, { ...owned(), CFFIXED_USER_HOME: owned().nativeHome },
    { ...owned(), nativeHome: '/' }, { ...owned(), nativeHome: 'relative/home' },
    { ...owned(), nativeHome: '/Users/../home' }, { ...owned(), nativeHome: '/Users/home\n' },
    { ...owned(), nativeHome: '/Users/home/' }, { ...owned(), nativeHome: owned().APPIUM_HOME },
    { ...owned(), APPIUM_HOME: '/private/tmp/unrelated/appium' },
    { ...owned(), APPIUM_HOME: owned().nativeHome }, { ...owned(), APPIUM_HOME: owned().XDG_CACHE_HOME },
    { ...owned(), TMPDIR: '/private/tmp/tld-ios-unit/tmp//' }];
  for (const value of variants) assert.throws(() => createIosDeviceEnvironment(value, {}), { message: 'IOS_DEVICE_ENV_INVALID' });
});

test('malformed executable paths are refused without including their values in an error', () => {
  for (const source of [null, [], { PATH: '' }, { PATH: '/usr/bin:' }, { PATH: '/usr/bin:.' },
    { PATH: '/usr/bin\n' }, { PATH: '/usr/bin/../bin' }, { DEVELOPER_DIR: 'relative' },
    { DEVELOPER_DIR: '/Applications/Xcode.app\0/Contents/Developer' }]) {
    assert.throws(() => createIosDeviceEnvironment(owned(), source), { message: 'IOS_DEVICE_ENV_INVALID' });
  }
});
