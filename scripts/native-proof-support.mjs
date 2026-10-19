/** Common installed-package business proof. Platform owners supply device/build/store lifecycles. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function tree(root) {
  const result=[];
  async function walk(dir) {
    for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      assert.equal(item.isSymbolicLink(),false,'proof files must not be symlinks');
      const file=path.join(dir,item.name);
      if(item.isDirectory())await walk(file);
      else if(item.isFile())result.push([path.relative(root,file),await readFile(file)]);
    }
  }
  await walk(root);return result;
}
export const digestTree=async root=>sha(JSON.stringify((await tree(root)).map(([name,bytes])=>[name.split(path.sep).join('/'),sha(bytes)])));
export async function installedModule(packageRoot,file) {
  const root=await realpath(packageRoot),candidate=await realpath(path.join(root,file)),relative=path.relative(root,candidate);
  assert.ok(relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));
  return import(pathToFileURL(candidate).href);
}
export function proofProfiles(namespace,origin,accounts,app='testlane-android-proof') {
  return {version:1,profiles:Object.fromEntries(Object.entries(accounts).map(([role,account])=>[namespace+':testing:'+role,{
    app,environment:'testing',baseUrl:origin,strategy:'form-post',account:{email:account.email,role:account.role},session:{ttlMinutes:30},
    options:{loginPath:'/api/login',bodyFormat:'json',fields:'{"email":"{{email}}","password":"{{secret}}"}',sessionCookieName:'tldemo_session',mePath:'/api/me'},
  }]))};
}
export async function runProofPhases({consumer,app,device,plan,cookies,identities,output,before,runWorker,sanitize,signal,
  workerTimeoutMs,driverOptions,assertBuildUnchanged,onStage=()=>{},onCaptured=()=>{},onWorkerRisk=()=>{}}) {
  const recovery=path.join(output,'recovery'),journals=new Map();
  const metric=()=>({calls:0,failed:0,elapsedMs:0}),elapsed=start=>Math.max(0,Math.round(performance.now()-start));
  // These metrics contain fixed operation/phase labels and numbers only. They
  // deliberately stay outside the native report contract and retain no values,
  // identifiers, raw errors, device responses or credential-bearing payloads.
  const timings={schemaVersion:1,assertOwned:metric(),phases:[]};
  let currentPhase;
  const planBytes=Buffer.from(JSON.stringify(plan,null,2)+'\n'),planSha256=sha(planBytes);
  await writeFile(path.join(output,'plan.json'),planBytes,{flag:'wx',mode:0o600});
  const specFile=path.join(consumer.packageRoot,'examples/android-verification/proof-cases.mjs'),specSha256=sha(await readFile(specFile));
  const onRequest=async request=>{
    if(request.type==='assert-owned'){
      const start=performance.now(),phaseMetric=currentPhase?.assertOwned;let failed=true;
      timings.assertOwned.calls++;if(phaseMetric)phaseMetric.calls++;
      try{await device.assertOwned();failed=false;return true;}
      finally{
        const milliseconds=elapsed(start);timings.assertOwned.elapsedMs+=milliseconds;if(phaseMetric)phaseMetric.elapsedMs+=milliseconds;
        if(failed){timings.assertOwned.failed++;if(phaseMetric)phaseMetric.failed++;}
      }
    }
    if(request.type==='bootstrap-consumed'){await device.assertBootstrapAbsent();return true;}
    if(request.type==='load-role'){
      assert.ok(Object.hasOwn(cookies,request.role));
      await device.writeBootstrap(JSON.stringify({schemaVersion:1,origin:app.origin,cookie:cookies[request.role]}));return true;
    }
    assert.ok(plan.cases.some(item=>item.id===request.caseId&&item.cleanup.required));
    const file=path.join(recovery,request.caseId+'.json');
    if(request.type==='intent'){
      assert.match(request.marker,/^native-proof-[a-f0-9-]{36}$/);assert.equal(journals.has(request.caseId),false);
      const entry={caseId:request.caseId,marker:request.marker,id:null};
      await writeFile(file,JSON.stringify(entry)+'\n',{flag:'wx',mode:0o600});journals.set(request.caseId,entry);return true;
    }
    const owned=journals.get(request.caseId);assert.ok(owned);
    if(request.type==='record'){
      assert.equal(owned.marker,request.marker);assert.match(request.id,/^[a-f0-9-]{36}$/);assert.ok(owned.id===null||owned.id===request.id);
      owned.id=request.id;await writeFile(file,JSON.stringify(owned)+'\n',{mode:0o600});return true;
    }
    if(request.type==='remove'){
      assert.equal(app.records().some(row=>row.marker===owned.marker||row.id===owned.id),false,'controller independently confirms absence');
      await unlink(file);journals.delete(request.caseId);return true;
    }
    throw Error('NATIVE_PROOF_RPC_REFUSED');
  };
  const runs=[];
  for(const [phase,defect] of [['positive',false],['fault',true],['corrected',false]]){
    signal?.throwIfAborted();onStage(phase);app.setDefect(defect);
    const phaseStart=performance.now();currentPhase={phase,elapsedMs:0,assertOwned:metric()};timings.phases.push(currentPhase);
    try{
      const result=await runWorker({plan,identities,origin:app.origin,cookies,onRequest,signal,timeoutMs:workerTimeoutMs,driverOptions});
      onCaptured(result.captured??'');
      const report=sanitize(result.report,plan);
      if(report.reasonCodes.some(code=>['NATIVE_WORKER_TERMINATION_UNCONFIRMED','NATIVE_WORKER_RPC_UNSETTLED'].includes(code)))onWorkerRisk();
      await writeFile(path.join(output,phase+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
      assert.equal(report.verdict,defect?'failed':'passed','unchanged native suite detects the injected total defect');
      for(const row of report.cases){
        assert.equal(row.attempts,1);assert.ok(row.bodyAssertionsObserved>0);
        assert.equal(row.cleanup.status,row.id==='anonymous-denied'?'not-required':'completed');
        const failed=defect&&['editor-native-total','reviewer-native-approval'].includes(row.id);
        assert.equal(row.status,failed?'failed':'passed');if(failed)assert.equal(row.reason,'NATIVE_ASSERTION_FAILED');
      }
      assert.equal(app.records().length,0,'independent controller proves no records remain');assert.equal(journals.size,0);
      assert.equal(sha(await readFile(specFile)),specSha256);assert.equal(sha(await readFile(path.join(output,'plan.json'))),planSha256);
      assert.equal(await digestTree(consumer.packageRoot),before);await assertBuildUnchanged();
      runs.push({phase,verdict:report.verdict,passed:report.cases.filter(row=>row.status==='passed').length,failed:report.cases.filter(row=>row.status==='failed').length,recordsRemaining:0});
    }finally{
      currentPhase.elapsedMs=elapsed(phaseStart);currentPhase=undefined;
      await writeFile(path.join(output,'timings.json'),JSON.stringify(timings,null,2)+'\n',{mode:0o600});
    }
  }
  return {runs,planSha256,specSha256,timings};
}
