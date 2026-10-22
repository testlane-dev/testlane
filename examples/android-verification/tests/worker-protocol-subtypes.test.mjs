/** Exact host handlers with inert retained-child fixtures; no OS/native/network process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {readFile,writeFile,mkdtemp,realpath,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {validateNativePlan,sanitizeNativeReport,nativeFailureReport,appendNativeRunFailure,nativeDiagnostic,NATIVE_WORKER_PROTOCOL_SUBTYPE_CODES,NATIVE_DRIVER_FAILURE_CODES,IOS_NATIVE_RUNNER,NATIVE_RUNNER} from '../contracts.mjs';
import {APPROVAL_REQUIREMENTS} from '../proof-cases.mjs';
import {validateIosDeviceBinding} from '../../ios-verification/device-scope.mjs';
import {publicIosFailure} from '../../ios-verification/failure.mjs';
import {publicAndroidFailure,projectPublicAndroidFailure} from '../failure.mjs';
const source=await readFile(new URL('../worker-host.mjs',import.meta.url),'utf8');
const helper='const object =',stop='async function stopChild(',run='export async function runNativeWorker(';
for(const anchor of [helper,stop,run])assert.equal(source.split(anchor).length,2);
const body=source.slice(source.indexOf(helper),source.indexOf(stop)).replace('export ','')+'\n'+source.slice(source.indexOf(run)).replace('export ','');
const C=NATIVE_WORKER_PROTOCOL_SUBTYPE_CODES,PRIMARY='NATIVE_WORKER_PROTOCOL_INVALID',MAX=256*1024;
const plan=(runner=IOS_NATIVE_RUNNER)=>validateNativePlan({schemaVersion:1,runner,status:'reviewed',title:'Synthetic native approval proof',target:{baseUrl:'http://127.0.0.1:4555',environment:'testing'},app:runner===IOS_NATIVE_RUNNER?{bundleId:'dev.testlane.iosproof',buildSha256:'0'.repeat(64)}:{package:'dev.testlane.androidproof',apkSha256:'0'.repeat(64)},cases:APPROVAL_REQUIREMENTS.map(row=>({...row,cleanup:{required:row.id!=='anonymous-denied',description:row.id==='anonymous-denied'?'No state is created':'Delete only the unique owned marker and verify absence'}}))});
const report=()=>nativeFailureReport(plan(),'NATIVE_DRIVER_OWNERSHIP_REFUSED');
const pair=code=>[PRIMARY,code];
const tick=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function fixture({onRequest=async()=>true,stopConfirmed=true,finalReject=false,signal}={}){
 const timers=new Map();let seq=0,stopCalls=0,spawnCalls=0,sanitizeCalls=0,settled=false,started=false;
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};child.connected=true;child.disconnect=()=>{child.connected=false;};child.unref=()=>{};
 child.send=(message,callback)=>{callback?.();if(message.type==='start')started=true;};
 const spawn=()=>{spawnCalls++;queueMicrotask(()=>child.emit('spawn'));return child;};
 const stopChild=async()=>{stopCalls++;if(stopConfirmed){child.connected=false;child.emit('close',0);}return stopConfirmed;};
 const sanitize=(...args)=>{sanitizeCalls++;if(finalReject&&sanitizeCalls===2)throw Error('SYNTHETIC_REJECTED_REPORT');return sanitizeNativeReport(...args);};
 const set=(callback,ms)=>{const id=++seq;timers.set(id,{callback,ms});return id;};const clear=id=>timers.delete(id);
 const invoke=vm.compileFunction(body+'\nreturn runNativeWorker;',[],{contextExtensions:[{validateNativePlan,sanitizeNativeReport:sanitize,nativeFailureReport,appendNativeRunFailure,NATIVE_WORKER_PROTOCOL_SUBTYPE_CODES,NATIVE_DRIVER_FAILURE_CODES,IOS_NATIVE_RUNNER,validateIosDeviceBinding,MAX_IPC:MAX,MAX_OUTPUT:MAX,ENTRY:'INERT_ENTRY',path:{dirname:()=>'.'},process:{execPath:'INERT_NODE',platform:'fixture',env:{}},spawn,stopChild,structuredClone,Buffer,setTimeout:set,clearTimeout:clear}]})();
 const binding={schemaVersion:1,scope:'ephemeral-hosted-standard-device-set',nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-abc123',udid:'12345678-1234-1234-1234-123456789ABC',nonce:'a'.repeat(24)};
 const pending=invoke({plan:plan(),driverOptions:{deviceBinding:binding,capabilities:{'appium:udid':binding.udid,'appium:simulatorDevicesSetPath':binding.deviceSetPath,'appium:derivedDataPath':binding.privateRoot+'/derived-data'}},identities:{editor:{email:'editor@example.test',role:'Editor'},reviewer:{email:'reviewer@example.test',role:'Reviewer'}},origin:'http://127.0.0.1:4555',cookies:{editor:'synthetic-editor',reviewer:'synthetic-reviewer'},onRequest,signal,timeoutMs:600000}).then(value=>{settled=true;return value;});
 return{child,pending,send:value=>child.emit('message',value),close:code=>child.emit('close',code),fire(ms){const row=[...timers].find(([,v])=>v.ms===ms);assert.ok(row,'expected existing host timer');timers.delete(row[0]);row[1].callback();},timers,stopCalls:()=>stopCalls,spawnCalls:()=>spawnCalls,settled:()=>settled,started:()=>started};
}
async function refused(message,code,options={}){const f=fixture(options);await tick();assert.equal(f.started(),true);f.send(message);const r=await f.pending;assert.deepEqual(r.report.reasonCodes,pair(code));assert.deepEqual(sanitizeNativeReport(r.report,plan()),r.report);assert.equal(f.stopCalls(),1);assert.equal(r.report.verdict,'blocked');assert.ok(r.report.cases.every(row=>row.attempts===0&&row.cleanup.status==='unknown'));assert.equal(f.timers.size,0);return r;}
function noCanary(value,canary){const text=JSON.stringify(value);for(const form of [canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')])assert.equal(text.includes(form),false);}

test('actual serialization and request/result contract handlers emit fixed primary plus exact subtype without offending data',async()=>{
 const canary=randomBytes(24).toString('base64url')+'/+=',cycle={privateValue:canary};cycle.self=cycle;
 for(const value of [cycle,{privateValue:canary,big:1n}])noCanary(await refused(value,C[0]),canary);
 noCanary(await refused({type:'request',id:'rpc-1',request:{type:'assert-owned',privateValue:canary}},C[2]),canary);
 noCanary(await refused({type:'result',report:{privateValue:canary}},C[3]),canary);
 noCanary(await refused({type:'result',report:{...report(),privateValue:canary,reasonCodes:['NATIVE_DRIVER_SESSION_TIMEOUT']}},C[3]),canary);
});
test('UTF8 byte limit remains exact at boundary and above it, independent of character count',async()=>{
 const base=Buffer.byteLength(JSON.stringify({type:'unknown',padding:''}));
 for(const [bytes,code]of [[MAX,C[2]],[MAX+1,C[1]]]){const n=bytes-base,value={type:'unknown',padding:'\u00e9'.repeat(Math.floor(n/2))+'x'.repeat(n%2)};assert.equal(Buffer.byteLength(JSON.stringify(value)),bytes);assert.ok(value.padding.length<bytes);await refused(value,code);}
});
test('valid failed result with active actual callback retains only reported fixed driver codes and joins after stop',async()=>{
 assert.equal(nativeDiagnostic('NATIVE_DRIVER_SESSION_TIMEOUT',IOS_NATIVE_RUNNER).summary,'Native session creation did not finish within its active setup or request budget.');
 assert.equal(nativeDiagnostic('NATIVE_DRIVER_SESSION_TIMEOUT',NATIVE_RUNNER).summary,'Native session creation exceeded its 120-second setup budget.');
 for(const driverCode of ['NATIVE_DRIVER_SESSION_TIMEOUT','NATIVE_DRIVER_FAILED']){
 const gate=Promise.withResolvers();let calls=0,ended=false;const f=fixture({onRequest:async()=>{calls++;await gate.promise;ended=true;return true;}});await tick();f.send({type:'request',id:'rpc-1',request:{type:'assert-owned'}});await tick();f.send({type:'result',report:nativeFailureReport(plan(),driverCode)});await tick();
 assert.equal(f.stopCalls(),1);assert.equal(f.settled(),false);assert.equal(ended,false);assert.ok([...f.timers.values()].some(row=>row.ms===25000));gate.resolve();const r=await f.pending;
 assert.equal(calls,1);assert.equal(ended,true);assert.deepEqual(r.report.reasonCodes,[...pair(C[4]),...(driverCode==='NATIVE_DRIVER_SESSION_TIMEOUT'?[driverCode]:[])]);assert.ok(r.report.cases.every(row=>row.attempts===0&&row.assertionsObserved===0&&row.cleanup.status==='unknown'));assert.deepEqual(sanitizeNativeReport(r.report,plan()),r.report);assert.equal(f.timers.size,0);
 }
});
test('existing25s RPC join expiry and unconfirmed worker stop remain explicit with first subtype retained',async()=>{
 const gate=Promise.withResolvers(),f=fixture({onRequest:()=>gate.promise,stopConfirmed:false});await tick();f.send({type:'request',id:'rpc-1',request:{type:'assert-owned'}});await tick();f.send({type:'result',report:report()});await tick();assert.equal(f.settled(),false);f.fire(25000);const r=await f.pending;
 assert.deepEqual(r.report.reasonCodes,[PRIMARY,C[4],'NATIVE_DRIVER_OWNERSHIP_REFUSED','NATIVE_WORKER_TERMINATION_UNCONFIRMED','NATIVE_WORKER_RPC_UNSETTLED']);assert.deepEqual(sanitizeNativeReport(r.report,plan()),r.report);assert.equal(f.stopCalls(),1);gate.resolve(true);await tick();
});
test('final sanitizer refusal preserves only observed host stop, join-expiry and cancellation outcomes',async()=>{
 const gate=Promise.withResolvers(),controller=new AbortController(),f=fixture({onRequest:()=>gate.promise,stopConfirmed:false,finalReject:true,signal:controller.signal});await tick();f.send({type:'request',id:'rpc-1',request:{type:'assert-owned'}});await tick();f.send({type:'result',report:report()});await tick();controller.abort();f.fire(25000);const r=await f.pending;
 assert.deepEqual(r.report.reasonCodes,[PRIMARY,C[5],'NATIVE_WORKER_TERMINATION_UNCONFIRMED','NATIVE_WORKER_RPC_UNSETTLED','NATIVE_RUN_CANCELLED']);assert.equal(r.report.verdict,'cancelled');assert.ok(r.report.cases.every(row=>!Object.hasOwn(row,'requestFailure')&&row.cleanup.status==='unknown'));assert.deepEqual(sanitizeNativeReport(r.report,plan()),r.report);gate.resolve(true);await tick();
});
test('late competing bad messages and close events cannot replace the first refusal subtype',async()=>{
 const gate=Promise.withResolvers(),f=fixture({onRequest:()=>gate.promise});await tick();f.send({type:'request',id:'rpc-1',request:{type:'assert-owned'}});await tick();f.send({type:'result',report:report()});await tick();f.send({type:'unexpected'});f.send({type:'result',report:{bad:true}});f.close(23);gate.resolve(true);const r=await f.pending;assert.deepEqual(r.report.reasonCodes,[...pair(C[4]),'NATIVE_DRIVER_OWNERSHIP_REFUSED']);assert.equal(f.stopCalls(),1);
});
test('every reserved subtype forged in a worker reason or case diagnostic becomes RESULT_CONTRACT instead',async()=>{
 for(const code of C){const forged=appendNativeRunFailure(appendNativeRunFailure(nativeFailureReport(plan(),PRIMARY),code),'NATIVE_DRIVER_SESSION_TIMEOUT');await refused({type:'result',report:forged},C[3]);const nested=report();nested.cases[0].reason=code;nested.cases[0].diagnostics=[nativeDiagnostic(code,IOS_NATIVE_RUNNER)];await refused({type:'result',report:nested},C[3]);}
});
test('shared sanitizer requires primary first, at most one subtype and no case subtype; legacy generic-alone remains valid',()=>{
 for(const code of C){const canonical=appendNativeRunFailure(nativeFailureReport(plan(),PRIMARY),code);assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(canonical)),plan()),canonical);assert.throws(()=>sanitizeNativeReport(nativeFailureReport(plan(),code),plan()));assert.throws(()=>sanitizeNativeReport(appendNativeRunFailure(report(),code),plan()));const reversed=structuredClone(canonical);reversed.reasonCodes.reverse();reversed.diagnostics.reverse();assert.throws(()=>sanitizeNativeReport(reversed,plan()));}
 const many=appendNativeRunFailure(appendNativeRunFailure(nativeFailureReport(plan(),PRIMARY),C[0]),C[1]);assert.throws(()=>sanitizeNativeReport(many,plan()));const legacy=nativeFailureReport(plan(),PRIMARY);assert.deepEqual(sanitizeNativeReport(legacy,plan()),legacy);
});
test('normal pass and nonprotocol worker timeout/output/failure paths acquire no subtype',async()=>{
 const f=fixture();await tick();const pass=report();pass.reasonCodes=[];pass.diagnostics=[];pass.verdict='passed';for(const row of pass.cases){row.status='passed';row.reason='NATIVE_CASE_PASSED';row.attempts=1;row.bodyAssertionsObserved=1;row.cleanupAssertionsObserved=row.cleanup.required?1:0;row.assertionsObserved=1+row.cleanupAssertionsObserved;row.cleanup.status=row.cleanup.required?'completed':'not-required';row.diagnostics=[];}f.send({type:'result',report:pass});f.close(0);assert.deepEqual((await f.pending).report,pass);
 for(const mode of ['timeout','output','failure']){const h=fixture();await tick();if(mode==='timeout')h.fire(600000);else if(mode==='output')h.child.stdout.emit('data',Buffer.alloc(MAX+1));else h.child.emit('error',Error('synthetic'));const r=await h.pending;assert.deepEqual(r.report.reasonCodes,[mode==='timeout'?'NATIVE_WORKER_TIMEOUT':mode==='output'?'NATIVE_WORKER_OUTPUT_LIMIT':'NATIVE_WORKER_FAILED']);}
});
test('normal completion cancellation still removes iOS request facts without fabricating protocol diagnostics',async()=>{
 const controller=new AbortController(),f=fixture({signal:controller.signal});await tick();const failed=report();failed.reasonCodes=[];failed.diagnostics=[];failed.verdict='failed';const row=failed.cases[0];row.status='failed';row.reason='NATIVE_BODY_FAILED';row.attempts=1;row.bodyAssertionsObserved=0;row.cleanupAssertionsObserved=1;row.assertionsObserved=1;row.cleanup.status='completed';row.diagnostics=['NATIVE_BODY_FAILED','NATIVE_DRIVER_COMMAND_FAILED'].map(code=>nativeDiagnostic(code,IOS_NATIVE_RUNNER));row.requestFailure={stage:'body',operation:'element-find',phase:'http'};assert.deepEqual(sanitizeNativeReport(failed,plan()),failed);
 f.send({type:'result',report:failed});controller.abort();f.close(0);const r=await f.pending;assert.deepEqual(r.report.reasonCodes,['NATIVE_RUN_CANCELLED']);assert.equal(r.report.verdict,'cancelled');assert.equal(Object.hasOwn(r.report.cases[0],'requestFailure'),false);assert.deepEqual(sanitizeNativeReport(r.report,plan()),r.report);
});
test('public iOS and Android phase projections roundtrip canonical host subtype reports without widening top-level codes',async()=>{
 const parent=await realpath(os.tmpdir()),temporary=await mkdtemp(path.join(parent,'testlane-protocol-subtypes-')),canonical=await realpath(temporary);assert.equal(path.dirname(canonical),parent);
 try{for(const runner of [IOS_NATIVE_RUNNER,NATIVE_RUNNER])for(const [index,code]of C.entries()){const output=path.join(canonical,(runner===IOS_NATIVE_RUNNER?'ios':'android')+'-'+index);await mkdir(output);const p=plan(runner),value=appendNativeRunFailure(nativeFailureReport(p,PRIMARY),code);await writeFile(path.join(output,'plan.json'),JSON.stringify(p));await writeFile(path.join(output,'positive.json'),JSON.stringify(value));const error=Object.assign(Error('synthetic'),{code:'ERR_ASSERTION'}),summary=await(runner===IOS_NATIVE_RUNNER?publicIosFailure:publicAndroidFailure)({output,stage:'positive',error});assert.equal(summary.reports.length,1);assert.deepEqual(summary.reports[0],{phase:'positive',...value});if(runner===NATIVE_RUNNER)assert.deepEqual(projectPublicAndroidFailure(JSON.parse(JSON.stringify(summary))),summary);const fake=await(runner===IOS_NATIVE_RUNNER?publicIosFailure:publicAndroidFailure)({output,stage:'positive',error:Error(code)});assert.equal(fake.code,runner===IOS_NATIVE_RUNNER?'IOS_PROOF_FAILED':'ANDROID_PROOF_FAILED');}}
 finally{const resolved=await realpath(temporary);assert.equal(resolved,canonical);assert.equal(path.dirname(resolved),parent);await rm(resolved,{recursive:true,force:false,maxRetries:3,retryDelay:50});}
});
