/** Node-only projection tests: no Docker, SDK, emulator, bus or keyring. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateHostedAndroidRuntimeFailure, readHostedAndroidRuntimeFailure, validateHostedRuntimeScanFact } from './android-hosted-failure.mjs';
import { exerciseHostedSecretService } from './android-hosted-runtime.mjs';
import { publicAndroidFailure } from '../examples/android-verification/failure.mjs';
import {retainAndroidOwnershipFailure} from '../examples/android-verification/ownership-facts.mjs';

const INVALID = 'ANDROID_HOSTED_RUNTIME_DIAGNOSTIC_INVALID';
const valid = () => ({ schemaVersion: 1, purpose: 'fixed-hosted-runtime-failure', stage: 'proof',
  code: 'PROOF_FAILED', proofExitCode: 1, recoveryRetained: true });
const variants = secret => [...new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')])];
const noLeaks = (text, secret) => { for (const value of variants(secret)) assert.equal(text.includes(value), false); };
async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-runtime-diagnostic-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^tld-runtime-diagnostic-[A-Za-z0-9]+$/);
    assert.equal((await lstat(root)).isSymbolicLink(), false); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });
  return root;
}

test('the actual runtime failed-proof record projects without inferring cleanup from its flags', async () => {
  let failure;
  const ops = Object.fromEntries(['startBus','startKeyring','storeCanary','lookupCanary','removeCanary','verifyProof',
    'stopCommands','stopKeyring','stopBus','confirmGroupsAbsent','confirmListenersAbsent','scan','removeStorage'].map(key => [key, async () => {}]));
  ops.uncertain = () => false; ops.runProof = async () => 1; ops.writeFailure = async value => { failure = value; };
  await assert.rejects(exerciseHostedSecretService(ops), { message: 'ANDROID_HOSTED_RUNTIME_PROOF_FAILED' });
  assert.deepEqual(validateHostedAndroidRuntimeFailure(failure), valid());
  assert.deepEqual(validateHostedAndroidRuntimeFailure(Object.fromEntries(Object.entries(failure).reverse())), valid());
  assert.equal(Object.isFrozen(validateHostedAndroidRuntimeFailure(failure)), true);
  // Abort may arrive after storage removal; false is a preserved fact, not success.
  assert.equal(validateHostedAndroidRuntimeFailure({ ...valid(), stage: 'cleanup', code: 'ABORTED', proofExitCode: 0, recoveryRetained: false }).recoveryRetained, false);
  assert.equal(validateHostedAndroidRuntimeFailure({ ...valid(), proofExitCode: null }).proofExitCode, null);
  assert.equal(validateHostedAndroidRuntimeFailure({ ...valid(), proofExitCode: 255 }).proofExitCode, 255);
});

test('runtime projection rejects extra fields, malformed scalar types and arbitrary canary strings', () => {
  const secret = randomBytes(32).toString('base64') + '/+=';
  const candidates = [null, [], {}, { ...valid(), message: secret }, { ...valid(), stage: secret }, { ...valid(), code: secret },
    { ...valid(), purpose: secret }, { ...valid(), schemaVersion: 2 }, { ...valid(), recoveryRetained: 'true' },
    { ...valid(), proofExitCode: false }, { ...valid(), proofExitCode: -1 }, { ...valid(), proofExitCode: 256 },
    { ...valid(), proofExitCode: 1.5 }, { ...valid(), proofExitCode: Infinity }, { ...valid(), proofExitCode: secret },
    ...variants(secret).map(value => ({ ...valid(), code: value }))];
  for (const value of candidates) assert.throws(() => validateHostedAndroidRuntimeFailure(value), error => error.message === INVALID && !error.message.includes(secret));
  const missing = valid(); delete missing.proofExitCode;
  assert.throws(() => validateHostedAndroidRuntimeFailure(missing), { message: INVALID });
  assert.throws(() => validateHostedAndroidRuntimeFailure({ ...valid(), [Symbol()]: secret }), { message: INVALID });
  let read = false;
  const accessor = valid(); Object.defineProperty(accessor, 'code', { enumerable: true, get() { read = true; return secret; } });
  assert.throws(() => validateHostedAndroidRuntimeFailure(accessor), { message: INVALID }); assert.equal(read, false);
  noLeaks(JSON.stringify(validateHostedAndroidRuntimeFailure(valid())), secret);
});

test('runtime reader accepts only bounded canonical ordinary files', async t => {
  const root = await fixture(t), file = path.join(root, 'linux-runtime-failure.json'), secret = randomBytes(32).toString('base64');
  await writeFile(file, JSON.stringify(valid())); assert.deepEqual(await readHostedAndroidRuntimeFailure(file), valid());
  for (const bytes of ['', secret, JSON.stringify({ ...valid(), raw: secret }), ' '.repeat(8193)]) {
    await writeFile(file, bytes);
    await assert.rejects(readHostedAndroidRuntimeFailure(file), error => error.message === INVALID && !error.message.includes(secret));
  }
  await assert.rejects(readHostedAndroidRuntimeFailure(root), { message: INVALID });
  await assert.rejects(readHostedAndroidRuntimeFailure(path.join(root, 'missing.json')), { message: INVALID });
  await assert.rejects(readHostedAndroidRuntimeFailure('linux-runtime-failure.json'), { message: INVALID });
  await writeFile(file, JSON.stringify(valid()));
  const source = path.join(root, 'ordinary'), linked = path.join(root, 'linked'); await mkdir(source);
  await writeFile(path.join(source, 'failure.json'), JSON.stringify(valid()));
  await symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readHostedAndroidRuntimeFailure(path.join(linked, 'failure.json')), { message: INVALID });
});

async function workflowFixture(t) {
  const root = await fixture(t), source = await readFile(new URL('../.github/workflows/android-emulator-proof.yml', import.meta.url), 'utf8');
  const section = source.split('name: Write a fixed failure stage without logs or private payloads')[1];
  const inline = /node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/.exec(section)?.[1].replace(/^ {10}/gm, '');
  assert.equal(typeof inline, 'string');
  for (const file of ['scripts/android-hosted-failure.mjs','examples/mobile-approval-app/build-diagnostics.mjs',
    'examples/android-verification/failure.mjs','examples/android-verification/contracts.mjs','examples/android-verification/proof-cases.mjs','examples/android-verification/ownership-facts.mjs']) {
    const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true });
    await copyFile(new URL('../' + file, import.meta.url), target);
  }
  const output = path.join(root, 'output/android-proof'); await mkdir(output, { recursive: true });
  return { root, output, inline };
}
async function project(f, { stage = 'proof' } = {}) {
  const outcomes = Object.fromEntries(['SDK','TOOLS','BUILD','PROOF','EVIDENCE'].map(key => [key + '_OUTCOME', key.toLowerCase() === stage ? 'failure' : 'success']));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', f.inline], {
    cwd: f.root, env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), ...outcomes },
    timeout: 15000, maxBuffer: 4096, windowsHide: true });
  assert.equal(stdout, ''); assert.equal(stderr, '');
  const file = path.join(f.root, 'output/android-hosted-failure.json'), value = JSON.parse(await readFile(file, 'utf8'));
  await rm(file); return value;
}

test('actual inline workflow keeps both validated projections and no other proof-file content', async t => {
  const f = await workflowFixture(t), secret = randomBytes(32).toString('base64') + '/+=';
  const native = await publicAndroidFailure({ output: f.output, stage: 'setup', error: Error(secret) });
  await writeFile(path.join(f.output, 'linux-runtime-failure.json'), JSON.stringify(valid()));
  await writeFile(path.join(f.output, 'public-failure.json'), JSON.stringify(native));
  await writeFile(path.join(f.output, 'raw.log'), variants(secret).join('\n'));
  await writeFile(path.join(f.output, 'cleanup-status.json'), JSON.stringify({ private: secret }));
  const result = await project(f);
  assert.deepEqual(result, { schemaVersion: 1, status: 'failed', stage: 'proof', code: 'ANDROID_HOSTED_EXPERIMENT_FAILED', runtimeDiagnostic: valid(), nativeDiagnostic: native });
  noLeaks(JSON.stringify(result), secret);
});

test('actual inline workflow omits refused or missing diagnostics using only fixed unavailable markers', async t => {
  const f = await workflowFixture(t), secret = randomBytes(32).toString('base64') + '/+=';
  const native = await publicAndroidFailure({ output: f.output, stage: 'setup', error: Error(secret) });
  const runtimeFile = path.join(f.output, 'linux-runtime-failure.json'), nativeFile = path.join(f.output, 'public-failure.json');
  for (const [runtime, nativeValue] of [[{ ...valid(), message: secret }, { ...native, message: secret }],
    [{ ...valid(), code: secret }, { ...native, code: secret }], [null, null]]) {
    if (runtime === null) { await rm(runtimeFile, { force: true }); await rm(nativeFile, { force: true }); }
    else { await writeFile(runtimeFile, JSON.stringify(runtime)); await writeFile(nativeFile, JSON.stringify(nativeValue)); }
    const result = await project(f);
    assert.deepEqual(result, { schemaVersion: 1, status: 'failed', stage: 'proof', code: 'ANDROID_HOSTED_EXPERIMENT_FAILED',
      runtimeDiagnosticStatus: 'unavailable', nativeDiagnosticStatus: 'unavailable' });
    noLeaks(JSON.stringify(result), secret);
  }
  await writeFile(runtimeFile, JSON.stringify(valid())); await writeFile(nativeFile, JSON.stringify({ ...native, reports: secret }));
  const result = await project(f); assert.deepEqual(result.runtimeDiagnostic, valid()); assert.equal(result.nativeDiagnosticStatus, 'unavailable');
  assert.equal(Object.hasOwn(result, 'nativeDiagnostic'), false); noLeaks(JSON.stringify(result), secret);
});

test('actual inline workflow never reads proof diagnostics for an earlier failed outer stage', async t => {
  const f = await workflowFixture(t), secret = randomBytes(32).toString('base64');
  await writeFile(path.join(f.output, 'linux-runtime-failure.json'), secret);
  await writeFile(path.join(f.output, 'public-failure.json'), secret);
  const result = await project(f, { stage: 'tools' });
  assert.deepEqual(result, { schemaVersion: 1, status: 'failed', stage: 'tools', code: 'ANDROID_HOSTED_EXPERIMENT_FAILED' });
  noLeaks(JSON.stringify(result), secret);
});

test('optional scan facts are exact data-only match or incomplete variants',()=>{
  const secret=randomBytes(32).toString('base64')+' /+?',match={scope:'captured',kind:'match',code:'LEAK_DETECTED',secret:'canary',encoding:'base64url'},
    incomplete={scope:'private-runtime',kind:'incomplete',code:'OUTPUT_LIMIT'};
  for(const scanFact of [match,incomplete,{...incomplete,code:'SCAN_TIMEOUT'},{...incomplete,code:'ABORTED'}]){
    assert.deepEqual(validateHostedRuntimeScanFact(scanFact),scanFact);
    assert.deepEqual(validateHostedAndroidRuntimeFailure({...valid(),scanFact}),{...valid(),scanFact});
    assert.equal(Object.isFrozen(validateHostedAndroidRuntimeFailure({...valid(),scanFact}).scanFact),true);
  }
  const candidates=[null,[],{}, {...match,message:secret},{...match,scope:secret},{...match,kind:secret},{...match,code:'OUTPUT_LIMIT'},
    {...match,secret},{...match,encoding:secret},{...incomplete,code:secret},{...incomplete,secret:'unlock'},
    {...incomplete,encoding:'raw'},{...incomplete,scope:'combined-boundary'}, {...match,kind:'incomplete'}];
  for(const value of candidates)assert.throws(()=>validateHostedAndroidRuntimeFailure({...valid(),scanFact:value}),{message:INVALID});
  let reads=0;const hostile=()=>{reads++;throw Error(secret);},getter={...match};Object.defineProperty(getter,'secret',{get:hostile});
  const proxy=new Proxy(match,{ownKeys:hostile,get:hostile,getPrototypeOf:hostile});
  for(const value of [getter,proxy])assert.throws(()=>validateHostedRuntimeScanFact(value),{message:INVALID});assert.equal(reads,0);
  noLeaks(JSON.stringify(validateHostedAndroidRuntimeFailure({...valid(),scanFact:match})),secret);
});

test('actual inline workflow preserves validated scan facts and refuses malformed or secret-bearing facts',async t=>{
  const f=await workflowFixture(t),secret=randomBytes(32).toString('base64')+' /+?',native=await publicAndroidFailure({output:f.output,stage:'setup',error:Error(secret)}),
    file=path.join(f.output,'linux-runtime-failure.json'),match={scope:'proof-output',kind:'match',code:'LEAK_DETECTED',secret:'unlock',encoding:'uri'},
    incomplete={scope:'private-runtime',kind:'incomplete',code:'OUTPUT_LIMIT'};
  await writeFile(path.join(f.output,'public-failure.json'),JSON.stringify(native));
  for(const scanFact of [match,incomplete,{...incomplete,code:'SCAN_TIMEOUT'},{...incomplete,code:'ABORTED'}]){
    await writeFile(file,JSON.stringify({...valid(),scanFact}));const result=await project(f);
    assert.deepEqual(result.runtimeDiagnostic,{...valid(),scanFact});assert.deepEqual(result.nativeDiagnostic,native);noLeaks(JSON.stringify(result),secret);
  }
  for(const scanFact of [{...match,path:secret},{...match,secret},{...incomplete,encoding:secret},...variants(secret).map(code=>({...incomplete,code}))]){
    await writeFile(file,JSON.stringify({...valid(),scanFact}));const result=await project(f);
    assert.equal(result.runtimeDiagnosticStatus,'unavailable');assert.equal(Object.hasOwn(result,'runtimeDiagnostic'),false);
    assert.deepEqual(result.nativeDiagnostic,native);noLeaks(JSON.stringify(result),secret);
  }
});


test('actual workflow carries only validated fresh ownership facts and refuses unknown query fields',async t=>{
  const f=await workflowFixture(t),secret=randomBytes(32).toString('base64')+' /+?';
  const error=retainAndroidOwnershipFailure(Error('ANDROID_OWNERSHIP_REFUSED'),{gate:'marker'});
  const native=await publicAndroidFailure({output:f.output,stage:'device-owned-emulator-booted',error});
  await writeFile(path.join(f.output,'linux-runtime-failure.json'),JSON.stringify(valid()));
  await writeFile(path.join(f.output,'public-failure.json'),JSON.stringify(native));
  const result=await project(f);assert.deepEqual(result.nativeDiagnostic.ownershipFailure,{gate:'marker'});assert.deepEqual(result.runtimeDiagnostic,valid());
  for(const ownershipFailure of [{gate:'marker',query:secret},...variants(secret).map(gate=>({gate})),{gate:'guest-identity',checks:{stateDevice:true}}]){
    await writeFile(path.join(f.output,'public-failure.json'),JSON.stringify({...native,ownershipFailure}));
    const refused=await project(f);assert.equal(refused.nativeDiagnosticStatus,'unavailable');assert.equal(Object.hasOwn(refused,'nativeDiagnostic'),false);noLeaks(JSON.stringify(refused),secret);
  }
});
