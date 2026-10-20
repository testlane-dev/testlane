/** Actual receipt files with deterministic cancellation, no broker/provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {lstat,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {finalizeProvisioningProof} from '../proof-finalization.mjs';
import {createPrivateRuntimeDirectory} from '../supabase/tools/private-directory.mjs';
import {fixture} from './private-proof-fixture.mjs';
const verified=()=>({schemaVersion:1,passed:true,cleanupVerified:true,credentialLeakScanPassed:true});

for(const [kind,prefix] of [['synthetic','PROVISION_PROOF'],['supabase','SUPABASE_PROOF']]){
  for(const checkpoint of ['after-cleanup','before-write','after-write']){
    test(kind+' abort at '+checkpoint+' leaves no passing receipt and records already verified cleanup',async()=>{
      const f=await fixture(),output=await createPrivateRuntimeDirectory(path.join(f.parent,'proof'));
      const controller=new AbortController(),seen=[];
      try{
        await assert.rejects(finalizeProvisioningProof({outputDir:output,receipt:verified(),kind,signal:controller.signal,
          onCheckpoint:stage=>{seen.push(stage);if(stage===checkpoint)controller.abort();}}),{code:prefix+'_CANCELLED'});
        assert.equal(controller.signal.aborted,true);assert.ok(seen.includes(checkpoint));
        await assert.rejects(lstat(path.join(output,'receipt.json')),{code:'ENOENT'});
        assert.deepEqual(JSON.parse(await readFile(path.join(output,'failure.json'),'utf8')),{schemaVersion:1,status:'cancelled',
          stage:'receipt-finalization',code:prefix+'_CANCELLED',cleanupVerified:true,credentialLeakScanPassed:true,passingReceiptAbsent:true});
      }finally{await f.close();}
    });
  }
}
test('successful finalization keeps the verified receipt and emits no failure artifact',async()=>{
  const f=await fixture(),output=await createPrivateRuntimeDirectory(path.join(f.parent,'proof'));
  try{
    const receipt=verified();
    assert.equal(await finalizeProvisioningProof({outputDir:output,receipt,kind:'synthetic'}),receipt);
    assert.deepEqual(JSON.parse(await readFile(path.join(output,'receipt.json'),'utf8')),receipt);
    assert.deepEqual(await readdir(output),['receipt.json']);
  }finally{await f.close();}
});
test('an existing receipt is refused and is never overwritten or deleted by a failed finalization',async()=>{
  const f=await fixture(),output=await createPrivateRuntimeDirectory(path.join(f.parent,'proof'));
  try{
    const prior=randomBytes(32).toString('hex'),file=path.join(output,'receipt.json');await writeFile(file,prior,{flag:'wx',mode:0o600});
    await assert.rejects(finalizeProvisioningProof({outputDir:output,receipt:verified(),kind:'synthetic'}),{code:'PROVISION_PROOF_FINALIZATION_EVIDENCE_INCOMPLETE'});
    assert.equal(await readFile(file,'utf8'),prior);
    const failure=JSON.parse(await readFile(path.join(output,'failure.json'),'utf8'));
    assert.equal(failure.passingReceiptAbsent,false);assert.equal(failure.status,'failed');
  }finally{await f.close();}
});
test('an arbitrary observer error after writing is fixed and invalidates only this finalizer receipt',async()=>{
  const f=await fixture(),output=await createPrivateRuntimeDirectory(path.join(f.parent,'proof'));
  try{
    const canary=randomBytes(32).toString('base64url');
    await assert.rejects(finalizeProvisioningProof({outputDir:output,receipt:verified(),kind:'supabase',
      onCheckpoint:stage=>{if(stage==='after-write')throw Error(canary);}}),{code:'SUPABASE_PROOF_FINALIZATION_FAILED'});
    await assert.rejects(lstat(path.join(output,'receipt.json')),{code:'ENOENT'});
    assert.equal((await readFile(path.join(output,'failure.json'),'utf8')).includes(canary),false);
  }finally{await f.close();}
});
test('cleanup that has not been independently verified cannot obtain a passing receipt',async()=>{
  const f=await fixture(),output=await createPrivateRuntimeDirectory(path.join(f.parent,'proof'));
  try{
    await assert.rejects(finalizeProvisioningProof({outputDir:output,receipt:{...verified(),cleanupVerified:false},kind:'synthetic'}),
      {code:'PROVISION_PROOF_FINALIZATION_REFUSED'});
    assert.deepEqual(await readdir(output),[]);
  }finally{await f.close();}
});
test('prototype property names cannot choose a proof codebook or create receipt files',async()=>{
  const f=await fixture(),output=await createPrivateRuntimeDirectory(path.join(f.parent,'proof'));
  try{
    await assert.rejects(finalizeProvisioningProof({outputDir:output,receipt:verified(),kind:'constructor'}),
      {code:'PROVISION_PROOF_FINALIZATION_REFUSED'});
    assert.deepEqual(await readdir(output),[]);
  }finally{await f.close();}
});
