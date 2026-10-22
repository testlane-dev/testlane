/** Controlled controller completion, not a native device/store acceptance proof. */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {writeNativeProofReceipt,installedModule} from '../../../scripts/native-proof-support.mjs';
import {publicAndroidFailure,retainAndroidFailureFact,readAndroidFailureFact} from '../failure.mjs';
import {retainAndroidOwnershipFailure} from '../ownership-facts.mjs';
import {publicIosFailure} from '../../ios-verification/failure.mjs';
import {retainIosStartupFailure,readIosStartupFailure,retainIosStartupCommandObservation} from '../../ios-verification/failure-facts.mjs';

const test=(name,callback)=>nodeTest(name,{timeout:10000},callback);
const root=fileURLToPath(new URL('../../../',import.meta.url));
const sources=Object.fromEntries(await Promise.all(['android','ios'].map(async platform=>[platform,await fs.readFile(path.join(root,'scripts',platform+'-proof.mjs'),'utf8')])));
const support=await fs.readFile(path.join(root,'scripts/native-proof-support.mjs'),'utf8');
const deferred=()=>Promise.withResolvers();
const receipt=()=>({schemaVersion:1,passed:true,cleanupVerified:true,credentialLeakScanPassed:true});
const cancelCode=platform=>platform==='ios'?'IOS_CANCELLED':'ANDROID_CANCELLED';
function unique(source,needle){assert.equal(source.split(needle).length,2,'controlled completion anchor must occur exactly once');return source.indexOf(needle);}
function writerBody(source=support){
  const start=unique(source,'export async function writeNativeProofReceipt('),end=unique(source,'export async function tree(');
  assert.ok(end>start);return source.slice(start,end).replace(/^export /,'');
}
function mainBody(platform,source=sources[platform]){
  const start=unique(source,'async function main('),end=unique(source,platform==='ios'?'function entry()':'function isEntryPoint()');
  assert.ok(end>start);return source.slice(start,end);
}
function controllerTail(platform,source=sources[platform]){
  const start=unique(source,platform==='ios'?'  }finally{\n    const priorStage':'  } finally {\n    const priorStage');
  const end=unique(source,'\nasync function main(');assert.ok(end>start);
  const text=source.slice(start,end).trimEnd();assert.ok(text.endsWith('\n}'));
  return text.slice(0,-2);
}
function noCanary(text,canary){for(const encoded of [canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')])assert.equal(text.includes(encoded),false);}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
async function fixture(t){
  const parent=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(parent,'tld-completion-'));
  t.after(async()=>{assert.equal(path.dirname(dir),parent);assert.ok(path.basename(dir).startsWith('tld-completion-'));await fs.rm(dir,{recursive:true,force:true});});
  return dir;
}
// Wrap actual retained filesystem handles at explicit I/O barriers. No new
// production observer/injection API is introduced by this controlled fixture.
function controlledWriter({barrier,gate,entered,failure}={}){
  const handles=[],counts={};
  const after=async(label,value)=>{counts[label]=(counts[label]??0)+1;if(label===barrier&&counts[label]===1){entered.resolve();await gate.promise;}return value;};
  const context={Error,JSON,path,
    lstat:fs.lstat,realpath:async(...args)=>after('parent',await fs.realpath(...args)),unlink:fs.unlink,
    open:async(...args)=>{
      const handle=await fs.open(...args);handles.push(handle);await after('open');
      return {stat:async(...values)=>after('stat',await handle.stat(...values)),
        writeFile:async(...values)=>{await handle.writeFile(...values);if(failure)throw Error(failure);await after('write');},
        close:async()=>{await handle.close();await after('close');}};
    }};
  const run=new vm.Script(writerBody()+'\nwriteNativeProofReceipt;').runInNewContext(context);
  return{run,handles};
}

test('controlled completion extraction refuses missing or duplicated actual source anchors',()=>{
  for(const platform of ['android','ios']){
    assert.throws(()=>mainBody(platform,sources[platform].replace('async function main(','async function renamed(')),/exactly once/);
    assert.throws(()=>mainBody(platform,sources[platform]+'\nasync function main('),/exactly once/);
    assert.throws(()=>controllerTail(platform,sources[platform]+'\nasync function main('),/exactly once/);
  }
  assert.throws(()=>writerBody(support+'\nexport async function tree('),/exactly once/);
});

test('successful exclusive receipt preserves the existing JSON shape and closes its handle',async t=>{
  const output=await fixture(t),value=receipt(),controlled=controlledWriter();
  assert.equal(await controlled.run({outputDir:output,receipt:value,cancelCode:'ANDROID_CANCELLED'}),value);
  assert.equal(await fs.readFile(path.join(output,'receipt.json'),'utf8'),JSON.stringify(value,null,2)+'\n');
  assert.ok(controlled.handles.every(handle=>handle.fd===-1));
});

test('pre-abort and cancellation during real parent/open/stat/write/close awaits never leave an accepted owned receipt',async t=>{
  for(const platform of ['android','ios']){
    const canary=randomBytes(32).toString('base64')+'/+',controller=new AbortController(),output=await fixture(t);
    controller.abort(canary);
    await assert.rejects(writeNativeProofReceipt({outputDir:output,receipt:receipt(),signal:controller.signal,cancelCode:cancelCode(platform)}),error=>error.message===cancelCode(platform));
    await absent(path.join(output,'receipt.json'));
    for(const barrier of ['parent','open','stat','write','close']){
      const dir=await fixture(t),active=new AbortController(),gate=deferred(),entered=deferred(),controlled=controlledWriter({barrier,gate,entered});
      const pending=controlled.run({outputDir:dir,receipt:receipt(),signal:active.signal,cancelCode:cancelCode(platform)});
      const rejected=assert.rejects(pending,error=>{assert.equal(error.message,cancelCode(platform));noCanary(String(error),canary);return true;});
      try{await entered.promise;active.abort(canary);}finally{gate.resolve();}
      await rejected;await absent(path.join(dir,'receipt.json'));assert.ok(controlled.handles.every(handle=>handle.fd===-1));
    }
  }
});

test('receipt failures cannot overwrite a preexisting file or remove a substituted foreign inode',async t=>{
  const output=await fixture(t),file=path.join(output,'receipt.json'),foreign=randomBytes(32).toString('base64');
  await fs.writeFile(file,foreign,{flag:'wx'});
  await assert.rejects(writeNativeProofReceipt({outputDir:output,receipt:receipt(),cancelCode:'IOS_CANCELLED'}),/NATIVE_PROOF_FINALIZATION_FAILED/);
  assert.equal(await fs.readFile(file,'utf8'),foreign);
  const second=await fixture(t),active=new AbortController(),gate=deferred(),entered=deferred(),controlled=controlledWriter({barrier:'close',gate,entered});
  const target=path.join(second,'receipt.json'),pending=controlled.run({outputDir:second,receipt:receipt(),signal:active.signal,cancelCode:'IOS_CANCELLED'});
  const rejected=assert.rejects(pending,/NATIVE_PROOF_FINALIZATION_UNCONFIRMED/);
  try{await entered.promise;await fs.rename(target,path.join(second,'displaced.json'));await fs.writeFile(target,foreign,{flag:'wx'});active.abort();}finally{gate.resolve();}
  await rejected;assert.equal(await fs.readFile(target,'utf8'),foreign);assert.ok(controlled.handles.every(handle=>handle.fd===-1));
});

test('writer settles actual failed I/O and emits only fixed failure data',async t=>{
  const output=await fixture(t),canary=randomBytes(32).toString('base64')+'/+',controlled=controlledWriter({failure:canary});
  await assert.rejects(controlled.run({outputDir:output,receipt:receipt(),cancelCode:'ANDROID_CANCELLED'}),error=>{assert.equal(error.message,'NATIVE_PROOF_FINALIZATION_FAILED');noCanary(String(error),canary);return true;});
  await absent(path.join(output,'receipt.json'));assert.ok(controlled.handles.every(handle=>handle.fd===-1));
  await assert.rejects(writeNativeProofReceipt({outputDir:{},receipt:receipt(),cancelCode:'ANDROID_CANCELLED'}),/NATIVE_PROOF_FINALIZATION_FAILED/);
});

async function tailFixture(t,platform,{cleanupFailure=false,originalError,sessionBarrier=false}={}){
  const output=await fixture(t),sessionTemp=path.join(output,'sessions'),recovery=path.join(output,'recovery');
  await fs.mkdir(sessionTemp);await fs.mkdir(recovery);
  const active=new AbortController(),entered=deferred(),gate=deferred(),events=[];
  const originalFailure={stage:'positive',code:'NATIVE_WORKER_TERMINATION_UNCONFIRMED'};
  const startupFailure={stage:'device-wda-build-for-testing',code:'IOS_COMMAND_TIMEOUT',commandKind:'owned-wda-prebuild'};
  const context={Error,Object,JSON,Set,assert,path,signal:active.signal,receipt:receipt(),output,recovery,
    consumer:{root:output,sessionTemp},stage:'corrected',at:stage=>{context.stage=stage;events.push(stage);},
    workerUnconfirmed:false,deviceStartUnconfirmed:false,cleanupOK:true,harness:undefined,broker:undefined,brokerRecovery:undefined,
    captured:'',audit:'',accounts:{},attempted:new Set(),originalFailure,startupFailure,startupCommandObservation:undefined,ownershipFailure:undefined,primaryError:originalError,
    retainAndroidFailureFact,retainAndroidOwnershipFailure,retainIosStartupFailure,retainIosStartupCommandObservation,writeFile:fs.writeFile,writeNativeProofReceipt,
    device:{async close(){events.push('device-close');if(!sessionBarrier){entered.resolve();await gate.promise;}if(cleanupFailure)throw Error('controlled-stop');events.push('device-stopped');},capturedText:()=>''},
    app:{records:()=>[],async close(){events.push('app-stopped');}},
    readdir:async file=>{const entries=await fs.readdir(file);if(sessionBarrier&&file===sessionTemp){entered.resolve();await gate.promise;}return entries;}};
  const program=new vm.Script('(async()=>{try{if(primaryError)throw primaryError;\n'+controllerTail(platform)+'\n})()');
  return{active,entered,gate,events,output,originalFailure,startupFailure,run:()=>program.runInNewContext(context)};
}
for(const platform of ['android','ios']){
  test(platform+' controller rejects late cancellation after independent cleanup and while final session verification settles',async t=>{
    for(const sessionBarrier of [false,true]){
      const value=await tailFixture(t,platform,{sessionBarrier}),pending=value.run(),rejected=assert.rejects(pending,error=>error.message===cancelCode(platform));
      try{await value.entered.promise;value.active.abort(randomBytes(32).toString('hex'));}finally{value.gate.resolve();}
      await rejected;assert.ok(value.events.includes('device-stopped'));assert.ok(value.events.includes('app-stopped'));await absent(path.join(value.output,'receipt.json'));
    }
  });
  test(platform+' controller keeps original failure or unknown cleanup primary over late cancellation',async t=>{
    const primary=Error('NATIVE_WORKER_TERMINATION_UNCONFIRMED');
    for(const cleanupFailure of [false,true]){
      const value=await tailFixture(t,platform,{cleanupFailure,originalError:primary}),pending=value.run();
      const rejected=assert.rejects(pending,error=>{
        if(cleanupFailure){assert.equal(error.message,platform==='ios'?'IOS_PROOF_CLEANUP_INCOMPLETE':'ANDROID_PROOF_CLEANUP_INCOMPLETE');assert.equal(error.preserveConsumer,true);
          const fact=platform==='ios'?readIosStartupFailure(error):readAndroidFailureFact(error);assert.deepEqual(fact,platform==='ios'?value.startupFailure:value.originalFailure);
        }else assert.equal(error,primary);return true;
      });
      try{await value.entered.promise;value.active.abort();}finally{value.gate.resolve();}
      await rejected;await absent(path.join(value.output,'receipt.json'));
    }
  });
}

const projectorFiles=['examples/ios-verification/failure.mjs','examples/ios-verification/failure-facts.mjs',
  'examples/ios-verification/driver.mjs','examples/ios-verification/device-scope.mjs','examples/ios-verification/setup-ownership.mjs',
  'examples/android-verification/contracts.mjs','examples/android-verification/proof-cases.mjs','examples/android-verification/driver-phase.mjs'];
async function mainFixture(t,platform,options={}){
  const {entryCode,disposeFailure,runFailure,preserve=false,runExitCode,abortDuringDispose=false,disposeSignal='SIGTERM',abortAfterProof=false,installedFailure=false}=options;
  const hasRunFailure=Object.hasOwn(options,'runFailure');
  const output=await fixture(t),consumerRoot=path.join(output,'consumer'),packageRoot=path.join(consumerRoot,'package');await fs.mkdir(packageRoot,{recursive:true});
  if(platform==='ios')for(const relative of projectorFiles){const target=path.join(packageRoot,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,relative),target);}
  const proc=Object.assign(new EventEmitter(),{argv:['node','proof',...(platform==='ios'?['--app',output]:['--apk',path.join(output,'proof.apk')]),'--tools-root',output,'--output-dir',output],env:{},exitCode:entryCode});
  const stdout=[],stderr=[],events=[],observedErrors=[],entered=deferred(),gate=deferred();let disposals=0,imports=0;
  const consumer={root:consumerRoot,packageRoot,async dispose(){disposals++;events.push('dispose-start');assert.equal(stdout.filter(value=>value.startsWith('{')).length,0);entered.resolve();await gate.promise;
    if(disposeFailure)throw Error(randomBytes(32).toString('hex'));await fs.rm(consumerRoot,{recursive:true});events.push('disposed');}};
  let proofSignal,installedFact;
  const run=async({signal})=>{events.push('proof');proofSignal=signal;assert.equal(proc.exitCode,1);
    if(installedFailure){const {NativeDriverError}=await installedModule(packageRoot,'examples/ios-verification/driver.mjs');installedFact=new NativeDriverError('NATIVE_DRIVER_RESPONSE_INVALID',{operation:'native-context',phase:'http'});throw installedFact;}
    if(hasRunFailure){if(preserve)runFailure.preserveConsumer=true;throw runFailure;}
    if(runExitCode!==undefined)proc.exitCode=runExitCode;
    const result=await writeNativeProofReceipt({outputDir:output,receipt:receipt(),signal,cancelCode:cancelCode(platform)});
    if(abortAfterProof)proc.emit('SIGINT');return result;
  };
  const context={Error,Object,JSON,AbortController,assert,path,process:proc,
    console:{log:value=>{stdout.push(value);events.push(value.startsWith('{')?'stdout-success':'stdout-stage');},error:value=>stderr.push(value)},
    writeFile:fs.writeFile,
    publicAndroidFailure:async options=>{observedErrors.push(options.error);return publicAndroidFailure(options);},
    publicIosFailure:async options=>{observedErrors.push(options.error);return publicIosFailure(options);},
    installedModule:async(...args)=>{imports++;assert.equal(events.includes('dispose-start'),false,'installed projector must load before deletion');
      const module=await installedModule(...args);return{...module,publicIosFailure:async options=>{observedErrors.push(options.error);return module.publicIosFailure(options);}};},
    consumerProject:async()=>{events.push('consumer');assert.equal(proc.exitCode,1);return consumer;},runAndroidProof:run,runIosProof:run};
  const pending=new vm.Script(mainBody(platform)+'\nmain();').runInNewContext(context);
  const settle=async()=>{gate.resolve();await pending;};
  t.after(async()=>{gate.resolve();await pending;});
  if(abortDuringDispose){await entered.promise;proc.emit(disposeSignal);}
  return{output,consumerRoot,proc,stdout,stderr,events,observedErrors,entered,gate,pending,settle,disposals:()=>disposals,imports:()=>imports,proofSignal:()=>proofSignal,installedFact:()=>installedFact};
}
for(const platform of ['android','ios']){
  test(platform+' actual main treats every falsy rejection as failure and preserves it across disposal failure or cancellation',async t=>{
    for(const runFailure of [undefined,null,false,0,''])for(const mode of [{},{disposeFailure:true},{abortDuringDispose:true}]){
      const value=await mainFixture(t,platform,{...mode,runFailure});await value.entered.promise;await value.settle();
      assert.equal(value.proc.exitCode,1);assert.equal(value.stdout.length,0);assert.equal(value.observedErrors.length,1);assert.equal(value.observedErrors[0],runFailure);
      const summary=JSON.parse(await fs.readFile(path.join(value.output,'public-failure.json'),'utf8'));
      assert.equal(summary.status,'failed');assert.equal(summary.code,platform==='ios'?'IOS_PROOF_FAILED':'ANDROID_PROOF_FAILED');
      assert.equal(value.disposals(),1);await absent(path.join(value.output,'receipt.json'));
    }
  });
  test(platform+' actual main commits success synchronously only after consumer disposal',async t=>{
    for(const entryCode of [undefined,0]){
      const value=await mainFixture(t,platform,{entryCode});await value.entered.promise;assert.equal(value.proc.exitCode,1);assert.equal(value.stdout.length,0);
      await value.settle();assert.equal(value.proc.exitCode,0);assert.deepEqual(value.events.slice(-2),['disposed','stdout-success']);assert.equal(value.stdout.length,1);
      assert.equal(JSON.parse(value.stdout[0]).passed,true);assert.equal(value.proc.listenerCount('SIGTERM'),0);assert.equal(value.proc.listenerCount('SIGINT'),0);await absent(value.consumerRoot);
    }
  });
  test(platform+' actual main refuses disposal-time cancellation and disposal failure without success stdout',async t=>{
    for(const options of [{abortDuringDispose:true,disposeSignal:'SIGINT'},{abortDuringDispose:true},{abortAfterProof:true},{disposeFailure:true}]){
      const value=await mainFixture(t,platform,options);await value.entered.promise;await value.settle();
      assert.notEqual(value.proc.exitCode,0);assert.equal(value.stdout.length,0);assert.ok(value.stderr.some(line=>line.startsWith('FAIL ')));
      const inner=JSON.parse(await fs.readFile(path.join(value.output,'receipt.json'),'utf8'));assert.equal(inner.passed,true,'returned inner receipt is not sufficient invocation acceptance');
      const failure=JSON.parse(await fs.readFile(path.join(value.output,'public-failure.json'),'utf8'));assert.equal(failure.status,'failed');
      assert.equal(value.proc.listenerCount('SIGTERM'),0);assert.equal(value.proc.listenerCount('SIGINT'),0);
      if(options.abortDuringDispose||options.abortAfterProof){assert.equal(value.proofSignal().aborted,true);await absent(value.consumerRoot);}
    }
  });
  test(platform+' actual main preserves existing nonzero status and uncertain-state preservation',async t=>{
    for(const entryCode of [1,2]){
      const value=await mainFixture(t,platform,{entryCode});await value.settle();assert.equal(value.proc.exitCode,entryCode);assert.equal(value.stdout.length,0);assert.equal(value.events.includes('consumer'),false);assert.equal(value.disposals(),0);
    }
    const changed=await mainFixture(t,platform,{runExitCode:2});await changed.entered.promise;await changed.settle();assert.equal(changed.proc.exitCode,2);assert.equal(changed.stdout.length,0);
    const primary=Error(platform==='ios'?'IOS_PROOF_CLEANUP_INCOMPLETE':'ANDROID_PROOF_CLEANUP_INCOMPLETE');
    const value=await mainFixture(t,platform,{runFailure:primary,preserve:true});await value.settle();assert.equal(value.disposals(),0);assert.equal(value.stdout.length,0);assert.equal(value.proc.exitCode,1);
    const failure=JSON.parse(await fs.readFile(path.join(value.output,'public-failure.json'),'utf8'));assert.equal(failure.code,primary.message);assert.equal((await fs.lstat(value.consumerRoot)).isDirectory(),true);
    for(const options of [{disposeFailure:true},{abortDuringDispose:true}]){
      const message=platform==='ios'?'IOS_COMMAND_TIMEOUT':'ANDROID_COMMAND_TIMEOUT';
      const earlier=await mainFixture(t,platform,{...options,runFailure:Error(message)});await earlier.entered.promise;await earlier.settle();
      assert.equal(earlier.proc.exitCode,1);assert.equal(earlier.stdout.length,0);
      assert.equal(JSON.parse(await fs.readFile(path.join(earlier.output,'public-failure.json'),'utf8')).code,message,'earlier fixed failure remains primary over disposal failure or cancellation');
    }
  });
}

test('iOS main uses its cached installed class-aware projector after the consumer is deleted',async t=>{
  const value=await mainFixture(t,'ios',{installedFailure:true});await value.entered.promise;await value.settle();await absent(value.consumerRoot);
  assert.equal(value.imports(),1);assert.equal(value.proc.exitCode,1);assert.equal(value.stdout.length,0);
  const failure=JSON.parse(await fs.readFile(path.join(value.output,'public-failure.json'),'utf8'));
  assert.equal(failure.code,'NATIVE_DRIVER_RESPONSE_INVALID');assert.deepEqual(failure.requestFailure,{operation:'native-context',phase:'http'});
  const foreign=await publicIosFailure({output:value.output,stage:'setup',error:value.installedFact()});assert.equal(Object.hasOwn(foreign,'requestFailure'),false,'workspace reader intentionally cannot validate installed exact class');
});

async function child(source){
  const proc=spawn(process.execPath,['--input-type=module'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
  const timeout=setTimeout(()=>proc.kill(),5000);
  try{return await new Promise((resolve,reject)=>{proc.once('error',reject);proc.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>65536)proc.kill();});proc.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>65536)proc.kill();});
    proc.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));proc.stdin.end(source);});}finally{clearTimeout(timeout);}
}
test('actual main cannot exit implicitly successful while consumer installation or disposal has an unresolved unreffed await',async()=>{
  for(const platform of ['android','ios'])for(const phase of ['install','dispose']){
    const source=`import assert from 'node:assert/strict';import path from 'node:path';\nprocess.argv=['node','controlled-proof','${platform==='ios'?'--app':'--apk'}',process.cwd(),'--tools-root',process.cwd(),'--output-dir',process.cwd()];\nconst pending=()=>new Promise(()=>{});\nconst consumerProject=${phase==='install'?'pending':"async()=>({packageRoot:process.cwd(),dispose:pending})"};\nconst installedModule=async()=>({publicIosFailure:async()=>({status:'failed',stage:'setup',code:'IOS_PROOF_FAILED'})});\nconst runAndroidProof=async()=>({passed:true}),runIosProof=runAndroidProof;\nconst publicIosFailure=async()=>({status:'failed',stage:'setup',code:'IOS_PROOF_FAILED'}),publicAndroidFailure=publicIosFailure;\nconst writeFile=async()=>{};\n${mainBody(platform)}\nmain().catch(()=>{if(process.exitCode===undefined||process.exitCode===0)process.exitCode=2;});\n`;
    const result=await child(source);assert.equal(result.signal,null);assert.equal(result.code,1);assert.equal(result.stdout,'');
  }
});
