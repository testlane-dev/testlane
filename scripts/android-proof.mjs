#!/usr/bin/env node
/** Installed-package acceptance against a NEW owned Android emulator. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdir,readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {consumerProject,assertNoLeaks} from '../examples/playwright/tests/consumer.mjs';
import {createRealBrokerHarness,realBrokerSupport} from '../examples/workflows/test-support/real-broker.mjs';

import {sha,tree,digestTree,installedModule,proofProfiles,runProofPhases} from './native-proof-support.mjs';
const PACKAGE='dev.testlane.androidproof';
export async function runAndroidProof({consumer,apkFile,outputDir,sdkRoot,javaHome,toolsRoot,systemImagePath,signal,onStage=()=>{}}) {
  signal?.throwIfAborted();
  const support=realBrokerSupport();assert.ok(support.supported,'requires DPAPI or explicitly isolated Linux Secret Service');
  const output=path.resolve(outputDir);await mkdir(output,{mode:0o700});
  await writeFile(path.join(output,'.gitignore'),'*\n',{flag:'wx'});
  const recovery=path.join(output,'recovery');await mkdir(recovery,{mode:0o700});
  const moduleFrom=file=>installedModule(consumer.packageRoot,file);
  const {startDemoApp}=await moduleFrom('examples/verification-demo/app.mjs');
  const {runDemoChild}=await moduleFrom('examples/verification-demo/native.mjs');
  const {startOwnedAndroid}=await moduleFrom('examples/android-verification/device.mjs');
  const {createNativeDriver}=await moduleFrom('examples/android-verification/driver.mjs');
  const {androidProofDriverOptions,verifyInstalledAndroidReadiness,androidReadinessFailure}=await moduleFrom('examples/android-verification/readiness.mjs');
  const {runNativeWorker}=await moduleFrom('examples/android-verification/worker-host.mjs');
  const {validateNativePlan,sanitizeNativeReport}=await moduleFrom('examples/android-verification/contracts.mjs');
  const {APPROVAL_REQUIREMENTS}=await moduleFrom('examples/android-verification/proof-cases.mjs');
  const {NATIVE_PROOF_BUDGETS}=await moduleFrom('examples/android-verification/budgets.mjs');
  const before=await digestTree(consumer.packageRoot),apkSha256=sha(await readFile(apkFile));
  const buildManifestFile=path.join(path.dirname(apkFile),'build-manifest.json');
  const buildBytes=await readFile(buildManifestFile),build=JSON.parse(buildBytes);
  assert.equal(build.package,PACKAGE);assert.equal(build.proofOnly,true);assert.equal(build.embeddedBundle,true);
  assert.equal(build.debuggable,true);assert.equal(build.architecture,'x86_64');assert.equal(build.apkSHA256,apkSha256);
  const publicFiles=['package.json','package-lock.json','app.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withProofBuild.cjs'];
  assert.deepEqual(Object.keys(build.publicSourceSHA256).sort(),[...publicFiles].sort());
  for(const file of publicFiles)assert.equal(build.publicSourceSHA256[file],sha(await readFile(path.join(consumer.packageRoot,'examples/mobile-approval-app',file))),'APK build inputs match installed public app source');
  const namespace='android-'+randomBytes(8).toString('hex');
  let accounts={},identities,preauthDiagnosticsAllowed=true;
  let app,harness,device,cli,captured='',receipt,androidReadiness,cleanupOK=true,stage='setup',workerUnconfirmed=false,deviceStartUnconfirmed=false;const attempted=new Set();
  const at=name=>{stage=name;onStage(name);};
  try {
    at('owned-device-start');
    const startup=new AbortController(),cancelStartup=()=>startup.abort();
    signal?.addEventListener('abort',cancelStartup,{once:true});
    if(signal?.aborted)startup.abort();
    try {device=await startOwnedAndroid({sdkRoot,javaHome,toolsRoot,systemImagePath,outputDir:path.join(output,'device'),signal:startup.signal,
      onStage:name=>at('device-'+name)});}
    finally {signal?.removeEventListener('abort',cancelStartup);}
    signal?.throwIfAborted();await device.installApk(apkFile);
    const driverOptions=androidProofDriverOptions(device);
    at('android-readiness');
    androidReadiness=await verifyInstalledAndroidReadiness({createNativeDriver,driverOptions,assertOwned:()=>device.assertOwned(),signal});
    signal?.throwIfAborted();
    assert.equal(await digestTree(consumer.packageRoot),before);
    assert.equal(sha(await readFile(apkFile)),apkSha256);assert.equal(sha(await readFile(buildManifestFile)),sha(buildBytes));
    await writeFile(path.join(output,'readiness.json'),JSON.stringify(androidReadiness,null,2)+'\n',{flag:'wx',mode:0o600});
    signal?.throwIfAborted();
    // Revoke before allocation starts: a partial allocation can throw while
    // accounts is still empty, but native logs must never become eligible again.
    preauthDiagnosticsAllowed=false;at('credential-allocation');
    accounts=Object.fromEntries(['editor','reviewer'].map(role=>[role,{email:namespace+'-'+role+'@example.test',role:role==='editor'?'Editor':'Reviewer',password:randomBytes(32).toString('base64url')}]));
    identities=Object.fromEntries(Object.entries(accounts).map(([role,{email,role:label}])=>[role,{email,role:label}]));
    at('broker-setup');app=await startDemoApp({accounts});
    harness=await createRealBrokerHarness({brokerCli:consumer.brokerCli,support,registry:proofProfiles(namespace,app.origin,accounts)});
    const env={...harness.env,DEBUG:'',NODE_DEBUG:'',NODE_OPTIONS:'',TMP:consumer.sessionTemp,TEMP:consumer.sessionTemp,TMPDIR:consumer.sessionTemp};
    cli=async(args,options={})=>{
      try {const result=await runDemoChild({entry:consumer.brokerCli,args,cwd:consumer.root,env,timeoutMs:35000,signal,...options});captured+=result.stdout+result.stderr;return result;}
      catch(error){if(error.message==='DEMO_CHILD_TERMINATION_UNCONFIRMED')cleanupOK=false;throw error;}
    };
    const cookies={};
    for(const [role,account] of Object.entries(accounts)) {
      const profile=namespace+':testing:'+role;attempted.add(profile);
      assert.equal((await cli(['store','set',profile],{input:account.password})).code,0,'seed generated password over stdin');
      const file=path.join(consumer.sessionTemp,role+'.json');
      try {
        assert.equal((await cli(['session',profile,'--format','storage-state','--out',file])).code,0,'real broker issues authenticated session');
        const state=JSON.parse(await readFile(file,'utf8'));
        const cookie=state.cookies.filter(item=>item.name==='tldemo_session');
        assert.equal(cookie.length,1);assert.match(cookie[0].value,/^[A-Za-z0-9_-]+$/);
        cookies[role]='tldemo_session='+cookie[0].value;
      } finally {await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
    const port=new URL(app.origin).port;
    await device.adb(['reverse','tcp:'+port,'tcp:'+port]);
    const plan=validateNativePlan({schemaVersion:1,runner:'android-uiautomator2',status:'reviewed',title:'Synthetic native approval proof',
      target:{baseUrl:app.origin,environment:'testing'},app:{package:PACKAGE,apkSha256},
      cases:APPROVAL_REQUIREMENTS.map(item=>({...item,cleanup:{required:item.id!=='anonymous-denied',description:item.id==='anonymous-denied'?'No state is created':'Delete only the unique owned marker and verify absence'}}))});
    const result=await runProofPhases({consumer,app,device,plan,cookies,identities,output,before,runWorker:runNativeWorker,sanitize:sanitizeNativeReport,signal,
      workerTimeoutMs:NATIVE_PROOF_BUDGETS.workerMs,onStage:at,onCaptured:value=>{captured+=value;},onWorkerRisk:()=>{workerUnconfirmed=true;},
      assertBuildUnchanged:async()=>{assert.equal(sha(await readFile(apkFile)),apkSha256);assert.equal(sha(await readFile(buildManifestFile)),sha(buildBytes));},
      driverOptions});
    receipt={schemaVersion:1,passed:true,runner:'android-uiautomator2',context:'NATIVE_APP',proofOnly:true,nativeStore:support.store,
      packageTreeSha256:before,apkSha256,buildManifestSha256:sha(buildBytes),publicAppSourceSha256:Object.fromEntries(publicFiles.map(file=>[file,build.publicSourceSHA256[file]])),
      androidReadiness,versions:device.versions,budgets:NATIVE_PROOF_BUDGETS,...result};
  } catch(error) {
    // A factory can fail its own teardown before returning a device handle.
    // Arm preservation before diagnostic work, which may itself fail.
    if(!device&&error?.message==='ANDROID_DEVICE_CLEANUP_UNCONFIRMED')deviceStartUnconfirmed=true;
    if(/TERMINATION_UNCONFIRMED|STOP_UNCONFIRMED/.test(String(error?.code??error?.message??'')))workerUnconfirmed=true;
    if(typeof error?.capturedText==='function')captured+=error.capturedText();
    // Only setup before even generating passwords may retain existing bounded
    // error-level native output. Authenticated failures never write this log.
    if(preauthDiagnosticsAllowed&&Object.keys(accounts).length===0&&!app&&!harness){
      const startupText=captured+(device?.capturedText()??'');
      assert.ok(Buffer.byteLength(startupText)<=8*1024*1024,'existing native capture bound');
      assertNoLeaks(startupText,Object.values(accounts).map(item=>item.password));
      await writeFile(path.join(output,'preauth-device.log'),startupText,{flag:'wx',mode:0o600});
      if(stage==='android-readiness')await writeFile(path.join(output,'readiness-failure.json'),JSON.stringify(androidReadinessFailure(error),null,2)+'\n',{flag:'wx',mode:0o600});
    }
    throw error;
  } finally {
    const priorStage=stage;at('cleanup');
    const errors=workerUnconfirmed?['worker-stop']:[];
    if(deviceStartUnconfirmed)errors.push('device-start');
    if(device) {
      try{await device.close();}catch{errors.push('device-stop');}
      try{captured+=device.capturedText();}catch{errors.push('device-diagnostics');}
    }
    const nativeStopped=!workerUnconfirmed&&!deviceStartUnconfirmed&&!errors.includes('device-stop');
    if(harness&&nativeStopped) {
      for(const profile of attempted) {
        try {if((await cli(['store','delete',profile],{signal:null})).code!==0)cleanupOK=false;}catch{cleanupOK=false;}
        try {if((await cli(['check',profile],{signal:null})).code!==4)cleanupOK=false;}catch{cleanupOK=false;}
      }
      try {
        const publicText=(await tree(output)).map(([,bytes])=>bytes.toString('utf8')).join('\n');
        assertNoLeaks(captured+publicText+await harness.auditText(),[...Object.values(accounts).map(item=>item.password),...app.issuedSessionTokens()]);
      }catch{errors.push('privacy-scan');}
      if(cleanupOK)try{await harness.dispose();}catch{errors.push('broker-home');}
      else errors.push('native-store');
    } else if(harness) errors.push('credential-cleanup-deferred');
    try{if(app?.records().length)errors.push('owned-records');}catch{errors.push('owned-records');}
    try{if((await readdir(recovery)).length)errors.push('recovery-journal');}catch{errors.push('recovery-journal');}
    try{await app?.close();}catch{errors.push('backend-stop');}
    if(errors.length) {
      const error=Error('ANDROID_PROOF_CLEANUP_INCOMPLETE');error.preserveConsumer=true;
      try{await writeFile(path.join(output,'cleanup-status.json'),JSON.stringify({status:'incomplete',steps:errors,consumerRoot:consumer.root})+'\n',{mode:0o600});}
      catch{/* Metadata failure cannot revoke preservation of uncertain owned state. */}
      throw error;
    }
    at(priorStage);
  }
  assert.equal((await readdir(consumer.sessionTemp)).length,0);
  receipt.cleanupVerified=true;receipt.credentialLeakScanPassed=true;
  await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
}

async function main() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++) {
    const key={'--apk':'apkFile','--output-dir':'outputDir','--sdk-root':'sdkRoot','--java-home':'javaHome','--tools-root':'toolsRoot','--system-image':'systemImagePath'}[args[i]];
    if(!key||options[key]||!args[i+1])throw Error('ANDROID_ARGUMENTS_INVALID');options[key]=path.resolve(args[++i]);
  }
  assert.ok(options.apkFile&&options.outputDir&&options.toolsRoot,'--apk, --tools-root and a NEW --output-dir are required');
  options.sdkRoot??=process.env.ANDROID_HOME??process.env.ANDROID_SDK_ROOT;
  options.javaHome??=process.env.JAVA_HOME;
  if(options.sdkRoot)options.systemImagePath??=path.join(options.sdkRoot,'system-images/android-34/google_apis/x86_64');
  let consumer,preserveConsumer=false;let stage='consumer-install';
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try {consumer=await consumerProject({tarball:process.env.TESTLANE_PACKAGE_TARBALL});
    const result=await runAndroidProof({...options,consumer,signal:controller.signal,onStage:name=>{stage=name;console.log('ANDROID_PROOF_STAGE '+name);}});console.log(JSON.stringify(result));
  }catch(error){preserveConsumer=error?.preserveConsumer===true;console.error('FAIL Android proof at fixed stage: '+stage);process.exitCode=1;}
  finally{try{if(!preserveConsumer)await consumer?.dispose();}catch{console.error('FAIL Android proof consumer cleanup');process.exitCode=1;}
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
function isEntryPoint() {
  try {
    const entry=realpathSync(process.argv[1]),self=realpathSync(fileURLToPath(import.meta.url));
    return process.platform==='win32'?entry.toLowerCase()===self.toLowerCase():entry===self;
  }catch{return false;}
}
if(isEntryPoint())try{await main();}catch{console.error('FAIL Android proof arguments or prerequisites');process.exitCode=2;}
