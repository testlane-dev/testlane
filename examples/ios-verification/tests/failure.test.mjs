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
