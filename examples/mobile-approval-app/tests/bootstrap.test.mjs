import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { consumeBootstrap, validateBootstrap } from '../bootstrap.mjs';

const fixture = () => ({ schemaVersion: 1, origin: 'http://127.0.0.1:43210', cookie: 'tldemo_session=' + randomBytes(32).toString('base64url') });
test('bootstrap accepts only the exact loopback origin and known single cookie', () => {
  const value = fixture(), parsed = validateBootstrap(JSON.stringify(value));
  assert.equal(parsed.origin, value.origin); assert.equal(parsed.cookie === value.cookie, true); assert.equal(Object.isFrozen(parsed), true);
  for (const patch of [
    { origin: 'https://production.example.test' }, { origin: 'http://localhost:43210' }, { origin: 'http://127.0.0.1:43210/path' },
    { origin: 'http://127.0.0.1:43210/' }, { origin: 'http://127.0.0.1:43210?x=1' }, { origin: 'http://user:pass@127.0.0.1:43210' },
    { origin: 'http://127.0.0.1:0' }, { origin: 'http://127.0.0.2:43210' }, { cookie: 'other=' + randomBytes(32).toString('hex') },
    { cookie: value.cookie + '; extra=value' }, { cookie: value.cookie + '\r\nX-Other: value' }, { schemaVersion: 2 }, { password: 'not-allowed' },
  ]) assert.throws(() => validateBootstrap(JSON.stringify({ ...value, ...patch })), /^Error: BOOTSTRAP_INVALID$/);
});

test('bootstrap deletion precedes acceptance even for malformed input', () => {
  const events = [], value = fixture();
  const accepted = consumeBootstrap({ read: () => { events.push('read'); return JSON.stringify(value); }, remove: () => events.push('delete') });
  events.push('accepted'); assert.deepEqual(events, ['read', 'delete', 'accepted']); assert.equal(accepted.cookie === value.cookie, true);
  const failed = [];
  assert.throws(() => consumeBootstrap({ read: () => { failed.push('read'); return '{invalid'; }, remove: () => failed.push('delete') }), /BOOTSTRAP_INVALID/);
  assert.deepEqual(failed, ['read', 'delete']);
  let deleted = false;
  assert.throws(() => consumeBootstrap({ read: () => { throw Error('unreadable'); }, remove: () => { deleted = true; } }), /BOOTSTRAP_READ_FAILED/);
  assert.equal(deleted, true);
  assert.throws(() => consumeBootstrap({ read: () => JSON.stringify(value), remove: () => { throw Error('not deleted'); } }), /BOOTSTRAP_DELETE_FAILED/);
});
