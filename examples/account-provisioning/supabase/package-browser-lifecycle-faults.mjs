/** Test-only fixed fault gates. No provider, browser, store, I/O or loader imports. */
import assert from 'node:assert/strict';
import { types } from 'node:util';

export const LIFECYCLE_EDGE_SCENARIOS=Object.freeze(['late-cancellation','settled-cleanup-recovery']);
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const METHODS=['verifyTarget','coordinatorBinding','bindCoordinator','createOwned','inspectOwned','beginCredentialDelivery','endCredentialDelivery','revokeDeleteOwned'];
const refusal=()=>{const e=Error('PACKAGE_BROWSER_LIFECYCLE_REFUSED');e.stack='PACKAGE_BROWSER_LIFECYCLE_REFUSED';return e;};
function data(value,keys){
  if(!value||typeof value!=='object'||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)throw refusal();
  const fields=Object.getOwnPropertyDescriptors(value),copy={};
  if(Reflect.ownKeys(fields).length!==keys.length||keys.some(key=>!Object.hasOwn(fields,key)))throw refusal();
  for(const key of Reflect.ownKeys(fields)){const field=fields[key];if(typeof key!=='string'||!keys.includes(key)||!field.enumerable||!Object.hasOwn(field,'value'))throw refusal();copy[key]=field.value;}
  return copy;
}
function owner(input){
  const v=data(input,['targetId','bindingHash','runId','operationId','role','email','expiresAt']);
  if(![v.targetId,v.runId,v.operationId].every(x=>typeof x==='string'&&UUID.test(x))||typeof v.bindingHash!=='string'||!HASH.test(v.bindingHash)||
    !['Editor','Reviewer'].includes(v.role)||v.email!==`tlp-${v.runId}-${v.role.toLowerCase()}@example.test`||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<1)throw refusal();
  return Object.freeze(v);
}
const same=(a,b)=>Object.keys(a).every(key=>a[key]===b[key]);

/** Explicit trusted test decorator; never supplied to the worker or package API as fault settings. */
export function createLifecycleEdgeAdapter(underlying,{scenario,cancel}){
  if(!LIFECYCLE_EDGE_SCENARIOS.includes(scenario)||typeof cancel!=='function'||types.isProxy(cancel))throw refusal();
  const original=data(underlying,['metadata',...METHODS]);
  if(METHODS.some(key=>typeof original[key]!=='function'||types.isProxy(original[key])))throw refusal();
  const rows=[],counts={createAttempts:0,deliveryBegins:0,deliveryEnds:0,revocationAttempts:0,revocationAcknowledgements:0,injectedRejections:0};
  let postRunObserved=false,cancellationTriggered=false,recoveryReleased=false;
  function known(value){const v=owner(value),row=rows.find(item=>same(item.owner,v));if(!row)throw refusal();return row;}
  const call=(key,...args)=>Reflect.apply(original[key],undefined,args);
  const adapter={metadata:original.metadata};
  for(const key of ['verifyTarget','coordinatorBinding','bindCoordinator'])adapter[key]=(...args)=>call(key,...args);
  adapter.createOwned=async(value,password)=>{
    const v=owner(value);
    if(rows.length>=2||rows.some(row=>row.owner.role===v.role)||rows.some(row=>['targetId','bindingHash','runId','expiresAt'].some(key=>row.owner[key]!==v[key])))throw refusal();
    rows.push({owner:v,revoked:0});counts.createAttempts++;return call('createOwned',v,password);
  };
  adapter.inspectOwned=value=>call('inspectOwned',known(value).owner);
  adapter.beginCredentialDelivery=value=>{const row=known(value);counts.deliveryBegins++;return call('beginCredentialDelivery',row.owner);};
  adapter.endCredentialDelivery=value=>{const row=known(value);counts.deliveryEnds++;return call('endCredentialDelivery',row.owner);};
  adapter.revokeDeleteOwned=async value=>{
    const row=known(value);counts.revocationAttempts++;
    if(row.revoked>0){
      // Core's first successful cleanup is the in-browser revocation barrier.
      // A repeated call can be treated as post-run only after BOTH original
      // owners acknowledged that barrier; the real producer additionally binds
      // the completed runner report before accepting any scenario as evidence.
      if(rows.length!==2||rows.some(item=>item.revoked<1))throw refusal();
      postRunObserved=true;
      if(scenario==='late-cancellation'&&!cancellationTriggered){cancellationTriggered=true;cancel();}
      if(scenario==='settled-cleanup-recovery'&&!recoveryReleased){counts.injectedRejections++;throw refusal();}
    }
    const result=await call('revokeDeleteOwned',row.owner);
    if(data(result,['revoked']).revoked!==true)throw refusal();
    row.revoked++;counts.revocationAcknowledgements++;return result;
  };
  return Object.freeze({adapter:Object.freeze(adapter),
    matchesOriginalRun:runId=>typeof runId==='string'&&UUID.test(runId)&&rows.length===2&&rows.every(row=>row.owner.runId===runId),
    releaseRecovery(runId){
      if(scenario!=='settled-cleanup-recovery'||recoveryReleased||!postRunObserved||counts.injectedRejections!==1||rows.length!==2||rows.some(row=>row.owner.runId!==runId||row.revoked!==1))throw refusal();
      recoveryReleased=true;
    },
    summary:()=>Object.freeze({owners:rows.length,...counts,postRunObserved,cancellationTriggered,recoveryReleased})});
}
function reasons(value){
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw refusal();const fields=Object.getOwnPropertyDescriptors(value);
  if(value.length!==1||Reflect.ownKeys(fields).length!==2||!Object.hasOwn(fields,'0')||!Object.hasOwn(fields['0'],'value')||!fields['0'].enumerable)throw refusal();
  return [fields['0'].value];
}
/** The original browser verdict is not rewritten into a managed pass. */
export function checkedLifecycleManaged(input,scenario,phase,gate,expectedRunId){
  try{
    const v=data(input,['schemaVersion','runId','verdict','reasonCodes','verification','cleanup','accounts','nativeEntries','temporaryFiles','recoveryRequired']);
    assert.equal(v.schemaVersion,1);assert.equal(typeof v.runId,'string');assert.match(v.runId,UUID);if(expectedRunId!==undefined)assert.equal(v.runId,expectedRunId);
    assert.equal(v.verification,'passed');assert.equal(v.nativeEntries,'completed');assert.equal(v.temporaryFiles,'completed');
    const g=data(gate,['owners','createAttempts','deliveryBegins','deliveryEnds','revocationAttempts','revocationAcknowledgements','injectedRejections','postRunObserved','cancellationTriggered','recoveryReleased']);
    for(const key of ['owners','createAttempts','deliveryBegins','deliveryEnds'])assert.equal(g[key],2);assert.equal(g.postRunObserved,true);
    if(scenario==='late-cancellation'){
      assert.equal(phase,'completed');assert.equal(v.verdict,'cancelled');assert.deepEqual(reasons(v.reasonCodes),['BROWSER_MANAGED_CANCELLED']);
      assert.equal(v.cleanup,'completed');assert.equal(v.accounts,'completed');assert.equal(v.recoveryRequired,false);
      assert.equal(g.cancellationTriggered,true);assert.equal(g.recoveryReleased,false);assert.equal(g.injectedRejections,0);assert.equal(g.revocationAttempts,4);assert.equal(g.revocationAcknowledgements,4);
    }else{
      assert.equal(scenario,'settled-cleanup-recovery');assert.equal(v.verdict,'blocked');assert.deepEqual(reasons(v.reasonCodes),['BROWSER_MANAGED_CLEANUP_INCOMPLETE']);
      assert.equal(g.cancellationTriggered,false);assert.equal(g.injectedRejections,1);
      if(phase==='incomplete'){
        assert.equal(v.cleanup,'incomplete');assert.equal(v.accounts,'incomplete');assert.equal(v.recoveryRequired,true);assert.equal(g.recoveryReleased,false);assert.equal(g.revocationAttempts,3);assert.equal(g.revocationAcknowledgements,2);
      }else{
        assert.equal(phase,'recovered');assert.equal(v.cleanup,'completed');assert.equal(v.accounts,'completed');assert.equal(v.recoveryRequired,false);assert.equal(g.recoveryReleased,true);assert.equal(g.revocationAttempts,5);assert.equal(g.revocationAcknowledgements,4);
      }
    }
    return Object.freeze({scenario,phase,verdict:v.verdict,cleanup:v.cleanup,recoveryRequired:v.recoveryRequired,createAttempts:2});
  }catch{throw refusal();}
}
