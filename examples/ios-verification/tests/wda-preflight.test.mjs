import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {lstat,mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {requireIosWdaCi,publicIosWdaStatus,validateWdaBuildManifest,probeOwnedWdaSession,runIosWdaPreflight} from '../../../scripts/ios-wda-preflight.mjs';

const ci={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',TESTLANE_IOS_PROOF_CI:'1'};
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
  const device={serverUrl:'http://127.0.0.1:'+server.address().port+'/',udid:'12345678-1234-1234-1234-123456789ABC',
    deviceSetPath:'/private/tmp/tld-ios-Abc123/devices',derivedDataPath:'/private/tmp/tld-ios-Abc123/derived-data',wdaPort:8211,mjpegPort:8212,assertOwned:async()=>true};
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
    assert.equal(Object.hasOwn(caps,'appium:processArguments'),false);
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
  const device={serverUrl:'http://127.0.0.1:8210/',assertOwned:async()=>true};
  await assert.rejects(probeOwnedWdaSession({device}),error=>error.message==='IOS_WDA_SESSION_TIMEOUT'&&!String(error.stack).includes('untrusted-native-payload'));
  assert.equal(budget,240000);
});
