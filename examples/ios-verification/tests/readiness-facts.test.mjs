/** Diagnostic transport only: disposable HTTP/Node fixtures, never native tools. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {NativeDriverError,readIosRequestFailure} from '../driver.mjs';
import {iosProofDriverOptions,verifyInstalledIosReadiness} from '../readiness.mjs';
import {publicIosFailure} from '../failure.mjs';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canary=()=>randomBytes(24).toString('hex')+'/+=';
const absent=(text,secret)=>{for(const value of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')])assert.equal(text.includes(value),false);};
const device=origin=>{
  const deviceBinding={schemaVersion:1,scope:'ephemeral-hosted-standard-device-set',nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-abc123',udid:'FA001122-3344-5566-7788-9900AABBCCDD',nonce:'a'.repeat(24)};
  return{deviceBinding,udid:deviceBinding.udid,deviceSetPath:deviceBinding.deviceSetPath,derivedDataPath:deviceBinding.privateRoot+'/derived-data',serverUrl:origin,wdaPort:8211,mjpegPort:8212};
};
async function owned(t){
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-ios-facts-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^tld-ios-facts-/);assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:false,maxRetries:5,retryDelay:100});});return root;
}
async function put(root,file,source){const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,source);return target;}
async function runtime(root){
  for(const file of ['driver.mjs','device-scope.mjs','setup-ownership.mjs','readiness.mjs','preauth-controls.mjs','failure.mjs','failure-facts.mjs'])await put(root,'examples/ios-verification/'+file,await readFile(new URL('../'+file,import.meta.url)));
  for(const file of ['contracts.mjs','proof-cases.mjs','driver-phase.mjs','worker-host.mjs','budgets.mjs'])await put(root,'examples/android-verification/'+file,await readFile(new URL('../../android-verification/'+file,import.meta.url)));
  const load=file=>import(pathToFileURL(path.join(root,'examples/ios-verification',file)).href);
  return{driver:await load('driver.mjs'),readiness:await load('readiness.mjs'),failure:await load('failure.mjs')};
}
async function responseServer(t,secret){
  const calls=[],server=createServer(async(req,res)=>{
    for await(const ignored of req)void ignored;calls.push([req.method,req.url]);
    res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({value:{error:'unknown error',message:[secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')].join('|')}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return{calls,origin:'http://127.0.0.1:'+server.address().port};
}

test('real HTTP rejection survives copied installed readiness and its genuine installed projector',async t=>{
  const root=await owned(t),secret=canary(),server=await responseServer(t,secret),installed=await runtime(path.join(root,'package'));let failure;
  await assert.rejects(installed.readiness.verifyInstalledIosReadiness({createNativeDriver:installed.driver.createNativeDriver,
    driverOptions:installed.readiness.iosProofDriverOptions(device(server.origin)),assertOwned:()=>true,appPrewarmed:true}),error=>{failure=error;return true;});
  assert.deepEqual(server.calls,[['POST','/session']]);
  assert.deepEqual(installed.driver.readIosRequestFailure(failure),{operation:'session-create',phase:'response'});
  assert.equal(readIosRequestFailure(failure),undefined,'workspace class cannot brand an installed error');
  const summary=await installed.failure.publicIosFailure({output:path.join(root,'missing'),stage:'wda-readiness',error:failure});
  assert.equal(summary.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.deepEqual(summary.requestFailure,{operation:'session-create',phase:'response'});
  assert.equal(Object.isFrozen(summary.requestFailure),true);absent(JSON.stringify(summary),secret);
  const wrong=await publicIosFailure({output:path.join(root,'missing'),stage:'wda-readiness',error:failure});assert.equal(Object.hasOwn(wrong,'requestFailure'),false);
});

test('failed live ownership preserves its fixed phase and sends no HTTP',async t=>{
  const root=await owned(t),secret=canary(),server=await responseServer(t,secret),installed=await runtime(path.join(root,'package'));let failure;
  await assert.rejects(installed.readiness.verifyInstalledIosReadiness({createNativeDriver:installed.driver.createNativeDriver,
    driverOptions:installed.readiness.iosProofDriverOptions(device(server.origin)),assertOwned:()=>false,appPrewarmed:true}),error=>{failure=error;return true;});
  assert.equal(server.calls.length,0);
  const summary=await installed.failure.publicIosFailure({output:path.join(root,'missing'),stage:'wda-readiness',error:failure});
  assert.equal(summary.code,'NATIVE_DRIVER_OWNERSHIP_REFUSED');assert.deepEqual(summary.requestFailure,{operation:'session-create',phase:'ownership'});
});

test('preauth first error survives readiness close failure; close-only keeps its separate request fact',async()=>{
  for(const first of [true,false]){
    let closes=0,rows;const primary={operation:'element-find',phase:'http'},closing={operation:'session-delete',phase:'response'};
    let failure;await assert.rejects(verifyInstalledIosReadiness({appPrewarmed:true,driverOptions:iosProofDriverOptions(device('http://127.0.0.1:4723')),assertOwned:()=>true,
      preauthControls:first,onPreauthControls:value=>{rows=value;},createNativeDriver:async()=>({context:'NATIVE_APP',
        scrollIntoView:async()=>{throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT',primary);},
        close:async()=>{closes++;throw new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',closing);},
      })}),error=>{failure=error;return true;});
    assert.equal(closes,1);assert.equal(failure.code,first?'NATIVE_DRIVER_TIMEOUT':'NATIVE_DRIVER_COMMAND_FAILED');
    assert.deepEqual(readIosRequestFailure(failure),first?primary:closing);
    if(first){assert.equal(rows.completed,false);assert.equal(rows.sessionCleanupAcknowledged,false);assert.deepEqual(rows.steps[0].request,primary);}
    const summary=await publicIosFailure({output:'missing-readiness-facts',stage:'wda-readiness',error:failure});assert.deepEqual(summary.requestFailure,first?primary:closing);
  }
});

test('hostile errors never execute getters/proxies or carry forged/malformed request facts through readiness',async()=>{
  const secret=canary();let reads=0;
  const getter=new NativeDriverError('NATIVE_DRIVER_TIMEOUT');Object.defineProperty(getter,'code',{get(){reads++;throw Error(secret);}});
  const requestGetter=new NativeDriverError('NATIVE_DRIVER_TIMEOUT');Object.defineProperty(requestGetter,'requestFailure',{get(){reads++;throw Error(secret);}});
  const malformed=new NativeDriverError('NATIVE_DRIVER_TIMEOUT');Object.defineProperty(malformed,'requestFailure',{value:{operation:'session-create',phase:'response',raw:secret}});
  const factGetter=new NativeDriverError('NATIVE_DRIVER_TIMEOUT');Object.defineProperty(factGetter,'requestFailure',{value:{operation:'session-create',get phase(){reads++;throw Error(secret);}}});
  const forged=Object.assign(Error(secret),{code:'NATIVE_DRIVER_TIMEOUT',requestFailure:{operation:'session-create',phase:'http'}});
  const unknown=new NativeDriverError(secret,{operation:'session-create',phase:'http'});
  const proxy=new Proxy(new NativeDriverError('NATIVE_DRIVER_TIMEOUT'),{get(){reads++;throw Error(secret);},getPrototypeOf(){reads++;throw Error(secret);}});
  for(const thrown of [getter,requestGetter,malformed,factGetter,forged,unknown,proxy,null]){
    let failure;await assert.rejects(verifyInstalledIosReadiness({appPrewarmed:true,driverOptions:iosProofDriverOptions(device('http://127.0.0.1:4723')),assertOwned:()=>true,
      createNativeDriver:async()=>{throw thrown;}}),error=>{failure=error;return true;});
    assert.equal(readIosRequestFailure(failure),undefined);
    const summary=await publicIosFailure({output:'missing-readiness-facts',stage:'wda-readiness',error:failure});assert.equal(Object.hasOwn(summary,'requestFailure'),false);absent(JSON.stringify(summary),secret);
    const direct=await publicIosFailure({output:'missing-readiness-facts',stage:'wda-readiness',error:thrown});assert.equal(Object.hasOwn(direct,'requestFailure'),false);absent(JSON.stringify(direct),secret);
  }
  assert.equal(reads,0);
});

test('genuine fixed facts do not require reading a driver error message',async()=>{
  let reads=0;const secret=canary(),error=new NativeDriverError('NATIVE_DRIVER_TIMEOUT',{operation:'native-context',phase:'response'});
  Object.defineProperty(error,'message',{get(){reads++;throw Error(secret);}});
  let failure;await assert.rejects(verifyInstalledIosReadiness({appPrewarmed:true,driverOptions:iosProofDriverOptions(device('http://127.0.0.1:4723')),assertOwned:()=>true,
    createNativeDriver:async()=>{throw error;}}),value=>{failure=value;return true;});
  const summary=await publicIosFailure({output:'missing-readiness-facts',stage:'wda-readiness',error:failure});assert.deepEqual(summary.requestFailure,{operation:'native-context',phase:'response'});assert.equal(reads,0);absent(JSON.stringify(summary),secret);
});

async function mainFixture(t,{consumerFails=false}={}){
  const root=await owned(t),workspace=path.join(root,'workspace'),packageRoot=path.join(root,'package'),appDirectory=path.join(root,'TestlaneIOSProof.app'),outputDir=path.join(root,'output'),sessionTemp=path.join(root,'sessions');
  const secret=canary(),server=await responseServer(t,secret);
  await Promise.all([mkdir(appDirectory),mkdir(sessionTemp)]);await runtime(workspace);await runtime(packageRoot);
  const entry=await put(workspace,'scripts/ios-proof.mjs',await readFile(new URL('../../../scripts/ios-proof.mjs',import.meta.url)));
  await put(workspace,'scripts/native-proof-support.mjs',await readFile(new URL('../../../scripts/native-proof-support.mjs',import.meta.url)));
  const disposeFile=path.join(root,'consumer-disposed.json');
  await put(workspace,'examples/playwright/tests/consumer.mjs',`import {writeFile} from 'node:fs/promises';import {NativeDriverError} from '../../ios-verification/driver.mjs';
    export async function consumerProject(){${consumerFails?"throw new NativeDriverError('NATIVE_DRIVER_COMMAND_FAILED',{operation:'session-create',phase:'http'});":`return {root:${JSON.stringify(root)},packageRoot:${JSON.stringify(packageRoot)},sessionTemp:${JSON.stringify(sessionTemp)},async dispose(){await writeFile(${JSON.stringify(disposeFile)},'true');}};`}}`);
  if(consumerFails)await mkdir(outputDir);
  const ownedDevice=device(server.origin);
  await put(packageRoot,'examples/ios-verification/device.mjs',`export async function startOwnedIos(){return {...${JSON.stringify(ownedDevice)},async installApp(){},async prewarmProofApp(){return {appPrewarmed:true};},async assertWdaPrepared(){},async assertOwned(){return true;},capturedText(){return '';},async close(){}};}`);
  await put(packageRoot,'examples/ios-verification/broker.mjs',`export function requireIosBrokerCi(){};export function scanIosCredentials(){};export function startIosBroker(){throw Error('FIXTURE_BROKER_MUST_NOT_START');}`);
  await put(packageRoot,'examples/verification-demo/app.mjs',`export function startDemoApp(){throw Error('FIXTURE_BACKEND_MUST_NOT_START');}`);
  const appSHA256='a'.repeat(64),builder=`export async function hashIosTree(){return {sha256:'${appSHA256}'};}`;
  await put(packageRoot,'examples/mobile-approval-app/build-ios.mjs',builder);
  const publicSourceSHA256={};for(const file of ['package.json','package-lock.json','app.ios.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withIosProofBuild.cjs']){const content='synthetic diagnostic input '+file;await put(packageRoot,'examples/mobile-approval-app/'+file,content);publicSourceSHA256[file]=sha(content);}
  await writeFile(path.join(root,'build-manifest.json'),JSON.stringify({schemaVersion:1,platform:'ios-simulator',package:'dev.testlane.iosproof',proofOnly:true,configuration:'Release',signature:'none',unsigned:true,codeSigningAllowed:false,embeddedBundle:true,architecture:'arm64',appSHA256,builderSHA256:sha(builder),publicSourceSHA256}));
  return{root,workspace,entry,appDirectory,outputDir,disposeFile,secret,server};
}

test('copied controller main catch selects installed projector and preserves its actual HTTP request fact',async t=>{
  const f=await mainFixture(t);const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','TMPDIR'])if(process.env[key])env[key]=process.env[key];
  let result;try{await execute(process.execPath,[f.entry,'--app',f.appDirectory,'--tools-root',path.join(f.root,'tools'),'--output-dir',f.outputDir],{cwd:f.workspace,env,timeout:15000,maxBuffer:1024*1024,windowsHide:true});assert.fail('fixture must fail readiness');}catch(error){assert.equal(error.code,1);result=error;}
  const summary=JSON.parse(await readFile(path.join(f.outputDir,'public-failure.json'),'utf8'));
  assert.equal(summary.stage,'wda-readiness');assert.equal(summary.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.deepEqual(summary.requestFailure,{operation:'session-create',phase:'response'});
  assert.deepEqual(f.server.calls,[['POST','/session']]);assert.equal(await readFile(f.disposeFile,'utf8'),'true');absent(JSON.stringify(summary)+result.stdout+result.stderr,f.secret);
});

test('copied controller uses workspace projector only before a consumer exists',async t=>{
  const f=await mainFixture(t,{consumerFails:true});const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','TMPDIR'])if(process.env[key])env[key]=process.env[key];
  let result;try{await execute(process.execPath,[f.entry,'--app',f.appDirectory,'--tools-root',path.join(f.root,'tools'),'--output-dir',f.outputDir],{cwd:f.workspace,env,timeout:15000,maxBuffer:1024*1024,windowsHide:true});assert.fail('fixture must fail consumer creation');}catch(error){assert.equal(error.code,1);result=error;}
  const summary=JSON.parse(await readFile(path.join(f.outputDir,'public-failure.json'),'utf8'));
  assert.equal(summary.stage,'consumer-install');assert.deepEqual(summary.requestFailure,{operation:'session-create',phase:'http'});assert.equal(f.server.calls.length,0);absent(JSON.stringify(summary)+result.stdout+result.stderr,f.secret);
});
