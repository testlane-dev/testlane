/** A real CLI/KeychainMacosStore proof confined to an explicitly opted-in ephemeral CI Mac. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const fail=code=>new Error(code),MARKER='testlane-ios-broker.json';
export function requireIosBrokerCi({platform=process.platform,env=process.env}={}) {
  if(platform!=='darwin'||env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.TESTLANE_IOS_PROOF_CI!=='1')throw fail('IOS_BROKER_EPHEMERAL_CI_REQUIRED');
}
export function validateIosBrokerMarker({root,home,keychain,marker,parentPid}) {
  const p=path.posix;
  if(typeof root!=='string'||!/^\/[A-Za-z0-9._/-]+$/.test(root)||!/^tld-ios-broker-[A-Za-z0-9]+$/.test(p.basename(root))||
    p.normalize(root)!==root||home!==p.join(root,'home')||keychain!==p.join(root,'proof.keychain-db')||!marker||marker.schemaVersion!==1||
    marker.root!==root||marker.home!==home||marker.keychain!==keychain||!Number.isSafeInteger(parentPid)||parentPid<1||marker.ownerPid!==parentPid||
    !/^[a-f0-9]{24}$/.test(marker.nonce??''))throw fail('IOS_BROKER_OWNERSHIP_REFUSED');
  return true;
}
export function scanIosCredentials(text,values) {
  for(const value of values){
    assert.ok(typeof value==='string'&&value.length>0);
    for(const variant of [value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('base64url')])
      if(text.includes(variant))throw fail('IOS_BROKER_CREDENTIAL_LEAK');
  }
}
/** A timed-out create command can still have committed. Inspect actual owned state on every disposal. */
export async function reconcileIosKeychain({inspect,remove,restoreSearch}) {
  let error;
  try {
    let metadata;
    try{metadata=await inspect();}catch(caught){if(caught.code!=='ENOENT')throw caught;}
    if(metadata){
      if(!metadata.isFile()||metadata.isSymbolicLink())throw fail('IOS_BROKER_KEYCHAIN_OWNERSHIP_REFUSED');
      if((await remove()).code!==0)throw fail('IOS_BROKER_KEYCHAIN_DELETE_FAILED');
    }
    try{await inspect();throw fail('IOS_BROKER_KEYCHAIN_DELETE_UNCONFIRMED');}catch(caught){if(caught.code!=='ENOENT')throw caught;}
  }catch(caught){error=caught;}
  try{await restoreSearch();}catch(caught){error??=caught;}
  if(error)throw error;
}
function systemCommand(args,{cwd,input,timeoutMs=30000,signal}={}) {
  if(signal?.aborted)return Promise.reject(fail('IOS_BROKER_CANCELLED'));
  return new Promise((resolve,reject)=>{
    let child,stdout='',stderr='',closed=false,settled=false,stopping=false,timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(result);};
    const stop=async code=>{
      if(stopping||settled)return;stopping=true;clearTimeout(timer);
      if(child?.pid&&!closed){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
      if(!closed)await new Promise(resolve=>{const t=setTimeout(resolve,5000);child.once('close',()=>{clearTimeout(t);resolve();});});
      if(!closed){child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();child.unref();}
      finish(fail(closed?code:'IOS_BROKER_PROCESS_STOP_UNCONFIRMED'));
    };
    const cancel=()=>{void stop('IOS_BROKER_CANCELLED');};
    try{
      child=spawn('/usr/bin/security',args,{cwd,shell:false,detached:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DEBUG:'',NODE_DEBUG:'',NODE_OPTIONS:''}});
      child.stdin.on('error',()=>{});
      for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>{
        if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+bytes.length>128*1024){void stop('IOS_BROKER_OUTPUT_LIMIT');return;}
        if(stream==='stdout')stdout+=bytes.toString('utf8');else stderr+=bytes.toString('utf8');
      });
      child.once('error',()=>finish(fail('IOS_BROKER_TOOL_START_FAILED')));
      child.once('close',code=>{closed=true;if(!stopping)finish(null,{code,stdout,stderr});});
      timer=setTimeout(()=>{void stop('IOS_BROKER_TOOL_TIMEOUT');},timeoutMs);
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();child.stdin.end(input);
    }catch{finish(fail('IOS_BROKER_TOOL_START_FAILED'));}
  });
}
export async function startIosBroker({packageRoot,registry,signal}={}) {
  requireIosBrokerCi();signal?.throwIfAborted();
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-ios-broker-'));
  const home=path.join(root,'home'),keychain=path.join(root,'proof.keychain-db'),nonce=randomBytes(12).toString('hex');
  const password=randomBytes(24).toString('hex'),profilesFile=path.join(root,'testlane.profiles.json');
  let captured='',baselineSearch,baselineDefault,created=false,closed=false;
  const command=async(args,options={})=>{const result=await systemCommand(args,{cwd:root,...options});captured+=result.stdout+result.stderr;return result;};
  const parsePaths=text=>{
    const rows=text.trim().split('\n').filter(Boolean).map(line=>/^\s*"([^"\r\n]+)"\s*$/.exec(line)?.[1]);
    if(rows.some(row=>!row||!path.isAbsolute(row)))throw fail('IOS_BROKER_SEARCH_LIST_INVALID');return rows;
  };
  const search=async()=>{const result=await command(['list-keychains','-d','user']);if(result.code!==0)throw fail('IOS_BROKER_SEARCH_LIST_FAILED');return parsePaths(result.stdout);};
  const defaultKeychain=async()=>{const result=await command(['default-keychain','-d','user']);if(result.code!==0)throw fail('IOS_BROKER_DEFAULT_INSPECTION_FAILED');return parsePaths(result.stdout);};
  async function assertOwned(){
    if(path.dirname(root)!==parent||(await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw fail('IOS_BROKER_OWNERSHIP_REFUSED');
    const marker=JSON.parse(await readFile(path.join(root,MARKER),'utf8'));
    validateIosBrokerMarker({root,home,keychain,marker,parentPid:process.pid});
    for(const file of [home,profilesFile])if((await lstat(file)).isSymbolicLink()||await realpath(file)!==file)throw fail('IOS_BROKER_OWNERSHIP_REFUSED');
  }
  async function restoreSearch(){
    if(!baselineSearch)return;
    if(JSON.stringify(await search())!==JSON.stringify(baselineSearch)){
      const restored=await command(['list-keychains','-d','user','-s',...baselineSearch]);
      if(restored.code!==0||JSON.stringify(await search())!==JSON.stringify(baselineSearch))throw fail('IOS_BROKER_SEARCH_LIST_RESTORE_FAILED');
    }
    if(JSON.stringify(await defaultKeychain())!==JSON.stringify(baselineDefault))throw fail('IOS_BROKER_DEFAULT_CHANGED');
  }
  async function dispose({removeHome=true}={}){
    if(closed)return;await assertOwned();
    await reconcileIosKeychain({inspect:()=>lstat(keychain),remove:()=>command(['delete-keychain',keychain]),restoreSearch});created=false;
    scanIosCredentials(captured,[password]);
    if(removeHome)await rm(root,{recursive:true,force:false});closed=true;
  }
  try{
    await mkdir(home,{mode:0o700});
    await writeFile(profilesFile,JSON.stringify(registry)+'\n',{flag:'wx',mode:0o600});
    await writeFile(path.join(root,MARKER),JSON.stringify({schemaVersion:1,root,home,keychain,nonce,ownerPid:process.pid})+'\n',{flag:'wx',mode:0o600});
    await assertOwned();baselineSearch=await search();baselineDefault=await defaultKeychain();
    // Password exists only in this private stdin command, never argv/environment.
    const initialized=await command(['-i'],{input:'create-keychain -p '+password+' '+keychain+'\nunlock-keychain -p '+password+' '+keychain+'\nset-keychain-settings '+keychain+'\n',signal});
    try{const metadata=await lstat(keychain);created=metadata.isFile()&&!metadata.isSymbolicLink();}catch{}
    if(initialized.code!==0||!created)throw fail('IOS_BROKER_KEYCHAIN_CREATE_FAILED');
    await restoreSearch();
    const {runDemoChild}=await import(pathToFileURL(path.join(packageRoot,'examples/verification-demo/native.mjs')).href);
    const env={...process.env,TESTLANE_HOME:home,AGENT_AUTH_HOME:home,TESTLANE_PROFILES:profilesFile,AGENT_AUTH_PROFILES:'',TESTLANE_IOS_BROKER_ROOT:root,
      TESTLANE_STORE:'keychain-macos',AGENT_AUTH_STORE:'',TESTLANE_REQUESTER:'',AGENT_AUTH_REQUESTER:'',DEBUG:'',NODE_DEBUG:'',NODE_OPTIONS:''};
    return {root,home,env,assertOwned,capturedText:()=>captured,
      async cli(args,options={}){await assertOwned();const result=await runDemoChild({entry:path.join(packageRoot,'examples/ios-verification/broker-child.mjs'),args,cwd:root,env,signal,...options});captured+=result.stdout+result.stderr;return result;},
      async auditText(){try{return await readFile(path.join(home,'audit.ndjson'),'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}},
      scan(text,extra=[]){scanIosCredentials(text+captured,[password,...extra]);},dispose};
  }catch(error){
    try{await dispose({removeHome:false});}catch{}
    const safe=fail(/^IOS_[A-Z_]+$/.test(error.message)?error.message:'IOS_BROKER_START_FAILED');safe.root=root;throw safe;
  }
}
