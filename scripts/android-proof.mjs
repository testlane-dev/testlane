#!/usr/bin/env node
/** Installed-package acceptance against a NEW owned Android emulator. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdir,readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {consumerProject,assertNoLeaks} from '../examples/playwright/tests/consumer.mjs';
import {createRealBrokerHarness,realBrokerSupport} from '../examples/workflows/test-support/real-broker.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const PACKAGE='dev.testlane.androidproof';
async function tree(root) {
  const result=[];
  async function walk(dir) {
    for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      assert.equal(item.isSymbolicLink(),false,'proof files must not be symlinks');
      const file=path.join(dir,item.name);
      if(item.isDirectory()) await walk(file);
      else if(item.isFile()) result.push([path.relative(root,file),await readFile(file)]);
    }
  }
  await walk(root);return result;
}
const digestTree=async root=>sha(Buffer.concat((await tree(root)).flatMap(([name,bytes])=>[Buffer.from(name+'\0'),bytes])));
function profiles(namespace,origin,accounts) {
  return {version:1,profiles:Object.fromEntries(Object.entries(accounts).map(([role,account])=>[namespace+':testing:'+role,{
    app:'testlane-android-proof',environment:'testing',baseUrl:origin,strategy:'form-post',
    account:{email:account.email,role:account.role},session:{ttlMinutes:30},
    options:{loginPath:'/api/login',bodyFormat:'json',fields:'{"email":"{{email}}","password":"{{secret}}"}',sessionCookieName:'tldemo_session',mePath:'/api/me'},
  }]))};
}
export async function runAndroidProof({consumer,apkFile,outputDir,sdkRoot,javaHome,toolsRoot,systemImagePath,signal,onStage=()=>{}}) {
  signal?.throwIfAborted();
  const support=realBrokerSupport();assert.ok(support.supported,'requires DPAPI or explicitly isolated Linux Secret Service');
  const output=path.resolve(outputDir);await mkdir(output,{mode:0o700});
  await writeFile(path.join(output,'.gitignore'),'*\n',{flag:'wx'});
  const recovery=path.join(output,'recovery');await mkdir(recovery,{mode:0o700});
  const moduleFrom=async file=>{
    const candidate=await realpath(path.join(consumer.packageRoot,file));
    const relative=path.relative(await realpath(consumer.packageRoot),candidate);
    assert.ok(relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    return import(pathToFileURL(candidate).href);
  };
  const {startDemoApp}=await moduleFrom('examples/verification-demo/app.mjs');
  const {runDemoChild}=await moduleFrom('examples/verification-demo/native.mjs');
  const {startOwnedAndroid}=await moduleFrom('examples/android-verification/device.mjs');
  const {runNativeWorker}=await moduleFrom('examples/android-verification/worker-host.mjs');
  const {validateNativePlan,sanitizeNativeReport}=await moduleFrom('examples/android-verification/contracts.mjs');
  const {APPROVAL_REQUIREMENTS}=await moduleFrom('examples/android-verification/proof-cases.mjs');
  const before=await digestTree(consumer.packageRoot),apkSha256=sha(await readFile(apkFile));
  const buildManifestFile=path.join(path.dirname(apkFile),'build-manifest.json');
  const buildBytes=await readFile(buildManifestFile),build=JSON.parse(buildBytes);
  assert.equal(build.package,PACKAGE);assert.equal(build.proofOnly,true);assert.equal(build.embeddedBundle,true);
  assert.equal(build.debuggable,true);assert.equal(build.architecture,'x86_64');assert.equal(build.apkSHA256,apkSha256);
  const publicFiles=['package.json','package-lock.json','app.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withProofBuild.cjs'];
  assert.deepEqual(Object.keys(build.publicSourceSHA256).sort(),[...publicFiles].sort());
  for(const file of publicFiles)assert.equal(build.publicSourceSHA256[file],sha(await readFile(path.join(consumer.packageRoot,'examples/mobile-approval-app',file))),'APK build inputs match installed public app source');
  const namespace='android-'+randomBytes(8).toString('hex');
  const accounts=Object.fromEntries(['editor','reviewer'].map(role=>[role,{email:namespace+'-'+role+'@example.test',role:role==='editor'?'Editor':'Reviewer',password:randomBytes(32).toString('base64url')}]));
  const identities=Object.fromEntries(Object.entries(accounts).map(([role,{email,role:label}])=>[role,{email,role:label}]));
  let app,harness,device,cli,captured='',receipt,cleanupOK=true,stage='setup',workerUnconfirmed=false;const attempted=new Set();
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
    at('broker-setup');app=await startDemoApp({accounts});
    harness=await createRealBrokerHarness({brokerCli:consumer.brokerCli,support,registry:profiles(namespace,app.origin,accounts)});
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
    const planBytes=Buffer.from(JSON.stringify(plan,null,2)+'\n'),planHash=sha(planBytes);
    await writeFile(path.join(output,'plan.json'),planBytes,{flag:'wx',mode:0o600});
    const specFile=path.join(consumer.packageRoot,'examples/android-verification/proof-cases.mjs'),specHash=sha(await readFile(specFile));
    const journals=new Map();
    const onRequest=async request=>{
      if(request.type==='assert-owned') {await device.assertOwned();return true;}
      if(request.type==='bootstrap-consumed') {await device.assertBootstrapAbsent();return true;}
      if(request.type==='load-role') {
        assert.ok(Object.hasOwn(cookies,request.role));
        const payload=JSON.stringify({schemaVersion:1,origin:app.origin,cookie:cookies[request.role]});
        await device.writeBootstrap(payload);return true;
      }
      assert.ok(plan.cases.some(item=>item.id===request.caseId&&item.cleanup.required));
      const file=path.join(recovery,request.caseId+'.json');
      if(request.type==='intent') {
        assert.match(request.marker,/^native-proof-[a-f0-9-]{36}$/);assert.equal(journals.has(request.caseId),false);
        const entry={caseId:request.caseId,marker:request.marker,id:null};
        await writeFile(file,JSON.stringify(entry)+'\n',{flag:'wx',mode:0o600});journals.set(request.caseId,entry);return true;
      }
      const owned=journals.get(request.caseId);assert.ok(owned);
      if(request.type==='record') {
        assert.equal(owned.marker,request.marker);assert.match(request.id,/^[a-f0-9-]{36}$/);
        assert.ok(owned.id===null||owned.id===request.id);owned.id=request.id;
        await writeFile(file,JSON.stringify(owned)+'\n',{mode:0o600});return true;
      }
      if(request.type==='remove') {
        assert.equal(app.records().some(row=>row.marker===owned.marker||row.id===owned.id),false,'controller independently confirms absence');
        await unlink(file);journals.delete(request.caseId);return true;
      }
      throw Error('ANDROID_RPC_REFUSED');
    };
    const runs=[];
    for(const [phase,defect] of [['positive',false],['fault',true],['corrected',false]]) {
      signal?.throwIfAborted();
      at(phase);app.setDefect(defect);
      const result=await runNativeWorker({plan,identities,origin:app.origin,cookies,onRequest,signal,timeoutMs:360000,
        driverOptions:{url:device.serverUrl,capabilities:{platformName:'Android','appium:automationName':'UiAutomator2','appium:udid':device.serial,
          'appium:appPackage':PACKAGE,'appium:appActivity':'.MainActivity','appium:remoteAdbHost':'127.0.0.1','appium:adbPort':device.adbPort,
          'appium:systemPort':device.systemPort,'appium:skipLogcatCapture':true,'appium:suppressKillServer':true,
          'appium:printPageSourceOnFindFailure':false,'appium:noReset':true,'appium:newCommandTimeout':90}}});
      captured+=result.captured??'';
      const report=sanitizeNativeReport(result.report,plan);
      if(report.reasonCodes.some(code=>['NATIVE_WORKER_TERMINATION_UNCONFIRMED','NATIVE_WORKER_RPC_UNSETTLED'].includes(code)))workerUnconfirmed=true;
      await writeFile(path.join(output,phase+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
      assert.equal(report.verdict,defect?'failed':'passed','unchanged native suite detects the injected total defect');
      for(const row of report.cases) {
        assert.equal(row.attempts,1);assert.ok(row.bodyAssertionsObserved>0);
        assert.equal(row.cleanup.status,row.id==='anonymous-denied'?'not-required':'completed');
        const failed=defect&&['editor-native-total','reviewer-native-approval'].includes(row.id);
        assert.equal(row.status,failed?'failed':'passed');
        if(failed)assert.equal(row.reason,'NATIVE_ASSERTION_FAILED');
      }
      assert.equal(app.records().length,0,'independent controller proves no records remain');assert.equal(journals.size,0);
      assert.equal(sha(await readFile(apkFile)),apkSha256);assert.equal(sha(await readFile(specFile)),specHash);
      assert.equal(sha(await readFile(buildManifestFile)),sha(buildBytes));
      assert.equal(sha(await readFile(path.join(output,'plan.json'))),planHash);assert.equal(await digestTree(consumer.packageRoot),before);
      runs.push({phase,verdict:report.verdict,passed:report.cases.filter(row=>row.status==='passed').length,failed:report.cases.filter(row=>row.status==='failed').length,recordsRemaining:0});
    }
    receipt={schemaVersion:1,passed:true,runner:'android-uiautomator2',context:'NATIVE_APP',proofOnly:true,nativeStore:support.store,
      packageTreeSha256:before,apkSha256,buildManifestSha256:sha(buildBytes),publicAppSourceSha256:Object.fromEntries(publicFiles.map(file=>[file,build.publicSourceSHA256[file]])),
      planSha256:planHash,specSha256:specHash,versions:device.versions,runs};
  } catch(error) {
    if(typeof error?.capturedText==='function')captured+=error.capturedText();
    if(/TERMINATION_UNCONFIRMED|STOP_UNCONFIRMED/.test(String(error?.code??error?.message??'')))workerUnconfirmed=true;
    throw error;
  } finally {
    const priorStage=stage;at('cleanup');
    const errors=workerUnconfirmed?['worker-stop']:[];
    if(device) {try{await device.close();}catch{errors.push('device-stop');}captured+=device.capturedText();}
    if(harness) {
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
    }
    if(app?.records().length)errors.push('owned-records');
    if((await readdir(recovery)).length)errors.push('recovery-journal');
    try{await app?.close();}catch{errors.push('backend-stop');}
    if(errors.length) {await writeFile(path.join(output,'cleanup-status.json'),JSON.stringify({status:'incomplete',steps:errors,consumerRoot:consumer.root})+'\n',{mode:0o600});
      const error=Error('ANDROID_PROOF_CLEANUP_INCOMPLETE');error.preserveConsumer=true;throw error;}
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
