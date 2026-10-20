import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSupabaseAuthority, supabaseIdentity } from '../authority.mjs';
import { isSupabaseApp, startSupabaseProvisioningApp } from '../app.mjs';
import { isNextAuthSupabaseApp, isSensitiveNextAuthCookie, NEXTAUTH_VERSION, parseNextAuthCookies, parseNextAuthForm, startNextAuthSupabaseApp } from '../nextauth-app.mjs';

const origin = 'http://127.0.0.1:54321';
const fixedError = { code: 'PROVISION_INPUT_REFUSED', message: 'PROVISION_INPUT_REFUSED' };
function validForm() {
  return new URLSearchParams({ csrfToken: 'a'.repeat(64), email: 'test@example.test', password: 'generated-input-only', json: 'true', callbackUrl: origin });
}

test('NextApi form adapter preserves credential bytes while admitting only the fixed broker flow', () => {
  const form = validForm(); form.set('password', 'a+&=/% encoded input');
  const parsed = parseNextAuthForm(form.toString(), origin);
  assert.equal(parsed.password, 'a+&=/% encoded input'); assert.equal(parsed.email, 'test@example.test');
  assert.equal(Object.getPrototypeOf(parsed), null); assert.equal(NEXTAUTH_VERSION, '4.24.15');
});

test('NextApi form adapter rejects duplicate credentials, authority fields, redirects, missing CSRF and oversized bodies without echoing values', () => {
  const cases = [];
  let form = validForm(); form.append('password', 'second'); cases.push(form.toString());
  form = validForm(); form.set('role', 'Admin'); cases.push(form.toString());
  form = validForm(); form.set('__proto__', 'input'); cases.push(form.toString());
  form = validForm(); form.set('callbackUrl', 'https://outside.example'); cases.push(form.toString());
  form = validForm(); form.delete('csrfToken'); cases.push(form.toString());
  form = validForm(); form.set('csrfToken', 'invalid'); cases.push(form.toString());
  form = validForm(); form.set('json', 'false'); cases.push(form.toString());
  form = validForm(); form.set('password', 'x'.repeat(4097)); cases.push(form.toString());
  for (const value of cases) assert.throws(() => parseNextAuthForm(value, origin), fixedError);
});

test('NextApi cookie adapter decodes actual framework cookies and refuses ambiguous or malformed cookie inputs', () => {
  const cookies = parseNextAuthCookies('next-auth.csrf-token=abc%7Cdef; next-auth.session-token.0=opaque; next-auth.callback-url=http%3A%2F%2F127.0.0.1');
  assert.equal(cookies['next-auth.csrf-token'], 'abc|def'); assert.equal(cookies['next-auth.session-token.0'], 'opaque');
  assert.equal(Object.getPrototypeOf(cookies), null); assert.deepEqual(Object.keys(parseNextAuthCookies(undefined)), []);
  for (const header of ['a=1;a=2', '__proto__=input', 'constructor=input', 'a=%', 'a=%0A', 'a=1\r\nb=2', 'a=' + 'x'.repeat(16384), 'not-a-pair']) {
    assert.throws(() => parseNextAuthCookies(header), fixedError);
  }
});

test('cookie canaries exclude only the exact known public callback origin while retaining session, CSRF and unexpected callback values', () => {
  assert.equal(isSensitiveNextAuthCookie('next-auth.callback-url', origin, origin), false);
  for (const name of ['next-auth.session-token', 'next-auth.session-token.0', 'next-auth.csrf-token', 'next-auth.callback-url.0', '__Secure-next-auth.callback-url', 'unexpected-cookie']) {
    assert.equal(isSensitiveNextAuthCookie(name, origin, origin), true);
  }
  for (const value of [origin + '/', origin + '/private', 'https://outside.example', 'unexpected-generated-value']) {
    assert.equal(isSensitiveNextAuthCookie('next-auth.callback-url', value, origin), true);
  }
  assert.equal(isSensitiveNextAuthCookie('next-auth.callback-url', 'https://outside.example', 'https://outside.example'), true);
  assert.equal(isSensitiveNextAuthCookie('next-auth.callback-url', origin, undefined), true);
});

test('shared identity boundary admits only exact live lease roles, never copies provider metadata or tokens', () => {
  const identity = { id: randomUUID(), email: 'test@example.test', role: 'Editor' };
  assert.deepEqual(supabaseIdentity(identity), identity); assert.notEqual(supabaseIdentity(identity), identity);
  assert.deepEqual(supabaseIdentity({ ...identity, role: 'Control' }), { ...identity, role: 'Control' });
  for (const value of [null, {}, { ...identity, role: 'Admin' }, { ...identity, accessToken: 'not-public' }, { ...identity, id: 'not-an-id' }, { ...identity, email: '' }]) assert.equal(supabaseIdentity(value), null);
});

test('optional framework import is inert; forged provider descriptors cannot obtain authority or change origin configuration', async () => {
  const before = process.env.NEXTAUTH_URL, hadBefore = Object.hasOwn(process.env, 'NEXTAUTH_URL');
  let called = false;
  const forged = { targetId: randomUUID(), ledger() { called = true; throw new Error('untrusted'); } };
  const options = { runtime: forged, releaseId: 'a'.repeat(64), toolsRoot: 'must-not-be-loaded' };
  assert.throws(() => createSupabaseAuthority({ ...options, assertLive() {} }), { code: 'PROVISION_TARGET_REFUSED' });
  await assert.rejects(startNextAuthSupabaseApp(options), { code: 'PROVISION_TARGET_REFUSED' });
  await assert.rejects(startSupabaseProvisioningApp(options), { code: 'PROVISION_TARGET_REFUSED' });
  assert.equal(called, false); assert.equal(isNextAuthSupabaseApp(forged), false); assert.equal(isSupabaseApp(forged), false);
  assert.equal(process.env.NEXTAUTH_URL, before); assert.equal(Object.hasOwn(process.env, 'NEXTAUTH_URL'), hadBefore);
});
