/** Fixed evidence only: no native tools, accounts, provider or credential store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {APPROVAL_REQUIREMENTS} from '../proof-cases.mjs';
import {runNativeCases} from '../runner.mjs';
import {createAndroidFailureFact,readAndroidFailureFact,retainAndroidFailureFact,publicAndroidFailure,
  projectPublicAndroidFailure,readPublicAndroidFailure} from '../failure.mjs';

const plan=()=>({schemaVersion:1,runner:'android-uiautomator2',status:'reviewed',title:'Synthetic native approval proof',
  target:{baseUrl:'http://127.0.0.1:4555',environment:'testing'},app:{package:'dev.testlane.androidproof',apkSha256:'0'.repeat(64)},
  cases:APPROVAL_REQUIREMENTS.map(item=>({...item,cleanup:{required:item.id!=='anonymous-denied',
    description:item.id==='anonymous-denied'?'No state is created':'Delete only the unique owned marker and verify absence'}}))});
const variants=secret=>[secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')];
async function fixture(t){const parent=await realpath(os.tmpdir()),output=await mkdtemp(path.join(parent,'tld-android-fixed-failure-'));
  t.after(async()=>{assert.equal(path.dirname(await realpath(output)),parent);assert.match(path.basename(output),/^tld-android-fixed-failure-/);await rm(output,{recursive:true});});return output;}
async function failedReport(input=plan()){
  return runNativeCases({plan:input,cases:input.cases.map((row,index)=>({id:row.id,run:({check})=>check(index===0?4199:4200,4200),
    ...(row.cleanup.required?{cleanup:({check})=>check([],[])}:{})}))});
}
const save=(output,name,value)=>writeFile(path.join(output,name+'.json'),JSON.stringify(value),{mode:0o600});

test('failed phase retains fixed assertion evidence while omitting all target, title and exception material',async t=>{
  const output=await fixture(t),input=plan(),report=await failedReport(input),secret=randomBytes(32).toString('base64url');
  await save(output,'plan',input);await save(output,'positive',report);
  const summary=await publicAndroidFailure({output,stage:'positive',error:Object.assign(Error(secret),{code:'ERR_ASSERTION'})});
  assert.equal(summary.stage,'positive');assert.equal(summary.code,'ANDROID_PROOF_ASSERTION_FAILED');assert.equal(summary.reports.length,1);
  assert.equal(summary.reports[0].phase,'positive');assert.equal(summary.reports[0].verdict,'failed');
  assert.equal(summary.reports[0].cases[0].reason,'NATIVE_ASSERTION_FAILED');assert.equal(summary.reports[0].cases[0].cleanup.status,'completed');
  for(const value of [...variants(secret),input.target.baseUrl,input.app.apkSha256,input.title,input.cases[0].title,input.cases[0].cleanup.description])assert.equal(JSON.stringify(summary).includes(value),false);
  assert.deepEqual(projectPublicAndroidFailure(summary),summary);
  await save(output,'public-failure',summary);assert.deepEqual(await readPublicAndroidFailure(path.join(output,'public-failure.json')),summary);
});

test('every public synthetic plan metadata field must match before a phase is included',async t=>{
  const output=await fixture(t),original=plan(),report=await failedReport(original),secret=randomBytes(32).toString('base64url');
  await save(output,'positive',report);
  for(const mutate of [p=>p.title=secret,p=>p.cases[0].title=secret,p=>p.cases[0].expected=[secret],
    p=>p.cases[0].cleanup.description=secret,p=>p.cases[0].cleanup.required=false,p=>p.app.package='dev.synthetic.other',
    p=>p.status='draft',p=>p.target.environment='local',p=>p.cases.reverse(),p=>p.extra=secret]){
    const input=structuredClone(original);mutate(input);await save(output,'plan',input);
    const summary=await publicAndroidFailure({output,stage:'positive',error:Error(secret)});
    assert.deepEqual(summary.reports,[]);for(const value of variants(secret))assert.equal(JSON.stringify(summary).includes(value),false);
  }
});

test('original fixed failure survives cleanup wrapping without changing the cleanup code or preservation flag',async t=>{
  const output=await fixture(t),original=Object.assign(Error(randomBytes(32).toString('base64url')),{code:'NATIVE_DRIVER_SESSION_TIMEOUT'});
  const fact=createAndroidFailureFact({stage:'positive',error:original});retainAndroidFailureFact(original,fact);
  const wrapped=retainAndroidFailureFact(Error('ANDROID_PROOF_CLEANUP_INCOMPLETE'),readAndroidFailureFact(original));wrapped.preserveConsumer=true;
  retainAndroidFailureFact(wrapped,createAndroidFailureFact({stage:'cleanup',error:Error('ANDROID_COMMAND_TIMEOUT')}));
  const summary=await publicAndroidFailure({output,stage:'cleanup',error:wrapped});
  assert.equal(wrapped.preserveConsumer,true);assert.equal(wrapped.message,'ANDROID_PROOF_CLEANUP_INCOMPLETE');
  assert.deepEqual(summary.originalFailure,{stage:'positive',code:'NATIVE_DRIVER_SESSION_TIMEOUT'});assert.equal(summary.code,'ANDROID_PROOF_CLEANUP_INCOMPLETE');
});

test('error fields, facts and summary trees never invoke accessors or proxy traps',async t=>{
  const output=await fixture(t),secret=randomBytes(32).toString('base64url');let reads=0;
  const hostile=()=>{reads++;throw Error(secret);},getter=Error(secret);
  for(const key of ['message','code','originalFailure'])Object.defineProperty(getter,key,{get:hostile});
  const proxy=new Proxy(Error(secret),{get:hostile,getPrototypeOf:hostile,ownKeys:hostile});
  for(const error of [getter,proxy,{message:'ANDROID_COMMAND_TIMEOUT'},null]){
    const summary=await publicAndroidFailure({output,stage:secret,error});
    assert.deepEqual(summary,{schemaVersion:1,status:'failed',stage:'setup',code:'ANDROID_PROOF_FAILED',reports:[]});
  }
  const valid=await publicAndroidFailure({output,stage:'setup',error:Error(secret)});
  const getterSummary={...valid};Object.defineProperty(getterSummary,'reports',{get:hostile});
  for(const value of [getterSummary,new Proxy(valid,{get:hostile,getPrototypeOf:hostile,ownKeys:hostile}),
    {...valid,extra:secret},{...valid,code:secret},{...valid,originalFailure:{stage:'setup',code:secret}},
    {...valid,originalFailure:{stage:'setup',code:'ANDROID_PROOF_FAILED',extra:secret}}])assert.equal(projectPublicAndroidFailure(value),undefined);
  assert.equal(reads,0);
});

test('malformed report fields and generated-secret variants cannot enter the public reader',async t=>{
  const output=await fixture(t),input=plan(),report=await failedReport(input),secret=randomBytes(32).toString('base64url');
  await save(output,'plan',input);
  for(const mutate of [r=>r.extra=secret,r=>r.cases[0].id=secret,r=>r.diagnostics=[{code:secret}],
    r=>r.cases[0].diagnostics[0].summary=secret,r=>r.limits=[secret]]){
    const bad=structuredClone(report);mutate(bad);await save(output,'positive',bad);
    const summary=await publicAndroidFailure({output,stage:'positive',error:Error(secret)});assert.deepEqual(summary.reports,[]);
    for(const value of variants(secret))assert.equal(JSON.stringify(summary).includes(value),false);
  }
  await save(output,'positive',report);const good=await publicAndroidFailure({output,stage:'positive',error:Error(secret)});
  for(const value of [{...good,extra:secret},{...good,reports:[...good.reports,...good.reports]},
    {...good,reports:[{...good.reports[0],privatePath:secret}]}]){
    await save(output,'public-failure',value);assert.equal(await readPublicAndroidFailure(path.join(output,'public-failure.json')),undefined);
  }
});

test('missing, nonregular, oversized or malformed files give no diagnostic, and early failures stay safe',async t=>{
  const output=await fixture(t),file=path.join(output,'public-failure.json');
  assert.equal(await readPublicAndroidFailure(file),undefined);
  assert.deepEqual(await publicAndroidFailure({output,stage:'consumer-install',error:Error(randomBytes(32).toString('base64url'))}),
    {schemaVersion:1,status:'failed',stage:'consumer-install',code:'ANDROID_PROOF_FAILED',reports:[]});
  await writeFile(file,'x'.repeat(512*1024+1));assert.equal(await readPublicAndroidFailure(file),undefined);await rm(file);
  await mkdir(file);assert.equal(await readPublicAndroidFailure(file),undefined);await rm(file,{recursive:true});
  await writeFile(file,'{');assert.equal(await readPublicAndroidFailure(file),undefined);
});

test('a regular-to-FIFO open race cannot hang projection and the refused retained handle closes',async t=>{
  const output=await fixture(t),helper=new URL('../failure.mjs',import.meta.url).href;
  const file=path.join(output,'public-failure.json'),marker=path.join(output,'open-state.json');
  await writeFile(file,JSON.stringify({schemaVersion:1,status:'failed',stage:'setup',code:'ANDROID_PROOF_FAILED',reports:[]}));
  // Node-only filesystem seam simulates POSIX FIFO behavior even on Windows.
  // It does not change the helper bytes or create/open a real pipe or service.
  const constantsFile=path.join(output,'constants.mjs'),fsFile=path.join(output,'filesystem.mjs'),loaderFile=path.join(output,'loader.mjs');
  await writeFile(constantsFile,"import {constants as original} from 'node:fs';export const constants={...original,O_NONBLOCK:2048,O_NOFOLLOW:131072};");
  await writeFile(fsFile,`export {lstat,realpath} from 'node:fs/promises';
    import {writeFile} from 'node:fs/promises';
    export async function open(file,flags){
      if((flags&2048)===0){setInterval(()=>{},1000);return new Promise(()=>{});}
      await writeFile(${JSON.stringify(marker)},JSON.stringify({nonblocking:true,closed:false}));
      return {async stat(){return {isFile:()=>false};},async close(){await writeFile(${JSON.stringify(marker)},JSON.stringify({nonblocking:true,closed:true}));}};
    }`);
  await writeFile(loaderFile,`export async function resolve(specifier,context,next){
    if(context.parentURL===${JSON.stringify(helper)}&&specifier==='node:fs')return {url:${JSON.stringify(pathToFileURL(constantsFile).href)},shortCircuit:true};
    if(context.parentURL===${JSON.stringify(helper)}&&specifier==='node:fs/promises')return {url:${JSON.stringify(pathToFileURL(fsFile).href)},shortCircuit:true};
    return next(specifier,context);}`);
  const source=`import {readPublicAndroidFailure} from ${JSON.stringify(helper)};
    if(await readPublicAndroidFailure(${JSON.stringify(file)})!==undefined)throw Error('FIXTURE_REFUSAL_REQUIRED');
    process.stdout.write('REFUSED');`;
  const result=await promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',pathToFileURL(loaderFile).href,'--input-type=module','--eval',source],
    {shell:false,windowsHide:true,timeout:5000,maxBuffer:4096});
  assert.equal(result.stdout,'REFUSED');assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),{nonblocking:true,closed:true});
});
