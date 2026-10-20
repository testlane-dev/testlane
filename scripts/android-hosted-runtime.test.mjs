/** Node-only policy/lifecycle tests. These do not run or attest Linux services. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { exerciseHostedSecretService, assertRuntimeSecretsAbsent, retainedHostedServiceLive, runHostedAndroidRuntime,
  verifyHostedServiceOwners, scanHostedRuntimeSecrets, streamHostedRuntimeScanTree, HOSTED_RUNTIME_SCAN_LIMITS } from './android-hosted-runtime.mjs';

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

const serviceSecrets = () => ({ unlock: randomBytes(32).toString('base64') + ' /+?', canary: randomBytes(32).toString('base64') + ' /+?' });
const encodedSecrets = secret => ({ raw:secret,uri:encodeURIComponent(secret),base64:Buffer.from(secret).toString('base64'),base64url:Buffer.from(secret).toString('base64url') });
function noServiceSecrets(value, secrets) {
  const text=JSON.stringify(value);
  for(const secret of Object.values(secrets))for(const encoded of Object.values(encodedSecrets(secret)))assert.equal(text.includes(encoded),false);
}
function scanningFixture(sources, secrets, overrides={}) {
  return fixture({ ...overrides, scan: () => scanHostedRuntimeSecrets({captured:sources.captured??'',overflow:sources.overflow??false,signal:sources.signal,now:sources.now,
    readProofOutput:sources.readProofOutput??(async()=>sources['proof-output']??''),
    readPrivateRuntime:sources.readPrivateRuntime??(async()=>sources['private-runtime']??'')},secrets) });
}

test('actual matches record only fixed scope, secret kind and encoding, retaining failure storage',async()=>{
  const secrets=serviceSecrets();
  for(const scope of ['captured','proof-output','private-runtime'])for(const [secret,value]of Object.entries(secrets))for(const [encoding,encoded]of Object.entries(encodedSecrets(value))){
    const f=scanningFixture({[scope]:'prefix '+encoded+' suffix'},secrets);
    await rejected(exerciseHostedSecretService(f.ops),'LEAK_DETECTED');
    assert.deepEqual(f.failures[0].scanFact,{scope,kind:'match',code:'LEAK_DETECTED',secret,encoding});
    assert.equal(f.failures[0].recoveryRetained,true);assert.equal(f.calls.includes('removeStorage'),false);noServiceSecrets(f.failures,secrets);
  }
});

test('the original concatenation matches remain detectable across two or three scan scopes',async()=>{
  const secrets=serviceSecrets();
  for(const [encoding,encoded]of Object.entries(encodedSecrets(secrets.canary))){
    const split=Math.floor(encoded.length/3);
    for(const parts of [[encoded.slice(0,split),encoded.slice(split),''],['',encoded.slice(0,split),encoded.slice(split)],
      [encoded.slice(0,split),encoded.slice(split,split*2),encoded.slice(split*2)]]){
      const f=scanningFixture({captured:parts[0],'proof-output':parts[1],'private-runtime':parts[2]},secrets);
      await rejected(exerciseHostedSecretService(f.ops),'LEAK_DETECTED');
      assert.deepEqual(f.failures[0].scanFact,{scope:'combined-boundary',kind:'match',code:'LEAK_DETECTED',secret:'canary',encoding});
      assert.equal(f.calls.includes('removeStorage'),false);noServiceSecrets(f.failures,secrets);
    }
  }
});

test('incomplete scans preserve known read/size codes without claiming a secret match',async()=>{
  const secrets=serviceSecrets();
  for(const scope of ['proof-output','private-runtime'])for(const code of ['OUTPUT_LIMIT','STORAGE_UNCONFIRMED','OWNERSHIP_REFUSED','FAILED']){
    const failure=code==='FAILED'?Error(secrets.unlock):error(code);
    const f=scanningFixture({[scope==='proof-output'?'readProofOutput':'readPrivateRuntime']:async()=>{throw failure;}},secrets);
    await rejected(exerciseHostedSecretService(f.ops),'LEAK_DETECTED');
    assert.deepEqual(f.failures[0].scanFact,{scope,kind:'incomplete',code});
    assert.equal(f.failures[0].code,'LEAK_DETECTED');assert.equal(f.calls.includes('removeStorage'),false);noServiceSecrets(f.failures,secrets);
  }
  const overflow=scanningFixture({overflow:true},secrets);await rejected(exerciseHostedSecretService(overflow.ops),'LEAK_DETECTED');
  assert.deepEqual(overflow.failures[0].scanFact,{scope:'captured',kind:'incomplete',code:'OUTPUT_LIMIT'});
  const invalid=scanningFixture({captured:null},secrets);invalid.ops.scan=()=>scanHostedRuntimeSecrets({captured:null,readProofOutput:async()=>'',readPrivateRuntime:async()=>''},secrets);
  await rejected(exerciseHostedSecretService(invalid.ops),'LEAK_DETECTED');
  assert.deepEqual(invalid.failures[0].scanFact,{scope:'captured',kind:'incomplete',code:'LEAK_DETECTED'});
});

test('secondary scan failure preserves a primary proof failure; forged error facts do not become evidence',async()=>{
  const secrets=serviceSecrets(),f=scanningFixture({readPrivateRuntime:async()=>{throw error('OUTPUT_LIMIT');}},secrets,{runProof:()=>1});
  await rejected(exerciseHostedSecretService(f.ops),'PROOF_FAILED');assert.equal(f.failures[0].stage,'proof');
  assert.deepEqual(f.failures[0].scanFact,{scope:'private-runtime',kind:'incomplete',code:'OUTPUT_LIMIT'});
  const forged=fixture({scan:()=>{throw Object.assign(Error(secrets.canary),{scanFact:{scope:'captured',kind:'match',code:'LEAK_DETECTED',secret:secrets.canary,encoding:'raw'}});}});
  await rejected(exerciseHostedSecretService(forged.ops),'LEAK_DETECTED');assert.equal(Object.hasOwn(forged.failures[0],'scanFact'),false);noServiceSecrets(forged.failures,secrets);
});

test('complete sequential scans still gate success and storage removal',async()=>{
  const secrets=serviceSecrets(),readers=[],f=scanningFixture({captured:'fixed capture',readProofOutput:async()=>{readers.push('proof');return 'fixed proof';},
    readPrivateRuntime:async()=>{readers.push('private');return 'fixed private';}},secrets);
  const result=await exerciseHostedSecretService(f.ops);assert.deepEqual(readers,['proof','private']);assert.equal(result.unlockSecretLeakScanPassed,true);
  assert.equal(f.calls.includes('removeStorage'),true);assert.deepEqual(f.failures,[]);
});

async function streamFixture(t) {
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-scan-tree-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^tld-scan-tree-[A-Za-z0-9]+$/);assert.equal(await realpath(root),root);assert.equal((await lstat(root)).isSymbolicLink(),false);await rm(root,{recursive:true});});
  return {root,uid:(await lstat(root)).uid,file:path.join(root,'ordinary')};
}
const treeReader = ({root,uid}) => control => streamHostedRuntimeScanTree(root,uid,control);

test('a real file above the old 64 MiB limit completes; a late-chunk secret still prevents success',async t=>{
  const owned=await streamFixture(t),secrets=serviceSecrets(),size=65*1024*1024,handle=await open(owned.file,'wx');
  try{await handle.truncate(size);}finally{await handle.close();}
  const clean=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);
  assert.equal((await exerciseHostedSecretService(clean.ops)).unlockSecretLeakScanPassed,true);assert.equal(clean.calls.includes('removeStorage'),true);
  const writer=await open(owned.file,'r+');try{await writer.write(Buffer.from(secrets.canary),0,Buffer.byteLength(secrets.canary),size-Buffer.byteLength(secrets.canary));}finally{await writer.close();}
  const late=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);await rejected(exerciseHostedSecretService(late.ops),'LEAK_DETECTED');
  assert.deepEqual(late.failures[0].scanFact,{scope:'private-runtime',kind:'match',code:'LEAK_DETECTED',secret:'canary',encoding:'raw'});assert.equal(late.calls.includes('removeStorage'),false);
});

test('a >64 MiB clean inventory scans in a controlled Node child with a 32 MiB JS heap limit',async t=>{
  const owned=await streamFixture(t),handle=await open(owned.file,'wx');try{await handle.truncate(65*1024*1024);}finally{await handle.close();}
  const source=`import {randomBytes} from 'node:crypto';import {lstat} from 'node:fs/promises';
    import {scanHostedRuntimeSecrets,streamHostedRuntimeScanTree} from ${JSON.stringify(new URL('./android-hosted-runtime.mjs',import.meta.url).href)};
    const root=process.argv[1],uid=(await lstat(root)).uid;
    await scanHostedRuntimeSecrets({captured:'',readProofOutput:async()=>'',readPrivateRuntime:control=>streamHostedRuntimeScanTree(root,uid,control)},
      {unlock:randomBytes(48).toString('base64url'),canary:randomBytes(48).toString('base64url')});process.stdout.write('COMPLETE');`;
  const result=await promisify(execFile)(process.execPath,['--max-old-space-size=32','--input-type=module','--eval',source,owned.root],
    {env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{},windowsHide:true,timeout:30000,maxBuffer:4096});
  assert.equal(result.stdout,'COMPLETE');assert.equal(result.stderr,'');
});

test('chunk boundaries, UTF-8 decoding, file newlines and scope boundaries retain original matches',async t=>{
  const owned=await streamFixture(t),secrets=serviceSecrets();
  for(const [encoding,value]of Object.entries(encodedSecrets(secrets.canary))){
    await writeFile(owned.file,Buffer.concat([Buffer.alloc(65536-11,65),Buffer.from(value),Buffer.from('suffix')]));
    const chunk=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);await rejected(exerciseHostedSecretService(chunk.ops),'LEAK_DETECTED');
    assert.deepEqual(chunk.failures[0].scanFact,{scope:'private-runtime',kind:'match',code:'LEAK_DETECTED',secret:'canary',encoding});
    await writeFile(owned.file,value.slice(13));const boundary=scanningFixture({captured:value.slice(0,13),readPrivateRuntime:treeReader(owned)},secrets);
    await rejected(exerciseHostedSecretService(boundary.ops),'LEAK_DETECTED');assert.equal(boundary.failures[0].scanFact.scope,'combined-boundary');
  }
  await writeFile(owned.file,Buffer.concat([Buffer.alloc(65535,65),Buffer.from('😀'+secrets.canary)]));
  const utf8=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);await rejected(exerciseHostedSecretService(utf8.ops),'LEAK_DETECTED');assert.equal(utf8.failures[0].scanFact.encoding,'raw');
  await rm(owned.file);const first=secrets.canary.slice(0,21),second=secrets.canary.slice(21);
  await writeFile(path.join(owned.root,'a'),first);await writeFile(path.join(owned.root,'b'),second);
  const separated=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);assert.equal((await exerciseHostedSecretService(separated.ops)).unlockSecretLeakScanPassed,true);
  const withNewline={...secrets,canary:first+'\n'+second};const joined=scanningFixture({readPrivateRuntime:treeReader(owned)},withNewline);
  await rejected(exerciseHostedSecretService(joined.ops),'LEAK_DETECTED');assert.equal(joined.failures[0].scanFact.scope,'private-runtime');assert.equal(joined.failures[0].scanFact.encoding,'raw');
});

test('the new aggregate byte cap, UID and symlink guards fail closed',async t=>{
  const owned=await streamFixture(t),secrets=serviceSecrets(),handle=await open(owned.file,'wx');
  try{await handle.truncate(HOSTED_RUNTIME_SCAN_LIMITS.totalBytes+1);}finally{await handle.close();}
  const f=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);
  await rejected(exerciseHostedSecretService(f.ops),'LEAK_DETECTED');
  assert.deepEqual(f.failures[0].scanFact,{scope:'private-runtime',kind:'incomplete',code:'OUTPUT_LIMIT'});assert.equal(f.calls.includes('removeStorage'),false);
  await rm(owned.file);await writeFile(owned.file,'synthetic');
  const foreign=scanningFixture({readPrivateRuntime:treeReader({...owned,uid:owned.uid+1})},secrets);await rejected(exerciseHostedSecretService(foreign.ops),'LEAK_DETECTED');
  assert.equal(foreign.failures[0].scanFact.code,'STORAGE_UNCONFIRMED');
  await symlink(owned.root,path.join(owned.root,'link'),process.platform==='win32'?'junction':'dir');
  const linked=scanningFixture({readPrivateRuntime:treeReader(owned)},secrets);await rejected(exerciseHostedSecretService(linked.ops),'LEAK_DETECTED');assert.equal(linked.failures[0].scanFact.code,'STORAGE_UNCONFIRMED');
});

test('the total-byte cap is shared by both complete trees',async t=>{
  const proof=await streamFixture(t),privateRuntime=await streamFixture(t),secrets=serviceSecrets();
  for(const owned of [proof,privateRuntime]){const handle=await open(owned.file,'wx');try{await handle.truncate(300*1024*1024);}finally{await handle.close();}}
  const f=scanningFixture({readProofOutput:treeReader(proof),readPrivateRuntime:treeReader(privateRuntime)},secrets);
  await rejected(exerciseHostedSecretService(f.ops),'LEAK_DETECTED');
  assert.deepEqual(f.failures[0].scanFact,{scope:'private-runtime',kind:'incomplete',code:'OUTPUT_LIMIT'});assert.equal(f.calls.includes('removeStorage'),false);
});

test('same-size mutation is refused after the retained file read',async t=>{
  const owned=await streamFixture(t),secrets=serviceSecrets();await writeFile(owned.file,'synthetic data');let changed=false;
  const reader=control=>(async function*(){for await(const text of streamHostedRuntimeScanTree(owned.root,owned.uid,control)){
    if(!changed){changed=true;await new Promise(resolve=>setTimeout(resolve,5));const writer=await open(owned.file,'r+');try{await writer.write(Buffer.from('X'),0,1,0);}finally{await writer.close();}}
    yield text;}})();
  const f=scanningFixture({readPrivateRuntime:reader},secrets);await rejected(exerciseHostedSecretService(f.ops),'LEAK_DETECTED');
  assert.equal(changed,true);assert.deepEqual(f.failures[0].scanFact,{scope:'private-runtime',kind:'incomplete',code:'STORAGE_UNCONFIRMED'});assert.equal(f.calls.includes('removeStorage'),false);
});

test('cooperative timeout and cancellation settle awaited reads without a passing receipt',async()=>{
  const secrets=serviceSecrets();let tick=0;
  const timed=scanningFixture({now:()=>tick,readPrivateRuntime:async()=>{await new Promise(resolve=>setImmediate(resolve));tick=HOSTED_RUNTIME_SCAN_LIMITS.milliseconds;return '';}},secrets);
  await rejected(exerciseHostedSecretService(timed.ops),'LEAK_DETECTED');assert.deepEqual(timed.failures[0].scanFact,{scope:'private-runtime',kind:'incomplete',code:'SCAN_TIMEOUT'});
  const controller=new AbortController();let finish,settled=false;
  const cancelled=scanningFixture({signal:controller.signal,readPrivateRuntime:()=>new Promise(resolve=>{finish=resolve;})},secrets);
  const result=exerciseHostedSecretService(cancelled.ops).finally(()=>{settled=true;}),failure=rejected(result,'LEAK_DETECTED');
  while(!finish)await new Promise(resolve=>setImmediate(resolve));controller.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  finish('');await failure;assert.deepEqual(cancelled.failures[0].scanFact,{scope:'private-runtime',kind:'incomplete',code:'ABORTED'});assert.equal(cancelled.calls.includes('removeStorage'),false);
});

test('FIFO, read, entry-limit and acquired-handle cancellation failures close controlled handles',async t=>{
  const owned=await streamFixture(t);await writeFile(owned.file,'synthetic');
  const helper=new URL('./android-hosted-runtime.mjs',import.meta.url).href,constantsFile=path.join(owned.root,'constants.mjs'),filesystemFile=path.join(owned.root,'filesystem.mjs'),loaderFile=path.join(owned.root,'loader.mjs'),marker=path.join(owned.root,'state.json');
  await writeFile(constantsFile,"export {realpathSync} from 'node:fs';import {constants as original} from 'node:fs';export const constants={...original,O_NONBLOCK:2048,O_NOFOLLOW:131072};");
  for(const mode of ['fifo','read-error','entry-cap','open-aborted','invalid-name']){
    await writeFile(filesystemFile,`export {access,lstat,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
      import {open as originalOpen,opendir as originalDirectory,writeFile} from 'node:fs/promises';
      export async function opendir(file,options){
        if(!['entry-cap','invalid-name'].includes(${JSON.stringify(mode)})||file!==${JSON.stringify(owned.root)})return originalDirectory(file,options);
        let entries=0;return {async read(){entries++;return {name:${JSON.stringify(mode)}==='invalid-name'?Buffer.from([255]):Buffer.from('entry'+entries)};},async close(){await writeFile(${JSON.stringify(marker)},JSON.stringify({entries,closed:true}));}};
      }
      export async function open(file,flags,...args){
        if(file!==${JSON.stringify(owned.file)})return originalOpen(file,flags,...args);
        if((flags&2048)===0){setInterval(()=>{},1000);return new Promise(()=>{});}
        const marker=${JSON.stringify(marker)};await writeFile(marker,JSON.stringify({nonblocking:true,closed:false}));
        if(${JSON.stringify(mode)}==='open-aborted'){globalThis.__testAbort();return {async close(){await writeFile(marker,JSON.stringify({nonblocking:true,closed:true}));}};}
        if(${JSON.stringify(mode)}==='fifo')return {async stat(){return {isFile:()=>false};},async close(){await writeFile(marker,JSON.stringify({nonblocking:true,closed:true}));}};
        const handle=await originalOpen(file,0,...args);return {stat:options=>handle.stat(options),async read(){throw Error('unreviewed fixture read');},
          async close(){await handle.close();await writeFile(marker,JSON.stringify({nonblocking:true,closed:true}));}};
      }`);
    await writeFile(loaderFile,`export async function resolve(specifier,context,next){
      if(context.parentURL===${JSON.stringify(helper)}&&specifier==='node:fs')return {url:${JSON.stringify(pathToFileURL(constantsFile).href)},shortCircuit:true};
      if(context.parentURL===${JSON.stringify(helper)}&&specifier==='node:fs/promises')return {url:${JSON.stringify(pathToFileURL(filesystemFile).href)},shortCircuit:true};return next(specifier,context);}`);
    const source=`import {randomBytes} from 'node:crypto';import {lstat} from 'node:fs/promises';
      import {scanHostedRuntimeSecrets,streamHostedRuntimeScanTree} from ${JSON.stringify(helper)};
      const root=process.argv[1],uid=(await lstat(root)).uid,controller=new AbortController();globalThis.__testAbort=()=>controller.abort();try{
        await scanHostedRuntimeSecrets({captured:'',signal:controller.signal,readProofOutput:async()=>'',readPrivateRuntime:control=>streamHostedRuntimeScanTree(root,uid,control)},
          {unlock:randomBytes(48).toString('base64url'),canary:randomBytes(48).toString('base64url')});throw Error('FIXTURE_REFUSAL_REQUIRED');
      }catch(error){if(error.message!==${JSON.stringify('ANDROID_HOSTED_RUNTIME_'+({fifo:'STORAGE_UNCONFIRMED','read-error':'FAILED','entry-cap':'OUTPUT_LIMIT','open-aborted':'ABORTED','invalid-name':'STORAGE_UNCONFIRMED'}[mode]))})throw Error('FIXTURE_WRONG_FAILURE');process.stdout.write('REFUSED');}`;
    const result=await promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',pathToFileURL(loaderFile).href,'--input-type=module','--eval',source,owned.root],
      {env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{},windowsHide:true,timeout:15000,maxBuffer:4096});
    assert.equal(result.stdout,'REFUSED');assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),mode==='entry-cap'?{entries:10000,closed:true}:mode==='invalid-name'?{entries:1,closed:true}:{nonblocking:true,closed:true});
    await rm(marker);
  }
});
