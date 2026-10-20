import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {lstat,mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {requireIosWdaCi,publicIosWdaStatus,validateWdaBuildManifest,probeOwnedWdaSession,runIosWdaPreflight} from '../../../scripts/ios-wda-preflight.mjs';
import {IOS_DEVICE_SCOPE} from '../device-scope.mjs';

const ci={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',TESTLANE_IOS_PROOF_CI:'1'};
const preparation=()=>({schemaVersion:1,wdaPrepared:true,buildBudgetMs:600000,buildMs:12345,webdriveragent:'16.16.3',
  projectSHA256:'a'.repeat(64),packageSHA256:'b'.repeat(64),runnerSHA256:'c'.repeat(64),xctestrunSHA256:'d'.repeat(64)});
const testDevice=()=>({serverUrl:'http://127.0.0.1:8210/',udid:'12345678-1234-1234-1234-123456789ABC',
  deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',derivedDataPath:'/private/tmp/tld-ios-Abc123/derived-data',
  wdaPort:8211,mjpegPort:8212,assertOwned:async()=>true,deviceBinding:{schemaVersion:1,scope:IOS_DEVICE_SCOPE,nativeHome:'/Users/runner',
    deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-Abc123',udid:'12345678-1234-1234-1234-123456789ABC',nonce:'a'.repeat(24)}});
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('UNIT_WDA_DID_NOT_SETTLE')),2000);})]);}finally{clearTimeout(timer);}}
async function fixture(t){
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-ios-wda-test-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent);assert.equal(await realpath(root),root);assert.equal((await lstat(root)).isSymbolicLink(),false);await rm(root,{recursive:true,maxRetries:5,retryDelay:100});});
  return root;
}
test('WDA diagnostic requires opted-in hosted macOS and refuses before output allocation',async t=>{
  for(const options of [{platform:'win32',env:ci},{platform:'darwin',env:{}},{platform:'darwin',env:{...ci,RUNNER_ENVIRONMENT:'self-hosted'}},{platform:'darwin',env:null}])assert.throws(()=>requireIosWdaCi(options),/IOS_WDA_CI_REQUIRED/);
  assert.doesNotThrow(()=>requireIosWdaCi({platform:'darwin',env:ci}));
  const root=await fixture(t),outputDir=path.join(root,'not-created'),controller=new AbortController();controller.abort();
  await assert.rejects(runIosWdaPreflight({signal:controller.signal,outputDir}),/IOS_WDA_CANCELLED/);await assert.rejects(lstat(outputDir),{code:'ENOENT'});
  if(process.platform!=='darwin'){await assert.rejects(runIosWdaPreflight({outputDir}),/IOS_WDA_CI_REQUIRED/);await assert.rejects(lstat(outputDir),{code:'ENOENT'});}
});
test('public WDA status never retains arbitrary errors, stages, session IDs or raw responses',()=>{
  const secret='untrusted-private-canary',status=publicIosWdaStatus({stage:secret,error:Error(secret),session:{sessionId:secret,raw:secret,sessionCreated:true},deviceCleanup:'unconfirmed'});
  assert.equal(status.code,'IOS_WDA_PREFLIGHT_FAILED');assert.equal(status.stage,'build-validation');assert.equal(status.status,'failed');
  assert.equal(JSON.stringify(status).includes(secret),false);assert.equal(publicIosWdaStatus().status,'failed');
  assert.equal(publicIosWdaStatus({error:Error('IOS_WDA_SESSION_TIMEOUT')}).code,'IOS_WDA_SESSION_TIMEOUT');
  const successful={ownershipVerified:true,session:{sessionCreated:true,nativeContextVerified:true,sessionCleanup:'deleted'},deviceCleanup:'completed'};
  assert.equal(publicIosWdaStatus(successful).status,'failed','success cannot silently omit the prewarmed setup condition');
  assert.equal(publicIosWdaStatus({...successful,appPrewarmed:true}).appPrewarmed,true);
  assert.equal(publicIosWdaStatus({...successful,appPrewarmed:true}).status,'failed','missing prepared artifact binding cannot pass');
  assert.equal(publicIosWdaStatus({...successful,appPrewarmed:true,wdaPreparation:preparation()}).status,'passed');
  const stale=publicIosWdaStatus({...successful,appPrewarmed:true,wdaPreparation:{...preparation(),buildBudgetMs:300000}});
  assert.equal(stale.status,'failed');assert.equal(stale.wdaPrepared,false);assert.equal(Object.hasOwn(stale,'wdaPreparation'),false);
  const invalid=publicIosWdaStatus({...successful,appPrewarmed:true,wdaPreparation:{...preparation(),raw:secret}});
  assert.equal(invalid.status,'failed');assert.equal(invalid.wdaPrepared,false);assert.equal(JSON.stringify(invalid).includes(secret),false);
});
test('build binding rejects changed public source, builder, app tree, signing and architecture metadata',()=>{
  const sourceHashes=Object.fromEntries(['package.json','package-lock.json','app.ios.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withIosProofBuild.cjs'].map(file=>[file,'a'.repeat(64)]));
  const inputs={sourceHashes,builderSHA256:'b'.repeat(64),appSHA256:'c'.repeat(64),architecture:'arm64'};
  const build={schemaVersion:1,platform:'ios-simulator',package:'dev.testlane.iosproof',proofOnly:true,configuration:'Release',codeSigningAllowed:false,
    embeddedBundle:true,appDirectory:'TestlaneIOSProof.app',signature:'none',unsigned:true,architecture:'arm64',appSHA256:inputs.appSHA256,builderSHA256:inputs.builderSHA256,publicSourceSHA256:sourceHashes};
  assert.equal(validateWdaBuildManifest(build,inputs).appSHA256,inputs.appSHA256);
  for(const change of [{appSHA256:'d'.repeat(64)},{builderSHA256:'d'.repeat(64)},{codeSigningAllowed:true},{signature:'developer-signed'},{architecture:'x86_64'},
    {publicSourceSHA256:{...sourceHashes,'App.js':'d'.repeat(64)}},{publicSourceSHA256:{...sourceHashes,extra:'d'.repeat(64)}}])assert.throws(()=>validateWdaBuildManifest({...build,...change},inputs),/IOS_WDA_BUILD_INVALID/);
});
async function serverFixture({context='NATIVE_APP',failure=false,hang=false,deleteFailure=false}={}){
  const calls=[],entered=Promise.withResolvers(),connectionClosed=Promise.withResolvers(),privateText='untrusted-native-payload';
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const bytes of req)chunks.push(bytes);
    calls.push({method:req.method,route:req.url,body:chunks.length?JSON.parse(Buffer.concat(chunks)):null});
    if(req.url==='/session'&&hang){entered.resolve();res.once('close',()=>connectionClosed.resolve());return;}
    const rejected=failure||(deleteFailure&&req.method==='DELETE');
    res.writeHead(rejected?500:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({value:rejected?{error:'unknown error',message:privateText}:req.url==='/session'?{sessionId:'owned-session'}:req.url.endsWith('/context')?context:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const device={...testDevice(),serverUrl:'http://127.0.0.1:'+server.address().port+'/'};
  return {device,calls,entered:entered.promise,connectionClosed:connectionClosed.promise,privateText,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
test('credential-free probe creates once, checks native context and deletes only its exact session',async()=>{
  const fixture=await serverFixture();
  try{
    const result=await probeOwnedWdaSession({device:fixture.device});assert.equal(result.nativeContextVerified,true);assert.equal(result.sessionCleanup,'deleted');
    assert.deepEqual(fixture.calls.map(item=>[item.method,item.route]),[['POST','/session'],['GET','/session/owned-session/context'],['DELETE','/session/owned-session']]);
    const caps=fixture.calls[0].body.capabilities.alwaysMatch;
    assert.equal(caps['appium:showXcodeLog'],true);assert.equal(caps['appium:skipLogCapture'],true);assert.equal(caps['appium:disableAutomaticScreenshots'],true);
    assert.equal(caps['appium:printPageSourceOnFindFailure'],false);assert.equal(caps['appium:bundleId'],'dev.testlane.iosproof');
    assert.equal(caps['appium:isHeadless'],true);
    assert.equal(caps['appium:wdaStartupRetries'],1);assert.equal(caps['appium:wdaConnectionTimeout'],5000);
    assert.equal(caps['appium:forceAppLaunch'],false);assert.equal(caps['appium:shouldTerminateApp'],false);
    assert.equal(caps['appium:usePrebuiltWDA'],true);
    assert.equal(caps['appium:simulatorDevicesSetPath'],fixture.device.deviceBinding.deviceSetPath);
    assert.equal(Object.hasOwn(caps,'deviceBinding'),false);
    assert.equal(Object.hasOwn(caps,'appium:processArguments'),false);
  }finally{await fixture.close();}
});
test('pre-auth probe refuses a mismatched hosted descriptor before any native HTTP',async()=>{
  const fixture=await serverFixture();
  try{
    await assert.rejects(probeOwnedWdaSession({device:{...fixture.device,deviceBinding:{...fixture.device.deviceBinding,scope:'foreign-set'}}}),/IOS_WDA_INPUT_INVALID/);
    assert.equal(fixture.calls.length,0);
  }finally{await fixture.close();}
});
test('failed context still deletes the known session and raw native errors stay out of public errors',async()=>{
  for(const options of [{context:'WEBVIEW'}, {failure:true}, {deleteFailure:true}]){
    const fixture=await serverFixture(options),raw=[];
    try{
      await assert.rejects(probeOwnedWdaSession({device:fixture.device,onRawResponse:text=>raw.push(text)}),error=>{
        assert.equal(error.message,options.context?'IOS_WDA_CONTEXT_REFUSED':options.deleteFailure?'IOS_WDA_SESSION_CLEANUP_UNCONFIRMED':'IOS_WDA_REQUEST_FAILED');
        assert.equal(String(error.stack).includes(fixture.privateText),false);
        assert.equal(error.sessionCleanup,options.failure?'not-addressable':options.deleteFailure?'unknown':'deleted');return true;
      });
      assert.equal(fixture.calls.filter(item=>item.method==='POST').length,1);
      assert.equal(fixture.calls.filter(item=>item.method==='DELETE').length,options.failure?0:1);
      if(options.failure||options.deleteFailure)assert.equal(raw.some(text=>text.includes(fixture.privateText)),true,'raw diagnostics have only the explicitly private capture sink');
    }finally{await fixture.close();}
  }
});
test('aborting an unknown session interrupts HTTP without retry or invented session cleanup',async()=>{
  const fixture=await serverFixture({hang:true}),controller=new AbortController();
  try{
    const pending=assert.rejects(probeOwnedWdaSession({device:fixture.device,signal:controller.signal}),error=>error.message==='IOS_WDA_CANCELLED'&&error.sessionCleanup==='not-addressable');
    await promptly(fixture.entered);controller.abort();await promptly(pending);await promptly(fixture.connectionClosed);
    assert.deepEqual(fixture.calls.map(item=>item.route),['/session']);
  }finally{controller.abort();await fixture.close();}
});
test('session setup preserves its 240-second bound and cancellation never prints native error text',async t=>{
  const originalTimer=globalThis.setTimeout;let latest,budget;
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>{latest=callback;budget=milliseconds;return originalTimer(callback,milliseconds,...args);});
  t.mock.method(globalThis,'fetch',async(_url,options)=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('untrusted-native-payload')),{once:true});queueMicrotask(latest);}));
  const device=testDevice();
  await assert.rejects(probeOwnedWdaSession({device}),error=>error.message==='IOS_WDA_SESSION_TIMEOUT'&&!String(error.stack).includes('untrusted-native-payload'));
  assert.ok(budget>239900&&budget<=240000);
});

test('credential-free diagnostic refuses a successful response that arrives after its monotonic deadline',async t=>{
  let now=0;const routes=[];
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'fetch',async url=>{routes.push(new URL(url).pathname);now=240001;return new Response(JSON.stringify({value:{sessionId:'late-owned-session'}}));});
  await assert.rejects(probeOwnedWdaSession({device:testDevice()}),error=>
    error.message==='IOS_WDA_SESSION_TIMEOUT'&&error.sessionCleanup==='not-addressable'&&error.sessionCreated===false);
  assert.deepEqual(routes,['/session']);
});

test('credential-free request cancellation settles without relying on HTTP abort-drain behavior',async t=>{
  const entered=Promise.withResolvers(),controller=new AbortController();
  t.mock.method(globalThis,'fetch',async()=>{entered.resolve();return new Promise(()=>{});});
  const pending=assert.rejects(probeOwnedWdaSession({device:testDevice(),signal:controller.signal}),
    error=>error.message==='IOS_WDA_CANCELLED'&&error.sessionCleanup==='not-addressable');
  await promptly(entered.promise);controller.abort();await promptly(pending);
});

test('pre-auth setup metrics include seven-second ownership stabilization and still use a fresh context guard',async t=>{
  let now=0,owners=0;const calls=[],stages=[];
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const route=new URL(url).pathname;calls.push([options.method,route]);if(route==='/session')now=90000;
    return new Response(JSON.stringify({value:route==='/session'?{sessionId:'owned-session'}:route.endsWith('/context')?'NATIVE_APP':null}));
  });
  const result=await probeOwnedWdaSession({device:{...testDevice(),assertOwned:()=>{if(++owners===2)now+=7000;return true;}},onStage:value=>stages.push(value)});
  assert.equal(result.sessionSetupMs,97000);assert.equal(result.sessionCreated,true);assert.equal(result.sessionCleanup,'deleted');
  assert.equal(owners,4,'create guard, one stabilization, context guard, cleanup guard');
  assert.deepEqual(stages,['wda-session-create','session-ownership','native-context','session-close']);
  assert.deepEqual(calls,[['POST','/session'],['GET','/session/owned-session/context'],['DELETE','/session/owned-session']]);
});

test('pre-auth stabilization cannot extend a nearly exhausted original 240-second setup budget',async t=>{
  let now=0,owners=0;const calls=[],stages=[];
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'fetch',async url=>{calls.push(new URL(url).pathname);now=239000;
    return new Response(JSON.stringify({value:{sessionId:'owned-session'}}));});
  await assert.rejects(probeOwnedWdaSession({device:{...testDevice(),assertOwned:()=>{if(++owners===2)now+=1001;return true;}},onStage:value=>stages.push(value)}),
    error=>error.message==='IOS_WDA_SESSION_TIMEOUT'&&error.sessionCreated===true&&error.sessionCleanup==='unknown'&&error.sessionSetupMs===240001);
  assert.equal(owners,2);assert.deepEqual(calls,['/session']);assert.equal(stages.at(-1),'session-ownership');
});

test('a context-stage scheduling delay cannot reset the absolute startup deadline or send an expired context request',async t=>{
  let now=0,owners=0;const calls=[],stages=[];
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const route=new URL(url).pathname;calls.push([options.method,route]);
    if(route==='/session')now=239995;
    return new Response(JSON.stringify({value:route==='/session'?{sessionId:'owned-session'}:route.endsWith('/context')?'NATIVE_APP':null}));
  });
  await assert.rejects(probeOwnedWdaSession({device:{...testDevice(),assertOwned:()=>{owners++;return true;}},
    onStage:value=>{stages.push(value);if(value==='native-context')now+=10;}}),error=>
    error.message==='IOS_WDA_SESSION_TIMEOUT'&&error.sessionCreated===true&&error.sessionCleanup==='deleted'&&error.nativeContextVerified===false);
  assert.deepEqual(calls,[['POST','/session'],['DELETE','/session/owned-session']]);
  assert.equal(owners,3,'the expired context starts no guard; confirmed stabilization allows an independent cleanup guard');
  assert.equal(stages.at(-1),'native-context');
});

test('pre-auth setup timeout, cancellation and refusal fence late ACKs without another guard or DELETE',async t=>{
  let now=0,expire,calls;const originalTimer=globalThis.setTimeout;
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms===20000)expire=fn;return originalTimer(fn,ms,...args);});
  t.mock.method(globalThis,'fetch',async url=>{calls.push(new URL(url).pathname);return new Response(JSON.stringify({value:{sessionId:'owned-session'}}));});
  for(const mode of ['timeout','cancelled','rejected']){
    now=0;calls=[];const stages=[],entered=Promise.withResolvers(),gate=Promise.withResolvers(),controller=new AbortController();let owners=0;
    const secret='private-callback-value';
    const pending=assert.rejects(probeOwnedWdaSession({device:{...testDevice(),assertOwned:()=>{if(++owners===2){entered.resolve();return gate.promise;}return true;}},
      signal:controller.signal,onStage:value=>stages.push(value)}),error=>{
      assert.equal(error.message,mode==='timeout'?'IOS_WDA_SETUP_OWNERSHIP_TIMEOUT':mode==='cancelled'?'IOS_WDA_CANCELLED':'IOS_WDA_OWNERSHIP_REFUSED');
      assert.equal(error.sessionCreated,true);assert.equal(error.sessionCleanup,'unknown');assert.equal(error.nativeContextVerified,false);
      const status=publicIosWdaStatus({stage:stages.at(-1),error,session:error});
      assert.equal(status.stage,'session-ownership');assert.equal(status.sessionCreated,true);assert.equal(status.sessionCleanup,'unknown');
      for(const value of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),'owned-session']){
        assert.equal(String(error.stack).includes(value),false);assert.equal(JSON.stringify(status).includes(value),false);
      }
      return true;
    });
    await entered.promise;
    if(mode==='timeout'){now=20000;expire();}else if(mode==='cancelled')controller.abort();else gate.reject(Error(secret));
    await pending;gate.resolve(true);await Promise.resolve();await Promise.resolve();
    assert.equal(owners,2);assert.deepEqual(calls,['/session']);assert.equal(stages.at(-1),'session-ownership');
  }
});

test('a confirmed setup guard permits bounded deletion after a context failure without hiding its stage',async()=>{
  const fixture=await serverFixture({context:'WEBVIEW'}),stages=[];
  try{
    await assert.rejects(probeOwnedWdaSession({device:fixture.device,onStage:value=>stages.push(value)}),error=>
      error.message==='IOS_WDA_CONTEXT_REFUSED'&&error.sessionCreated===true&&error.sessionCleanup==='deleted');
    assert.equal(fixture.calls.filter(item=>item.method==='DELETE').length,1);assert.equal(stages.at(-1),'native-context');
  }finally{await fixture.close();}
});

test('a cancelled initial context ownership guard retains known-session uncertainty and never starts deletion',async t=>{
  const controller=new AbortController(),gate=Promise.withResolvers(),entered=Promise.withResolvers(),calls=[],stages=[];let owners=0;
  t.mock.method(globalThis,'fetch',async url=>{calls.push(new URL(url).pathname);return new Response(JSON.stringify({value:{sessionId:'owned-session'}}));});
  const pending=assert.rejects(probeOwnedWdaSession({device:{...testDevice(),assertOwned:()=>{if(++owners===3){entered.resolve();return gate.promise;}return true;}},
    signal:controller.signal,onStage:value=>stages.push(value)}),error=>error.message==='IOS_WDA_CANCELLED'&&error.sessionCreated===true&&error.sessionCleanup==='unknown');
  await entered.promise;controller.abort();await pending;gate.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(owners,3);assert.deepEqual(calls,['/session']);assert.equal(stages.at(-1),'native-context');
});
