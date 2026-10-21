/** Actual private guard source with Node-only query/filesystem seams; no SDK. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {verifyOwnedIdentity} from '../device.mjs';
import {normalizeAndroidOwnershipFailure,readAndroidOwnershipFailure,retainAndroidOwnershipFailure} from '../ownership-facts.mjs';
import {publicAndroidFailure,projectPublicAndroidFailure,createAndroidFailureFact,retainAndroidFailureFact} from '../failure.mjs';

const fields=['stateDevice','allQueriesSucceeded','qemuMatches','avdNamePresent','avdNameMatches','avdNameNonceMatches','markerPidMatches','markerNonceMatches','retainedProcessesAlive'];
const good=()=>Object.fromEntries(fields.map(name=>[name,true]));
const variants=value=>[value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('base64url')];
const source=await readFile(new URL('../device.mjs',import.meta.url),'utf8');
const start=source.indexOf('  async function assertRoot() {'),end=source.indexOf('\n  const adb = ',start);
assert.ok(start>=0&&end>start&&source.indexOf('  async function assertRoot() {',start+1)<0);
const refusal=/^const ownershipRefusal = .+;$/m.exec(source)?.[0];assert.equal(typeof refusal,'string');
const make=vm.runInThisContext(`(deps)=>{const {root,parent,nonce,avdName,serial,marker,markerPath,process,path,same,realpath,lstat,readFile,ensureLive,rawAdb,verifyOwnedIdentity,retainAndroidOwnershipFailure,emulator,adbServer}=deps;
  const fail=code=>new Error(code);${refusal}let ownershipChecks;${source.slice(start,end)}
  return {assertOwned,legacy:()=>ownershipChecks};}`);
function harness(){
  const root=path.resolve(os.tmpdir(),'tld-android-fixture'),nonce=randomBytes(12).toString('hex'),avdName='testlane_'+nonce;
  const marker={schemaVersion:1,nonce,avdName,serial:'emulator-5564',ownerPid:123,emulatorPid:456,adbPid:457,appiumPid:458,adbPort:49321};
  const emulator={closed:false},adbServer={closed:false},calls=[];
  const state={path:root,symlink:false,marker:{...marker},code:0,device:'device',qemu:'1',name:avdName,reject:false,closeDuringQuery:false};
  const owner=make({root,parent:path.dirname(root),nonce,avdName,serial:marker.serial,marker,markerPath:path.join(root,'testlane-owned-device.json'),process:{pid:123},path,same:(a,b)=>a===b,
    realpath:async()=>state.path,lstat:async()=>({isSymbolicLink:()=>state.symlink}),readFile:async()=>JSON.stringify(state.marker),ensureLive:()=>{},
    rawAdb:async args=>{calls.push([...args]);if(state.reject)throw Error('FIXED_QUERY_REJECTED');if(state.closeDuringQuery)emulator.closed=true;
      return {code:state.code,stdout:args[0]==='get-state'?state.device:args.at(-1)==='ro.kernel.qemu'?state.qemu:state.name};},
    verifyOwnedIdentity,retainAndroidOwnershipFailure,emulator,adbServer});
  return {...owner,state,calls,emulator,marker};
}
async function refused(owner){let failure;await assert.rejects(owner.assertOwned(),error=>{failure=error;return error.message==='ANDROID_OWNERSHIP_REFUSED';});return failure;}

test('first success then root or marker refusal never reuses the earlier query snapshot',async()=>{
  for(const mode of ['path','marker']){
    const h=harness();assert.equal(await h.assertOwned(),true);assert.deepEqual(h.legacy(),good());assert.equal(h.calls.length,3);
    if(mode==='path')h.state.path=path.dirname(h.state.path);else h.state.marker.appiumPid++;
    const failure=await refused(h);assert.deepEqual(readAndroidOwnershipFailure(failure),{gate:mode==='path'?'root-path':'marker'});
    assert.equal(h.legacy(),undefined);assert.equal(h.calls.length,3,'early refusal starts no additional query');
  }
});

test('query-status and device-state refusals retain only fresh boolean query results',async()=>{
  for(const mode of ['status','state']){
    const h=harness();if(mode==='status')h.state.code=1;else h.state.device='offline';
    const fact=readAndroidOwnershipFailure(await refused(h));assert.equal(fact.gate,mode==='status'?'adb-query-status':'adb-device-state');
    assert.deepEqual(fact.checks,{...good(),allQueriesSucceeded:mode!=='status',stateDevice:mode!=='state'});
    assert.equal(h.calls.length,3);assert.equal(Object.isFrozen(fact),true);assert.equal(Object.isFrozen(fact.checks),true);
  }
});

test('guest qemu, empty/wrong AVD and retained liveness refusals keep existing guards and exact three queries',async()=>{
  for(const mode of ['qemu','empty','name','closed']){
    const h=harness();if(mode==='qemu')h.state.qemu='0';if(mode==='empty')h.state.name='';if(mode==='name')h.state.name='unrelated';if(mode==='closed')h.state.closeDuringQuery=true;
    const fact=readAndroidOwnershipFailure(await refused(h));assert.equal(fact.gate,'guest-identity');
    assert.equal(fact.checks.qemuMatches,mode!=='qemu');assert.equal(fact.checks.avdNamePresent,mode!=='empty');
    assert.equal(fact.checks.avdNameMatches,!['empty','name'].includes(mode));assert.equal(fact.checks.avdNameNonceMatches,!['empty','name'].includes(mode));
    assert.equal(fact.checks.retainedProcessesAlive,mode!=='closed');assert.equal(h.calls.length,3);
  }
});

test('a rejected query has no fabricated ownership-refusal fact or stale query snapshot',async()=>{
  const h=harness();await h.assertOwned();h.state.reject=true;
  let failure;await assert.rejects(h.assertOwned(),error=>{failure=error;return error.message==='FIXED_QUERY_REJECTED';});
  assert.equal(readAndroidOwnershipFailure(failure),undefined);assert.equal(h.legacy(),undefined);assert.equal(h.calls.length,6);
});

test('failure snapshots cannot change after a later invocation or marker/result mutation',async()=>{
  const h=harness();h.state.qemu='0';const first=await refused(h),fact=readAndroidOwnershipFailure(first);
  h.state.qemu='1';h.state.name='';await refused(h);h.state.marker.nonce=randomBytes(12).toString('hex');
  assert.deepEqual(readAndroidOwnershipFailure(first),fact);assert.equal(fact.checks.qemuMatches,false);assert.equal(fact.checks.avdNameMatches,true);
  for(const value of [h.marker.nonce,h.marker.avdName,h.marker.serial])assert.equal(JSON.stringify(fact).includes(value),false);
});

test('strict fact helper omits extra fields, unknown gates, malformed booleans and raw/encoded canaries',()=>{
  const secret=randomBytes(32).toString('base64')+' /+?',fact={gate:'guest-identity',checks:good()};
  assert.deepEqual(normalizeAndroidOwnershipFailure(fact),fact);
  for(const value of [null,[],{},...variants(secret).map(gate=>({gate})),{gate:'marker',checks:good()},
    {gate:'guest-identity'},{...fact,extra:secret},{...fact,checks:{...good(),extra:secret}},
    ...variants(secret).map(stateDevice=>({...fact,checks:{...good(),stateDevice}})),{...fact,checks:{...good(),stateDevice:1}}])assert.equal(normalizeAndroidOwnershipFailure(value),undefined);
  const error=retainAndroidOwnershipFailure(Error('ANDROID_OWNERSHIP_REFUSED'),fact);fact.checks.stateDevice=false;
  assert.equal(readAndroidOwnershipFailure(error).checks.stateDevice,true);
  retainAndroidOwnershipFailure(error,{gate:'marker'});assert.equal(readAndroidOwnershipFailure(error).gate,'guest-identity');
  for(const value of variants(secret))assert.equal(JSON.stringify(readAndroidOwnershipFailure(error)).includes(value),false);
});

test('facts and error readers never invoke accessors or proxy traps',()=>{
  let touched=0;const hostile=()=>{touched++;throw Error('FIXED_ACCESSOR_REFUSED');},fact={gate:'guest-identity',checks:good()};
  const gateGetter=Object.defineProperty({...fact},'gate',{get:hostile});
  const checkGetter={...fact,checks:Object.defineProperty(good(),'stateDevice',{get:hostile})};
  for(const value of [gateGetter,checkGetter,new Proxy(fact,{get:hostile,getPrototypeOf:hostile,ownKeys:hostile})])assert.equal(normalizeAndroidOwnershipFailure(value),undefined);
  for(const error of [{ownershipFailure:fact},new Proxy(Error('ANDROID_OWNERSHIP_REFUSED'),{get:hostile,getPrototypeOf:hostile,ownKeys:hostile}),
    Object.defineProperty(Error('ANDROID_OWNERSHIP_REFUSED'),'ownershipFailure',{get:hostile})])assert.equal(readAndroidOwnershipFailure(error),undefined);
  assert.equal(touched,0);
});

test('public projection preserves original ownership and cleanup precedence, omits unrelated/malformed facts',async()=>{
  const output=path.join(os.tmpdir(),'absent-fixed-ownership-plan-'+randomBytes(12).toString('hex'));
  const original=retainAndroidOwnershipFailure(Error('ANDROID_DEVICE_CLEANUP_UNCONFIRMED'),{gate:'marker'});
  const wrapped=retainAndroidFailureFact(Error('ANDROID_PROOF_CLEANUP_INCOMPLETE'),createAndroidFailureFact({stage:'device-owned-emulator-booted',error:original}));
  wrapped.preserveConsumer=true;retainAndroidOwnershipFailure(wrapped,readAndroidOwnershipFailure(original));
  const summary=await publicAndroidFailure({output,stage:'cleanup',error:wrapped});
  assert.equal(wrapped.preserveConsumer,true);assert.equal(summary.code,'ANDROID_PROOF_CLEANUP_INCOMPLETE');
  assert.deepEqual(summary.originalFailure,{stage:'device-owned-emulator-booted',code:'ANDROID_DEVICE_CLEANUP_UNCONFIRMED'});assert.deepEqual(summary.ownershipFailure,{gate:'marker'});
  assert.deepEqual(projectPublicAndroidFailure(summary),summary);assert.deepEqual(summary.reports,[]);
  assert.equal(projectPublicAndroidFailure({...summary,ownershipFailure:{gate:'marker',extra:true}}),undefined);
  const unrelated=await publicAndroidFailure({output,stage:'setup',error:retainAndroidOwnershipFailure(Error('ANDROID_PROOF_FAILED'),{gate:'marker'})});
  assert.equal(Object.hasOwn(unrelated,'ownershipFailure'),false);assert.equal(projectPublicAndroidFailure({...unrelated,ownershipFailure:{gate:'marker'}}),undefined);
});
