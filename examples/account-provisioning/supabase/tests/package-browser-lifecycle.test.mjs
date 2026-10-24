/** Inert fault, report and invocation tests; no services, browser, credential store or child process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createLifecycleEdgeAdapter, checkedLifecycleManaged } from '../package-browser-lifecycle-faults.mjs';
import { reconcile,LIMITS } from '../../../agent-verification/runtime.mjs';
import { HARNESS_VERSION } from '../../../agent-verification/contracts.mjs';
const fail={message:'PACKAGE_BROWSER_LIFECYCLE_REFUSED'},runId=randomUUID(),targetId=randomUUID(),bindingHash='a'.repeat(64);
const owners=['Editor','Reviewer'].map(role=>({targetId,bindingHash,runId,operationId:randomUUID(),role,email:`tlp-${runId}-${role.toLowerCase()}@example.test`,expiresAt:Date.now()+600000}));
function fixture(scenario){
  const events=[],underlying={metadata:{protocol:'testlane-disposable-browser-v1',target:{id:targetId,origin:'http://127.0.0.1:1234',environment:'testing'}},
    verifyTarget:async()=>({}),coordinatorBinding:async()=>null,bindCoordinator:async()=>({bound:true}),
    createOwned:async value=>{events.push('create:'+value.role);return{id:randomUUID()};},inspectOwned:async()=>({present:false,id:null,revoked:true,deliveryPending:false,ownedRecords:0,activeReservations:0}),
    beginCredentialDelivery:async()=>({pending:true}),endCredentialDelivery:async()=>({pending:false}),revokeDeleteOwned:async value=>{events.push('revoke:'+value.role);return{revoked:true};}};
  const controller=new AbortController(),gate=createLifecycleEdgeAdapter(underlying,{scenario,cancel:()=>controller.abort()});
  const create=async()=>{for(const owner of owners){await gate.adapter.createOwned(owner,'synthetic-generated-value');await gate.adapter.beginCredentialDelivery(owner);await gate.adapter.endCredentialDelivery(owner);}};
  const barrier=async()=>{for(const owner of owners)await gate.adapter.revokeDeleteOwned(owner);};
  return {events,controller,gate,create,barrier};
}
const report=(scenario,phase)=>({schemaVersion:1,runId,verdict:scenario==='late-cancellation'?'cancelled':'blocked',reasonCodes:[scenario==='late-cancellation'?'BROWSER_MANAGED_CANCELLED':'BROWSER_MANAGED_CLEANUP_INCOMPLETE'],verification:'passed',cleanup:phase==='incomplete'?'incomplete':'completed',accounts:phase==='incomplete'?'incomplete':'completed',nativeEntries:'completed',temporaryFiles:'completed',recoveryRequired:phase==='incomplete'});
async function prepared(scenario){const f=fixture(scenario);await f.create();await f.barrier();return f;}
test('late cancellation triggers only after both original barrier acknowledgements and keeps cleanup delegates',async()=>{
  const f=await prepared('late-cancellation');assert.equal(f.controller.signal.aborted,false);await f.barrier();assert.equal(f.controller.signal.aborted,true);
  assert.equal(f.events.filter(x=>x.startsWith('create:')).length,2);assert.equal(f.events.filter(x=>x.startsWith('revoke:')).length,4);
  assert.equal(checkedLifecycleManaged(report('late-cancellation','completed'),'late-cancellation','completed',f.gate.summary(),runId).verdict,'cancelled');
});
test('known-settled fault persists until explicit same-run release; recovery creates or delivers nothing',async()=>{
  const f=await prepared('settled-cleanup-recovery');await assert.rejects(f.gate.adapter.revokeDeleteOwned(owners[0]),fail);
  const before=f.gate.summary();checkedLifecycleManaged(report('settled-cleanup-recovery','incomplete'),'settled-cleanup-recovery','incomplete',before,runId);
  f.gate.releaseRecovery(runId);await f.barrier();const after=f.gate.summary();
  checkedLifecycleManaged(report('settled-cleanup-recovery','recovered'),'settled-cleanup-recovery','recovered',after,runId);
  for(const key of ['createAttempts','deliveryBegins','deliveryEnds'])assert.equal(after[key],before[key]);assert.equal(after.createAttempts,2);assert.equal(after.revocationAcknowledgements,4);
});
test('recovery release before the fault, another run, and a second release are refused',async()=>{
  const f=await prepared('settled-cleanup-recovery');assert.throws(()=>f.gate.releaseRecovery(runId),fail);await assert.rejects(f.gate.adapter.revokeDeleteOwned(owners[0]),fail);
  assert.throws(()=>f.gate.releaseRecovery(randomUUID()),fail);f.gate.releaseRecovery(runId);assert.throws(()=>f.gate.releaseRecovery(runId),fail);
});
test('a repeated revoke before the other owner barrier ACK cannot trigger late cancellation',async()=>{
  const f=fixture('late-cancellation');await f.create();await f.gate.adapter.revokeDeleteOwned(owners[0]);await assert.rejects(f.gate.adapter.revokeDeleteOwned(owners[0]),fail);
  assert.equal(f.controller.signal.aborted,false);assert.equal(f.gate.summary().postRunObserved,false);
});
test('foreign owner and replay create cannot reach the underlying account adapter',async()=>{
  const f=fixture('settled-cleanup-recovery');await f.create();const before=[...f.events];
  await assert.rejects(f.gate.adapter.revokeDeleteOwned({...owners[0],operationId:randomUUID()}),fail);await assert.rejects(f.gate.adapter.createOwned(owners[0],'not-exported'),fail);
  assert.deepEqual(f.events,before);assert.equal(f.gate.matchesOriginalRun(randomUUID()),false);assert.equal(f.gate.matchesOriginalRun(runId),true);
});
test('a managed pass, unknown/incomplete child shape, or altered original run cannot be accepted as late cancellation',async()=>{
  const f=await prepared('late-cancellation');await f.barrier();
  for(const mutate of [v=>{v.verdict='passed';v.reasonCodes=[];},v=>{v.cleanup='incomplete';v.accounts='pending';v.nativeEntries='pending';v.temporaryFiles='pending';v.recoveryRequired=true;},v=>{v.runId=randomUUID();},v=>{v.reasonCodes=['BROWSER_MANAGED_CHILD_UNKNOWN'];},v=>{v.verification='blocked';}]){
    const value=report('late-cancellation','completed');mutate(value);assert.throws(()=>checkedLifecycleManaged(value,'late-cancellation','completed',f.gate.summary(),runId),fail);
  }
});
test('recovery must preserve the original nonpassing reason and cannot reset create/delivery counters',async()=>{
  const f=await prepared('settled-cleanup-recovery');await assert.rejects(f.gate.adapter.revokeDeleteOwned(owners[0]),fail);f.gate.releaseRecovery(runId);await f.barrier();
  for(const mutate of [v=>{v.reasonCodes=[];v.verdict='passed';},v=>{v.recoveryRequired=true;},v=>{v.cleanup='incomplete';}]){const v=report('settled-cleanup-recovery','recovered');mutate(v);assert.throws(()=>checkedLifecycleManaged(v,'settled-cleanup-recovery','recovered',f.gate.summary(),runId),fail);}
  assert.throws(()=>checkedLifecycleManaged(report('settled-cleanup-recovery','recovered'),'settled-cleanup-recovery','recovered',{...f.gate.summary(),createAttempts:4},runId),fail);
});
test('report proxies/accessors/extra fields and encoded canaries are fixed-refused without traps',async()=>{
  const f=await prepared('late-cancellation');await f.barrier();let touched=0;const canary=randomBytes(24).toString('base64url'),v=report('late-cancellation','completed');
  for(const input of [new Proxy(v,{get(){touched++;throw Error(canary);}}),Object.defineProperty({...v},'verdict',{enumerable:true,get(){touched++;throw Error(canary);}}),{...v,extra:encodeURIComponent(canary)},{...v,reasonCodes:[Buffer.from(canary).toString('base64')]}]){
    assert.throws(()=>checkedLifecycleManaged(input,'late-cancellation','completed',f.gate.summary(),runId),error=>error.message===fail.message&&!error.stack.includes(canary));
  }
  assert.equal(touched,0);
});
async function producerFixture(){
  const source=await readFile(new URL('../package-browser-lifecycle-proof.mjs',import.meta.url),'utf8');
  const begin=source.indexOf('export function checkedLifecycleBrowserReport('),end=source.indexOf('\nasync function json(',begin);assert.ok(begin>0&&end>begin);
  const check=Function('assert','CASE','refuse',source.slice(begin,end).replace('export ','')+';return checkedLifecycleBrowserReport;')(assert,'automatic-account-browser-lifecycle',()=>{throw Error('PACKAGE_BROWSER_REPORT_REFUSED');});
  const expected={helperSHA256:'a'.repeat(64),harnessVersion:HARNESS_VERSION,harnessSHA256:'b'.repeat(64),limits:LIMITS,planSHA256:'c'.repeat(64),specSHA256:'d'.repeat(64),specId:createHash('sha256').update('e2e/provisioning/package-browser.spec.mjs').digest('hex')};
  const plan={cases:[{id:'automatic-account-browser-lifecycle',cleanup:{required:true}}]},execution={exitCode:0,cancelled:false,forced:false};
  const report={schemaVersion:1,...reconcile(plan,{schemaVersion:1,discovered:1,errors:[],outcome:'passed',results:[{id:plan.cases[0].id,mapped:true,status:'passed',expectedPassed:true,retry:0,assertionsObserved:46,helper:true,started:true,cleanup:'completed',screenshots:[],unexpectedAttachments:false}]},execution),execution,
    artifacts:[],limits:LIMITS,helper:{version:'1',sha256:expected.helperSHA256},harness:{version:HARNESS_VERSION,sha256:expected.harnessSHA256},plan:{sha256:expected.planSHA256},specs:[{id:expected.specId,sha256:expected.specSHA256}]};report.cases[0].specId=expected.specId;
  return{source,check,expected,report};
}
test('actual derived browser oracle requires the unchanged bound positive same-context case',async()=>{
  const f=await producerFixture();assert.equal(f.check(f.report,f.expected).originalContextsRefused,2);
  for(const mutate of [v=>{v.execution.forced=true;},v=>{v.execution.cancelled=true;},v=>{v.helper.sha256='e'.repeat(64);},v=>{v.cases[0].attempts=2;},v=>{v.cases[0].cleanup.status='failed';},v=>{v.cases[0].status='failed';},v=>{v.cases[0].assertionsObserved=0;}]){
    const value=structuredClone(f.report);mutate(value);assert.throws(()=>f.check(value,f.expected),{message:'PACKAGE_BROWSER_REPORT_REFUSED'});
  }
});
test('actual invocation refuses unknown before recovery and preserves the unknown latch for every falsy rejection',async()=>{
  const {source}=await producerFixture(),begin=source.indexOf('        childStopConfirmed=false;'),end=source.indexOf('\n      }finally{',begin);assert.ok(begin>0&&end>begin);const body=source.slice(begin,end);
  for(const rejection of [undefined,null,false,0,'']){
    const context={childStopConfirmed:true,at:()=>{},index:0,module:{runDisposableBrowserVerification:async()=>{throw rejection;},recoverDisposableBrowserVerification:async()=>{throw Error('MUST_NOT_RECOVER');}},adapter:{},binding:{},planFile:'fixed',managedRoot:'fixed',allowUserKeychain:false,managedSignal:undefined,scenario:'settled-cleanup-recovery'};
    let caught=false;try{await vm.runInNewContext('(async()=>{'+body+'})()',context);}catch(value){caught=true;assert.equal(value,rejection);}assert.equal(caught,true);assert.equal(context.childStopConfirmed,false);
  }
});

test('actual invocation rejects an unknown managed result before any recovery, report read or gate release',async()=>{
  const {source}=await producerFixture(),begin=source.indexOf('        childStopConfirmed=false;'),end=source.indexOf('\n      }finally{',begin),events=[];assert.ok(begin>0&&end>begin);
  const f=await prepared('settled-cleanup-recovery');await assert.rejects(f.gate.adapter.revokeDeleteOwned(owners[0]),fail);
  const unknown={...report('settled-cleanup-recovery','incomplete'),reasonCodes:['BROWSER_MANAGED_CHILD_UNKNOWN','BROWSER_MANAGED_CANCELLED'],verification:'not-run',accounts:'pending',nativeEntries:'pending',temporaryFiles:'pending'};
  const context={childStopConfirmed:true,at:()=>{},index:0,module:{runDisposableBrowserVerification:async()=>unknown,recoverDisposableBrowserVerification:async()=>events.push('recover')},adapter:{},binding:{},planFile:'fixed',managedRoot:'fixed',allowUserKeychain:false,managedSignal:undefined,scenario:'settled-cleanup-recovery',managedResults:[],runIds:[],UUID:/^[a-f0-9-]{36}$/,gate:{matchesOriginalRun:()=>true,summary:f.gate.summary,releaseRecovery:()=>events.push('release')},checkedLifecycleManaged,readVerificationReport:async()=>events.push('read'),refuse:()=>{throw Error(fail.message);}};
  await assert.rejects(vm.runInNewContext('(async()=>{'+source.slice(begin,end)+'})()',context),fail);assert.equal(context.childStopConfirmed,false);assert.deepEqual(events,[]);
});
