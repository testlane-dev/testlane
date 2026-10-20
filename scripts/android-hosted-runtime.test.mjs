/** Node-only policy/lifecycle tests. These do not run or attest Linux services. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { exerciseHostedSecretService, assertRuntimeSecretsAbsent, retainedHostedServiceLive, runHostedAndroidRuntime,
  verifyHostedServiceOwners } from './android-hosted-runtime.mjs';

function fixture(overrides = {}) {
  const calls = [], failures = [];
  const names = ['startBus','startKeyring','storeCanary','lookupCanary','removeCanary','verifyProof',
    'stopCommands','stopKeyring','stopBus','confirmGroupsAbsent','confirmListenersAbsent','scan','removeStorage'];
  const ops = Object.fromEntries(names.map(name => [name, async (...args) => { calls.push(name); return overrides[name]?.(...args); }]));
  ops.uncertain = () => overrides.uncertain?.() ?? false;
  ops.runProof = async signal => { calls.push('runProof'); return overrides.runProof ? overrides.runProof(signal) : 0; };
  ops.writeFailure = async failure => { calls.push('writeFailure'); failures.push(failure); };
  return { ops, calls, failures };
}
const error = code => Error('ANDROID_HOSTED_RUNTIME_' + code);
const rejected = (promise, code) => assert.rejects(promise, { message: 'ANDROID_HOSTED_RUNTIME_' + code });
const service = pid => ({ pid, spawned: true, exited: false, closed: false, startError: false, child: { exitCode: null, signalCode: null } });

test('an exited service with still-open pipes is not a retained live owner', () => {
  const good = service(101); assert.equal(retainedHostedServiceLive(good), true);
  for (const change of [{ exited: true }, { closed: true }, { spawned: false }, { startError: true },
    { child: { exitCode: 0, signalCode: null } }, { child: { exitCode: null, signalCode: 'SIGTERM' } }]) {
    assert.equal(retainedHostedServiceLive({ ...good, ...change }), false);
  }
});
test('bus ownership queries cannot accept service exit, PID drift or cancellation during the awaited reply', async () => {
  for (const mode of ['exited-before','exited-during','wrong-pid','cancelled-during','passed']) {
    const bus = service(101), keyring = service(102), controller = new AbortController(); let queries = 0;
    if (mode === 'exited-before') bus.exited = true;
    const run = verifyHostedServiceOwners({ bus, keyring, signal: controller.signal, queryPid: async name => {
      queries++; await new Promise(resolve => setImmediate(resolve));
      if (mode === 'exited-during') bus.exited = true;
      if (mode === 'cancelled-during') controller.abort();
      return mode === 'wrong-pid' ? 103 : name === 'org.freedesktop.DBus' ? bus.pid : keyring.pid;
    } });
    if (mode === 'passed') { assert.equal(await run, true); assert.equal(queries, 2); }
    else { await rejected(run, mode === 'cancelled-during' ? 'ABORTED' : 'START_FAILED'); assert.equal(queries, mode === 'exited-before' ? 0 : 1); }
  }
});

test('proof is gated by verified canary removal; receipt follows groups, listener, scan, then storage absence', async () => {
  const f = fixture();
  const result = await exerciseHostedSecretService(f.ops);
  assert.deepEqual(f.calls, ['startBus','startKeyring','storeCanary','lookupCanary','removeCanary','runProof','verifyProof',
    'stopCommands','stopKeyring','stopBus','confirmGroupsAbsent','confirmListenersAbsent','scan','removeStorage']);
  assert.deepEqual(result, { schemaVersion: 1, privateBusStopped: true, keyringStopped: true, processGroupsAbsent: true,
    runtimeStorageRemoved: true, canaryRemoved: true, unlockSecretLeakScanPassed: true, proofExitCode: 0 });
  assert.equal(f.failures.length, 0);
});

test('a failed canary comparison never starts proof and still confirms removal before stopping services', async () => {
  const f = fixture({ lookupCanary: () => { throw error('CANARY_FAILED'); } });
  await rejected(exerciseHostedSecretService(f.ops), 'CANARY_FAILED');
  assert.equal(f.calls.includes('runProof'), false);
  assert.equal(f.calls.includes('removeStorage'), false);
  assert.ok(f.calls.indexOf('removeCanary') < f.calls.indexOf('stopKeyring'));
  assert.deepEqual(f.failures, [{ schemaVersion: 1, purpose: 'fixed-hosted-runtime-failure', stage: 'keyring-canary',
    code: 'CANARY_FAILED', proofExitCode: null, recoveryRetained: true }]);
});

test('unconfirmed store outcome is not retried or treated as absent, even after service shutdown', async () => {
  const f = fixture({ storeCanary: () => { throw error('COMMAND_TIMEOUT'); }, uncertain: () => true });
  await rejected(exerciseHostedSecretService(f.ops), 'COMMAND_TIMEOUT');
  assert.equal(f.calls.filter(name => name === 'storeCanary').length, 1);
  assert.equal(f.calls.includes('removeCanary'), false);
  assert.equal(f.calls.includes('runProof'), false);
  assert.equal(f.calls.includes('removeStorage'), false);
  assert.equal(f.calls.includes('confirmGroupsAbsent'), true);
  assert.equal(f.failures[0].recoveryRetained, true);
});

test('settled nonzero proof keeps its failure and recovery rather than deleting private storage', async () => {
  const f = fixture({ runProof: () => 7 });
  await rejected(exerciseHostedSecretService(f.ops), 'PROOF_FAILED');
  assert.equal(f.calls.includes('verifyProof'), false);
  assert.equal(f.calls.includes('removeStorage'), false);
  assert.equal(f.failures[0].proofExitCode, 7);
  assert.equal(f.failures[0].code, 'PROOF_FAILED');
  assert.ok(f.calls.indexOf('stopKeyring') < f.calls.indexOf('stopBus'));
});

test('cancellation still waits for independent teardown and cannot continue to proof', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let finishStop, stopped = false;
  const f = fixture({
    lookupCanary: () => controller.abort(),
    stopKeyring: () => new Promise(resolve => { finishStop = () => { stopped = true; resolve(); }; }),
  });
  let settled = false;
  const result = exerciseHostedSecretService(f.ops, { signal: controller.signal }).finally(() => { settled = true; });
  // Attach the rejection handler now, before releasing the bounded test fixture.
  const rejectedResult = rejected(result, 'ABORTED');
  while (!finishStop) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.calls.includes('runProof'), false);
  finishStop(); await rejectedResult;
  assert.equal(stopped, true); assert.equal(f.calls.includes('confirmGroupsAbsent'), true);
  assert.equal(f.calls.includes('removeStorage'), false);
});

for (const [operation, code] of [['stopCommands','PROCESS_UNCONFIRMED'],['stopKeyring','PROCESS_UNCONFIRMED'],
  ['stopBus','PROCESS_UNCONFIRMED'],['confirmGroupsAbsent','PROCESS_UNCONFIRMED'],
  ['confirmListenersAbsent','LISTENER_UNCONFIRMED'],['scan','LEAK_DETECTED']]) {
  test(operation + ' failure prevents storage removal and a passing receipt', async () => {
    const f = fixture({ [operation]: () => { throw Error('unreviewed provider details https://example.test/private'); } });
    await rejected(exerciseHostedSecretService(f.ops), code);
    assert.equal(f.calls.includes('removeStorage'), false);
    assert.equal(f.failures[0].stage, 'cleanup'); assert.equal(f.failures[0].code, code);
    assert.equal(JSON.stringify(f.failures).includes('provider details'), false);
    assert.equal(JSON.stringify(f.failures).includes('https:'), false);
  });
}

test('a successful process exit cannot substitute for the proof cleanup receipt', async () => {
  const f = fixture({ verifyProof: () => { throw error('PROOF_RECEIPT_REFUSED'); } });
  await rejected(exerciseHostedSecretService(f.ops), 'PROOF_RECEIPT_REFUSED');
  assert.equal(f.failures[0].proofExitCode, 0);
  assert.equal(f.calls.includes('removeStorage'), false);
});

test('failed storage removal remains a fixed failure even when every service stopped', async () => {
  const f = fixture({ removeStorage: () => { throw Error('private filesystem details'); } });
  await rejected(exerciseHostedSecretService(f.ops), 'STORAGE_UNCONFIRMED');
  assert.equal(f.failures[0].proofExitCode, 0);
  assert.equal(f.failures[0].recoveryRetained, true);
});

test('unknown raw errors are replaced by a fixed code without leaking arbitrary properties', async () => {
  const secret = randomBytes(32).toString('base64url');
  const f = fixture({ runProof: () => { throw Object.assign(Error(secret), { url: 'http://example.test/' + secret }); } });
  await rejected(exerciseHostedSecretService(f.ops), 'FAILED');
  assert.equal(JSON.stringify(f.failures).includes(secret), false);
  assert.deepEqual(Object.keys(f.failures[0]).sort(), ['schemaVersion','purpose','stage','code','proofExitCode','recoveryRetained'].sort());
});

test('leak scan checks raw, URI, base64 and base64url representations', () => {
  const secret = randomBytes(32).toString('base64') + ' /+?';
  for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) {
    assert.throws(() => assertRuntimeSecretsAbsent('prefix ' + value + ' suffix', [secret]), { message: 'ANDROID_HOSTED_RUNTIME_LEAK_DETECTED' });
  }
  assert.equal(assertRuntimeSecretsAbsent('safe fixed diagnostics', [secret]), true);
});

test('cancellation during proof verification or teardown never removes recovery storage or returns passing cleanup', async () => {
  for (const operation of ['verifyProof','stopCommands','stopKeyring','stopBus','confirmGroupsAbsent','confirmListenersAbsent','scan']) {
    const controller = new AbortController(), f = fixture({ [operation]: () => controller.abort() });
    await rejected(exerciseHostedSecretService(f.ops, { signal: controller.signal }), 'ABORTED');
    assert.equal(f.calls.includes('removeStorage'), false, operation);
    for (const cleanup of ['stopCommands','stopKeyring','stopBus','confirmGroupsAbsent','confirmListenersAbsent','scan']) assert.equal(f.calls.includes(cleanup), true);
    assert.equal(f.failures[0].recoveryRetained, true); assert.equal(f.failures[0].code, 'ABORTED');
  }
});
test('cancellation during final storage removal stays failed even after physical removal completes', async () => {
  const controller = new AbortController(), f = fixture({ removeStorage: () => controller.abort() });
  await rejected(exerciseHostedSecretService(f.ops, { signal: controller.signal }), 'ABORTED');
  assert.equal(f.calls.includes('removeStorage'), true); assert.equal(f.failures[0].recoveryRetained, false);
  assert.equal(f.failures[0].proofExitCode, 0); assert.equal(f.failures[0].code, 'ABORTED');
});

test('pre-aborted factory refuses before host reads, path allocation or native child creation', async () => {
  const controller = new AbortController(); controller.abort();
  await rejected(runHostedAndroidRuntime({ root: null, proofOutput: null, signal: controller.signal }), 'ABORTED');
});

test('pre-aborted sequencing allocates neither services nor a proof, while failure remains fixed', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  await rejected(exerciseHostedSecretService(f.ops, { signal: controller.signal }), 'ABORTED');
  assert.equal(f.calls.includes('startBus'), false);
  assert.equal(f.calls.includes('startKeyring'), false);
  assert.equal(f.calls.includes('runProof'), false);
  assert.equal(f.calls.includes('removeStorage'), false);
});
