/** Fixed setup diagnostics only; logical clocks and disposable module copies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeDriver, NativeDriverError, readIosSetupOwnership } from '../driver.mjs';
import { verifyInstalledIosReadiness, iosProofDriverOptions } from '../readiness.mjs';
import { stabilizeIosSetupOwnership, readIosSetupOwnershipResult } from '../setup-ownership.mjs';
import { normalizeIosSetupOwnership, readIosOwnershipGuardFailure, tagIosCommandFailure } from '../failure-facts.mjs';
const device=()=>{const deviceBinding={schemaVersion:1,scope:'ephemeral-hosted-standard-device-set',nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-fixture',udid:'FA001122-3344-5566-7788-9900AABBCCDD',nonce:'a'.repeat(24)};return{deviceBinding,udid:deviceBinding.udid,deviceSetPath:deviceBinding.deviceSetPath,derivedDataPath:deviceBinding.privateRoot+'/derived-data',serverUrl:'http://127.0.0.1:4723',wdaPort:8211,mjpegPort:8212};};
const fact=(patch={})=>({status:'refused',elapsedMs:0,callbackStarted:true,callbackSettled:true,guardCode:'unavailable',commandKind:'not-recorded',...patch});
function harness(t){
  let now=0,expire;const routes=[],original=setTimeout;
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms===20000)expire=fn;return original(fn,ms,...args);});
  t.mock.method(globalThis,'fetch',async(url,options)=>{routes.push([options.method,new URL(url).pathname]);return new Response(JSON.stringify({value:new URL(url).pathname==='/session'?{sessionId:'owned-session'}:'NATIVE_APP'}));});
  return{routes,setNow:value=>{now=value;},expire:()=>{assert.equal(typeof expire,'function');expire();}};
}
function absent(value,secret){for(const variant of[secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')])assert.equal(JSON.stringify(value).includes(variant),false);}

test('fixed guard classifier retains known code/kind and refuses raw, accessor and proxy rejection data',()=>{
  const error=tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),'owned-device-list');
  assert.deepEqual(readIosOwnershipGuardFailure(error),{guardCode:'IOS_COMMAND_TIMEOUT',commandKind:'owned-device-list'});
  let invoked=0;const hostile=Error();Object.defineProperty(hostile,'message',{get(){invoked++;throw Error();}});
  for(const input of[hostile,new Proxy(Error('IOS_OWNERSHIP_REFUSED'),{get(){invoked++;throw Error();},getOwnPropertyDescriptor(){invoked++;throw Error();}}),{message:'IOS_OWNERSHIP_REFUSED'},Error(randomBytes(20).toString('hex'))])assert.deepEqual(readIosOwnershipGuardFailure(input),{guardCode:'unavailable',commandKind:'not-recorded'});
  assert.equal(invoked,0);
});

test('six-field schema admits only complete fixed own data without invoking hostile values',()=>{
  const valid=fact();assert.deepEqual(normalizeIosSetupOwnership(valid),valid);assert.equal(Object.isFrozen(normalizeIosSetupOwnership(valid)),true);
  let invoked=0;const getter={...valid};Object.defineProperty(getter,'status',{get(){invoked++;return'refused';}});
  for(const invalid of[getter,new Proxy(valid,{ownKeys(){invoked++;throw Error();}}),{...valid,extra:true},{...valid,[Symbol()]:true},{...valid,status:'completed'},{...valid,elapsedMs:NaN},{...valid,elapsedMs:Infinity},{...valid,elapsedMs:.5},{...valid,elapsedMs:-1},{...valid,callbackStarted:false},{...valid,guardCode:'unknown'},{...valid,commandKind:'arbitrary'},{...valid,callbackSettled:false,guardCode:'IOS_COMMAND_TIMEOUT'}])assert.equal(normalizeIosSetupOwnership(invalid),undefined);
  assert.equal(invoked,0);
});

test('helper preserves its legacy result shape and snapshots settled rejection versus nonpositive return',async t=>{
  harness(t);
  for(const [callback,expected]of[[()=>false,fact()],[()=>undefined,fact()],[()=>{throw tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),'owned-device-list');},fact({guardCode:'IOS_COMMAND_TIMEOUT',commandKind:'owned-device-list'})],[()=>Promise.reject(tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),'owned-device-list')),fact({guardCode:'IOS_COMMAND_TIMEOUT',commandKind:'owned-device-list'})]]){
    const result=await stabilizeIosSetupOwnership({assertOwned:callback,deadline:240000});assert.deepEqual(result,{status:'refused',completed:false,elapsedMs:0});assert.deepEqual(readIosSetupOwnershipResult(result),expected);
  }
  const completed=await stabilizeIosSetupOwnership({assertOwned:()=>true,deadline:240000});assert.deepEqual(completed,{status:'completed',completed:true,elapsedMs:0});assert.equal(readIosSetupOwnershipResult(completed),undefined);assert.equal(readIosSetupOwnershipResult({...completed}),undefined);
});

test('pending timeout snapshot cannot be changed by a late rejected guard or true acknowledgement',async t=>{
  const h=harness(t);
  for(const late of['true','reject']){
    h.setNow(0);const entered=Promise.withResolvers(),gate=Promise.withResolvers();const pending=stabilizeIosSetupOwnership({deadline:240000,assertOwned:()=>{entered.resolve();return gate.promise;}});
    await entered.promise;h.setNow(20000);h.expire();const result=await pending,snapshot=readIosSetupOwnershipResult(result);assert.deepEqual(snapshot,fact({status:'timeout',elapsedMs:20000,callbackSettled:false}));
    if(late==='true')gate.resolve(true);else gate.reject(tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),'owned-device-list'));await Promise.resolve();await Promise.resolve();assert.deepEqual(readIosSetupOwnershipResult(result),snapshot);assert.equal(Object.isFrozen(snapshot),true);
  }
});

test('late settled success and pre-cancelled wait retain honest failure observations without changing setup caps',async t=>{
  const h=harness(t);const result=await stabilizeIosSetupOwnership({deadline:240000,assertOwned:()=>{h.setNow(20000.25);return true;}});assert.deepEqual(readIosSetupOwnershipResult(result),fact({status:'timeout',elapsedMs:20000}));
  const controller=new AbortController();controller.abort();const cancelled=await stabilizeIosSetupOwnership({deadline:240000,signal:controller.signal,assertOwned:()=>assert.fail('pre-cancelled callback')});assert.deepEqual(readIosSetupOwnershipResult(cancelled),fact({status:'cancelled',callbackStarted:false,callbackSettled:false}));
});

test('actual factory emits a private setup fact only after validated session creation; JSON readiness preserves it',async t=>{
  const h=harness(t);let owners=0,error,controls;const reject=()=>{if(++owners===2)throw Error('IOS_LISTENER_BINDING_REFUSED');return true;};
  await assert.rejects(createNativeDriver({...iosProofDriverOptions(device()),assertOwned:reject}),caught=>{error=caught;return caught.code==='NATIVE_DRIVER_OWNERSHIP_REFUSED';});assert.deepEqual(readIosSetupOwnership(error),fact({guardCode:'IOS_LISTENER_BINDING_REFUSED'}));assert.deepEqual(h.routes,[['POST','/session']]);assert.equal(owners,2);
  owners=0;h.routes.length=0;await assert.rejects(verifyInstalledIosReadiness({createNativeDriver,driverOptions:iosProofDriverOptions(device()),assertOwned:reject,appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{controls=value;}}),{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED'});
  assert.deepEqual(JSON.parse(JSON.stringify(controls)),{schemaVersion:1,purpose:'credential-free-fixed-controls',completed:false,sessionCleanupAcknowledged:false,steps:[],setupFailure:{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED',setupOwnership:fact({guardCode:'IOS_LISTENER_BINDING_REFUSED'})}});assert.equal(owners,2);assert.deepEqual(h.routes,[['POST','/session']]);
});

test('actual factory timeout/cancellation snapshots stay pending and never enqueue context, fresh guards or DELETE after late ACK',async t=>{
  const h=harness(t);
  for(const mode of['timeout','cancelled']){
    h.setNow(0);h.routes.length=0;let owners=0,error;const entered=Promise.withResolvers(),gate=Promise.withResolvers(),controller=new AbortController();
    const pending=assert.rejects(createNativeDriver({...iosProofDriverOptions(device()),signal:controller.signal,assertOwned:()=>{if(++owners===2){entered.resolve();return gate.promise;}return true;}}),caught=>{error=caught;return caught.code===(mode==='timeout'?'NATIVE_DRIVER_OWNERSHIP_REFUSED':'NATIVE_DRIVER_CANCELLED');});
    await entered.promise;if(mode==='timeout'){h.setNow(20000);h.expire();}else controller.abort();await pending;const snapshot=readIosSetupOwnership(error);assert.deepEqual(snapshot,fact({status:mode,elapsedMs:mode==='timeout'?20000:0,callbackSettled:false}));gate.resolve(true);await Promise.resolve();await Promise.resolve();assert.deepEqual(readIosSetupOwnership(error),snapshot);assert.equal(owners,2);assert.deepEqual(h.routes,[['POST','/session']]);
  }
});

test('original overall startup deadline and ordinary request refusal retain their existing error and fact boundaries',async t=>{
  const h=harness(t);let owners=0,error;
  await assert.rejects(createNativeDriver({...iosProofDriverOptions(device()),assertOwned:()=>{if(++owners===2){h.setNow(240001);return true;}return true;}}),caught=>{error=caught;return caught.code==='NATIVE_DRIVER_SESSION_TIMEOUT';});assert.deepEqual(readIosSetupOwnership(error),fact({status:'timeout',elapsedMs:240001}));assert.deepEqual(h.routes,[['POST','/session']]);
  h.setNow(0);h.routes.length=0;await assert.rejects(createNativeDriver({...iosProofDriverOptions(device()),assertOwned:()=>{throw Error('IOS_OWNERSHIP_REFUSED');}}),caught=>{assert.equal(readIosSetupOwnership(caught),undefined);return caught.code==='NATIVE_DRIVER_OWNERSHIP_REFUSED';});assert.deepEqual(h.routes,[]);
  const forged=new NativeDriverError('NATIVE_DRIVER_OWNERSHIP_REFUSED');Object.defineProperty(forged,'setupOwnership',{value:fact()});assert.equal(readIosSetupOwnership(forged),undefined);assert.equal(readIosSetupOwnership(new Proxy(error,{})),undefined);assert.equal(readIosSetupOwnership(Object.setPrototypeOf(Error(),NativeDriverError.prototype)),undefined);
});

test('copied installed-module readiness transports only the real branded fixed snapshot, with unchanged public failure shape',async t=>{
  const h=harness(t),parent=await realpath(os.tmpdir()),temp=await mkdtemp(path.join(parent,'tld-setup-facts-')),sourceRoot=fileURLToPath(new URL('../../../',import.meta.url));
  try{
    for(const file of['examples/ios-verification/driver.mjs','examples/ios-verification/readiness.mjs','examples/ios-verification/preauth-controls.mjs','examples/ios-verification/device-scope.mjs','examples/ios-verification/setup-ownership.mjs','examples/ios-verification/failure.mjs','examples/ios-verification/failure-facts.mjs','examples/android-verification/contracts.mjs','examples/android-verification/proof-cases.mjs','examples/android-verification/driver-phase.mjs']){const target=path.join(temp,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,await readFile(path.join(sourceRoot,file)));}
    const installed=await import(pathToFileURL(path.join(temp,'examples/ios-verification/driver.mjs'))),readiness=await import(pathToFileURL(path.join(temp,'examples/ios-verification/readiness.mjs'))),failure=await import(pathToFileURL(path.join(temp,'examples/ios-verification/failure.mjs')));let owners=0,controls,error;
    await assert.rejects(readiness.verifyInstalledIosReadiness({createNativeDriver:installed.createNativeDriver,driverOptions:iosProofDriverOptions(device()),assertOwned:()=>{if(++owners===2)throw tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),'owned-device-list');return true;},appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{controls=value;}}),caught=>{error=caught;return true;});
    assert.deepEqual(controls.setupFailure.setupOwnership,fact({guardCode:'IOS_COMMAND_TIMEOUT',commandKind:'owned-device-list'}));assert.equal(Object.isFrozen(controls.setupFailure.setupOwnership),true);assert.equal(readIosSetupOwnership(error),undefined);assert.deepEqual(await failure.publicIosFailure({output:temp,stage:'wda-readiness',error}),{schemaVersion:1,status:'failed',stage:'wda-readiness',code:'NATIVE_DRIVER_OWNERSHIP_REFUSED',reports:[]});assert.deepEqual(h.routes,[['POST','/session']]);
    const secret=randomBytes(24).toString('base64url')+'/+=';let seen;const injected=new installed.NativeDriverError('NATIVE_DRIVER_OWNERSHIP_REFUSED');Object.defineProperty(injected,'setupOwnership',{value:{...fact(),extra:secret}});
    await assert.rejects(readiness.verifyInstalledIosReadiness({createNativeDriver:async()=>{throw injected;},driverOptions:iosProofDriverOptions(device()),assertOwned:()=>true,appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{seen=value;}}));assert.deepEqual(seen.setupFailure,{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED'});absent(seen,secret);
  }finally{assert.match(path.basename(temp),/^tld-setup-facts-/);assert.equal(path.dirname(temp),parent);assert.equal(await realpath(temp),temp);await rm(temp,{recursive:true,force:false,maxRetries:5,retryDelay:100});}
});


test('successful setup and ordinary HTTP/context failures never acquire setup ownership metadata',async t=>{
  const h=harness(t);let owners=0;
  const driver=await createNativeDriver({...iosProofDriverOptions(device()),assertOwned:()=>{owners++;return true;}});assert.equal(driver.context,'NATIVE_APP');assert.equal(owners,3);await driver.close();assert.equal(owners,4);assert.deepEqual(h.routes,[['POST','/session'],['GET','/session/owned-session/context'],['DELETE','/session/owned-session']]);
  for(const mode of['http','context']){
    const routes=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const route=new URL(url).pathname;routes.push([options.method,route]);const value=route==='/session'?(mode==='http'?{error:'unknown error'}:{sessionId:'owned-session'}):null;return new Response(JSON.stringify({value}),{status:mode==='http'?500:200});});
    let controls;await assert.rejects(verifyInstalledIosReadiness({createNativeDriver,driverOptions:iosProofDriverOptions(device()),assertOwned:()=>true,appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{controls=value;}}),error=>{assert.equal(readIosSetupOwnership(error),undefined);return error.code===(mode==='http'?'NATIVE_DRIVER_COMMAND_FAILED':'NATIVE_DRIVER_CONTEXT_REFUSED');});assert.equal(Object.hasOwn(controls.setupFailure,'setupOwnership'),false);
    assert.deepEqual(routes,mode==='http'?[['POST','/session']]:[['POST','/session'],['GET','/session/owned-session/context'],['DELETE','/session/owned-session']]);
  }
});
