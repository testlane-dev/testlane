/** Inert proof-envelope checks. No installer, account, browser, store or provider is invoked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { checkedPackagePhase, packageBrowserPlan } from '../package-browser-proof.mjs';
import { closedInstallerEnvironment, npmArguments, ordinaryBytes, packageBrowserShims } from '../package-browser-consumer.mjs';
import { reconcile, LIMITS } from '../../../agent-verification/runtime.mjs';
import { HARNESS_VERSION } from '../../../agent-verification/contracts.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const source=()=>readFile(path.join(HERE,'../package-browser-proof.mjs'),'utf8');
async function reportFixture(injected){
  const spec=await readFile(path.join(HERE,'../package-browser.spec.mjs'),'utf8'),lines=spec.split('\n');
  const position=lines.findIndex(line=>line.includes('expect(config.injectBodyFailure === false,'));assert.ok(position>0);
  const expected={limits:LIMITS,harnessVersion:HARNESS_VERSION,harnessSHA256:hash('harness'),helperSHA256:hash('helper'),planSHA256:hash('plan'),specSHA256:hash(spec),specId:hash('e2e/provisioning/package-browser.spec.mjs'),injectionLine:position+1,injectionColumnStart:lines[position].indexOf('expect(')+1,injectionColumnEnd:lines[position].length+1};
  const row={id:'automatic-account-browser-lifecycle',mapped:true,status:injected?'failed':'passed',expectedPassed:true,retry:0,assertionsObserved:46,helper:true,started:true,cleanup:'completed',screenshots:[],unexpectedAttachments:false,
    failureLocation:injected?{line:expected.injectionLine,column:expected.injectionColumnStart}:null,...(injected?{diagnosticCode:'ASSERTION_FAILED'}:{})};
  const execution={exitCode:injected?1:0,cancelled:false,forced:false},plan=packageBrowserPlan('http://127.0.0.1:1234');
  const report={schemaVersion:1,runId:randomUUID(),...reconcile(plan,{schemaVersion:1,discovered:1,errors:[],outcome:row.status,results:[row]},execution),execution,
    helper:{version:'1',sha256:expected.helperSHA256},harness:{version:HARNESS_VERSION,sha256:expected.harnessSHA256},limits:LIMITS,artifacts:[],plan:{sha256:expected.planSHA256},specs:[{id:expected.specId,sha256:expected.specSHA256}]};
  report.cases[0].specId=expected.specId;
  const managed={schemaVersion:1,runId:randomUUID(),verdict:injected?'failed':'passed',reasonCodes:injected?['BROWSER_MANAGED_RUN_FAILED']:[],verification:injected?'failed':'passed',cleanup:'completed',accounts:'completed',nativeEntries:'completed',temporaryFiles:'completed',recoveryRequired:false};
  return {expected,report,managed};
}
test('actual sanitized harness reports bind positive, intended assertion failure and corrected phases',async()=>{
  for(const injected of [false,true,false]){
    const f=await reportFixture(injected),result=checkedPackagePhase(f.managed,f.report,injected,f.expected);
    assert.equal(result.cleanup,'completed');assert.equal(result.attempts,1);assert.equal(result.assertionsObserved,46);
    assert.equal(result.phase,injected?'intended-body-failure':'passed');
  }
});
test('an arbitrary exit1, wrong assertion coordinate or incomplete component cannot become the intended proof',async()=>{
  const original=await reportFixture(true);
  for(const mutate of [f=>{f.report.cases[0].diagnostic.code='CASE_BODY_FAILED';},f=>{f.report.cases[0].failureLocation.line++;},f=>{f.report.cases[0].failureLocation.column=f.expected.injectionColumnEnd+1;},
    f=>{f.report.cases[0].specId=hash('foreign');},f=>{f.report.specs[0].sha256=hash('foreign');},f=>{f.report.helper.sha256=hash('foreign');},
    f=>{f.report.cases[0].cleanup.status='failed';},f=>{f.report.execution.forced=true;},f=>{f.report.execution.cancelled=true;},f=>{f.report.cases[0].attempts=2;},
    f=>{f.managed.recoveryRequired=true;},f=>{f.managed.nativeEntries='incomplete';},f=>{f.managed.temporaryFiles='incomplete';},f=>{f.report.artifacts=[{raw:'not-allowed'}];}]){
    const value=structuredClone(original);mutate(value);assert.throws(()=>checkedPackagePhase(value.managed,value.report,true,value.expected),{message:'PACKAGE_BROWSER_REPORT_REFUSED'});
  }
});
test('managed report getter, proxy and extra canary are refused without executing or projecting them',async()=>{
  const f=await reportFixture(false),canary=randomBytes(32).toString('base64url');let touched=0;
  for(const managed of [new Proxy(f.managed,{get(){touched++;throw Error(canary);}}),{...f.managed,extra:canary},Object.defineProperty({...f.managed},'verdict',{enumerable:true,get(){touched++;throw Error(canary);}})]){
    assert.throws(()=>checkedPackagePhase(managed,f.report,false,f.expected),error=>error.message==='PACKAGE_BROWSER_REPORT_REFUSED'&&!error.stack.includes(canary));
  }
  assert.equal(touched,0);
});
test('offline install argv and closed environment omit ambient credentials, proxies and npm config without mutating the source',()=>{
  const canary=randomBytes(32).toString('base64url'),input={...process.env,NPM_TOKEN:canary,HTTP_PROXY:canary,NODE_OPTIONS:canary,npm_config_registry:canary};
  const before={...input},root=path.resolve('synthetic-private');const env=closedInstallerEnvironment(root,input);
  assert.deepEqual(input,before);assert.equal(JSON.stringify(env).includes(canary),false);assert.equal(Object.hasOwn(env,'NODE_OPTIONS'),false);
  for(const key of ['HOME','USERPROFILE','TMP','TEMP','TMPDIR','XDG_CACHE_HOME'])assert.equal(env[key],root);
  const args=npmArguments({npmCLI:'npm-cli.js',tarball:'owned.tgz',cache:'owned-cache',userConfig:'empty-user',globalConfig:'empty-global'});
  for(const value of ['--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false','--cache=owned-cache','--userconfig=empty-user','--globalconfig=empty-global'])assert.ok(args.includes(value));
  assert.equal(args.filter(value=>value==='install').length,1);assert.equal(args.includes('--force'),false);
});
test('fixed consumer-local shims resolve public import conditions and keep worker exports separate',async t=>{
  const parent=await realpath(os.tmpdir()),directory=await mkdtemp(path.join(parent,'tlp-public-shims-')),app=path.join(directory,'e2e/provisioning'),installed=path.join(directory,'node_modules/@testlane/cli');
  t.after(async()=>{assert.equal(path.dirname(await realpath(directory)),parent);assert.match(path.basename(directory),/^tlp-public-shims-/);await rm(directory,{recursive:true,force:false});});
  await mkdir(app,{recursive:true});await mkdir(installed,{recursive:true});
  await writeFile(path.join(installed,'package.json'),JSON.stringify({name:'@testlane/cli',type:'module',exports:{'./browser':{import:'./parent.mjs',default:'./wrong.mjs'},'./browser-worker':{import:'./worker.mjs',default:'./wrong.mjs'}}}),{flag:'wx'});
  await writeFile(path.join(installed,'parent.mjs'),"export const runDisposableBrowserVerification=()=> 'run'; export const recoverDisposableBrowserVerification=()=> 'recover';\n",{flag:'wx'});
  await writeFile(path.join(installed,'worker.mjs'),"export const loadBrowserWorkerBinding=()=> 'binding'; export const requestBrowserRunRevocation=()=> 'revoke';\n",{flag:'wx'});
  await writeFile(path.join(installed,'wrong.mjs'),"throw Error('WRONG_EXPORT_CONDITION');\n",{flag:'wx'});
  const shims=packageBrowserShims();assert.equal(shims.parent,"export { runDisposableBrowserVerification, recoverDisposableBrowserVerification } from '@testlane/cli/browser';\n");
  assert.equal(shims.worker,"export { loadBrowserWorkerBinding, requestBrowserRunRevocation } from '@testlane/cli/browser-worker';\n");
  for(const [name,text]of Object.entries(shims))await writeFile(path.join(app,name+'.mjs'),text,{flag:'wx'});
  const parentAPI=await import(pathToFileURL(path.join(app,'parent.mjs')).href),workerAPI=await import(pathToFileURL(path.join(app,'worker.mjs')).href);
  assert.deepEqual(Object.keys(parentAPI),['recoverDisposableBrowserVerification','runDisposableBrowserVerification']);assert.equal(parentAPI.runDisposableBrowserVerification(),'run');assert.equal(parentAPI.recoverDisposableBrowserVerification(),'recover');
  assert.deepEqual(Object.keys(workerAPI),['loadBrowserWorkerBinding','requestBrowserRunRevocation']);assert.equal(workerAPI.loadBrowserWorkerBinding(),'binding');assert.equal(workerAPI.requestBrowserRunRevocation(),'revoke');
});
test('bounded real-filesystem reader accepts stable ordinary bytes and refuses a hardlink and overflow',async t=>{
  const parent=await realpath(os.tmpdir()),directory=await mkdtemp(path.join(parent,'tlp-package-envelope-'));
  t.after(async()=>{assert.equal(path.dirname(await realpath(directory)),parent);assert.match(path.basename(directory),/^tlp-package-envelope-/);await rm(directory,{recursive:true,force:false});});
  const file=path.join(directory,'fixed.json');await writeFile(file,'{"fixed":true}\n',{flag:'wx',mode:0o600});
  assert.equal((await ordinaryBytes(file,32)).toString(),'{"fixed":true}\n');await assert.rejects(ordinaryBytes(file,2),{message:'PACKAGE_BROWSER_INSTALL_REFUSED'});
  await link(file,path.join(directory,'alias.json'));await assert.rejects(ordinaryBytes(file,32),{message:'PACKAGE_BROWSER_INSTALL_REFUSED'});
});
async function finalizationFixture({unknown=false,drainFailure=false,initialFailure=true,consumerDirectory='private-consumer',ordinaryRead=async()=>Buffer.from('')}={}){
  const code=await source(),start=code.indexOf("    const failedStage=stage;"),end=code.indexOf('\n  if(failure||cleanupFailed',start);assert.ok(start>0&&end>start);
  const body=code.slice(start,end).replace(/\n  }\s*$/,'');const events=[];
  const context={stage:'installed-api-p1',at:()=>{},issue:code=>{context.cleanupFailed=true;events.push(code);},failure:initialFailure?{error:undefined}:undefined,cleanupFailed:false,childStopConfirmed:!unknown,accountsConfirmed:false,
    browser:undefined,passwords:[],endpoints:[],runIds:[],reports:[],managedResults:[],privateMetadata:[],consumer:{root:consumerDirectory,unchanged:async()=>events.push('unchanged'),dispose:async()=>events.push('consumer-delete')},
    app:{stopAndDrainRequests:async()=>{events.push('app-drain');if(drainFailure)throw Error();},issuedSessionTokens:()=>[],close:async()=>events.push('app-close')},
    runtime:{summary:async()=>{events.push('summary');return{ownedAccounts:0,activeReservations:0,pendingDeliveries:0,proofRecords:0,controlPresent:true};},capturedText:()=>'',assertNoLeaks:()=>{},close:async value=>{events.push(value.preserveData?'runtime-preserve':'runtime-delete');return{cleanupVerified:!value.preserveData};}},
    Promise,JSON,Boolean,path,TextDecoder,ordinaryBytes:ordinaryRead,scanVariants:()=>{},outputIdentity:undefined,temporaryIdentity:undefined,browserIdentity:undefined,issues:new Set()};
  await vm.runInNewContext('(async()=>{'+body+'})()',context);return{events,context};
}
test('unknown runner outcome stops owned app and runtime while preserving data, consumer and native evidence',async()=>{
  const f=await finalizationFixture({unknown:true});assert.ok(f.events.includes('app-drain'));assert.ok(f.events.includes('app-close'));assert.ok(f.events.includes('runtime-preserve'));
  assert.equal(f.context.accountsConfirmed,false);for(const event of ['summary','consumer-delete','runtime-delete'])assert.equal(f.events.includes(event),false);
});
test('failed app drain cannot authorize account confirmation or private/data disposal',async()=>{
  const f=await finalizationFixture({drainFailure:true});assert.equal(f.context.childStopConfirmed,false);assert.equal(f.context.accountsConfirmed,false);
  assert.ok(f.events.includes('runtime-preserve'));for(const event of ['summary','consumer-delete','runtime-delete'])assert.equal(f.events.includes(event),false);
});
test('actual finally scan refuses a hardlinked suite file and preserves data and consumer instead of passing',async t=>{
  const parent=await realpath(os.tmpdir()),directory=await mkdtemp(path.join(parent,'tlp-package-scan-')),suite=path.join(directory,'e2e/provisioning'),reads=[];
  t.after(async()=>{await Promise.allSettled(reads);assert.equal(path.dirname(await realpath(directory)),parent);assert.match(path.basename(directory),/^tlp-package-scan-/);await rm(directory,{recursive:true,force:false});});
  await mkdir(suite,{recursive:true});for(const name of ['fixtures.mjs','testlane-authoring.mjs','package-browser.spec.mjs','installed-parent.mjs','installed-worker.mjs'])await writeFile(path.join(suite,name),'fixed\n',{flag:'wx',mode:0o600});
  await link(path.join(suite,'fixtures.mjs'),path.join(suite,'linked.json'));
  const f=await finalizationFixture({initialFailure:false,consumerDirectory:directory,ordinaryRead:(file,maximum)=>{assert.equal(maximum,1048576);const pending=ordinaryBytes(file,maximum);reads.push(pending);return pending;}});
  await Promise.allSettled(reads);assert.equal(f.context.cleanupFailed,true);assert.ok(f.events.includes('credential-scan'));assert.ok(f.events.includes('runtime-preserve'));
  assert.equal(f.events.includes('runtime-delete'),false);assert.equal(f.events.includes('consumer-delete'),false);
});
test('actual installed invocation latches unknown before awaiting every falsy rejected outcome',async()=>{
  const code=await source(),start=code.indexOf('        childStopConfirmed=false;'),end=code.indexOf('\n      }finally{',start);assert.ok(start>0&&end>start);
  const body=code.slice(start,end);for(const rejection of [undefined,null,false,0,'']){
    const context={childStopConfirmed:true,at:()=>{},index:0,module:{runDisposableBrowserVerification:async()=>{throw rejection;}},adapter:{},binding:{},planFile:'plan',managedRoot:'managed',allowUserKeychain:false,signal:undefined};
    let caught=false;try{await vm.runInNewContext('(async()=>{'+body+'})()',context);}catch(value){caught=true;assert.equal(value,rejection);}assert.equal(caught,true);assert.equal(context.childStopConfirmed,false);
  }
});
test('actual installer and browser acquisition branches retain unknown when launch fails before a handle returns',async()=>{
  const code=await source();
  for(const [begin,end,overrides] of [
    ["    at('offline-consumer');","\n    const suite=",{installPackageBrowserConsumer:async()=>{throw Error('fixed');},consumerRoot:'owned',tarball:'fixed',tarballSHA256:'fixed',npmCLI:'fixed',npmCLISHA256:'fixed',npmCacheDirectory:'fixed',support:{}}],
    ["      signal?.throwIfAborted();at('browser-p'+index);","\n      const config=",{startOwnedBrowserServer:async()=>{throw Error('fixed');},consumer:{root:'owned'},browserRoot:'owned',index:0,endpoints:[]}],
  ]){
    const start=code.indexOf(begin),finish=code.indexOf(end,start);assert.ok(start>0&&finish>start);
    const context={childStopConfirmed:true,signal:undefined,at:()=>{},...overrides};
    await assert.rejects(vm.runInNewContext('(async()=>{'+code.slice(start,finish)+'})()',context),{message:'fixed'});assert.equal(context.childStopConfirmed,false);
  }
});
