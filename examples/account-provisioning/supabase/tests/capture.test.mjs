/** Retention/teardown contracts with actual private source bodies; no Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';
import vm from 'node:vm';
import { canonical } from '../../contracts.mjs';
import { createSupabaseCapture, SUPABASE_IMAGES, validateResourceProof } from '../runtime.mjs';

const CAP = 2 * 1024 * 1024;
const fixed = code => Object.assign(Error(code), { code });
const output = (stdout, code = 0, stderr = '') => ({ stdout, stderr, code });
const source = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
function extract(text, start, end) {
  const at = text.indexOf(start), stop = text.indexOf(end, at);
  assert.ok(at >= 0 && stop > at); assert.equal(text.indexOf(start, at + 1), -1);
  return text.slice(at, stop);
}

test('repeated complete successful inspection documents retain once without raising the 2MiB ceiling', () => {
  const capture = createSupabaseCapture(), args = ['network', 'inspect', randomBytes(32).toString('hex'), '--format', '{{json .}}'];
  const frame = JSON.stringify({ snapshot: randomBytes(2048).toString('hex') }) + '\n';
  for (let index = 0; index < 1202; index++) capture.retain(args, output(frame), [args]);
  assert.ok(Buffer.byteLength(frame) * 1202 > CAP);
  assert.equal(capture.text(), frame); assert.equal(capture.byteLength(), Buffer.byteLength(frame));
  assert.equal(capture.incomplete(), false); capture.assertComplete();
});

test('only exact argv/code0/empty-stderr complete JSON objects are deduplicated; all unique and other bytes remain', () => {
  const args = ['volume', 'inspect', randomBytes(16).toString('hex'), '--format', '{{json .Labels}}'];
  const frame = JSON.stringify({ label: randomBytes(16).toString('hex') }) + '\n';
  const capture = createSupabaseCapture();
  for (const result of [output(frame), output(frame), output(frame, 1), output(frame, 0, 'fixed-stderr'), output('null\n'), output('[]\n'), output('{')])
    capture.retain(args, result, [args]);
  capture.retain([...args, 'extra'], output(frame), [args]);
  capture.retain(args, output(frame), [[...args.slice(0, -1), '{{json .}}']]);
  const other = JSON.stringify({ label: randomBytes(16).toString('hex') }) + '\n'; capture.retain(args, output(other), [args]);
  assert.equal(capture.text(), frame + frame + frame + 'fixed-stderr' + 'null\n[]\n{' + frame + frame + other);
});

test('raw and encoded generated canaries in repeated documents remain retained; non-JSON fragment boundaries are unchanged', () => {
  const capture = createSupabaseCapture(), args = ['network', 'inspect', randomBytes(32).toString('hex'), '--format', '{{json .}}'];
  const canary = randomBytes(32).toString('base64') + '/', variants = [canary, encodeURIComponent(canary), Buffer.from(canary).toString('base64'), Buffer.from(canary).toString('base64url')];
  for (const variant of variants) {
    const frame = JSON.stringify({ value: variant }) + '\n'; capture.retain(args, output(frame), [args]); capture.retain(args, output(frame), [args]);
    assert.equal(capture.text().includes(variant), true);
  }
  const ordinary = ['container', 'ls'];
  capture.retain(ordinary, output(canary.slice(0, 15)), [args]); capture.retain(ordinary, output(canary.slice(15)), [args]);
  assert.equal(capture.text().endsWith(canary), true);
});

test('unique overflow permanently refuses acceptance while retained bytes stay bounded', () => {
  const capture = createSupabaseCapture(); capture.retain(['ordinary'], output('x'.repeat(CAP)), []);
  capture.assertComplete(); assert.equal(capture.byteLength(), CAP);
  capture.retain(['ordinary'], output('y'), []); assert.equal(capture.incomplete(), true);
  capture.retain(['ordinary'], output('z'.repeat(CAP)), []);
  assert.equal(capture.byteLength(), CAP); assert.equal(capture.text(), 'x'.repeat(CAP));
  assert.throws(() => capture.assertComplete(), { code: 'SUPABASE_CAPTURE_LIMIT' });
});

async function runtimeFixture({ initialOverflow = false, overflowOnClose = false, foreign = false, preserveData = false } = {}) {
  const text = await source('runtime.mjs'), nonce = randomBytes(16).toString('hex');
  const names = Object.fromEntries(['network', 'gatewayNetwork', 'volume', 'gateway', 'rest', 'auth', 'database'].map(kind => [kind, 'owned-' + nonce + '-' + kind]));
  const resources = Object.fromEntries(Object.keys(names).map(kind => [kind, kind === 'volume' ? true : randomBytes(32).toString('hex')]));
  const imageIds = Object.fromEntries(['gateway', 'rest', 'auth', 'database'].map(kind => [kind, 'sha256:' + randomBytes(32).toString('hex')]));
  const labels = { 'dev.testlane.supabase-owner': nonce, 'dev.testlane.purpose': 'local-account-proof' };
  const formatLine = text.split('\n').find(line => line.startsWith('const CONTAINER_FORMAT=')); assert.ok(formatLine);
  const CONTAINER_FORMAT = vm.runInNewContext(formatLine + '\nCONTAINER_FORMAT;');
  const capture = createSupabaseCapture(), events = [], removed = new Set(), writes = [];
  if (initialOverflow) capture.retain(['ordinary'], output('x'.repeat(CAP + 1)), []);
  if (overflowOnClose) capture.retain(['ordinary'], output('x'.repeat(CAP - 1)), []);
  let calls = 0;
  const container = kind => ({ id: foreign ? randomBytes(32).toString('hex') : resources[kind], labels, imageRef: SUPABASE_IMAGES[kind].reference,
    imageId: imageIds[kind], privileged: false, networks: { [names.network]: { IPAddress: '172.23.0.3' } }, mounts: [], ports: {} });
  const state = { capture, names, resources, imageIds, CONTAINER_FORMAT, nonce, SUPABASE_IMAGES, validateResourceProof, canonical, LABEL: 'dev.testlane.supabase-owner',
    backendIps: { auth: '172.23.0.3' }, gatewayPorts: undefined, fail: fixed, Buffer, JSON, Object, Set, path,
    closing: false, closed: false, closeResult: undefined, unknownChild: false, ready: true, signal: undefined,
    docker: { context: 'owned-context' }, root: path.resolve('owned-runtime'), env: {}, attempted: new Set(Object.keys(names)),
    marker: () => ({ schemaVersion: 1 }), assertRoot: async () => { events.push('root-check'); },
    summaryCounts: async () => ({ ownedAccounts: 0, activeReservations: 0, pendingDeliveries: 0, proofRecords: 0, controlPresent: true }),
    pool: { end: async () => { events.push('pool-end'); } }, setTimeout, clearTimeout,
    writeFile: async (file, data) => { writes.push({ name: path.basename(file), value: JSON.parse(data) }); },
    readdir: async () => { events.push('readdir'); return []; }, unlink: async () => { events.push('unlink'); }, rmdir: async () => { events.push('rmdir'); },
    files: new Set(), realpath: async value => value, lstat: async () => { const error = Error(); error.code = 'ENOENT'; throw error; }, same: (a, b) => a === b,
    runOwnedCommand: async (executable, fullArgs) => {
      calls++; assert.equal(executable, 'docker'); assert.deepEqual(Array.from(fullArgs.slice(0, 2)), ['--context', 'owned-context']);
      const args = Array.from(fullArgs.slice(2)); events.push(args.slice(0, 2).join('-'));
      if (args[0] === 'container' && args[1] === 'inspect') {
        const kind = ['gateway', 'rest', 'auth', 'database'].find(kind => args[2] === resources[kind] || args[2] === names[kind]); assert.ok(kind);
        assert.equal(args[4], CONTAINER_FORMAT); return output(JSON.stringify(container(kind)) + '\n');
      }
      if (args[0] === 'container' && args[1] === 'rm') { removed.add(args[3]); return output(args[3] + '\n'); }
      if (args[1] === 'ls') return output('');
      if (args[0] === 'volume' && args[1] === 'inspect') return output(JSON.stringify(labels) + '\n');
      if (args[0] === 'volume' && args[1] === 'rm') { removed.add('volume'); return output(names.volume + '\n'); }
      if (args[0] === 'network' && args[1] === 'inspect') return output(JSON.stringify({ Id: args[2], Labels: labels, Containers: {} }) + '\n');
      if (args[0] === 'network' && args[1] === 'rm') { removed.add(args[2]); return output(args[2] + '\n'); }
      throw Error('UNEXPECTED_FIXED_COMMAND');
    } };
  state.command = vm.runInNewContext('(' + extract(text, '  async function command(', '\n  async function assertRoot(') + ')', state);
  state.inspectContainer = vm.runInNewContext('(' + extract(text, '  async function inspectContainer(', '\n  async function assertOwned(') + ')', state);
  state.close = vm.runInNewContext('(' + extract(text, '  async function close(', '\n  try{\n    await writeFile(') + ')', state);
  const leak = extract(text, '  function assertNoLeaks(', '\n  async function summaryCounts(');
  state.secrets = new Set(); state.issued = new Set(); state.assertNoLeaks = vm.runInNewContext('(' + leak + ')', state);
  return { state, capture, events, removed, writes, calls: () => calls, close: () => state.close({ preserveData }) };
}

test('actual private command executes every fresh inspection and foreign last result is still refused', async () => {
  const fixture = await runtimeFixture();
  for (let index = 0; index < 1202; index++) await fixture.state.inspectContainer('auth');
  assert.equal(fixture.calls(), 1202); assert.equal(fixture.capture.incomplete(), false);
  const original = fixture.state.runOwnedCommand;
  fixture.state.runOwnedCommand = async (...args) => {
    const result = await original(...args), value = JSON.parse(result.stdout); value.id = randomBytes(32).toString('hex'); return output(JSON.stringify(value) + '\n');
  };
  await assert.rejects(fixture.state.inspectContainer('auth'), { code: 'SUPABASE_OWNERSHIP_REFUSED' }); assert.equal(fixture.calls(), 1203);
});

test('ordinary command rechecks capture after await even when teardown starts while the child is pending', async () => {
  const fixture = await runtimeFixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const original = fixture.state.runOwnedCommand;
  fixture.state.runOwnedCommand = async (...args) => { entered(); await gate; return original(...args); };
  const pending = fixture.state.inspectContainer('auth');
  const rejected = assert.rejects(pending, { code: 'SUPABASE_CAPTURE_LIMIT' });
  await started;
  fixture.capture.retain(['ordinary'], output('x'.repeat(CAP + 1)), []);
  fixture.state.closing = true; release(); await rejected;
  assert.equal(fixture.calls(), 1); assert.equal(fixture.capture.incomplete(), true);
  assert.equal(fixture.state.unknownChild, false); assert.equal(fixture.removed.size, 0);
});

test('private teardown capture option refuses before close and remains absent from ordinary call sites', async () => {
  const fixture = await runtimeFixture();
  await assert.rejects(fixture.state.command(['container', 'inspect', fixture.state.resources.auth], { teardown: true }), { code: 'SUPABASE_OWNERSHIP_REFUSED' });
  await assert.rejects(fixture.state.command(['container', 'inspect', fixture.state.resources.auth], { teardown: 'true' }), { code: 'SUPABASE_OWNERSHIP_REFUSED' });
  assert.equal(fixture.calls(), 0);
  const text = await source('runtime.mjs');
  assert.equal(text.split('teardown:true').length - 1, 1);
  const close = extract(text, '  async function close(', '\n  try{\n    await writeFile(');
  assert.ok(close.includes('const closeCommand=(args,options={})=>command(args,{...options,teardown:true});'));
  assert.equal(close.includes('await command('), false);
});

for (const mode of ['initial-overflow', 'overflow-during-close', 'data-preserved']) test('actual teardown validates fresh outputs but keeps overflow nonpassing: ' + mode, async () => {
  const fixture = await runtimeFixture({ initialOverflow: mode !== 'overflow-during-close', overflowOnClose: mode === 'overflow-during-close', preserveData: mode === 'data-preserved' });
  if (mode !== 'overflow-during-close') { await assert.rejects(fixture.state.inspectContainer('auth'), { code: 'SUPABASE_CAPTURE_LIMIT' }); assert.equal(fixture.calls(), 0); }
  await assert.rejects(fixture.close(), { code: 'SUPABASE_CLEANUP_INCOMPLETE', causeCode: 'SUPABASE_CAPTURE_LIMIT' });
  assert.ok(fixture.calls() >= 16); assert.equal(fixture.removed.size, mode === 'data-preserved' ? 6 : 7);
  assert.equal(fixture.events.includes('rmdir'), false); assert.equal(fixture.events.includes('unlink'), false);
  assert.equal(fixture.state.unknownChild, false); assert.equal(fixture.capture.incomplete(), true); assert.ok(fixture.capture.byteLength() <= CAP);
  assert.throws(() => fixture.state.assertNoLeaks(''), { code: 'SUPABASE_CAPTURE_LIMIT' });
  assert.deepEqual(fixture.writes.map(value => ({ name: value.name, status: value.value.status, causeCode: value.value.causeCode })),
    [{ name: 'recovery.json', status: 'cleanup-incomplete', causeCode: 'SUPABASE_CAPTURE_LIMIT' }]);
});

test('overflow cannot authorize foreign container removal or erase unknown-child preservation', async () => {
  const fixture = await runtimeFixture({ initialOverflow: true, foreign: true }); fixture.state.unknownChild = true;
  await assert.rejects(fixture.close(), { code: 'SUPABASE_CLEANUP_INCOMPLETE', causeCode: 'SUPABASE_CAPTURE_LIMIT' });
  assert.equal(fixture.removed.size, 0); assert.equal(fixture.state.unknownChild, true); assert.equal(fixture.events.includes('rmdir'), false);
});

async function causeReader() {
  const text = await source('browser-proof.mjs');
  return vm.runInNewContext(extract(text, 'const FIXED_BROWSER_CAUSES = ', '\nconst FILES = ') + '\nfixedBrowserCause;', { types });
}
test('browser cause projection reads only allowlisted own native-error strings, never getters/proxies/raw or encoded errors', async () => {
  const read = await causeReader(), canary = randomBytes(32).toString('base64url'); let invoked = 0;
  const error = Object.assign(Error(canary), { code: 'SUPABASE_CLEANUP_INCOMPLETE', causeCode: 'SUPABASE_CAPTURE_LIMIT' });
  assert.equal(read(error), 'SUPABASE_CAPTURE_LIMIT');
  const getter = Error(canary); Object.defineProperty(getter, 'causeCode', { get() { invoked++; throw Error(canary); } });
  const proxy = new Proxy(error, { getOwnPropertyDescriptor() { invoked++; throw Error(canary); } });
  for (const value of [getter, proxy, { code: 'SUPABASE_CAPTURE_LIMIT' }, Error(canary), ...[canary, encodeURIComponent(canary), Buffer.from(canary).toString('base64')].map(code => Object.assign(Error(canary), { code }))])
    assert.equal(read(value), undefined);
  assert.equal(invoked, 0);
});

test('actual browser finalization keeps cleanup primary, preserves consumer, and records only fixed supplemental capture cause', async () => {
  const text = await source('browser-proof.mjs'), read = await causeReader(), metadata = []; let finalized = 0;
  const state = { path, assert, canonical, stage: 'same-context-revocation-p2', output: path.resolve('owned-output'),
    at: () => {}, activeRunner: undefined, activeAbort: undefined, browser: undefined, terminationConfirmed: true,
    accountCleanupConfirmed: false, handles: [], attempted: new Set(), providerSessions: new Map(), credentials: [], endpoints: [], captured: '',
    failure: Error('fixed operation failure'), causeCode: undefined, cleanupFailed: false, cleanupFailures: new Set(),
    app: { issuedSessionTokens: () => [], stopAndDrainRequests: async () => {}, close: async () => {} },
    runtime: { summary: async () => ({ ownedAccounts: 0, activeReservations: 0, pendingDeliveries: 0, proofRecords: 0 }),
      close: async () => { throw Object.assign(fixed('SUPABASE_CLEANUP_INCOMPLETE'), { causeCode: 'SUPABASE_CAPTURE_LIMIT' }); }, capturedText: () => '', assertNoLeaks: () => {} },
    manager: {}, harness: { dispose: async () => { throw Error('MUST_PRESERVE'); } }, consumer: undefined, sessionRoot: undefined, scratchRoot: undefined, browserRoot: undefined,
    textTree: async () => '', assertNoLeaks: () => {}, restore: () => {}, readdir: async () => [],
    writeFile: async (file, bytes) => metadata.push({ file: path.basename(file), value: JSON.parse(bytes) }),
    finalizeProvisioningProof: async () => { finalized++; } };
  state.issue = code => { state.cleanupFailed = true; state.cleanupFailures.add(code); };
  state.fixedBrowserCause = read;
  const retention = text.split('\n').find(line => line.startsWith('  const retainCause = ')); assert.ok(retention);
  state.retainCause = vm.runInNewContext(retention + '\nretainCause;', state);
  const start = text.indexOf("    const failedStage = stage; at('cleanup');"), stop = text.indexOf('\n  if(failure)throw', start); assert.ok(start > 0 && stop > start);
  const body = text.slice(start, stop).replace(/\n  }\s*$/, '');
  const run = vm.runInNewContext('(async()=>{' + body + '\nawait finalizeProvisioningProof();})', state);
  await assert.rejects(run(), { message: 'SUPABASE_BROWSER_CLEANUP_INCOMPLETE', preserveConsumer: true });
  assert.equal(finalized, 0); assert.equal(metadata.length, 1); assert.equal(metadata[0].file, 'recovery.json');
  assert.equal(metadata[0].value.causeCode, 'SUPABASE_CAPTURE_LIMIT'); assert.equal(metadata[0].value.childTerminationConfirmed, true);
  assert.deepEqual(metadata[0].value.cleanupFailures, ['provider-close']);
});
