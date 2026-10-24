#!/usr/bin/env node
/** Test-only negative cohort: late cancellation and original-run recovery. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { startOwnedSupabase } from './runtime.mjs';
import { finalizeProvisioningProof } from '../proof-finalization.mjs';
import { startSupabaseProvisioningApp } from './app.mjs';
import { startOwnedBrowserServer } from './browser-server.mjs';
import { createPackageProofAdapter } from './package-adapter.mjs';
import { createLifecycleEdgeAdapter, checkedLifecycleManaged, LIFECYCLE_EDGE_SCENARIOS } from './package-browser-lifecycle-faults.mjs';
import { loadProofSupport, installPackageBrowserConsumer, ordinaryBytes, packageBrowserShims, proofFailure } from './package-browser-consumer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CASE = 'automatic-account-browser-lifecycle';
const FILES = ['package-browser-lifecycle-proof.mjs', 'package-browser-lifecycle-faults.mjs', 'package-browser-consumer.mjs', 'package-adapter.mjs', 'package-browser.spec.mjs',
  'app.mjs', 'runtime.mjs', 'authority.mjs', 'ledger.sql', 'browser-fixture.mjs', 'request-drain.mjs', 'browser-server.mjs',
  '../contracts.mjs', '../proof-finalization.mjs', 'tools/process.mjs', 'tools/private-directory.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(FILES.map(async name => [name, sha(await ordinaryBytes(path.join(HERE, name), 1048576))])));
const refuse = code => { throw proofFailure(code); };
function data(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) refuse('PACKAGE_BROWSER_REPORT_REFUSED');
  const fields = Object.getOwnPropertyDescriptors(value), result = {};
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !keys.includes(key)) || required.some(key => !Object.hasOwn(fields, key))) refuse('PACKAGE_BROWSER_REPORT_REFUSED');
  for (const key of Object.keys(fields)) { const field = fields[key]; if (!field.enumerable || !Object.hasOwn(field, 'value')) refuse('PACKAGE_BROWSER_REPORT_REFUSED'); result[key] = field.value; }
  return result;
}
export function packageBrowserPlan(origin) {
  return { schemaVersion: 1, status: 'reviewed', title: 'Installed automatic account browser lifecycle', projectDir: '../..',
    target: { baseUrl: origin, environment: 'testing' }, evidence: { screenshots: 'off' }, cases: [{ id: CASE,
      title: 'Automatically created accounts persist owned data and reject original sessions after revocation', spec: 'e2e/provisioning/package-browser.spec.mjs',
      expected: ['Created identities and role allow/deny controls are verified in the DOM',
        'The exact Editor record is persisted, deleted and verified absent even after the intended assertion failure',
        'The same live browser contexts retain their original cookies and receive401 with protected DOM cleared after revocation'],
      cleanup: { required: true, description: 'Delete the owned record, request same-run managed revocation, prove original-context rejection and let the fixture close contexts' } }] };
}
export function checkedLifecycleBrowserReport(report,expected){
  try{
    assert.equal(report.schemaVersion,1);assert.deepEqual(report.artifacts,[]);assert.deepEqual(report.limits,expected.limits);
    assert.deepEqual(report.helper,{version:'1',sha256:expected.helperSHA256});assert.deepEqual(report.harness,{version:expected.harnessVersion,sha256:expected.harnessSHA256});
    assert.equal(report.verdict,'passed');assert.deepEqual(report.reasonCodes,[]);assert.deepEqual(report.diagnostics,[]);
    assert.deepEqual(report.execution,{exitCode:0,cancelled:false,forced:false});assert.deepEqual(report.plan,{sha256:expected.planSHA256});
    assert.deepEqual(report.specs,[{id:expected.specId,sha256:expected.specSHA256}]);assert.equal(report.cases.length,1);
    const row=report.cases[0];assert.equal(row.id,CASE);assert.equal(row.status,'passed');assert.equal(row.reason,'CASE_PASSED');assert.equal(row.attempts,1);
    assert.deepEqual(row.cleanup,{required:true,status:'completed'});assert.equal(row.specId,expected.specId);assert.equal(row.diagnostic,undefined);
    assert.ok(Number.isSafeInteger(row.assertionsObserved)&&row.assertionsObserved>20);
    return Object.freeze({browserVerification:'passed',attempts:1,assertionsObserved:row.assertionsObserved,originalContextsRefused:2});
  }catch{refuse('PACKAGE_BROWSER_REPORT_REFUSED');}
}

async function json(file,maximum=1048576){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await ordinaryBytes(file,maximum)));}
async function missing(file){try{await lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function readVerificationReport(managedRoot, runId){
  let privateMetadata='';
  assert.match(runId,UUID);const directory=path.join(managedRoot,'runs',runId,'verification');
  const names=await readdir(directory);assert.equal(names.length,1);assert.match(names[0],/^run-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const folder=path.join(directory,names[0]);assert.equal(await realpath(folder),folder);assert.equal((await lstat(folder)).isSymbolicLink(),false);
  const report=await json(path.join(folder,'report.json'));assert.equal(report.reportPath,names[0]+'/report.json');
  for(const name of ['.control','artifacts'])assert.deepEqual(await readdir(path.join(folder,name)),[]);
  const privateResults=path.join(folder,'.private-test-results');
  if(!await missing(privateResults)){
    const files=await readdir(privateResults);if(files.some(name=>name!=='.last-run.json'))refuse('PACKAGE_BROWSER_ARTIFACT_REFUSED');
    if(files.length){const last=await json(path.join(privateResults,'.last-run.json'),16384), checked=data(last,['status','failedTests']);
      if(!['passed','failed'].includes(checked.status)||!Array.isArray(checked.failedTests)||checked.failedTests.length>1||checked.failedTests.some(value=>typeof value!=='string'||value.length>256))refuse('PACKAGE_BROWSER_ARTIFACT_REFUSED');privateMetadata=JSON.stringify(last);}
  }
  return {report,privateMetadata};
}
function scanVariants(text, values){
  for(const value of values)for(const variant of [value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('base64url')])
    if(text.includes(variant))refuse('PACKAGE_BROWSER_LEAK_REFUSED');
}
async function knownEvidence(managedRoot, runIds, reports){
  const files=[path.join(managedRoot,'managed-owner.json'),path.join(managedRoot,'coordinator','owner.json'),path.join(managedRoot,'coordinator','ledger.json')];
  for(const runId of runIds)for(const name of ['managed-run.json','profiles.json','worker-binding.json','revocation/request.json','revocation/response.json'])files.push(path.join(managedRoot,'runs',runId,name));
  let text=JSON.stringify(reports),total=Buffer.byteLength(text);
  for(const file of files){const bytes=await ordinaryBytes(file,1048576);total+=bytes.length;if(total>4*1048576)refuse('PACKAGE_BROWSER_SCAN_LIMIT');text+='\n'+new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  // No native store, recovery, raw console, browser profile or arbitrary files are read.
  return text;
}
async function disposeOwned(directory,identity,parent){
  const current=await lstat(directory,{bigint:true});
  if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||path.dirname(directory)!==parent||await realpath(directory)!==directory)refuse('PACKAGE_BROWSER_DISPOSAL_REFUSED');
  await rm(directory,{recursive:true,force:false});if(!await missing(directory))refuse('PACKAGE_BROWSER_DISPOSAL_REFUSED');
}
export async function runInstalledBrowserLifecycleEdgeProof({toolsRoot,outputDir,temporaryRoot,tarball,tarballSHA256,npmCLI,npmCLISHA256,npmCacheDirectory,bootstrapHashes,allowUserKeychain=false,signal,onStage=()=>{}}={}){
  let stage='preflight',support,consumer,runtime,app,browser,temporaryIdentity,outputIdentity,failure,receipt;
  let childStopConfirmed=true,accountsConfirmed=false,cleanupFailed=false;
  const phases=[],managedResults=[],reports=[],privateMetadata=[],runIds=[],passwords=[],endpoints=[],issues=new Set();
  const at=value=>{stage=value;onStage(value);};const issue=code=>{cleanupFailed=true;issues.add(code);};
  const output=path.resolve(outputDir??''),temporary=path.resolve(temporaryRoot??''),managedRoot=path.join(output,'managed');
  const browserRoot=path.join(temporary,'browser'),consumerRoot=path.join(temporary,'consumer');
  let browserIdentity,hashes,binding,control;
  try{
    const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
    if(![outputDir,temporaryRoot,toolsRoot,npmCacheDirectory].every(value=>typeof value==='string'&&path.isAbsolute(value))||inside(output,temporary)||inside(temporary,output)||typeof allowUserKeychain!=='boolean')refuse('PACKAGE_BROWSER_INPUT_REFUSED');
    if(process.platform!=='win32'&&!allowUserKeychain)refuse('PACKAGE_BROWSER_PLATFORM_REFUSED');
    if(['DEBUG','PWDEBUG','NODE_DEBUG','NODE_OPTIONS'].some(key=>process.env[key]))refuse('PACKAGE_BROWSER_DEBUG_REFUSED');
    signal?.throwIfAborted();support=await loadProofSupport(REPO,bootstrapHashes);
    await support.create(output,{signal});outputIdentity=await lstat(output,{bigint:true});await writeFile(path.join(output,'.gitignore'),'*\n',{flag:'wx',mode:0o600});
    await support.create(temporary,{signal});temporaryIdentity=await lstat(temporary,{bigint:true});await support.create(browserRoot,{signal});browserIdentity=await lstat(browserRoot,{bigint:true});
    hashes=await sourceHashes();const releaseId=sha(JSON.stringify(hashes));
    at('offline-consumer');childStopConfirmed=false;consumer=await installPackageBrowserConsumer({directory:consumerRoot,tarball,tarballSHA256,npmCLI,npmCLISHA256,npmCacheDirectory,support,signal});childStopConfirmed=true;
    const suite=path.join(consumer.root,'e2e','provisioning');await support.create(path.dirname(suite),{signal});await support.create(suite,{signal});
    const copied={};
    for(const [source,name]of [[path.join(consumer.packageRoot,'examples/playwright/fixtures.mjs'),'fixtures.mjs'],[path.join(consumer.packageRoot,'examples/agent-verification/authoring.mjs'),'testlane-authoring.mjs'],[path.join(HERE,'package-browser.spec.mjs'),'package-browser.spec.mjs']]){
      const bytes=await ordinaryBytes(source,1048576);copied[name]=sha(bytes);await writeFile(path.join(suite,name),bytes,{flag:'wx',mode:0o600});
    }
    // Literal app-owned shims resolve the installed package's public ESM exports
    // from inside the fresh consumer. Worker code never imports parent authority.
    const shims=packageBrowserShims();
    for(const[key,name]of [['parent','installed-parent.mjs'],['worker','installed-worker.mjs']]){
      copied[name]=sha(shims[key]);await writeFile(path.join(suite,name),shims[key],{flag:'wx',mode:0o600});
    }
    const module=await import(pathToFileURL(path.join(suite,'installed-parent.mjs')).href);
    const worker=await import(pathToFileURL(path.join(suite,'installed-worker.mjs')).href);
    if(typeof module.runDisposableBrowserVerification!=='function'||typeof module.recoverDisposableBrowserVerification!=='function'||typeof worker.loadBrowserWorkerBinding!=='function'||typeof worker.requestBrowserRunRevocation!=='function')refuse('PACKAGE_BROWSER_INSTALLED_API_REFUSED');
    const playwrightConfig="export default { testDir:'./e2e/provisioning', testMatch:'package-browser.spec.mjs', workers:1, retries:0, timeout:90000, reporter:'line', outputDir:'./results', use:{trace:'off',video:'off',screenshot:'off'} };\n";
    await writeFile(path.join(consumer.root,'playwright.config.mjs'),playwrightConfig,{flag:'wx',mode:0o600});
    at('owned-provider');childStopConfirmed=false;runtime=await startOwnedSupabase({toolsRoot,outputDir:path.join(output,'runtime'),signal});childStopConfirmed=true;control=await runtime.signInControl();assert.equal(control.status,200);
    childStopConfirmed=false;app=await startSupabaseProvisioningApp({runtime,releaseId});childStopConfirmed=true;const underlying=createPackageProofAdapter({app,runtime,releaseId});
    const recording=Object.freeze({...underlying,createOwned:async(owner,password)=>{if(passwords.length>=4)refuse('PACKAGE_BROWSER_CREATE_LIMIT');passwords.push(password);return underlying.createOwned(owner,password);}});
    const adapterPath=path.join(HERE,'package-browser-lifecycle-faults.mjs');
    binding={schemaVersion:1,status:'reviewed',target:{id:runtime.targetId,origin:app.origin,environment:'testing'},adapter:{protocol:'testlane-disposable-browser-v1',modulePath:adapterPath,sha256:hashes['package-browser-lifecycle-faults.mjs']},roles:['Editor','Reviewer'],ttlMs:600000,maxAccountsPerRun:2,maxActiveAccounts:4,maxCreateAttemptsPerHour:10,
      effects:{email:false,sms:false,billing:false,webhooks:false},authTemplate:{strategy:'form-post',options:{loginPath:'/api/login',bodyFormat:'json',fields:'{"email":"{{email}}","password":"{{secret}}"}',sessionCookieName:'tlp_supabase_session',mePath:'/api/me',emailField:'email',roleField:'role'},roleLabels:{Editor:'Editor',Reviewer:'Reviewer'}}};
    const planFile=path.join(suite,'plan.json');await writeFile(planFile,JSON.stringify(packageBrowserPlan(app.origin))+'\n',{flag:'wx',mode:0o600});
    const planSHA256=sha(await ordinaryBytes(planFile,1048576)),spec=await ordinaryBytes(path.join(suite,'package-browser.spec.mjs'),1048576),lines=spec.toString('utf8').split('\n');
    const matches=lines.flatMap((line,index)=>line.includes("expect(config.injectBodyFailure === false,")?[index]:[]);assert.equal(matches.length,1);
    const installedContracts=await import(pathToFileURL(path.join(consumer.packageRoot,'examples/agent-verification/contracts.mjs')).href),installedRuntime=await import(pathToFileURL(path.join(consumer.packageRoot,'examples/agent-verification/runtime.mjs')).href);
    const harnessBytes=await Promise.all(['runtime.mjs','contracts.mjs','reporter.mjs','bootstrap.mjs','run.mjs'].map(name=>ordinaryBytes(path.join(consumer.packageRoot,'examples/agent-verification',name),1048576)));
    const line=lines[matches[0]],expected={helperSHA256:copied['testlane-authoring.mjs'],harnessVersion:installedContracts.HARNESS_VERSION,harnessSHA256:sha(Buffer.concat(harnessBytes)),limits:installedRuntime.LIMITS,planSHA256,specSHA256:sha(spec),specId:sha('e2e/provisioning/package-browser.spec.mjs'),injectionLine:matches[0]+1,injectionColumnStart:line.indexOf('expect(')+1,injectionColumnEnd:line.length+1};
    for(const[index,scenario]of LIFECYCLE_EDGE_SCENARIOS.entries()){
      const cancellation=new AbortController(),gate=createLifecycleEdgeAdapter(recording,{scenario,cancel:()=>cancellation.abort()}),adapter=gate.adapter;
      const managedSignal=signal?AbortSignal.any([signal,cancellation.signal]):cancellation.signal;
      signal?.throwIfAborted();at('browser-p'+index);childStopConfirmed=false;browser=await startOwnedBrowserServer({consumerRoot:consumer.root,temporaryRoot:browserRoot,signal});childStopConfirmed=true;endpoints.push(browser.endpoint);
      const config=path.join(suite,'package-browser-config.json');await writeFile(config,JSON.stringify({privateBrowserEndpoint:browser.endpoint,injectBodyFailure:false})+'\n',{flag:'wx',mode:0o600});
      try{
        // Only the installed API's complete, bound outcome can restore known
        // runner settlement. A throw/unknown result cannot authorize fallback.
        childStopConfirmed=false;
        at('installed-api-p'+index);const managed=await module.runDisposableBrowserVerification({adapter,binding,planFile,outputDir:managedRoot,allowUserKeychain,signal:managedSignal});
        managedResults.push(managed);if(!UUID.test(managed.runId??'')||!gate.matchesOriginalRun(managed.runId))refuse('PACKAGE_BROWSER_REPORT_REFUSED');runIds.push(managed.runId);
        const before=gate.summary();
        const initial=checkedLifecycleManaged(managed,scenario,scenario==='late-cancellation'?'completed':'incomplete',before,managed.runId);
        // This exact repeated-owner branch is reached after the runner joined;
        // unknown launch/native outcomes fail the fixed checks and stay latched.
        const observed=await readVerificationReport(managedRoot,managed.runId),browserEvidence=checkedLifecycleBrowserReport(observed.report,expected);
        reports.push(observed.report);privateMetadata.push(observed.privateMetadata);
        let recovery;
        if(scenario==='settled-cleanup-recovery'){
          signal?.throwIfAborted();assert.deepEqual((await readdir(path.join(managedRoot,'runs'))).sort(),[...runIds].sort());gate.releaseRecovery(managed.runId);
          at('explicit-recovery');childStopConfirmed=false;
          const recovered=await module.recoverDisposableBrowserVerification({adapter,binding,outputDir:managedRoot,runId:managed.runId,allowUserKeychain,...(signal?{signal}:{})});
          managedResults.push(recovered);recovery=checkedLifecycleManaged(recovered,scenario,'recovered',gate.summary(),managed.runId);
          const after=await readVerificationReport(managedRoot,managed.runId);assert.deepEqual(after,observed);assert.deepEqual((await readdir(path.join(managedRoot,'runs'))).sort(),[...runIds].sort());
          // Public recovery has no create/credential-delivery/launch branch.
          // Adapter observations verify zero extra create/delivery calls; native
          // seed omission remains source-bound, not a new native command counter.
          const final=gate.summary();for(const key of ['owners','createAttempts','deliveryBegins','deliveryEnds'])assert.equal(final[key],before[key]);
        }
        phases.push({scenario,...browserEvidence,initial,recovery:recovery??null,originalRunRetained:true,activeAbortTested:false});childStopConfirmed=true;
      }finally{
        if(browser){try{await browser.close();browser=undefined;}catch{childStopConfirmed=false;issue('browser-stop');}}
        if(!browser&&childStopConfirmed)await unlink(config);
      }
      if(!childStopConfirmed||cleanupFailed)refuse('PACKAGE_BROWSER_MANAGED_INCOMPLETE');
      const summary=await runtime.summary();assert.equal(summary.ownedAccounts,0);assert.equal(summary.activeReservations,0);assert.equal(summary.pendingDeliveries,0);assert.equal(summary.proofRecords,0);assert.equal(summary.controlPresent,true);assert.equal(summary.reservations,(index+1)*2);
      assert.equal((await runtime.getUser(control.accessToken)).status,200);assert.equal(runtime.requestCounts().authCreate,(index+1)*2);
      for(const[name,digest]of Object.entries(copied))assert.equal(sha(await ordinaryBytes(path.join(suite,name),1048576)),digest);
      assert.equal(sha(await ordinaryBytes(planFile,1048576)),planSHA256);assert.equal(sha(await ordinaryBytes(path.join(consumer.root,'playwright.config.mjs'),1048576)),sha(playwrightConfig));await consumer.unchanged();
    }
    assert.equal(passwords.length,4);assert.equal(runtime.requestCounts().authCreate,4);assert.equal(new Set(runIds).size,2);
    assert.deepEqual(await sourceHashes(),hashes);await consumer.unchanged();accountsConfirmed=true;
    receipt={schemaVersion:1,passed:true,scope:'installed public API late-cancellation and same-run settled-cleanup recovery against synthetic local Supabase form-post only',tarballSHA256,installedPackageVersion:consumer.version,installedPackageTreeSHA256:consumer.installedTreeSHA256,
      sourceHashes:hashes,bootstrapHashes:support.hashes,copiedHashes:copied,phases,createAttempts:4,recoveryCreateAttempts:0,unchangedCreateAttemptLimitPerHour:10,foreignControlUnchanged:true,
      oldContextsRefused:4,lateCancellationOnly:true,activeAbortTested:false,recoveryAfterRevocationOnly:true,quarantinePolicyUnchanged:true,controllerRoutesAdded:false,providerTokensDeliveredToBrowser:false,agentAuthored:false,nextAuthDOMTested:false,existingProjectInstallerTested:false,cliMcpAccountCreationTested:false,
      cleanupVerified:false,credentialLeakScanPassed:false,credentialLeakScanScope:'fixed managed metadata/sanitized reports/copied source/runtime capture; native stores and browser private stores are not read',businessRecordCrashRecoveryProven:false};
  }catch(error){failure={error};}
  finally{
    const failedStage=stage;try{at('cleanup');}catch{issue('stage-observer');}
    if(browser){try{await browser.close();browser=undefined;}catch{childStopConfirmed=false;issue('browser-stop');}}
    try{await app?.stopAndDrainRequests();}catch{childStopConfirmed=false;issue('application-drain');}
    if(runtime&&childStopConfirmed)try{const summary=await runtime.summary();accountsConfirmed=summary.ownedAccounts===0&&summary.activeReservations===0&&summary.pendingDeliveries===0&&summary.proofRecords===0&&summary.controlPresent===true;if(!accountsConfirmed)issue('account-summary');}catch{issue('account-summary');}
    if(!childStopConfirmed)issue('owned-stop');
    const material=passwords.concat(endpoints);
    try{material.push(...(app?.issuedSessionTokens()??[]));}catch{issue('credential-scan');}
    try{
      if(consumer){const copiedText=(await Promise.all(['fixtures.mjs','testlane-authoring.mjs','package-browser.spec.mjs','installed-parent.mjs','installed-worker.mjs'].map(async name=>new TextDecoder('utf-8',{fatal:true}).decode(await ordinaryBytes(path.join(consumer.root,'e2e/provisioning',name),1048576))))).join('\n');
        const evidence=runIds.length?await knownEvidence(managedRoot,runIds,reports):'';const text=copiedText+evidence+JSON.stringify(managedResults)+privateMetadata.join('\n')+(runtime?.capturedText()??'');scanVariants(text,material);runtime?.assertNoLeaks(text);}
    }catch{issue('credential-scan');}
    try{await app?.close();}catch{issue('application-close');}
    // Preserve DATA/recovery on failure, not live listeners. Exact owned services
    // may stop; no business/native fallback mutation or data erasure is authorized.
    try{const closed=await runtime?.close({preserveData:!accountsConfirmed||!childStopConfirmed||Boolean(failure)||cleanupFailed});if(runtime&&closed?.cleanupVerified!==true)issue('provider-close');}catch{issue('provider-close');}
    try{const captured=runtime?.capturedText()??'';scanVariants(captured,material);runtime?.assertNoLeaks(captured);}catch{issue('credential-scan');}
    if(!failure&&!cleanupFailed&&accountsConfirmed&&childStopConfirmed){
      try{await consumer?.unchanged();await consumer?.dispose();if(browserIdentity)await disposeOwned(browserRoot,browserIdentity,temporary);if(temporaryIdentity)await disposeOwned(temporary,temporaryIdentity,path.dirname(temporary));}catch{issue('private-disposal');}
    }
    if(failure||cleanupFailed){
      if(outputIdentity)try{await writeFile(path.join(output,'failure.json'),JSON.stringify({schemaVersion:1,stage:failedStage,code:'PACKAGE_BROWSER_PROOF_FAILED',childStopConfirmed,accountsConfirmed,evidenceRetained:true,cleanupFailures:[...issues].sort()})+'\n',{flag:'wx',mode:0o600});}catch{/* Never replace failure with apparent success. */}
    }
  }
  if(failure||cleanupFailed||signal?.aborted||!receipt)refuse('PACKAGE_BROWSER_PROOF_FAILED');
  receipt.cleanupVerified=true;receipt.credentialLeakScanPassed=true;
  return finalizeProvisioningProof({outputDir:output,receipt,kind:'supabase',signal});
}

// Import this proof from an explicitly configured test runner.
