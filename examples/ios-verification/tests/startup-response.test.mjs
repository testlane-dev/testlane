import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createNativeDriver,NativeDriverError,normalizeIosStartupResponse,readIosStartupResponse,readIosRequestProgress} from '../driver.mjs';
import {verifyInstalledIosReadiness} from '../readiness.mjs';

const binding=()=>({schemaVersion:1,scope:'ephemeral-hosted-standard-device-set',nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-example',udid:'FA001122-3344-5566-7788-9900AABBCCDD',nonce:'a'.repeat(24)});
const caps=()=>({platformName:'iOS','appium:automationName':'XCUITest','appium:udid':binding().udid,'appium:bundleId':'dev.testlane.iosproof','appium:simulatorDevicesSetPath':binding().deviceSetPath,'appium:derivedDataPath':binding().privateRoot+'/derived-data','appium:wdaLocalPort':8211,'appium:wdaRemotePort':8211,'appium:mjpegServerPort':8212,'appium:wdaBindingIP':'127.0.0.1','appium:wdaBaseUrl':'http://127.0.0.1','appium:skipLogCapture':true,'appium:showIOSLog':false,'appium:showXcodeLog':false,'appium:printPageSourceOnFindFailure':false,'appium:disableAutomaticScreenshots':true,'appium:shutdownOtherSimulators':false,'appium:resetLocationService':false,'appium:noReset':true});
const request={operation:'session-create',phase:'response'};
const snapshot=(patch={})=>({httpStatus:500,responseState:'json-decoded',w3cError:'unknown-error',startupCategory:'unmatched',...patch});
function absent(value,canary){const text=JSON.stringify(value);for(const variant of [canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')])assert.equal(text.includes(variant),false);}
async function serverFixture(reply){
  const sockets=new Set(),calls=[];let response;
  const server=createServer(async(req,res)=>{for await(const _ of req){}calls.push({method:req.method,path:req.url});response=res;reply(req,res);});
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{url:'http://127.0.0.1:'+server.address().port,calls,destroyResponse:()=>response?.destroy(),async close(){const closed=new Promise(resolve=>server.close(resolve));const ended=[...sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();}));await Promise.all([closed,...ended]);assert.equal(server.listening,false);assert.equal(sockets.size,0);}};
}
async function failedReadiness(t,{status=500,value,raw,resetBody=false,runtime={createNativeDriver,verifyInstalledIosReadiness},onHeaders,signal}={}){
  const fixture=await serverFixture((_req,res)=>{res.writeHead(status,{'Content-Type':'application/json'});if(resetBody){res.write('{"value":');return;}res.end(raw??JSON.stringify({value}));});
  const original=globalThis.fetch;let observation,error;let mock;
  if(resetBody||onHeaders)mock=t.mock.method(globalThis,'fetch',async(...args)=>{const response=await original(...args);onHeaders?.();if(resetBody)setImmediate(()=>fixture.destroyResponse());return response;});
  try{
    await assert.rejects(runtime.verifyInstalledIosReadiness({createNativeDriver:runtime.createNativeDriver,driverOptions:{url:fixture.url,deviceBinding:binding(),capabilities:caps()},assertOwned:()=>true,appPrewarmed:true,preauthControls:true,signal,onPreauthControls:value=>{observation=value;}}),caught=>{error=caught;return true;});
    assert.equal(observation.completed,false);assert.equal(observation.sessionCleanupAcknowledged,false);assert.deepEqual(observation.steps,[]);assert.equal(Object.isFrozen(observation.setupFailure),true);
    assert.deepEqual(fixture.calls,[{method:'POST',path:'/session'}]);return{error,observation};
  }finally{try{mock?.mock.restore();}finally{await fixture.close();}}
}

test('actual incomplete HTTP body differs from a complete parsed server rejection',async t=>{
  const reset=await failedReadiness(t,{resetBody:true});assert.equal(reset.error.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.deepEqual(reset.observation.setupFailure.startupResponse,snapshot({responseState:'body-reading',w3cError:'unavailable'}));
  const canary=randomBytes(24).toString('base64url')+'/+=';
  const parsed=await failedReadiness(t,{value:{error:'unknown error',message:canary}});assert.equal(parsed.error.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.deepEqual(parsed.observation.setupFailure.startupResponse,snapshot());
  for(const result of [reset,parsed]){assert.deepEqual(result.observation.setupFailure.request,request);assert.deepEqual(readIosStartupResponse(result.error),result.observation.setupFailure.startupResponse);assert.equal(Object.isFrozen(result.observation.setupFailure.startupResponse),true);assert.deepEqual(readIosRequestProgress(result.error),result.observation.setupFailure.requestProgress);assert.equal(result.observation.setupFailure.requestProgress.responseHeadersObserved,true);absent(result.observation,canary);}
});

test('complete HTTP and W3C branches keep only the closed error bucket',async t=>{
  for(const [status,error,w3cError]of [[500,undefined,'none'],[200,'unknown error','unknown-error'],[500,'session not created','session-not-created'],[400,'invalid argument','invalid-argument'],[500,'timeout','timeout'],[500,'constructor','other'],[500,{toString:'not-callable'},'other']]){
    const canary=randomBytes(24).toString('base64url'),value={message:canary,...(error===undefined?{}:{error})};
    const result=await failedReadiness(t,{status,value});assert.equal(result.error.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.deepEqual(result.observation.setupFailure.startupResponse,snapshot({httpStatus:status,w3cError}));absent(result.observation,canary);
  }
});

test('public pinned signatures are classified without retaining any generated reply text',async t=>{
  const signatures=[['TESTLANE_WDA_STARTUP_SCOPE_REFUSED','startup-scope-signature'],['Unknown device or simulator UDID: ','device-discovery-signature'],['WDA was not ready in 120000 ms.','wda-readiness-timeout-signature'],['Could not proxy command to the remote server. Original error: ','downstream-proxy-signature'],['Unable to start WebDriverAgent session. Original error: ','wda-session-signature'],['Unable to launch WebDriverAgent. Original error: ','wda-launch-signature']];
  for(const [prefix,category]of signatures){const canary=randomBytes(24).toString('base64url')+'/+=',result=await failedReadiness(t,{value:{error:'unknown error',message:prefix+canary}});assert.equal(result.observation.setupFailure.startupResponse.startupCategory,category);absent(result.observation,canary);assert.equal(String(result.error.stack).includes(canary),false);}
  for(const [message,category]of [['Unable to launch WebDriverAgent. Original error: WDA was not ready in 120000 ms.','wda-readiness-timeout-signature'],['Unable to start WebDriverAgent session. Original error: Could not proxy command to the remote server. Original error: TESTLANE_WDA_STARTUP_SCOPE_REFUSED','startup-scope-signature']]){const result=await failedReadiness(t,{value:{error:'unknown error',message}});assert.equal(result.observation.setupFailure.startupResponse.startupCategory,category);}
});

test('malformed JSON and malformed envelopes preserve their original response-invalid code',async t=>{
  for(const [raw,responseState]of [['{','body-ended'],[JSON.stringify({other:true}),'json-decoded']]){const result=await failedReadiness(t,{status:200,raw});assert.equal(result.error.code,'NATIVE_DRIVER_RESPONSE_INVALID');assert.deepEqual(result.observation.setupFailure.startupResponse,snapshot({httpStatus:200,responseState,w3cError:'unavailable'}));}
});

test('late observed headers survive the session-timeout wrapper without claiming body or JSON completion',async t=>{
  let now=0;t.mock.method(performance,'now',()=>now);
  const result=await failedReadiness(t,{value:{error:'unknown error'},onHeaders:()=>{now=240000.25;}});assert.equal(result.error.code,'NATIVE_DRIVER_SESSION_TIMEOUT');assert.deepEqual(result.observation.setupFailure.startupResponse,snapshot({responseState:'headers-observed',w3cError:'unavailable'}));assert.equal(result.observation.setupFailure.requestProgress.responseHeadersObserved,true);
});

test('normalization refuses unknown values, encoded canaries, accessors, proxies and mutable references',()=>{
  const canary=randomBytes(24).toString('base64url');let touched=0;
  const getter=snapshot();Object.defineProperty(getter,'httpStatus',{get(){touched++;return 500;},enumerable:true});
  const proxy=new Proxy(snapshot(),{get(){touched++;throw Error();},ownKeys(){touched++;throw Error();}});
  for(const value of [null,[],Object.create(null),{...snapshot(),extra:canary},snapshot({httpStatus:NaN}),snapshot({httpStatus:Infinity}),snapshot({httpStatus:'500'}),snapshot({httpStatus:99}),snapshot({httpStatus:600}),snapshot({responseState:canary}),snapshot({startupCategory:encodeURIComponent(canary)}),snapshot({w3cError:Buffer.from(canary).toString('base64')}),snapshot({responseState:'body-reading',w3cError:'unknown-error'}),getter,proxy,{...snapshot(),[Symbol('extra')]:true}])assert.equal(normalizeIosStartupResponse(value),undefined);
  const input=snapshot(),fixed=normalizeIosStartupResponse(input);assert.equal(Object.isFrozen(fixed),true);input.httpStatus=400;assert.equal(fixed.httpStatus,500);assert.equal(touched,0);
});

test('class-aware readers never inspect unknown errors or property accessors',()=>{
  let touched=0;const wrong=Object.assign(Error(),{requestFailure:request,startupResponse:snapshot()});
  const getter=new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',request);Object.defineProperty(getter,'startupResponse',{get(){touched++;return snapshot();}});
  const proxy=new Proxy(getter,{get(){touched++;throw Error();}});
  class Other extends NativeDriverError{}
  for(const value of [wrong,getter,proxy,new Other('NATIVE_DRIVER_COMMAND_FAILED',request,undefined,snapshot()),new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',{operation:'click',phase:'response'},undefined,snapshot())])assert.equal(readIosStartupResponse(value),undefined);
  assert.equal(touched,0);
});

test('setupFailure requires actual factory rejection and never changes successful or post-construction control evidence',async()=>{
  const options={driverOptions:{deviceBinding:binding()},assertOwned:()=>true,appPrewarmed:true,preauthControls:true};
  for(const mode of ['success','context-failure','control-failure','close-failure','invalid-return']){
    let observed,closes=0;const driver={context:mode==='context-failure'?'WEBVIEW':'NATIVE_APP',scrollIntoView:async()=>{if(mode==='control-failure')throw new NativeDriverError('NATIVE_DRIVER_ELEMENT_TIMEOUT');},click:async()=>{},hideKeyboard:async()=>{},close:async()=>{closes++;if(mode==='close-failure')throw new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED');}};
    const pending=verifyInstalledIosReadiness({...options,createNativeDriver:async()=>mode==='invalid-return'?undefined:driver,onPreauthControls:value=>{observed=value;}});
    if(mode==='success')await pending;else await assert.rejects(pending);
    assert.equal(Object.hasOwn(observed,'setupFailure'),false);assert.equal(closes,mode==='invalid-return'?0:1);
  }
  const canary=randomBytes(24).toString('base64url');let observed;
  await assert.rejects(verifyInstalledIosReadiness({...options,createNativeDriver:async()=>{throw Error(canary);},onPreauthControls:value=>{observed=value;}}),{code:'NATIVE_DRIVER_COMMAND_FAILED'});assert.deepEqual(observed.setupFailure,{code:'NATIVE_DRIVER_COMMAND_FAILED'});absent(observed,canary);
});

test('cancellation and internal factory context rejection keep their original fixed request facts',async t=>{
  const controller=new AbortController();
  const cancelled=await failedReadiness(t,{value:{error:'unknown error'},signal:controller.signal,onHeaders:()=>controller.abort()});
  assert.equal(cancelled.error.code,'NATIVE_DRIVER_CANCELLED');assert.deepEqual(cancelled.observation.setupFailure.startupResponse,snapshot({httpStatus:0,responseState:'not-observed',w3cError:'unavailable'}));
  const bodyController=new AbortController(),bodyCancelled=await failedReadiness(t,{resetBody:true,signal:bodyController.signal,onHeaders:()=>setImmediate(()=>bodyController.abort())});
  assert.equal(bodyCancelled.error.code,'NATIVE_DRIVER_CANCELLED');assert.deepEqual(bodyCancelled.observation.setupFailure.startupResponse,snapshot({responseState:'body-reading',w3cError:'unavailable'}));
  const canary=randomBytes(24).toString('base64url');let observed;
  await assert.rejects(verifyInstalledIosReadiness({createNativeDriver:async()=>{throw new NativeDriverError('NATIVE_DRIVER_CONTEXT_TIMEOUT',{operation:'native-context',phase:'http'});},driverOptions:{deviceBinding:binding()},assertOwned:()=>true,appPrewarmed:true,preauthControls:true,onPreauthControls:value=>{observed=value;}}),{code:'NATIVE_DRIVER_CONTEXT_TIMEOUT'});
  assert.deepEqual(observed.setupFailure,{code:'NATIVE_DRIVER_CONTEXT_TIMEOUT',request:{operation:'native-context',phase:'http'}});assert.equal(Object.hasOwn(observed.setupFailure,'startupResponse'),false);absent(observed,canary);
});

test('a copied installed driver and readiness preserve facts while public-failure schema stays unchanged',async t=>{
  const temp=await realpath(await mkdtemp(path.join(os.tmpdir(),'tld-startup-response-'))),sourceRoot=fileURLToPath(new URL('../../../',import.meta.url));
  try{
    for(const file of ['examples/ios-verification/driver.mjs','examples/ios-verification/readiness.mjs','examples/ios-verification/preauth-controls.mjs','examples/ios-verification/device-scope.mjs','examples/ios-verification/setup-ownership.mjs','examples/ios-verification/failure.mjs','examples/ios-verification/failure-facts.mjs','examples/android-verification/contracts.mjs','examples/android-verification/proof-cases.mjs','examples/android-verification/driver-phase.mjs']){const target=path.join(temp,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,await readFile(path.join(sourceRoot,file)));}
    const driver=await import(pathToFileURL(path.join(temp,'examples/ios-verification/driver.mjs'))),readiness=await import(pathToFileURL(path.join(temp,'examples/ios-verification/readiness.mjs'))),failure=await import(pathToFileURL(path.join(temp,'examples/ios-verification/failure.mjs')));
    const canary=randomBytes(24).toString('base64url'),result=await failedReadiness(t,{runtime:{...driver,...readiness},value:{error:'unknown error',message:canary}});
    assert.deepEqual(driver.readIosStartupResponse(result.error),snapshot());assert.equal(readIosStartupResponse(result.error),undefined);
    const summary=await failure.publicIosFailure({output:temp,stage:'wda-readiness',error:result.error});assert.deepEqual(Object.keys(summary).sort(),['code','reports','requestFailure','schemaVersion','stage','status']);assert.equal(Object.hasOwn(summary,'startupResponse'),false);absent(summary,canary);
    assert.deepEqual(normalizeIosStartupResponse(JSON.parse(JSON.stringify(result.observation.setupFailure.startupResponse))),snapshot());
  }finally{await rm(temp,{recursive:true,force:true});}
});
