/** Explicit optional tooling/image installation. Importing this file is inert. */
import {createHash,randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SUPABASE_IMAGES,PG_VERSION} from '../runtime.mjs';
import {localDocker,runOwnedCommand} from './process.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export async function validateToolsDirectory(requested) {
  if(typeof requested!=='string'||!path.isAbsolute(requested)||/[\r\n\0]/.test(requested)||path.dirname(path.resolve(requested))===path.resolve(requested))throw fail('SUPABASE_TOOLS_OUTPUT_REFUSED');
  const root=path.resolve(requested),parent=await realpath(path.dirname(root));
  if(!same(parent,path.dirname(root))||(await lstat(parent)).isSymbolicLink())throw fail('SUPABASE_TOOLS_OUTPUT_REFUSED');
  if(await lstat(root).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw fail('SUPABASE_TOOLS_OUTPUT_EXISTS');
  return root;
}
export async function setupSupabaseTools({outputDir,signal}={}) {
  if(signal?.aborted)throw fail('SUPABASE_CANCELLED');const root=await validateToolsDirectory(outputDir);
  const docker=await localDocker({cwd:HERE,signal});
  await mkdir(root,{mode:0o700});await writeFile(path.join(root,'.gitignore'),'*\n',{flag:'wx',mode:0o600});
  const marker={schemaVersion:1,nonce:randomBytes(16).toString('hex'),ownerPid:process.pid,pgVersion:PG_VERSION,images:SUPABASE_IMAGES,complete:false,packageSha256:{}};
  const markerFile=path.join(root,'supabase-tools.json');
  for(const file of ['package.json','package-lock.json']){await copyFile(path.join(HERE,file),path.join(root,file));marker.packageSha256[file]=hash(await readFile(path.join(root,file)));}
  await writeFile(markerFile,JSON.stringify(marker,null,2)+'\n',{flag:'wx',mode:0o600});
  try{
    const npm=process.env.npm_execpath&&path.isAbsolute(process.env.npm_execpath)?process.env.npm_execpath:path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
    const installed=await runOwnedCommand(process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,timeoutMs:180000,signal});
    if(installed.code!==0)throw fail('SUPABASE_TOOLS_INSTALL_FAILED');
    for(const image of Object.values(SUPABASE_IMAGES)){
      const pulled=await runOwnedCommand('docker',['--context',docker.context,'pull',image.reference],{cwd:root,timeoutMs:180000,signal});
      if(pulled.code!==0)throw fail('SUPABASE_IMAGE_INSTALL_FAILED');
    }
    marker.complete=true;await writeFile(markerFile,JSON.stringify(marker,null,2)+'\n',{mode:0o600});
    return {installed:true,pg:PG_VERSION,images:SUPABASE_IMAGES};
  }catch(error){marker.failure=/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_TOOLS_INSTALL_FAILED';await writeFile(markerFile,JSON.stringify(marker,null,2)+'\n',{mode:0o600});throw fail(marker.failure);}
}
const invoked=process.argv[1]&&(()=>{try{return same(realpathSync(process.argv[1]),realpathSync(fileURLToPath(import.meta.url)));}catch{return false;}})();
if(invoked){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--output-dir'){process.stderr.write('SUPABASE_TOOLS_ARGUMENTS_REFUSED\n');process.exitCode=1;}
  else {
    const controller=new AbortController(),cancel=()=>controller.abort();
    process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    setupSupabaseTools({outputDir:args[1],signal:controller.signal}).then(()=>process.stdout.write('SUPABASE_TOOLS_READY\n'),error=>{
      process.stderr.write((/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_TOOLS_INSTALL_FAILED')+'\n');process.exitCode=1;
    }).finally(()=>{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);});
  }
}
