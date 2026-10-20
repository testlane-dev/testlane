import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicIosFailure} from '../failure.mjs';
test('failure summaries omit arbitrary errors, stages and unvalidated reports',async()=>{
  const output=await mkdtemp(path.join(os.tmpdir(),'tld-ios-failure-')),secret=randomBytes(32).toString('base64url');
  try{
    await writeFile(path.join(output,'plan.json'),JSON.stringify({runner:'ios-xcuitest',cases:[{id:secret}]}));
    await writeFile(path.join(output,'positive.json'),JSON.stringify({private:secret}));
    const summary=await publicIosFailure({output,stage:secret,error:Error(secret)});
    assert.deepEqual(summary,{schemaVersion:1,status:'failed',stage:'setup',code:'IOS_PROOF_FAILED',reports:[]});
    assert.equal(JSON.stringify(summary).includes(secret),false);
    assert.equal((await publicIosFailure({output,stage:'positive',error:{code:'ERR_ASSERTION'}})).code,'IOS_PROOF_ASSERTION_FAILED');
  }finally{await rm(output,{recursive:true,force:true});}
});

test('readiness failures retain only the explicit native-code allowlist and fixed readiness stage',async()=>{
  for(const code of ['NATIVE_DRIVER_SESSION_TIMEOUT','NATIVE_DRIVER_OWNERSHIP_REFUSED','NATIVE_DRIVER_CONTEXT_REFUSED','NATIVE_DRIVER_TIMEOUT','NATIVE_DRIVER_CANCELLED']){
    const summary=await publicIosFailure({output:'missing-readiness-output',stage:'wda-readiness',error:{code,message:'private-native-message'}});
    assert.equal(summary.stage,'wda-readiness');assert.equal(summary.code,code);assert.equal(JSON.stringify(summary).includes('private-native-message'),false);
  }
  const summary=await publicIosFailure({output:'missing-readiness-output',stage:'wda-readiness',error:{code:'NATIVE_DRIVER_arbitrary-private-value',message:'private-native-message'}});
  assert.equal(summary.code,'IOS_PROOF_FAILED');assert.equal(JSON.stringify(summary).includes('private'),false);
});
