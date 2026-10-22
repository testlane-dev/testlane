#!/usr/bin/env node
/** Installed-package native iOS proof on an explicitly opted-in ephemeral hosted Mac. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdir,readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {consumerProject} from '../examples/playwright/tests/consumer.mjs';
import {sha,tree,digestTree,installedModule,proofProfiles,runProofPhases,writeNativeProofReceipt} from './native-proof-support.mjs';
import {publicIosFailure} from '../examples/ios-verification/failure.mjs';
import {readIosStartupFailure,retainIosStartupFailure,readIosStartupCommandObservation,retainIosStartupCommandObservation} from '../examples/ios-verification/failure-facts.mjs';

const BUNDLE='dev.testlane.iosproof';
export async function runIosProof({consumer,appDirectory,toolsRoot,outputDir,signal,onStage=()=>{},preauthControls=false}) {
  assert.equal(typeof preauthControls,'boolean');
  const load=file=>installedModule(consumer.packageRoot,file);
  const {startIosBroker,requireIosBrokerCi,scanIosCredentials}=await load('examples/ios-verification/broker.mjs');
  requireIosBrokerCi();signal?.throwIfAborted();
  const output=path.resolve(outputDir);await mkdir(output,{mode:0o700});await writeFile(path.join(output,'.gitignore'),'*\n',{flag:'wx'});
  const recovery=path.join(output,'recovery');await mkdir(recovery,{mode:0o700});
  const {startDemoApp}=await load('examples/verification-demo/app.mjs');
  const {startOwnedIos}=await load('examples/ios-verification/device.mjs');
  const {createNativeDriver}=await load('examples/ios-verification/driver.mjs');
  const {iosProofDriverOptions,verifyInstalledIosReadiness}=await load('examples/ios-verification/readiness.mjs');
  const {runNativeWorker}=await load('examples/android-verification/worker-host.mjs');
  const {validateNativePlan,sanitizeNativeReport}=await load('examples/android-verification/contracts.mjs');
  const {APPROVAL_REQUIREMENTS}=await load('examples/android-verification/proof-cases.mjs');
  const {NATIVE_PROOF_BUDGETS}=await load('examples/android-verification/budgets.mjs');
  const {hashIosTree}=await load('examples/mobile-approval-app/build-ios.mjs');
  const before=await digestTree(consumer.packageRoot),appRoot=await realpath(appDirectory);
  const manifestFile=path.join(path.dirname(appRoot),'build-manifest.json'),manifestBytes=await readFile(manifestFile),build=JSON.parse(manifestBytes);
  assert.equal(build.schemaVersion,1);assert.equal(build.platform,'ios-simulator');assert.equal(build.package,BUNDLE);
  assert.equal(build.proofOnly,true);assert.equal(build.configuration,'Release');assert.ok(['none','linker-ad-hoc'].includes(build.signature));
  assert.equal(build.unsigned,build.signature==='none');
  assert.equal(build.codeSigningAllowed,false);assert.equal(build.embeddedBundle,true);
  assert.ok(['arm64','x86_64'].includes(build.architecture));
  assert.equal(build.builderSHA256,sha(await readFile(path.join(consumer.packageRoot,'examples/mobile-approval-app/build-ios.mjs'))),'installed builder matches the compiled build manifest');
  const appTree=await hashIosTree(appRoot);assert.equal(appTree.sha256,build.appSHA256);
  const publicFiles=['package.json','package-lock.json','app.ios.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withIosProofBuild.cjs'];
  assert.deepEqual(Object.keys(build.publicSourceSHA256).sort(),[...publicFiles].sort());
  for(const file of publicFiles)assert.equal(build.publicSourceSHA256[file],sha(await readFile(path.join(consumer.packageRoot,'examples/mobile-approval-app',file))),'installed app source matches the compiled build inputs');
  const namespace='ios-'+randomBytes(8).toString('hex');
  let accounts={},identities;
  let app,device,broker,receipt,wdaReadiness,captured='',audit='',stage='setup',workerUnconfirmed=false,deviceStartUnconfirmed=false,brokerRecovery,startupFailure,startupCommandObservation;
  const at=name=>{stage=name;onStage(name);};const attempted=new Set();
  try {
    at('owned-simulator-start');
    const startup=new AbortController(),cancelStartup=()=>startup.abort();
    signal?.addEventListener('abort',cancelStartup,{once:true});if(signal?.aborted)startup.abort();
    try{device=await startOwnedIos({toolsRoot,outputDir:path.join(output,'device'),signal:startup.signal,onStage:name=>at('device-'+name),prewarmDiagnostics:true});}
    finally{signal?.removeEventListener('abort',cancelStartup);}
    signal?.throwIfAborted();await device.installApp(appRoot);
    at('app-prewarm');assert.deepEqual(await device.prewarmProofApp(),{appPrewarmed:true});
    await device.assertWdaPrepared();
    const driverOptions=iosProofDriverOptions(device);
    at('wda-readiness');
    let controlResult;
    try{wdaReadiness=await verifyInstalledIosReadiness({createNativeDriver,driverOptions,assertOwned:()=>device.assertOwned(),signal,appPrewarmed:true,
      preauthControls,onPreauthControls:value=>{controlResult=value;}});}
    finally{if(preauthControls&&controlResult)await writeFile(path.join(output,'preauth-controls.json'),JSON.stringify(controlResult,null,2)+'\n',{flag:'wx',mode:0o600});}
    await device.assertWdaPrepared();
    signal?.throwIfAborted();
    await writeFile(path.join(output,'readiness.json'),JSON.stringify(wdaReadiness,null,2)+'\n',{flag:'wx',mode:0o600});
    signal?.throwIfAborted();
    accounts=Object.fromEntries(['editor','reviewer'].map(role=>[role,{email:namespace+'-'+role+'@example.test',role:role==='editor'?'Editor':'Reviewer',password:randomBytes(32).toString('base64url')}]));
    identities=Object.fromEntries(Object.entries(accounts).map(([role,{email,role:label}])=>[role,{email,role:label}]));
    at('broker-setup');app=await startDemoApp({accounts});
    try{broker=await startIosBroker({packageRoot:consumer.packageRoot,registry:proofProfiles(namespace,app.origin,accounts,'testlane-ios-proof'),signal});}
    catch(error){brokerRecovery=error.root;throw error;}
    const cookies={};
    for(const [role,account] of Object.entries(accounts)){
      const profile=namespace+':testing:'+role;attempted.add(profile);
      assert.equal((await broker.cli(['store','set',profile],{input:account.password})).code,0,'generated password is seeded through the actual CLI over stdin');
      const file=path.join(consumer.sessionTemp,role+'.json');
      try{
        assert.equal((await broker.cli(['session',profile,'--format','storage-state','--out',file])).code,0,'the real broker issues a live session');
        const state=JSON.parse(await readFile(file,'utf8')),cookie=state.cookies.filter(item=>item.name==='tldemo_session');
        assert.equal(cookie.length,1);assert.match(cookie[0].value,/^[A-Za-z0-9_-]+$/);cookies[role]='tldemo_session='+cookie[0].value;
      }finally{await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
    const plan=validateNativePlan({schemaVersion:1,runner:'ios-xcuitest',status:'reviewed',title:'Synthetic native approval proof',
      target:{baseUrl:app.origin,environment:'testing'},app:{bundleId:BUNDLE,buildSha256:appTree.sha256},
      cases:APPROVAL_REQUIREMENTS.map(item=>({...item,cleanup:{required:item.id!=='anonymous-denied',description:item.id==='anonymous-denied'?'No state is created':'Delete only the unique owned marker and verify absence'}}))});
    const result=await runProofPhases({consumer,app,device,plan,cookies,identities,output,before,
      runWorker:async options=>{await device.assertWdaPrepared();return runNativeWorker(options);},sanitize:sanitizeNativeReport,signal,
      workerTimeoutMs:NATIVE_PROOF_BUDGETS.workerMs,onStage:at,onCaptured:value=>{captured+=value;},onWorkerRisk:()=>{workerUnconfirmed=true;},
      assertBuildUnchanged:async()=>{assert.equal((await hashIosTree(appRoot)).sha256,appTree.sha256);assert.equal(sha(await readFile(manifestFile)),sha(manifestBytes));await device.assertWdaPrepared();},
      driverOptions});
    receipt={schemaVersion:1,passed:true,runner:'ios-xcuitest',context:'NATIVE_APP',proofOnly:true,deviceScope:device.deviceBinding.scope,appPrewarmed:true,nativeStore:'keychain-macos',
      wdaPreparation:device.wdaPreparation,wdaReadiness,wdaStartupPatch:device.wdaStartupPatch,
      brokerEntry:'installed runCli with explicit temporary KeychainMacosStore',packageTreeSha256:before,appSha256:appTree.sha256,
      buildManifestSha256:sha(manifestBytes),publicAppSourceSha256:build.publicSourceSHA256,versions:device.versions,budgets:NATIVE_PROOF_BUDGETS,...result};
    if(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??'')&&/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID??''))
      receipt.ci={sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID};
  }catch(error){
    if(!device&&error?.message==='IOS_DEVICE_CLEANUP_UNCONFIRMED')deviceStartUnconfirmed=true;
    startupFailure=readIosStartupFailure(error);
    startupCommandObservation=readIosStartupCommandObservation(error);
    if(typeof error?.capturedText==='function')captured+=error.capturedText();
    // The backend, keychain and broker have not started. A credential-free
    // readiness session may exist; no credential reached native tools.
    if(!app&&!broker){
      // Fixed observations never authorize raw diagnostic access or establish a cause.
      if(startupCommandObservation)try{await writeFile(path.join(output,'startup-command-observation.json'),JSON.stringify(startupCommandObservation)+'\n',{flag:'wx',mode:0o600});}catch{}
      const startupText=captured+(device?.capturedText()??'');
      scanIosCredentials(startupText,Object.values(accounts).map(item=>item.password));
      await writeFile(path.join(output,'preauth-device.log'),startupText,{flag:'wx',mode:0o600});
    }
    if(/TERMINATION_UNCONFIRMED|STOP_UNCONFIRMED/.test(String(error?.code??error?.message??'')))workerUnconfirmed=true;
    throw error;
  }finally{
    const priorStage=stage;at('cleanup');const errors=[...(workerUnconfirmed?['worker-stop']:[]),...(deviceStartUnconfirmed?['device-start']:[])];let deviceStopped=false;
    if(device){try{await device.close();deviceStopped=true;}catch{errors.push('device-stop');}
      try{captured+=device.capturedText();}catch{errors.push('device-capture');}}
    if(broker){
      const credentialsMayBeCleaned=deviceStopped&&!workerUnconfirmed;
      if(!credentialsMayBeCleaned)errors.push('credential-cleanup-deferred');
      for(const profile of credentialsMayBeCleaned?attempted:[]){
        try{if((await broker.cli(['store','delete',profile],{signal:null})).code!==0)errors.push('native-store-delete');}catch{errors.push('native-store-delete');}
        try{if((await broker.cli(['check',profile],{signal:null})).code!==4)errors.push('native-store-absence');}catch{errors.push('native-store-absence');}
      }
      try{audit=await broker.auditText();}catch{errors.push('audit-read');}
      const secrets=[...Object.values(accounts).map(item=>item.password),...app.issuedSessionTokens()];
      try{broker.scan(captured+(await tree(output)).map(([,bytes])=>bytes.toString('utf8')).join('\n')+audit,secrets);}catch{errors.push('privacy-scan');}
      if(credentialsMayBeCleaned)try{await broker.dispose({removeHome:errors.length===0});}catch{errors.push('temporary-keychain-cleanup');}
      try{broker.scan(captured+audit,secrets);}catch{errors.push('privacy-scan');}
    }else if(brokerRecovery)errors.push('broker-start-recovery');
    try{if(app?.records().length)errors.push('owned-records');}catch{errors.push('owned-records');}
    try{if((await readdir(recovery)).length)errors.push('recovery-journal');}catch{errors.push('recovery-journal');}
    try{await app?.close();}catch{errors.push('backend-stop');}
    if(errors.length){
      const brokerRoot=broker?.root??brokerRecovery;
      const error=retainIosStartupCommandObservation(retainIosStartupFailure(Error('IOS_PROOF_CLEANUP_INCOMPLETE'),startupFailure),startupCommandObservation);error.preserveConsumer=true;
      try{await writeFile(path.join(output,'cleanup-status.json'),JSON.stringify({status:'incomplete',steps:[...new Set(errors)],consumerRoot:consumer.root,...(brokerRoot?{brokerRoot}:{})})+'\n',{mode:0o600});}catch{}
      throw error;
    }
    at(priorStage);
  }
  if(signal?.aborted)throw Error('IOS_CANCELLED');
  assert.equal((await readdir(consumer.sessionTemp)).length,0);
  if(signal?.aborted)throw Error('IOS_CANCELLED');
  receipt.cleanupVerified=true;receipt.credentialLeakScanPassed=true;
  return writeNativeProofReceipt({outputDir:output,receipt,signal,cancelCode:'IOS_CANCELLED'});
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--preauth-controls'){if(options.preauthControls)throw Error('IOS_PROOF_ARGUMENTS_INVALID');options.preauthControls=true;continue;}
    const key={'--app':'appDirectory','--tools-root':'toolsRoot','--output-dir':'outputDir'}[args[i]];
    if(!key||options[key]||!args[i+1])throw Error('IOS_PROOF_ARGUMENTS_INVALID');options[key]=path.resolve(args[++i]);
  }
  assert.ok(options.appDirectory&&options.toolsRoot&&options.outputDir,'--app, --tools-root and a NEW --output-dir are required');
  const entryExitCode=process.exitCode,provisional=entryExitCode===undefined||entryExitCode===0;
  if(provisional)process.exitCode=1;
  const markFailure=()=>{if(process.exitCode===undefined||process.exitCode===0)process.exitCode=1;};
  const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  let consumer,preserve=false,stage='consumer-install',result,failure,projectFailure=publicIosFailure;
  const checkpoint=createIosProofCheckpointEmitter();
  try{
    if(!provisional)throw Error('NATIVE_PROOF_COMPLETION_REFUSED');
    try{
      consumer=await consumerProject({tarball:process.env.TESTLANE_PACKAGE_TARBALL});
      // Cache the installed class-aware projector before consumer deletion.
      projectFailure=(await installedModule(consumer.packageRoot,'examples/ios-verification/failure.mjs')).publicIosFailure;
      result=await runIosProof({...options,consumer,signal:controller.signal,onStage:name=>{stage=name;console.log('IOS_PROOF_STAGE '+name);checkpoint(name);}});
    }catch(error){failure={error};preserve=error?.preserveConsumer===true;}
    finally{
      try{if(!preserve)await consumer?.dispose();}
      catch{console.error('FAIL iOS proof consumer cleanup');failure??={error:Error('NATIVE_PROOF_CONSUMER_CLEANUP_FAILED')};markFailure();}
    }
    if(failure)throw failure.error;
    if(controller.signal.aborted)throw Error('IOS_CANCELLED');
    if(process.exitCode!==1)throw Error('NATIVE_PROOF_COMPLETION_REFUSED');
    // Final synchronous commit: no awaited cleanup follows stdout success.
    console.log(JSON.stringify(result));process.exitCode=0;
  }catch(error){
    const summary=await projectFailure({output:options.outputDir,stage,error});
    try{await writeFile(path.join(options.outputDir,'public-failure.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});}catch{}
    console.error('FAIL iOS proof at fixed stage: '+summary.stage+' ('+summary.code+')');markFailure();
  }
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
// Fixed, best-effort breadcrumbs only: an uploaded checkpoint establishes no
// later phase, credential absence, termination, cleanup or evidence permission.
function createIosProofCheckpointEmitter() {
  const notices=new Map([
    ['owned-simulator-start','::notice title=Testlane iOS checkpoint::Checkpoint observed: owned-simulator-start; subsequent state unknown.'],
    ['device-xcode-runtime-and-pinned-tools-validated','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-xcode-runtime-and-pinned-tools-validated; subsequent state unknown.'],
    ['device-owned-simulator-created','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-owned-simulator-created; subsequent state unknown.'],
    ['device-wda-build-for-testing','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-wda-build-for-testing; subsequent state unknown.'],
    ['device-wda-prepared','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-wda-prepared; subsequent state unknown.'],
    ['device-owned-simulator-boot-started','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-owned-simulator-boot-started; subsequent state unknown.'],
    ['device-owned-simulator-booted','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-owned-simulator-booted; subsequent state unknown.'],
    ['device-private-appium-ready','::notice title=Testlane iOS checkpoint::Checkpoint observed: device-private-appium-ready; subsequent state unknown.'],
    ['app-prewarm','::notice title=Testlane iOS checkpoint::Checkpoint observed: app-prewarm; subsequent state unknown.'],
    ['wda-readiness','::notice title=Testlane iOS checkpoint::Checkpoint observed: wda-readiness; subsequent state unknown.'],
    ['broker-setup','::notice title=Testlane iOS checkpoint::Checkpoint observed: broker-setup; subsequent state unknown.'],
    ['positive','::notice title=Testlane iOS checkpoint::Checkpoint observed: positive; subsequent state unknown.'],
    ['fault','::notice title=Testlane iOS checkpoint::Checkpoint observed: fault; subsequent state unknown.'],
    ['corrected','::notice title=Testlane iOS checkpoint::Checkpoint observed: corrected; subsequent state unknown.'],
    ['cleanup','::notice title=Testlane iOS checkpoint::Checkpoint observed: cleanup; subsequent state unknown.'],
  ]);
  const seen=new Set();
  return stage=>{
    if(typeof stage!=='string'||process.env.GITHUB_ACTIONS!=='true'||seen.has(stage))return;
    const notice=notices.get(stage);if(notice===undefined)return;
    seen.add(stage);try{console.log(notice);}catch{/* Delivery never changes the proof outcome. */}
  };
}
function entry(){try{return realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}}
if(entry())main().catch(()=>{console.error('FAIL iOS proof arguments or prerequisites');if(process.exitCode===undefined||process.exitCode===0)process.exitCode=2;});
