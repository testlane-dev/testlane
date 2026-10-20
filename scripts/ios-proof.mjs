#!/usr/bin/env node
/** Installed-package native iOS proof on an explicitly opted-in ephemeral hosted Mac. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdir,readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {consumerProject} from '../examples/playwright/tests/consumer.mjs';
import {sha,tree,digestTree,installedModule,proofProfiles,runProofPhases} from './native-proof-support.mjs';
import {publicIosFailure} from '../examples/ios-verification/failure.mjs';

const BUNDLE='dev.testlane.iosproof';
export async function runIosProof({consumer,appDirectory,toolsRoot,outputDir,signal,onStage=()=>{}}) {
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
  let app,device,broker,receipt,wdaReadiness,captured='',audit='',stage='setup',workerUnconfirmed=false,brokerRecovery;
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
    wdaReadiness=await verifyInstalledIosReadiness({createNativeDriver,driverOptions,assertOwned:()=>device.assertOwned(),signal,appPrewarmed:true});
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
      wdaPreparation:device.wdaPreparation,wdaReadiness,
      brokerEntry:'installed runCli with explicit temporary KeychainMacosStore',packageTreeSha256:before,appSha256:appTree.sha256,
      buildManifestSha256:sha(manifestBytes),publicAppSourceSha256:build.publicSourceSHA256,versions:device.versions,budgets:NATIVE_PROOF_BUDGETS,...result};
    if(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??'')&&/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID??''))
      receipt.ci={sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID};
  }catch(error){
    if(typeof error?.capturedText==='function')captured+=error.capturedText();
    // The backend, keychain and broker have not started. A credential-free
    // readiness session may exist; no credential reached native tools.
    if(!app&&!broker){
      const startupText=captured+(device?.capturedText()??'');
      scanIosCredentials(startupText,Object.values(accounts).map(item=>item.password));
      await writeFile(path.join(output,'preauth-device.log'),startupText,{flag:'wx',mode:0o600});
    }
    if(/TERMINATION_UNCONFIRMED|STOP_UNCONFIRMED/.test(String(error?.code??error?.message??'')))workerUnconfirmed=true;
    throw error;
  }finally{
    const priorStage=stage;at('cleanup');const errors=workerUnconfirmed?['worker-stop']:[];
    if(device){try{await device.close();}catch{errors.push('device-stop');}captured+=device.capturedText();}
    if(broker){
      for(const profile of attempted){
        try{if((await broker.cli(['store','delete',profile],{signal:null})).code!==0)errors.push('native-store-delete');}catch{errors.push('native-store-delete');}
        try{if((await broker.cli(['check',profile],{signal:null})).code!==4)errors.push('native-store-absence');}catch{errors.push('native-store-absence');}
      }
      try{audit=await broker.auditText();}catch{errors.push('audit-read');}
      const secrets=[...Object.values(accounts).map(item=>item.password),...app.issuedSessionTokens()];
      try{broker.scan(captured+(await tree(output)).map(([,bytes])=>bytes.toString('utf8')).join('\n')+audit,secrets);}catch{errors.push('privacy-scan');}
      try{await broker.dispose({removeHome:errors.length===0});}catch{errors.push('temporary-keychain-cleanup');}
      try{broker.scan(captured+audit,secrets);}catch{errors.push('privacy-scan');}
    }else if(brokerRecovery)errors.push('broker-start-recovery');
    if(app?.records().length)errors.push('owned-records');if((await readdir(recovery)).length)errors.push('recovery-journal');
    try{await app?.close();}catch{errors.push('backend-stop');}
    if(errors.length){
      const brokerRoot=broker?.root??brokerRecovery;
      await writeFile(path.join(output,'cleanup-status.json'),JSON.stringify({status:'incomplete',steps:[...new Set(errors)],consumerRoot:consumer.root,...(brokerRoot?{brokerRoot}:{})})+'\n',{mode:0o600});
      const error=Error('IOS_PROOF_CLEANUP_INCOMPLETE');error.preserveConsumer=true;throw error;
    }
    at(priorStage);
  }
  assert.equal((await readdir(consumer.sessionTemp)).length,0);
  receipt.cleanupVerified=true;receipt.credentialLeakScanPassed=true;
  await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    const key={'--app':'appDirectory','--tools-root':'toolsRoot','--output-dir':'outputDir'}[args[i]];
    if(!key||options[key]||!args[i+1])throw Error('IOS_PROOF_ARGUMENTS_INVALID');options[key]=path.resolve(args[++i]);
  }
  assert.ok(options.appDirectory&&options.toolsRoot&&options.outputDir,'--app, --tools-root and a NEW --output-dir are required');
  const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  let consumer,preserve=false,stage='consumer-install';
  try{
    consumer=await consumerProject({tarball:process.env.TESTLANE_PACKAGE_TARBALL});
    const result=await runIosProof({...options,consumer,signal:controller.signal,onStage:name=>{stage=name;console.log('IOS_PROOF_STAGE '+name);}});
    console.log(JSON.stringify(result));
  }catch(error){
    preserve=error.preserveConsumer===true;
    const summary=await publicIosFailure({output:options.outputDir,stage,error});
    try{await writeFile(path.join(options.outputDir,'public-failure.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});}catch{}
    console.error('FAIL iOS proof at fixed stage: '+summary.stage+' ('+summary.code+')');process.exitCode=1;
  }
  finally{
    try{if(!preserve)await consumer?.dispose();}catch{console.error('FAIL iOS proof consumer cleanup');process.exitCode=1;}
    process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
  }
}
function entry(){try{return realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}}
if(entry())main().catch(()=>{console.error('FAIL iOS proof arguments or prerequisites');process.exitCode=2;});
