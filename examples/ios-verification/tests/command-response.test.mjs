/** Inert fetch/retained-response fixtures only; no native service or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import vm from 'node:vm';
import {createNativeDriver,NativeDriverError,normalizeIosCommandResponse,readIosCommandResponse,readIosRequestFailure} from '../driver.mjs';
import {verifyInstalledIosReadiness} from '../readiness.mjs';
import {probeIosPreauthControls} from '../preauth-controls.mjs';
import {publicIosFailure} from '../failure.mjs';
import {IOS_DEVICE_SCOPE} from '../device-scope.mjs';
import {runNativeCases} from '../../android-verification/runner.mjs';
import {validateNativePlan,sanitizeNativeReport} from '../../android-verification/contracts.mjs';

const harnessSource=await readFile(new URL('./action-envelope.test.mjs',import.meta.url),'utf8');
const start='const binding = () =>',end='import { runNativeCases }';
assert.equal(harnessSource.split(start).length,2);assert.equal(harnessSource.split(end).length,2);
const {harness,binding}=vm.compileFunction(harnessSource.slice(harnessSource.indexOf(start),harnessSource.indexOf(end))+';return {harness,binding};',
 ['assert','randomBytes','createNativeDriver','IOS_DEVICE_SCOPE'])(assert,randomBytes,createNativeDriver,IOS_DEVICE_SCOPE);
const snapshot=(patch={})=>({httpStatus:500,responseState:'json-decoded',w3cError:'unknown-error',proxyCategory:'unmatched',...patch});
const prefix='Could not proxy command to the remote server. Original error: ';
function absent(value,canary){for(const text of [canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')])assert.equal(JSON.stringify(value).includes(text),false);}

async function failedFocus(t,{mode='decoded',status=500,error='unknown error',message,raw,value,signal,onRead,onFetch}={}){
 const h=harness(t),driver=await h.create({signal}),canary=randomBytes(24).toString('base64url')+'/+=',originals=[];let controls,failed;
 h.owner(()=>{h.advance(10);return true;});
 h.http(route=>{
  if(!route.endsWith('/click'))return;
  h.advance(5059);const changed=onFetch?.({h,driver});if(changed!==undefined)return changed;
  if(mode==='reader')return{ok:true,status:200,body:{getReader:()=>({async read(){onRead?.();throw Error(canary);}})}};
  if(raw!==undefined)return new Response(raw,{status});
  return h.json(value===undefined?{error,message:message??canary}:value,status);
 });
 const watched={...driver,async click(id){try{return await driver.click(id);}catch(caught){originals.push(caught);throw caught;}}};
 try{await verifyInstalledIosReadiness({createNativeDriver:async()=>watched,driverOptions:{deviceBinding:binding()},assertOwned:()=>true,appPrewarmed:true,preauthControls:true,signal,onPreauthControls:value=>{controls=value;}});}catch(caught){failed=caught;}
 assert.ok(failed);assert.equal(controls.completed,false);assert.equal(controls.sessionCleanupAcknowledged,false);assert.equal(controls.steps.length,9);
 assert.ok(controls.steps.slice(0,8).every(row=>row.completed&&row.step==='visibility'));
 const row=controls.steps[8];assert.equal(row.controlId,'quantity');assert.equal(row.step,'focus');assert.equal(row.completed,false);
 assert.equal(h.routes.filter(row=>row.route.endsWith('/click')).length,1);assert.equal(h.routes.some(row=>row.method==='DELETE'),false);
 const index=h.routes.findIndex(row=>row.route.endsWith('/click'));assert.deepEqual(h.routes.slice(index-3,index).map(row=>row.route.split('/').at(-1)),['context','element','displayed']);
 const beforeRoutes=h.routes.length,beforeOwners=h.ownerCount();await assert.rejects(driver.close(),{code:'NATIVE_DRIVER_REMOTE_UNSETTLED'});assert.equal(h.routes.length,beforeRoutes);assert.equal(h.ownerCount(),beforeOwners);assert.equal(h.timers.size,0);
 absent(controls,canary);absent(failed.stack,canary);
 return{h,driver,row,controls,failed,original:originals[0],canary};
}

test('actual driver and readiness distinguish decoded HTTP/W3C errors from a post-header reader rejection',async t=>{
 const outputs=[];
 for(const options of [{status:500},{status:200},{mode:'reader'}]){
  const result=await failedFocus(t,options);assert.equal(result.failed.code,'NATIVE_DRIVER_COMMAND_FAILED');
  assert.deepEqual(result.row.request,{operation:'click',phase:'response'});
  assert.deepEqual(result.row.requestProgress,{ownershipElapsedMs:10,effectiveHttpBudgetMs:10000,httpBodyElapsedMs:5059,budgetSource:'http-body',fetchInvoked:true,responseHeadersObserved:true});
  const expected=options.mode==='reader'?snapshot({httpStatus:200,responseState:'body-reading',w3cError:'unavailable'}):snapshot({httpStatus:options.status});
  assert.deepEqual(result.row.commandResponse,expected);assert.deepEqual(readIosCommandResponse(result.original),expected);assert.ok(Object.isFrozen(result.row.commandResponse));
  assert.equal(readIosCommandResponse(result.failed),undefined,'readiness wrapper deliberately does not export a private transfer API');
  outputs.push(result.row.commandResponse);
 }
 assert.notDeepEqual(outputs[0],outputs[1]);assert.notDeepEqual(outputs[1],outputs[2]);
});

test('malformed JSON, malformed envelope and non-null semantic results preserve primary refusal and exact parse boundary',async t=>{
 for(const [options,state,w3c]of [[{status:200,raw:'{'},'body-ended','unavailable'],[{status:200,raw:'{"other":true}'},'json-decoded','unavailable'],[{status:200,value:{unexpected:true}},'json-decoded','none']]){
  const result=await failedFocus(t,options);assert.equal(result.failed.code,'NATIVE_DRIVER_RESPONSE_INVALID');
  assert.deepEqual(result.row.commandResponse,snapshot({httpStatus:200,responseState:state,w3cError:w3c}));
 }
});

test('only the complete bounded pinned proxy prefix plus exact5000 literal produces the timeout signature bucket',async t=>{
 for(const [message,proxyCategory]of [[prefix+'timeout of 5000ms exceeded','downstream-5000-timeout-signature'],
  [prefix+'another fixed transport problem','downstream-proxy-signature'],[prefix+'timeout of 30000ms exceeded','downstream-proxy-signature'],
  ['timeout of 5000ms exceeded','unmatched'],['Could not proxy command to the remote server. timeout of 5000ms exceeded','unmatched'],[false,'unmatched'],[{toString:'not callable'},'unmatched']]){
  const result=await failedFocus(t,{message});assert.equal(result.failed.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.equal(result.row.commandResponse.proxyCategory,proxyCategory);
 }
});

test('decoded W3C codes use closed buckets and arbitrary or encoded values stay out of retained facts',async t=>{
 for(const [code,bucket]of [['stale element reference','stale-element-reference'],['element not interactable','element-not-interactable'],['invalid element state','invalid-element-state'],['no such element','no-such-element'],['invalid argument','invalid-argument'],['timeout','timeout'],['constructor','other'],[17,'other']]){
  const result=await failedFocus(t,{error:code});assert.equal(result.row.commandResponse.w3cError,bucket);
 }
 const canary=randomBytes(24).toString('base64url')+'/+=';
 for(const form of [canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')]){
  const result=await failedFocus(t,{error:form,message:prefix+form});assert.equal(result.row.commandResponse.w3cError,'other');assert.equal(result.row.commandResponse.proxyCategory,'downstream-proxy-signature');absent(result.controls,canary);
 }
});

test('normalizer refuses hostile own-data shapes and impossible nondecoded attribution without accessing getters or proxies',()=>{
 let touched=0;const getter=snapshot();Object.defineProperty(getter,'httpStatus',{enumerable:true,get(){touched++;throw Error();}});
 const proxy=new Proxy(snapshot(),{get(){touched++;throw Error();},ownKeys(){touched++;throw Error();},getPrototypeOf(){touched++;throw Error();}});
 const revoked=Proxy.revocable(snapshot(),{});revoked.revoke();
 for(const value of [null,[],Object.create(null),getter,proxy,revoked.proxy,{...snapshot(),[Symbol('extra')]:true},{...snapshot(),extra:'synthetic'},
  snapshot({httpStatus:NaN}),snapshot({httpStatus:Infinity}),snapshot({httpStatus:500.5}),snapshot({httpStatus:'500'}),snapshot({httpStatus:99}),snapshot({httpStatus:600}),
  snapshot({responseState:'unknown'}),snapshot({w3cError:'unknown'}),snapshot({proxyCategory:'unknown'}),snapshot({responseState:'not-observed'}),
  snapshot({responseState:'body-reading'}),snapshot({responseState:'body-ended',w3cError:'unavailable',proxyCategory:'downstream-proxy-signature'}),snapshot({w3cError:'unavailable',proxyCategory:'downstream-5000-timeout-signature'})])assert.equal(normalizeIosCommandResponse(value),undefined);
 const input=snapshot(),fixed=normalizeIosCommandResponse(input);input.httpStatus=400;assert.equal(fixed.httpStatus,500);assert.ok(Object.isFrozen(fixed));assert.equal(touched,0);
});

test('only the driver-created WeakMap fact is readable; forged properties, classes and proxy/accessor errors supply none',async t=>{
 const result=await failedFocus(t);let touched=0;
 const request={operation:'click',phase:'response'},forged=new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',request);
 Object.defineProperty(forged,'commandResponse',{get(){touched++;throw Error();}});
 const original=result.original,propertyCopy=Object.assign(new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',request),{commandResponse:snapshot()});
 class Other extends NativeDriverError{}
 for(const value of [forged,propertyCopy,new Other('NATIVE_DRIVER_COMMAND_FAILED',request),Object.assign(Error(),{requestFailure:request,commandResponse:snapshot()}),new Proxy(original,{get(){touched++;throw Error();},getPrototypeOf(){touched++;throw Error();}})])assert.equal(readIosCommandResponse(value),undefined);
 assert.equal(touched,0);assert.deepEqual(readIosCommandResponse(original),snapshot());
});

test('a genuine fixed response is exported only from the failed quantity/focus click row',async t=>{
 const result=await failedFocus(t),original=result.original;
 for(const phase of ['visibility','keyboard']){
  const rows=[],driver={async scrollIntoView(){if(phase==='visibility')throw original;},async click(){},async hideKeyboard(){throw original;}};
  await assert.rejects(probeIosPreauthControls({driver,onStep:row=>rows.push(row)}));assert.equal(Object.hasOwn(rows.at(-1),'commandResponse'),false);
 }
 const rows=[],fake={async scrollIntoView(){},async click(){throw new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',{operation:'click',phase:'response'});},async hideKeyboard(){}};
 await assert.rejects(probeIosPreauthControls({driver:fake,onStep:row=>rows.push(row)}));assert.equal(Object.hasOwn(rows.at(-1),'commandResponse'),false);
});

test('cancellation after headers freezes the first body-reading fact and a late reader settlement cannot rewrite it',async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers(),controller=new AbortController();let saved;
 const pending=failedFocus(t,{signal:controller.signal,onFetch:()=>({ok:true,status:200,body:{getReader:()=>({read(){entered.resolve();return gate.promise;}})}})});
 await entered.promise;controller.abort();const result=await pending;saved=result.row.commandResponse;
 assert.equal(result.failed.code,'NATIVE_DRIVER_CANCELLED');assert.deepEqual(saved,snapshot({httpStatus:200,responseState:'body-reading',w3cError:'unavailable'}));assert.ok(Object.isFrozen(saved));
 gate.resolve({done:true});await Promise.resolve();assert.deepEqual(readIosCommandResponse(result.original),saved);assert.deepEqual(result.row.commandResponse,saved);
});

test('cancelled pre-header click and ownership refusal keep their original primary facts and truthful observation state',async t=>{
 const controller=new AbortController(),gate=Promise.withResolvers();
 const cancelled=await failedFocus(t,{signal:controller.signal,onFetch:()=>{controller.abort();return gate.promise;}});
 assert.equal(cancelled.failed.code,'NATIVE_DRIVER_CANCELLED');assert.deepEqual(cancelled.row.request,{operation:'click',phase:'http'});
 assert.deepEqual(cancelled.row.commandResponse,snapshot({httpStatus:0,responseState:'not-observed',w3cError:'unavailable'}));gate.resolve(new Response('{"value":null}'));await Promise.resolve();
 const h=harness(t),driver=await h.create();let controls;
 const wrapped={...driver,async click(id){h.owner(()=>false);return driver.click(id);}};
 await assert.rejects(verifyInstalledIosReadiness({createNativeDriver:async()=>wrapped,driverOptions:{deviceBinding:binding()},assertOwned:()=>true,appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{controls=value;}}),{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED'});
 assert.equal(Object.hasOwn(controls.steps[8],'commandResponse'),false);assert.equal(h.routes.filter(row=>row.route.endsWith('/click')).length,0);
});

test('successful legacy preauth rows, shared reports and top-level public failure never acquire the optional response field',async t=>{
 const h=harness(t),driver=await h.create();h.http(route=>route.endsWith('/is_keyboard_shown')?h.json(false):undefined);let successful;
 await verifyInstalledIosReadiness({createNativeDriver:async()=>driver,driverOptions:{deviceBinding:binding()},assertOwned:()=>true,appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{successful=value;}});
 assert.equal(successful.completed,true);assert.equal(successful.sessionCleanupAcknowledged,true);assert.equal(successful.steps.length,11);assert.ok(successful.steps.every(row=>JSON.stringify(Object.keys(row).sort())===JSON.stringify(['completed','controlId','step'])));
 const result=await failedFocus(t),summary=await publicIosFailure({output:new URL('./absent-command-response-fixture',import.meta.url).pathname,stage:'wda-readiness',error:result.original});
 assert.equal(Object.hasOwn(summary,'commandResponse'),false);assert.deepEqual(summary.requestFailure,{operation:'click',phase:'response'});
 const input=validateNativePlan({schemaVersion:1,runner:'ios-xcuitest',status:'reviewed',title:'Synthetic fixed response scope',target:{baseUrl:'http://127.0.0.1:4555',environment:'testing'},app:{bundleId:'dev.testlane.iosproof',buildSha256:'a'.repeat(64)},cases:[{id:'only',title:'A failed semantic action remains nonpassing',expected:['The action result is confirmed'],cleanup:{required:true,description:'Remove owned state'}}]});
 const report=await runNativeCases({plan:input,cases:[{id:'only',run(){throw result.original;},cleanup(){assert.fail('remote uncertainty cannot run cleanup');}}]});
 assert.equal(report.verdict,'blocked');assert.equal(report.cases[0].cleanup.status,'unknown');assert.deepEqual(sanitizeNativeReport(JSON.parse(JSON.stringify(report)),input),report);assert.equal(JSON.stringify(report).includes('commandResponse'),false);
});
