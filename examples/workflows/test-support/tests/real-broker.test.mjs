import assert from 'node:assert/strict';
import test from 'node:test';
import { realBrokerSupport, referenceProfiles } from '../real-broker.mjs';

test('realBrokerSupport: win32 is always supported via dpapi', () => {
  const result = realBrokerSupport({ platform: 'win32', env: {}, which: () => null });
  assert.equal(result.supported, true);
  assert.equal(result.store, 'dpapi');
  assert.equal(typeof result.reason, 'string');
});

test('realBrokerSupport: darwin is always refused (no isolated real-keychain path)', () => {
  const result = realBrokerSupport({ platform: 'darwin', env: {}, which: () => '/usr/bin/security' });
  assert.equal(result.supported, false);
  assert.equal(result.store, null);
});

test('realBrokerSupport: linux without TESTLANE_REAL_KEYCHAIN=1 is refused even with secret-tool present', () => {
  const result = realBrokerSupport({ platform: 'linux', env: {}, which: () => '/usr/bin/secret-tool' });
  assert.equal(result.supported, false);
  assert.equal(result.store, null);
});

test('realBrokerSupport: linux with TESTLANE_REAL_KEYCHAIN=1 but no secret-tool on PATH is refused', () => {
  const result = realBrokerSupport({ platform: 'linux', env: { TESTLANE_REAL_KEYCHAIN: '1' }, which: () => null });
  assert.equal(result.supported, false);
  assert.equal(result.store, null);
});

test('realBrokerSupport: linux with TESTLANE_REAL_KEYCHAIN=1 and secret-tool on PATH is supported via secret-service', () => {
  const result = realBrokerSupport({ platform: 'linux', env: { TESTLANE_REAL_KEYCHAIN: '1' }, which: (cmd) => (cmd === 'secret-tool' ? '/usr/bin/secret-tool' : null) });
  assert.equal(result.supported, true);
  assert.equal(result.store, 'secret-service');
});

test('realBrokerSupport: TESTLANE_REAL_KEYCHAIN=1 has no effect on non-linux platforms', () => {
  const win = realBrokerSupport({ platform: 'win32', env: { TESTLANE_REAL_KEYCHAIN: '1' } });
  assert.equal(win.store, 'dpapi');
  const mac = realBrokerSupport({ platform: 'darwin', env: { TESTLANE_REAL_KEYCHAIN: '1' } });
  assert.equal(mac.supported, false);
});

test('realBrokerSupport: any other platform is refused', () => {
  for (const platform of ['freebsd', 'sunos', 'aix']) {
    const result = realBrokerSupport({ platform, env: {} });
    assert.equal(result.supported, false, platform);
    assert.equal(result.store, null, platform);
  }
});

test('referenceProfiles: builds a strict form-post registry for a writer and a reader, namespaced', () => {
  const registry = referenceProfiles({
    namespace: 'ns-1',
    origin: 'http://127.0.0.1:4321',
    writer: { email: 'writer@example.test', role: 'Writer' },
    reader: { email: 'reader@example.test', role: 'Reader' },
  });
  assert.equal(registry.version, 1);
  assert.deepEqual(Object.keys(registry.profiles).sort(), ['ns-1:local:reader', 'ns-1:local:writer']);

  const writerEntry = registry.profiles['ns-1:local:writer'];
  assert.equal(writerEntry.environment, 'testing');
  assert.equal(writerEntry.baseUrl, 'http://127.0.0.1:4321');
  assert.equal(writerEntry.strategy, 'form-post');
  assert.equal(writerEntry.account.email, 'writer@example.test');
  assert.equal(writerEntry.account.role, 'Writer');
  assert.equal(writerEntry.session.ttlMinutes, 30);
  assert.equal(writerEntry.options.loginPath, '/login');
  assert.equal(writerEntry.options.sessionCookieName, 'ref_session');
  assert.equal(writerEntry.options.successPath, '/workspace');
  assert.equal(writerEntry.options.mePath, '/api/me');
  assert.ok(writerEntry.options.fields.includes('{{secret}}'));
  assert.ok(typeof writerEntry.app === 'string' && writerEntry.app.length > 0);
});

test('referenceProfiles: extra entries are merged in as-is alongside writer/reader', () => {
  const registry = referenceProfiles({
    namespace: 'ns-2',
    origin: 'http://127.0.0.1:4321',
    writer: { email: 'writer@example.test', role: 'Writer' },
    reader: { email: 'reader@example.test', role: 'Reader' },
    extra: { 'ns-2:local:extra': { marker: true } },
  });
  assert.deepEqual(registry.profiles['ns-2:local:extra'], { marker: true });
});
