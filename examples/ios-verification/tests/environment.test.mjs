import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIosDeviceEnvironment } from '../environment.mjs';

const owned = () => ({
  HOME: '/private/tmp/tld-ios-unit/home', CFFIXED_USER_HOME: '/private/tmp/tld-ios-unit/home',
  APPIUM_HOME: '/private/tmp/tld-ios-unit/appium', TMPDIR: '/private/tmp/tld-ios-unit/tmp/',
  XDG_CACHE_HOME: '/private/tmp/tld-ios-unit/cache',
});

test('device child environment omits unknown and credential variables without mutating its source', () => {
  const canary = randomBytes(32).toString('base64url');
  const omitted = ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'UNRECOGNIZED',
    'TESTLANE_PROFILE', 'TESTLANE_HOME', 'SIMCTL_CHILD_TESTLANE_BOOTSTRAP', 'NODE_OPTIONS',
    'USE_PORT', 'USE_IP', 'MJPEG_SERVER_PORT', 'USER', 'LOGNAME', 'SHELL'];
  const source = Object.freeze({ PATH: '/opt/hostedtoolcache/node/22/bin:/usr/bin:/bin/',
    DEVELOPER_DIR: '/Applications/Xcode_26.6.app/Contents/Developer',
    ...Object.fromEntries(omitted.map(key => [key, canary])), HOME: canary, APPIUM_HOME: canary,
    DEBUG: canary, NODE_DEBUG: canary, VERBOSE_LOGGING: canary, LANG: canary, LC_ALL: canary });
  const before = JSON.stringify(source), overrides = Object.freeze(owned());
  const result = createIosDeviceEnvironment(overrides, source);
  for (const key of omitted) assert.equal(Object.hasOwn(result, key), false, key);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(source) === before, true);
  for (const key of Object.keys(overrides)) assert.equal(result[key], overrides[key], key);
  assert.equal(result.PATH, source.PATH); assert.equal(result.DEVELOPER_DIR, source.DEVELOPER_DIR);
  assert.equal(result.LANG, 'C'); assert.equal(result.LC_ALL, 'C');
  assert.equal(result.DEBUG, ''); assert.equal(result.NODE_DEBUG, ''); assert.equal(result.VERBOSE_LOGGING, '0');
  assert.equal(result.APPIUM_SKIP_EXTENSIONS_INSTALL, '1'); assert.equal(Object.isFrozen(result), true);
});

test('missing optional toolchain configuration uses fixed system PATH and never ambient process state', () => {
  const result = createIosDeviceEnvironment(owned(), Object.freeze({}));
  assert.equal(result.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(Object.hasOwn(result, 'DEVELOPER_DIR'), false);
  assert.deepEqual(Object.keys(result).sort(), ['PATH', ...Object.keys(owned()), 'LANG', 'LC_ALL',
    'APPIUM_SKIP_EXTENSIONS_INSTALL', 'DEBUG', 'NODE_DEBUG', 'VERBOSE_LOGGING'].sort());
});

test('missing, unexpected, aliased or non-private overrides fail with one fixed code', () => {
  const variants = [undefined, null, [], {}, { ...owned(), NODE_OPTIONS: 'unexpected' },
    { ...owned(), HOME: '/' }, { ...owned(), HOME: 'relative/home' },
    { ...owned(), HOME: '/private/tmp/../home' }, { ...owned(), HOME: '/private/tmp/home\n' },
    { ...owned(), CFFIXED_USER_HOME: '/private/tmp/tld-ios-unit/another-home' },
    { ...owned(), APPIUM_HOME: '/private/tmp/unrelated/appium' },
    { ...owned(), APPIUM_HOME: owned().HOME }, { ...owned(), TMPDIR: '/private/tmp/tld-ios-unit/tmp//' }];
  for (const value of variants) assert.throws(() => createIosDeviceEnvironment(value, {}), { message: 'IOS_DEVICE_ENV_INVALID' });
});

test('malformed executable paths are refused without including their values in an error', () => {
  for (const source of [null, [], { PATH: '' }, { PATH: '/usr/bin:' }, { PATH: '/usr/bin:.' },
    { PATH: '/usr/bin\n' }, { PATH: '/usr/bin/../bin' }, { DEVELOPER_DIR: 'relative' },
    { DEVELOPER_DIR: '/Applications/Xcode.app\0/Contents/Developer' }]) {
    assert.throws(() => createIosDeviceEnvironment(owned(), source), { message: 'IOS_DEVICE_ENV_INVALID' });
  }
});
