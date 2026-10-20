import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIosStartupFailure, fixedIosDeviceFailureCode, readIosStartupFailure, retainIosStartupFailure,
  tagIosCommandFailure } from '../failure-facts.mjs';
import { publicIosFailure } from '../failure.mjs';

const timeoutFact = () => createIosStartupFailure({ stage: 'device-owned-simulator-boot-started',
  error: tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'), 'owned-device-list') });

test('the original startup timeout survives both cleanup wrappers without replacing their primary failure', async () => {
  const original = timeoutFact(), factory = retainIosStartupFailure(Error('IOS_DEVICE_CLEANUP_UNCONFIRMED'), original);
  assert.equal(factory.message, 'IOS_DEVICE_CLEANUP_UNCONFIRMED');
  const cleanup = retainIosStartupFailure(Error('IOS_PROOF_CLEANUP_INCOMPLETE'), readIosStartupFailure(factory));
  cleanup.preserveConsumer = true;
  const later = createIosStartupFailure({ stage: 'device-wda-prepared', error: Error('IOS_OWNERSHIP_REFUSED') });
  retainIosStartupFailure(cleanup, later);
  assert.deepEqual(readIosStartupFailure(cleanup), { stage: 'device-owned-simulator-boot-started', code: 'IOS_COMMAND_TIMEOUT', commandKind: 'owned-device-list' });
  assert.equal(cleanup.message, 'IOS_PROOF_CLEANUP_INCOMPLETE'); assert.equal(cleanup.preserveConsumer, true);
  const summary = await publicIosFailure({ output: '.', stage: 'cleanup', error: cleanup });
  assert.equal(summary.code, 'IOS_PROOF_CLEANUP_INCOMPLETE'); assert.equal(summary.stage, 'cleanup');
  assert.deepEqual(summary.startupFailure, original); assert.deepEqual(summary.reports, []);
  assert.equal(Object.isFrozen(original), true); assert.equal(Object.isFrozen(summary.startupFailure), true);
});

test('only own native-error data and fixed catalogs become startup facts; getters and proxies remain unread', () => {
  const secret = randomBytes(32).toString('base64url'); let reads = 0;
  const getter = Error('IOS_COMMAND_TIMEOUT');
  for (const key of ['message', 'nativeCommandKind']) Object.defineProperty(getter, key, { get() { reads++; throw Error(secret); } });
  const proxy = new Proxy(Error('IOS_COMMAND_TIMEOUT'), { get() { reads++; throw Error(secret); }, getPrototypeOf() { reads++; throw Error(secret); } });
  for (const error of [Error(secret), getter, proxy, { message: 'IOS_COMMAND_TIMEOUT' }, null]) {
    const fact = createIosStartupFailure({ stage: secret, error });
    assert.deepEqual(fact, { stage: 'owned-simulator-start', code: 'IOS_DEVICE_START_FAILED', commandKind: 'not-recorded' });
    assert.equal(fixedIosDeviceFailureCode(error), 'IOS_DEVICE_START_FAILED');
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(JSON.stringify(fact).includes(value), false);
  }
  assert.equal(reads, 0);
});

test('malformed facts, extra fields and getter-backed metadata cannot enter public failure JSON', async () => {
  const secret = randomBytes(32).toString('base64'), valid = timeoutFact(); let reads = 0;
  const getterFact = { ...valid }; Object.defineProperty(getterFact, 'code', { enumerable: true, get() { reads++; throw Error(secret); } });
  const proxyFact = new Proxy(valid, { ownKeys() { reads++; throw Error(secret); }, getPrototypeOf() { reads++; throw Error(secret); } });
  for (const value of [{ ...valid, message: secret }, { ...valid, stage: secret }, { ...valid, code: secret },
    { ...valid, commandKind: secret }, getterFact, proxyFact, null, [valid]]) {
    const error = Error('IOS_DEVICE_CLEANUP_UNCONFIRMED'); Object.defineProperty(error, 'startupFailure', { value });
    const summary = await publicIosFailure({ output: '.', stage: 'cleanup', error });
    assert.equal(summary.code, 'IOS_DEVICE_CLEANUP_UNCONFIRMED'); assert.equal(Object.hasOwn(summary, 'startupFailure'), false);
    for (const canary of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(JSON.stringify(summary).includes(canary), false);
  }
  const error = Error('IOS_DEVICE_CLEANUP_UNCONFIRMED');
  for (const key of ['startupFailure', 'message', 'code']) Object.defineProperty(error, key, { get() { reads++; throw Error(secret); } });
  const summary = await publicIosFailure({ output: '.', stage: 'cleanup', error });
  assert.equal(summary.code, 'IOS_PROOF_FAILED'); assert.equal(Object.hasOwn(summary, 'startupFailure'), false); assert.equal(reads, 0);
});

test('command tagging never overwrites an existing original command kind', () => {
  const error = tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'), 'owned-device-list');
  tagIosCommandFailure(error, 'owned-device-delete');
  assert.equal(createIosStartupFailure({ stage: 'owned-simulator-start', error }).commandKind, 'owned-device-list');
});
