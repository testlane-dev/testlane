/** Bounded private child output. Commands are argv arrays, never shell strings. */
import {spawn} from 'node:child_process';
import path from 'node:path';

const fixed=code=>Object.assign(new Error(code),{code});
async function stop(child) {
  if(!child.pid)return false;
  let closed=false;const observed=()=>{closed=true;};child.once('close',observed);
  let tree=false;
  if(process.platform==='win32') {
    const system=process.env.SystemRoot??process.env.windir;
    if(system&&path.isAbsolute(system))tree=await new Promise(resolve=>{
      let killer,done=false;const finish=ok=>{if(done)return;done=true;clearTimeout(timer);resolve(ok);};
      const timer=setTimeout(()=>{try{killer?.kill();}catch{}finish(false);},5000);
      try{killer=spawn(path.join(system,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.once('error',()=>finish(false));killer.once('close',code=>finish(code===0));}catch{finish(false);}
    });
  }else try{process.kill(-child.pid,'SIGKILL');tree=true;}catch{}
  if(!tree)try{child.kill('SIGKILL');}catch{}
  if(!closed)await new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);child.off('close',finish);closed=true;resolve();};
    const timer=setTimeout(()=>{child.off('close',finish);resolve();},5000);child.once('close',finish);
  });
  child.off('close',observed);
  if(!closed){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}
  return tree&&closed;
}
export async function runOwnedCommand(executable,args,{cwd,env=process.env,input,timeoutMs=30000,signal}={}) {
  if(typeof executable!=='string'||!Array.isArray(args)||!args.every(x=>typeof x==='string'&&!x.includes('\0'))||
    !path.isAbsolute(cwd??'')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>220000)throw fixed('SUPABASE_COMMAND_INPUT_REFUSED');
  if(signal?.aborted)throw fixed('SUPABASE_CANCELLED');
  return new Promise((resolve,reject)=>{
    let child,timer,settled=false,stopping=false,stdout='',stderr='';
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(fixed(error));};
    const terminate=code=>{if(stopping||settled)return;stopping=true;void stop(child).then(ok=>finish(ok?code:'SUPABASE_COMMAND_STOP_UNCONFIRMED'),()=>finish('SUPABASE_COMMAND_STOP_UNCONFIRMED'));};
    const abort=()=>terminate('SUPABASE_CANCELLED');
    try{
      child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      for(const [name,append] of [['stdout',text=>{stdout+=text;}],['stderr',text=>{stderr+=text;}]])child[name].on('data',bytes=>{
        if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+bytes.length>128*1024)terminate('SUPABASE_COMMAND_OUTPUT_LIMIT');else append(bytes.toString('utf8'));
      });
      child.stdin.on('error',()=>{});child.once('error',()=>finish('SUPABASE_COMMAND_START_FAILED'));
      child.once('close',code=>{if(settled||stopping)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,stdout,stderr});});
      timer=setTimeout(()=>terminate('SUPABASE_COMMAND_TIMEOUT'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      child.stdin.end(input);
    }catch{finish('SUPABASE_COMMAND_START_FAILED');}
  });
}
export function validateDockerEndpoint(endpoint) {
  return typeof endpoint==='string'&&(/^(?:unix:\/\/\/[^\r\n\0]+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_-]+)$/.test(endpoint));
}
export async function localDocker({cwd,env=process.env,signal}={}) {
  for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])if(env[key])throw fixed('SUPABASE_REMOTE_DOCKER_REFUSED');
  const call=args=>runOwnedCommand('docker',args,{cwd,env,timeoutMs:15000,signal});
  const shown=await call(['context','show']);const context=shown.stdout.trim();
  if(shown.code!==0||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(context))throw fixed('SUPABASE_DOCKER_PREREQUISITE_FAILED');
  const inspected=await call(['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']);let endpoint;
  try{endpoint=JSON.parse(inspected.stdout);}catch{throw fixed('SUPABASE_REMOTE_DOCKER_REFUSED');}
  if(inspected.code!==0||!validateDockerEndpoint(endpoint))throw fixed('SUPABASE_REMOTE_DOCKER_REFUSED');
  const version=await call(['--context',context,'version','--format','{{json .Server}}']);let server;
  try{server=JSON.parse(version.stdout);}catch{throw fixed('SUPABASE_DOCKER_PREREQUISITE_FAILED');}
  if(version.code!==0||server.Os!=='linux'||typeof server.Version!=='string'||!/^29\./.test(server.Version))throw fixed('SUPABASE_DOCKER_PREREQUISITE_FAILED');
  return {context,version:server.Version,endpoint};
}
