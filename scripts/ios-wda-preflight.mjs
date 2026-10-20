#!/usr/bin/env node
/** Credential-free WDA diagnostic for the public synthetic app on an ephemeral hosted Mac. */
import {createHash,randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startOwnedIos} from '../examples/ios-verification/device.mjs';
import {hashIosTree} from '../examples/mobile-approval-app/build-ios.mjs';
import {withDriverSignal} from '../examples/android-verification/driver-phase.mjs';
import {fixedIosDevicePreflightCode,validateIosDevicePreflightOutput} from './ios-device-preflight.mjs';

const APP_SOURCE=fileURLToPath(new URL('../examples/mobile-approval-app/',import.meta.url));
const BUNDLE='dev.testlane.iosproof',PRODUCT='TestlaneIOSProof.app',MARKER='testlane-ios-wda-preflight.json';
const LIMIT=8*1024*1024,RESPONSE_LIMIT=64*1024;
const SOURCES=['package.json','package-lock.json','app.ios.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withIosProofBuild.cjs'];
const STAGES=new Set(['build-validation','device-start','xcode-runtime-and-pinned-tools-validated','owned-simulator-created',
  'owned-simulator-boot-started','owned-simulator-booted','private-appium-ready','app-install','wda-session-create','native-context','session-close','complete']);
const CODES=new Set(['IOS_WDA_CI_REQUIRED','IOS_WDA_CANCELLED','IOS_WDA_INPUT_INVALID','IOS_WDA_BUILD_INVALID',
  'IOS_WDA_OUTPUT_REFUSED','IOS_WDA_OUTPUT_OWNERSHIP_REFUSED','IOS_WDA_SESSION_TIMEOUT','IOS_WDA_REQUEST_TIMEOUT',
  'IOS_WDA_REQUEST_FAILED','IOS_WDA_RESPONSE_INVALID','IOS_WDA_SESSION_INVALID','IOS_WDA_CONTEXT_REFUSED',
  'IOS_WDA_OWNERSHIP_REFUSED','IOS_WDA_SESSION_CLEANUP_UNCONFIRMED','IOS_WDA_CAPTURE_LIMIT','IOS_WDA_PREFLIGHT_FAILED']);
const fail=code=>new Error(code),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&same(path.resolve(value),value)&&!/[\r\n\0]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sessionId=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,160}$/.test(value);

export function requireIosWdaCi({platform=process.platform,env=process.env}={}) {
  if(platform!=='darwin'||!env||typeof env!=='object'||env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.TESTLANE_IOS_PROOF_CI!=='1')throw fail('IOS_WDA_CI_REQUIRED');
}
export function fixedIosWdaCode(error) {
  if(CODES.has(error?.message))return error.message;
  const device=fixedIosDevicePreflightCode(error);
  return device==='IOS_DEVICE_PREFLIGHT_FAILED'?'IOS_WDA_PREFLIGHT_FAILED':device;
}
export function validateWdaBuildManifest(build,{sourceHashes,builderSHA256,appSHA256,architecture}={}) {
  if(!build||build.schemaVersion!==1||build.platform!=='ios-simulator'||build.package!==BUNDLE||build.proofOnly!==true||
    build.configuration!=='Release'||build.codeSigningAllowed!==false||build.embeddedBundle!==true||build.appDirectory!==PRODUCT||
    !['none','linker-ad-hoc'].includes(build.signature)||build.unsigned!==(build.signature==='none')||
    !['arm64','x86_64'].includes(architecture)||build.architecture!==architecture||
    !hash(appSHA256)||build.appSHA256!==appSHA256||!hash(builderSHA256)||build.builderSHA256!==builderSHA256||
    !build.publicSourceSHA256||!sourceHashes||JSON.stringify(Object.keys(build.publicSourceSHA256).sort())!==JSON.stringify([...SOURCES].sort())||
    SOURCES.some(file=>!hash(sourceHashes[file])||sourceHashes[file]!==build.publicSourceSHA256[file]))throw fail('IOS_WDA_BUILD_INVALID');
  return {appSHA256,builderSHA256,publicSourceSHA256:Object.fromEntries(SOURCES.map(file=>[file,sourceHashes[file]]))};
}
async function verifyBuild(appDirectory,signal) {
  try {
    if(!absolute(appDirectory)||path.basename(appDirectory)!==PRODUCT||!same(await realpath(appDirectory),appDirectory)||
      !(await lstat(appDirectory)).isDirectory()||(await lstat(appDirectory)).isSymbolicLink())throw Error();
    const manifestFile=path.join(path.dirname(appDirectory),'build-manifest.json'),info=await lstat(manifestFile);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error();
    const bytes=await readFile(manifestFile),sourceHashes={};
    for(const file of SOURCES){const source=path.join(APP_SOURCE,file),stat=await lstat(source);if(!stat.isFile()||stat.isSymbolicLink())throw Error();sourceHashes[file]=sha(await readFile(source));}
    const builderSHA256=sha(await readFile(path.join(APP_SOURCE,'build-ios.mjs'))),appSHA256=(await hashIosTree(appDirectory,{signal})).sha256;
    const checked=validateWdaBuildManifest(JSON.parse(bytes),{sourceHashes,builderSHA256,appSHA256,architecture:process.arch==='arm64'?'arm64':process.arch==='x64'?'x86_64':null});
    return {...checked,manifestSHA256:sha(bytes)};
  }catch{throw fail(signal?.aborted?'IOS_WDA_CANCELLED':'IOS_WDA_BUILD_INVALID');}
}
function capabilities(device) {
  return {platformName:'iOS','appium:automationName':'XCUITest','appium:udid':device.udid,'appium:bundleId':BUNDLE,
    'appium:simulatorDevicesSetPath':device.deviceSetPath,'appium:derivedDataPath':device.derivedDataPath,
    'appium:wdaLocalPort':device.wdaPort,'appium:wdaRemotePort':device.wdaPort,'appium:wdaBindingIP':'127.0.0.1',
    'appium:wdaBaseUrl':'http://127.0.0.1','appium:mjpegServerPort':device.mjpegPort,'appium:skipLogCapture':true,
    'appium:showIOSLog':false,'appium:showXcodeLog':true,'appium:printPageSourceOnFindFailure':false,
    'appium:disableAutomaticScreenshots':true,'appium:shutdownOtherSimulators':false,'appium:resetLocationService':false,
    'appium:noReset':true,'appium:isHeadless':true,'appium:newCommandTimeout':90,'appium:waitForIdleTimeout':1,
    'appium:wdaLaunchTimeout':120000,'appium:wdaConnectionTimeout':5000};
}
/** One fixed session attempt, one context read, one exact-session deletion. No app actions or credentials. */
export async function probeOwnedWdaSession({device,signal,onStage=()=>{},onRawResponse=()=>{}}) {
  let origin;
  try{const url=new URL(device.serverUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||typeof device.assertOwned!=='function')throw Error();origin=url.origin;}
  catch{throw fail('IOS_WDA_INPUT_INVALID');}
  let session,attempted=false,error,created=false,nativeContext=false,cleanup='not-created',sessionSetupMs=0;
  async function request(kind,{activeSignal=signal}={}) {
    if(activeSignal?.aborted)throw fail('IOS_WDA_CANCELLED');
    const timed=new AbortController(),budget=kind==='create'?240000:5000,timer=setTimeout(()=>timed.abort(),budget);
    const deadline=performance.now()+budget;
    const combined=activeSignal?AbortSignal.any([activeSignal,timed.signal]):timed.signal;
    const checkDeadline=()=>{if(performance.now()>=deadline){timed.abort();throw fail(kind==='create'?'IOS_WDA_SESSION_TIMEOUT':'IOS_WDA_REQUEST_TIMEOUT');}};
    try {
      const owned=await withDriverSignal(()=>device.assertOwned(),combined,()=>fail('IOS_WDA_CANCELLED'));
      if(owned!==true)throw fail('IOS_WDA_OWNERSHIP_REFUSED');
      if(combined.aborted)throw Error();
      checkDeadline();
      const route=kind==='create'?'/session':'/session/'+encodeURIComponent(session)+(kind==='context'?'/context':'');
      const response=await withDriverSignal(()=>fetch(origin+route,{method:kind==='create'?'POST':kind==='context'?'GET':'DELETE',signal:combined,redirect:'error',
        headers:{'Content-Type':'application/json'},...(kind==='create'?{body:JSON.stringify({capabilities:{alwaysMatch:capabilities(device),firstMatch:[{}]}})}:{})}),combined,()=>fail('IOS_WDA_CANCELLED'));
      const reader=response.body?.getReader();if(!reader)throw fail('IOS_WDA_RESPONSE_INVALID');
      let length=0;const chunks=[];
      for(;;){const {value,done}=await withDriverSignal(()=>reader.read(),combined,()=>fail('IOS_WDA_CANCELLED'));if(done)break;length+=value.byteLength;if(length>RESPONSE_LIMIT){await withDriverSignal(()=>reader.cancel(),combined,()=>fail('IOS_WDA_CANCELLED'));throw fail('IOS_WDA_RESPONSE_INVALID');}chunks.push(Buffer.from(value));}
      const raw=Buffer.concat(chunks).toString('utf8');let decoded;
      try{decoded=JSON.parse(raw);}catch{onRawResponse(raw);throw fail('IOS_WDA_RESPONSE_INVALID');}
      checkDeadline();
      if(!response.ok||!decoded||typeof decoded!=='object'||!Object.hasOwn(decoded,'value')||decoded.value?.error!==undefined){onRawResponse(raw);throw fail('IOS_WDA_REQUEST_FAILED');}
      return decoded.value;
    }catch(caught){
      if(activeSignal?.aborted)throw fail('IOS_WDA_CANCELLED');
      if(timed.signal.aborted)throw fail(kind==='create'?'IOS_WDA_SESSION_TIMEOUT':'IOS_WDA_REQUEST_TIMEOUT');
      throw fail(CODES.has(caught?.message)?caught.message:'IOS_WDA_REQUEST_FAILED');
    }finally{clearTimeout(timer);}
  }
  try{
    if(signal?.aborted)throw fail('IOS_WDA_CANCELLED');
    onStage('wda-session-create');attempted=true;const began=performance.now();
    let result;try{result=await request('create');}finally{sessionSetupMs=Math.round(performance.now()-began);}
    if(!sessionId(result?.sessionId))throw fail('IOS_WDA_SESSION_INVALID');
    session=result.sessionId;created=true;cleanup='unknown';
    onStage('native-context');if(await request('context')!=='NATIVE_APP')throw fail('IOS_WDA_CONTEXT_REFUSED');nativeContext=true;
  }catch(caught){error=caught;}
  finally{
    if(session){try{onStage('session-close');await request('delete',{activeSignal:null});cleanup='deleted';}catch{cleanup='unknown';error??=fail('IOS_WDA_SESSION_CLEANUP_UNCONFIRMED');}}
    else if(attempted)cleanup='not-addressable';
  }
  const result={sessionCreated:created,nativeContextVerified:nativeContext,sessionCleanup:cleanup,sessionSetupMs};
  if(error){const safe=fail(fixedIosWdaCode(error));Object.assign(safe,result);throw safe;}
  return result;
}
export function publicIosWdaStatus({stage,error,ownershipVerified=false,session={},deviceCleanup='not-started',elapsedMs=0,build}={}) {
  if(!error&&!(ownershipVerified===true&&session.sessionCreated===true&&session.nativeContextVerified===true&&session.sessionCleanup==='deleted'&&deviceCleanup==='completed'))error=fail('IOS_WDA_PREFLIGHT_FAILED');
  return {schemaVersion:1,purpose:'credential-free-wda-readiness',status:error?'failed':'passed',
    stage:STAGES.has(stage)?stage:'build-validation',code:error?fixedIosWdaCode(error):'IOS_WDA_READY',
    ownershipVerified:ownershipVerified===true,sessionCreated:session.sessionCreated===true,nativeContextVerified:session.nativeContextVerified===true,
    sessionCleanup:['not-created','deleted','unknown','not-addressable'].includes(session.sessionCleanup)?session.sessionCleanup:'not-created',
    deviceCleanup:['not-started','completed','unconfirmed'].includes(deviceCleanup)?deviceCleanup:'unconfirmed',
    sessionSetupMs:Number.isSafeInteger(session.sessionSetupMs)&&session.sessionSetupMs>=0?session.sessionSetupMs:0,
    elapsedMs:Number.isSafeInteger(elapsedMs)&&elapsedMs>=0?elapsedMs:0,
    ...(build&&hash(build.appSHA256)&&hash(build.manifestSHA256)?{appSHA256:build.appSHA256,buildManifestSHA256:build.manifestSHA256}:{}),node:process.version};
}
export async function runIosWdaPreflight({appDirectory,toolsRoot,outputDir,signal,onStage=()=>{}}={}) {
  if(signal?.aborted)throw fail('IOS_WDA_CANCELLED');requireIosWdaCi();
  if(!absolute(toolsRoot))throw fail('IOS_WDA_INPUT_INVALID');
  try{if(!same(await realpath(toolsRoot),toolsRoot)||(await lstat(toolsRoot)).isSymbolicLink())throw Error();}catch{throw fail('IOS_WDA_INPUT_INVALID');}
  let output;try{output=await validateIosDevicePreflightOutput(outputDir);}catch{throw fail('IOS_WDA_OUTPUT_REFUSED');}
  const began=performance.now(),marker={schemaVersion:1,purpose:'credential-free-wda-readiness',nonce:randomBytes(12).toString('hex'),ownerPid:process.pid,output};
  await mkdir(output,{mode:0o700});await writeFile(path.join(output,MARKER),JSON.stringify(marker)+'\n',{flag:'wx',mode:0o600});
  async function assertOutput(){
    const file=path.join(output,MARKER),info=await lstat(file);
    if(!same(await realpath(output),output)||(await lstat(output)).isSymbolicLink()||!info.isFile()||info.isSymbolicLink()||
      JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(marker))throw fail('IOS_WDA_OUTPUT_OWNERSHIP_REFUSED');
  }
  let device,error,build,session={},stage='build-validation',ownershipVerified=false,deviceCleanup='not-started',raw='';
  const at=name=>{if(STAGES.has(name)){stage=name;onStage(name);}};
  const append=text=>{if(typeof text!=='string'||Buffer.byteLength(raw)+Buffer.byteLength(text)>RESPONSE_LIMIT)throw fail('IOS_WDA_CAPTURE_LIMIT');raw+=text;};
  try{
    at('build-validation');build=await verifyBuild(appDirectory,signal);await assertOutput();
    at('device-start');const startup=new AbortController(),cancel=()=>startup.abort();
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)startup.abort();
    try{
      device=await startOwnedIos({toolsRoot,outputDir:path.join(output,'device'),signal:startup.signal,onStage:at,diagnostics:true});
      deviceCleanup='unconfirmed';await device.assertOwned();ownershipVerified=true;
      if(signal?.aborted)throw fail('IOS_WDA_CANCELLED');
      at('app-install');await device.installApp(appDirectory);
    }finally{signal?.removeEventListener('abort',cancel);}
    session=await probeOwnedWdaSession({device,signal,onStage:at,onRawResponse:append});
    const after=await verifyBuild(appDirectory,signal);
    if(JSON.stringify(after)!==JSON.stringify(build))throw fail('IOS_WDA_BUILD_INVALID');
  }catch(caught){
    error=caught;session={sessionCreated:typeof caught?.sessionCreated==='boolean'?caught.sessionCreated:session.sessionCreated===true,
      nativeContextVerified:typeof caught?.nativeContextVerified==='boolean'?caught.nativeContextVerified:session.nativeContextVerified===true,
      sessionCleanup:caught?.sessionCleanup??session.sessionCleanup,sessionSetupMs:caught?.sessionSetupMs??session.sessionSetupMs};
    if(!device&&typeof caught?.capturedText==='function')deviceCleanup=caught.message==='IOS_DEVICE_CLEANUP_UNCONFIRMED'?'unconfirmed':'completed';
  }finally{
    if(device)try{await device.close();deviceCleanup='completed';}catch{deviceCleanup='unconfirmed';error=fail('IOS_DEVICE_CLEANUP_UNCONFIRMED');}
  }
  if(signal?.aborted&&!error)error=fail('IOS_WDA_CANCELLED');
  if(!error&&(!session.sessionCreated||!session.nativeContextVerified||session.sessionCleanup!=='deleted'||deviceCleanup!=='completed'))error=fail('IOS_WDA_PREFLIGHT_FAILED');
  if(!error)at('complete');
  const status=publicIosWdaStatus({stage,error,ownershipVerified,session,deviceCleanup,elapsedMs:Math.round(performance.now()-began),build});
  await assertOutput();
  if(error){
    let captured='';try{captured=device?.capturedText()??error?.capturedText?.()??'';}catch{}
    if(typeof captured!=='string')captured='';
    const full=Buffer.from(captured+'\n'+raw,'utf8'),bytes=full.subarray(0,LIMIT);
    await writeFile(path.join(output,'preauth-wda.log'),bytes,{flag:'wx',mode:0o600});status.capture={bytes:bytes.length,truncated:full.length>LIMIT};
    if(deviceCleanup==='unconfirmed')await writeFile(path.join(output,'recovery.json'),JSON.stringify({schemaVersion:1,status:'manual-inspection-required',
      ...(device?{deviceSetPath:device.deviceSetPath,derivedDataPath:device.derivedDataPath,udid:device.udid}:{}),sessionWasCreated:session.sessionCreated===true})+'\n',{flag:'wx',mode:0o600});
  }
  await assertOutput();await writeFile(path.join(output,'status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx',mode:0o600});
  if(error)throw fail(status.code);return status;
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){const key={'--app':'appDirectory','--tools-root':'toolsRoot','--output-dir':'outputDir'}[args[i]];
    if(!key||options[key]||!args[i+1])throw fail('IOS_WDA_INPUT_INVALID');options[key]=path.resolve(args[++i]);}
  if(Object.keys(options).length!==3)throw fail('IOS_WDA_INPUT_INVALID');
  const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{console.log(JSON.stringify(await runIosWdaPreflight({...options,signal:controller.signal,onStage:name=>console.log('IOS_WDA_STAGE '+name)})));}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
function entry(){try{return same(realpathSync(process.argv[1]),realpathSync(fileURLToPath(import.meta.url)));}catch{return false;}}
if(entry())main().catch(error=>{console.error(fixedIosWdaCode(error));process.exitCode=1;});
