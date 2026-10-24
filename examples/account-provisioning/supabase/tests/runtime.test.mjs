/** Local policy/process tests. These are not a Supabase provider acceptance run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {lstat,mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isOwnedSupabaseRuntime,startOwnedSupabase,validRestRequest,validateResourceProof,privateSubnetAddresses} from '../runtime.mjs';
import {localDocker,runOwnedCommand,validateDockerEndpoint} from '../tools/process.mjs';
import {setupSupabaseTools,validateToolsDirectory} from '../tools/setup.mjs';

async function temporary(){
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-supabase-unit-'));
  return {root,async close(){assert.equal(path.dirname(await realpath(root)),parent);assert.match(path.basename(root),/^tld-supabase-unit-/);await rm(root,{recursive:true,force:false});}};
}
test('runtime import has no optional pg/Docker dependency and fake handles cannot acquire its brand',()=>{
  assert.equal(isOwnedSupabaseRuntime({}),false);assert.equal(isOwnedSupabaseRuntime(Object.freeze({targetId:randomUUID()})),false);
});
test('local Docker policy rejects remote endpoints and environment overrides before a command',async()=>{
  for(const endpoint of ['unix:///var/run/docker.sock','npipe:////./pipe/dockerDesktopLinuxEngine'])assert.equal(validateDockerEndpoint(endpoint),true);
  for(const endpoint of ['tcp://127.0.0.1:2375','tcp://example.test:2376','ssh://host','npipe:////other/pipe/docker','unix://remote/socket','unix:///socket\nother'])assert.equal(validateDockerEndpoint(endpoint),false);
  for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])await assert.rejects(localDocker({cwd:os.tmpdir(),env:{[key]:'remote'}}),{code:'SUPABASE_REMOTE_DOCKER_REFUSED'});
});
test('resource mutation proofs bind the full immutable container/network ID to exact owned nonce labels',()=>{
  const nonce='a'.repeat(32),id='b'.repeat(64),labels={'dev.testlane.supabase-owner':nonce,'dev.testlane.purpose':'local-account-proof'};
  assert.equal(validateResourceProof({nonce,id,labels}),true);
  for(const change of [{id:id.slice(0,12)},{nonce:'c'.repeat(32)},{labels:{}},{labels:{...labels,'dev.testlane.purpose':'unrelated'}}])assert.throws(()=>validateResourceProof({nonce,id,labels,...change}),{code:'SUPABASE_OWNERSHIP_REFUSED'});
});
test('fixed gateway targets derive only from aligned private owned-network subnets with spare host addresses',()=>{
  assert.deepEqual(privateSubnetAddresses('172.23.0.0/16'),{database:'172.23.0.2',auth:'172.23.0.3',rest:'172.23.0.4',gateway:'172.23.0.5'});
  assert.equal(privateSubnetAddresses('10.2.0.16/28').database,'10.2.0.18');
  for(const subnet of ['8.8.8.0/24','127.0.0.0/16','192.168.1.1/24','172.33.0.0/16','10.0.0.0/8','10.0.0.0/30','10.0.999.0/24'])assert.throws(()=>privateSubnetAddresses(subnet),{code:'SUPABASE_NETWORK_REFUSED'});
});
test('REST adapter permits only fixed proof operations and cannot forward profile/schema/host/query input',()=>{
  const id=randomUUID();
  for(const args of [['GET','/rpc/whoami'],['POST','/rpc/whoami',{}],['GET','/proof_records'],['POST','/proof_records',{owner_id:id,note:'synthetic'}],['DELETE','/proof_records?id=eq.'+id],['GET','/proof_records?owner_id=eq.'+id]])assert.equal(validRestRequest(...args),true);
  for(const args of [['POST','/rpc/arbitrary',{}],['GET','http://example.test'],['DELETE','/proof_records'],['GET','/proof_records?select=*'],['PATCH','/proof_records'],['DELETE','/proof_records?id=eq.'+id+'&owner_id=neq.'+id],['POST','/proof_records',{owner_id:id,note:'synthetic',role:'service_role'}],['POST','/proof_records',{owner_id:id,note:'other'}],['POST','/rpc/whoami',{sql:'select 1'}]])assert.equal(validRestRequest(...args),false);
});
test('pre-cancelled startup/setup allocates no output and needs no tools or Docker',async()=>{
  const temp=await temporary(),controller=new AbortController();controller.abort();
  try{
    const outputDir=path.join(temp.root,'runtime');
    await assert.rejects(startOwnedSupabase({outputDir,toolsRoot:path.join(temp.root,'missing'),signal:controller.signal}),{code:'SUPABASE_CANCELLED'});
    await assert.rejects(setupSupabaseTools({outputDir,signal:controller.signal}),{code:'SUPABASE_CANCELLED'});
    await assert.rejects(lstat(outputDir),{code:'ENOENT'});
  }finally{await temp.close();}
});
test('explicit tooling destination preserves existing content and rejects redirected parents',async()=>{
  const temp=await temporary();try{
    const existing=path.join(temp.root,'existing');await mkdir(existing);await writeFile(path.join(existing,'keep'),'unchanged');
    await assert.rejects(validateToolsDirectory(existing),{code:'SUPABASE_TOOLS_OUTPUT_EXISTS'});assert.equal(await readFile(path.join(existing,'keep'),'utf8'),'unchanged');
    const alias=path.join(temp.root,'alias');await symlink(existing,alias,process.platform==='win32'?'junction':'dir');
    await assert.rejects(validateToolsDirectory(path.join(alias,'new')),{code:'SUPABASE_TOOLS_OUTPUT_REFUSED'});
    await assert.rejects(validateToolsDirectory('relative'),{code:'SUPABASE_TOOLS_OUTPUT_REFUSED'});
  }finally{await temp.close();}
});
test('bounded child input/output can be inspected privately',async()=>{
  const temp=await temporary(),canary=randomBytes(32).toString('base64url');
  try{
    const echoed=await runOwnedCommand(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{cwd:temp.root,input:canary,timeoutMs:15000});
    assert.equal(echoed.stdout,canary);assert.equal(echoed.code,0);
  }finally{await temp.close();}
});

test('a command timeout is reported without assuming the process reached user code',async()=>{
  const temp=await temporary();try{
    await assert.rejects(runOwnedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:temp.root,timeoutMs:500}),{code:'SUPABASE_COMMAND_TIMEOUT'});
  }finally{await temp.close();}
});

async function reportedPid(file){
  const text=await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const pid=/^[1-9]\d*$/.test(text)?Number(text):NaN;
  return Number.isSafeInteger(pid)?pid:undefined;
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function waitForAbsence(pids){
  const deadline=Date.now()+5000;
  while(pids.some(alive)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(pids.some(alive),false,'the owned parent and child must both be absent after confirmed cancellation');
}

test('cancellation stops the owned parent and child after both independently report readiness',async()=>{
  const temp=await temporary(),controller=new AbortController();
  const parentFile=path.join(temp.root,'parent.pid'),childFile=path.join(temp.root,'child.pid');
  // The child writes its own readiness PID after starting user code. This
  // deliberately occurs later than the separate 500ms timeout test's budget.
  const childSource="const{writeFileSync}=require('node:fs');setTimeout(()=>{writeFileSync(process.argv[1],String(process.pid),{flag:'wx'});setInterval(()=>{},1000);},750);";
  const parentSource="const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');writeFileSync(process.argv[1],String(process.pid),{flag:'wx'});spawn(process.execPath,['-e',process.argv[3],process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000);";
  let settled=false;
  const finished=runOwnedCommand(process.execPath,['-e',parentSource,parentFile,childFile,childSource],
    {cwd:temp.root,timeoutMs:30000,signal:controller.signal}).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  try{
    const deadline=Date.now()+15000;let pids;
    while(Date.now()<deadline){
      pids=await Promise.all([reportedPid(parentFile),reportedPid(childFile)]);
      if(pids.every(pid=>pid!==undefined)&&pids[0]!==pids[1]&&pids.every(alive))break;
      assert.equal(settled,false,'the owned command must stay live until the readiness handshake');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(pids?.every(pid=>pid!==undefined)&&pids[0]!==pids[1]&&pids.every(alive),'both owned processes must report ready within 15 seconds');
    controller.abort();
    assert.equal((await finished).error?.code,'SUPABASE_CANCELLED');
    await waitForAbsence(pids);
  }finally{
    // Also settle teardown when readiness fails, so cold-start failures cannot
    // leave the parent or a child that started near the deadline running.
    controller.abort();await finished;
    const known=(await Promise.all([reportedPid(parentFile),reportedPid(childFile)])).filter(pid=>pid!==undefined);
    await waitForAbsence(known);
    await temp.close();
  }
});
