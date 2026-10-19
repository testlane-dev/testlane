import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {digestTree,runProofPhases} from '../../../scripts/native-proof-support.mjs';

test('package-tree binding distinguishes file boundaries even when raw concatenations are identical',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tld-tree-binding-'));
  try{
    await writeFile(path.join(root,'a'),'x');await writeFile(path.join(root,'b'),'y');const first=await digestTree(root);
    await writeFile(path.join(root,'a'),'xb\0y');await unlink(path.join(root,'b'));
    assert.notEqual(await digestTree(root),first);
  }finally{await rm(root,{recursive:true,force:true});}
});

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'tld-proof-controller-'));
  const packageRoot=path.join(root,'package'),output=path.join(root,'evidence');
  await mkdir(path.join(packageRoot,'examples/android-verification'),{recursive:true});
  await mkdir(path.join(output,'recovery'),{recursive:true});
  const spec=path.join(packageRoot,'examples/android-verification/proof-cases.mjs');
  await writeFile(spec,'// fixed proof inputs\n');
  const cases=['anonymous-denied','editor-native-total','reviewer-native-approval','editor-cannot-approve','duplicate-approval-denied']
    .map(id=>({id,cleanup:{required:id!=='anonymous-denied'}}));
  const records=[];let defect=false;
  const options={consumer:{packageRoot},output,plan:{cases},cookies:{editor:'memory-only'},identities:{},
    before:await digestTree(packageRoot),device:{assertOwned:async()=>{},assertBootstrapAbsent:async()=>{},writeBootstrap:async()=>{}},
    app:{origin:'http://127.0.0.1:1234',setDefect:value=>{defect=value;},records:()=>records},
    sanitize:report=>report,assertBuildUnchanged:async()=>{},workerTimeoutMs:1000};
  options.runWorker=async({onRequest})=>{
    await onRequest({type:'assert-owned'});
    const marker='native-proof-'+randomUUID(),id=randomUUID(),caseId='editor-native-total';
    await onRequest({type:'intent',caseId,marker});
    records.push({id,marker});await onRequest({type:'record',caseId,marker,id});records.length=0;
    await onRequest({type:'remove',caseId});
    return {report:{verdict:defect?'failed':'passed',reasonCodes:[],cases:cases.map(row=>{
      const failed=defect&&['editor-native-total','reviewer-native-approval'].includes(row.id);
      return {id:row.id,status:failed?'failed':'passed',reason:failed?'NATIVE_ASSERTION_FAILED':undefined,attempts:1,
        bodyAssertionsObserved:1,cleanup:{status:row.cleanup.required?'completed':'not-required'}};
    })}};
  };
  return {root,records,spec,options,async close(){await rm(root,{recursive:true,force:true});}};
}

test('controller requires the unchanged five-case suite to pass, detect exactly two defects, then pass',async()=>{
  const f=await fixture();try{
    f.options.device.assertOwned=()=>delay(5);
    const result=await runProofPhases(f.options);
    assert.deepEqual(result.runs.map(row=>[row.passed,row.failed,row.recordsRemaining]),[[5,0,0],[3,2,0],[5,0,0]]);
    assert.equal((await readdir(path.join(f.options.output,'recovery'))).length,0);
    assert.equal(JSON.parse(await readFile(path.join(f.options.output,'fault.json'))).verdict,'failed');
    assert.deepEqual(result.timings,JSON.parse(await readFile(path.join(f.options.output,'timings.json'))));
    assert.deepEqual(result.timings.phases.map(row=>row.phase),['positive','fault','corrected']);
    assert.equal(result.timings.assertOwned.calls,3);assert.equal(result.timings.assertOwned.failed,0);
    assert.equal(result.timings.assertOwned.elapsedMs,result.timings.phases.reduce((total,row)=>total+row.assertOwned.elapsedMs,0));
    for(const row of result.timings.phases){
      assert.ok(Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=row.assertOwned.elapsedMs);
      assert.equal(row.assertOwned.calls,1);assert.equal(row.assertOwned.failed,0);assert.ok(row.assertOwned.elapsedMs>=1);
    }
  }finally{await f.close();}
});

test('fixed numeric ownership timing evidence survives an early private failure without copying its payload',async()=>{
  const f=await fixture(),secret='private-'+randomUUID();
  try{
    f.options.device.assertOwned=async()=>{await delay(5);throw Error(secret);};
    await assert.rejects(runProofPhases(f.options),error=>error.message===secret);
    const bytes=await readFile(path.join(f.options.output,'timings.json'),'utf8'),timings=JSON.parse(bytes);
    assert.deepEqual(Object.keys(timings).sort(),['assertOwned','phases','schemaVersion']);
    assert.equal(timings.schemaVersion,1);assert.equal(timings.phases.length,1);assert.equal(timings.phases[0].phase,'positive');
    for(const row of [timings.assertOwned,timings.phases[0].assertOwned]){
      assert.deepEqual(Object.keys(row).sort(),['calls','elapsedMs','failed']);
      assert.equal(row.calls,1);assert.equal(row.failed,1);assert.ok(Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=1);
    }
    assert.deepEqual(Object.keys(timings.phases[0]).sort(),['assertOwned','elapsedMs','phase']);
    assert.ok(Number.isSafeInteger(timings.phases[0].elapsedMs)&&timings.phases[0].elapsedMs>=timings.assertOwned.elapsedMs);
    for(const value of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')])assert.equal(bytes.includes(value),false);
    assert.equal((await readdir(f.options.output)).includes('receipt.json'),false);
  }finally{await f.close();}
});

test('a worker cleanup claim cannot override the controller observing an owned backend record',async()=>{
  const f=await fixture();try{
    f.options.runWorker=async({onRequest})=>{
      const caseId='editor-native-total',marker='native-proof-'+randomUUID(),id=randomUUID();
      await onRequest({type:'intent',caseId,marker});f.records.push({marker,id});
      await onRequest({type:'record',caseId,marker,id});await onRequest({type:'remove',caseId});
      assert.fail('an existing record must refuse the cleanup ACK');
    };
    await assert.rejects(runProofPhases(f.options),/independently confirms absence/);
    assert.equal((await readdir(path.join(f.options.output,'recovery'))).length,1,'recovery intent remains');
  }finally{await f.close();}
});

test('a changed installed case file cannot receive acceptance even when the worker returns passing cases',async()=>{
  const f=await fixture();try{
    const run=f.options.runWorker;
    f.options.runWorker=async request=>{const result=await run(request);await writeFile(f.spec,'// changed during proof\n');return result;};
    await assert.rejects(runProofPhases(f.options),assert.AssertionError);
  }finally{await f.close();}
});
