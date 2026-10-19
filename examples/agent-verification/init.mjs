import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ownDirectory=path.dirname(fileURLToPath(import.meta.url));
const profilePattern=/^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$/;
const inside=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};

export async function initializeVerification({cwd=process.cwd(),brief,target,profile,environment='testing',outputDir='e2e/testlane-verification'}) {
  if (!['local','sandbox','testing','preview'].includes(environment)||!profilePattern.test(profile??'')) throw new Error('invalid-input');
  const origin=new URL(target);
  const local=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||
    (origin.protocol!=='https:'&&!(origin.protocol==='http:'&&local))||
    origin.hostname.toLowerCase().split('.').some(label=>['prod','production','live'].includes(label))) throw new Error('invalid-target');
  const root=await fs.realpath(cwd);
  const requested=path.resolve(root,outputDir);
  // An absolute caller path can use /var or a Windows short/junction alias even
  // though cwd's realpath does not. Canonicalize its existing ancestor before
  // checking containment; never create directories through an outside junction.
  let ancestor=path.dirname(requested),directory;
  for(;;){
    const info=await fs.lstat(ancestor).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(info){
      const actual=await fs.realpath(ancestor); // Dangling links fail closed.
      if(path.relative(root,actual)!==''&&!inside(root,actual))throw new Error('output-outside-project');
      directory=path.resolve(actual,path.relative(ancestor,requested));
      if(!inside(root,directory))throw new Error('output-outside-project');
      break;
    }
    const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error('invalid-output');ancestor=parent;
  }
  const briefBytes=await fs.readFile(path.resolve(root,brief));
  if(briefBytes.length===0||briefBytes.length>64*1024||briefBytes.includes(0))throw new Error('invalid-brief');
  const briefText=new TextDecoder('utf-8',{fatal:true}).decode(briefBytes);
  const [fixture,authoring]=await Promise.all([
    fs.readFile(path.join(ownDirectory,'../playwright/fixtures.mjs'),'utf8'),
    fs.readFile(path.join(ownDirectory,'authoring.mjs'),'utf8'),
  ]);
  const plan={schemaVersion:1,status:'draft',title:'Feature verification',projectDir:path.relative(directory,root).split(path.sep).join('/'),target:{baseUrl:origin.origin,environment},evidence:{screenshots:'off'},cases:[{id:'case-001',title:'Replace with a requirement from brief.md',spec:path.relative(root,path.join(directory,'feature.spec.mjs')).split(path.sep).join('/'),expected:['Replace with observable business assertions'],cleanup:{required:true,description:'Define and verify removal of test-owned data'}}]};
  const config=`import {createRequire} from 'node:module';
import {createTestlaneTest, expect} from './fixtures.mjs';
const require=createRequire(import.meta.url);
export const test=createTestlaneTest({
  cliPath:require.resolve('@testlane/cli/dist/cli.js'),
  baseURL:${JSON.stringify(origin.origin)},
  roles:{qa:[${JSON.stringify(profile)}]},
});
export {expect};
`;
  const spec=`import {test} from './test.mjs';
import {runCase} from './testlane-authoring.mjs';

// Your coding agent replaces this skipped scaffold with app-specific assertions.
// Keep the plan's case ID in the static annotation and runCase call.
test.skip('Design this case from brief.md', {annotation:{type:'testlane-case',description:'case-001'}}, async ({testlane},testInfo)=>{
  await runCase(testInfo,'case-001',{
    run:async()=>{throw new Error('Write the business checks before marking the plan reviewed');},
    cleanup:async()=>{throw new Error('Implement and verify cleanup of test-owned data');},
  });
});
`;
  const files=new Map([
    ['brief.md',briefText],['plan.json',JSON.stringify(plan,null,2)+'\n'],
    ['fixtures.mjs',fixture],['testlane-authoring.mjs',authoring],['test.mjs',config],['feature.spec.mjs',spec],
    ['.gitignore','brief.md\noutput/\nruns/\n.auth/\ntest-results/\nplaywright-report/\n'],
    ['.gitattributes','testlane-authoring.mjs text eol=lf\n'],
  ]);
  await fs.mkdir(path.dirname(directory),{recursive:true});
  await fs.mkdir(directory,{mode:0o700}); // Existing suites are never overwritten.
  for(const [name,text] of files)await fs.writeFile(path.join(directory,name),text,{flag:'wx',mode:0o600});
  return {schemaVersion:1,status:'draft',directory:path.relative(root,directory).split(path.sep).join('/'),files:[...files.keys()],next:'Have your coding agent read brief.md, inspect the app, author real cases/specs and review plan.json before running it.'};
}

async function main(){
  const args=process.argv.slice(2),values={};let json=false;
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(flag==='--json'){json=true;continue;}
    const key={'--brief':'brief','--target':'target','--profile':'profile','--environment':'environment','--output-dir':'outputDir'}[flag];
    if(!key||values[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw new Error('invalid-arguments');
    values[key]=args[++i];
  }
  if(!values.brief||!values.target||!values.profile)throw new Error('missing-input');
  const result=await initializeVerification(values);
  process.stdout.write(json?JSON.stringify(result,null,2)+'\n':`Draft verification workspace created: ${result.directory}\n${result.next}\n`);
}
function isEntryPoint(){try{const entry=realpathSync(process.argv[1]);const self=realpathSync(fileURLToPath(import.meta.url));return process.platform==='win32'?entry.toLowerCase()===self.toLowerCase():entry===self;}catch{return false;}}
if(isEntryPoint()){
  main().catch(()=>{process.stderr.write('Verification scaffold refused. Use a nonempty UTF-8 brief, reviewed nonproduction origin, existing profile and a new directory inside the app. Existing files were not replaced.\n');process.exitCode=1;});
}
