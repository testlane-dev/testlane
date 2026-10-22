/** Controlled command states and logical clocks; never runs sample or a native command. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import vm from 'node:vm';
import {createIosDiagnosticPolicy,iosPrewarmDiagnosticDue,verifyIosDiagnosticIdentity,iosPrewarmDiagnosticFailure,
  captureIosCommandOutput,createIosDeviceCapture} from '../device.mjs';
import {iosStartupCommandObservation,normalizeIosStartupCommandObservation,readIosStartupCommandObservation,
  retainIosStartupCommandObservation,tagIosCommandFailure,fixedIosDeviceFailureCode} from '../failure-facts.mjs';

const scope='cold-boot-first-owned-list',kind='owned-device-list';
const golden='CoreSimulatorService libxpc.dylib xpc_connection_send_message mach_msg2_trap semaphore_wait_trap';
const observation=text=>iosStartupCommandObservation(scope,kind,text);
const source=await readFile(new URL('../device.mjs',import.meta.url),'utf8');
function section(from,to){
  assert.equal(source.split(from).length,2,'unique start anchor');assert.equal(source.split(to).length,2,'unique end anchor');
  const start=source.indexOf(from),end=source.indexOf(to);assert.ok(end>start);return source.slice(start,end);
}
const actualRun=new vm.Script('(function(){'+section('  async function run(','  const simctl =')+'return run;})()');
const actualDiagnostic=section('      diagnosticTask = (async () => {','      diagnosticTasks.add(diagnosticTask);');
const actualProcessInfo=new vm.Script('(function(){'+section('  async function processInfo(','  async function stopOwnedGroups(')+'return processInfo;})()');
const actualList=new vm.Script('(function(){'+section('  async function listOwned(','  async function assertOwned(')+'return listOwned;})()');

test('fixed parser observes only allowlisted patterns and never exports native text or encoded canaries',()=>{
  const secret=randomBytes(32).toString('base64url');
  const fact=observation(golden+' '+[secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')].join(' '));
  assert.deepEqual(fact,{scope,commandKind:kind,status:'captured',coreSimulatorObserved:true,xpcObserved:true,machMsgObserved:true,semaphoreObserved:true});
  assert.ok(Object.isFrozen(fact));
  for(const value of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')])assert.equal(JSON.stringify(fact).includes(value),false);
  assert.deepEqual(observation('ordinary text'),{...fact,coreSimulatorObserved:false,xpcObserved:false,machMsgObserved:false,semaphoreObserved:false});
  for(const empty of ['', ' \r\n\t'])assert.equal(observation(empty).status,'unavailable');
  assert.deepEqual(observation(),{...fact,status:'unavailable',coreSimulatorObserved:false,xpcObserved:false,machMsgObserved:false,semaphoreObserved:false});
  let reads=0;assert.equal(observation({toString(){reads++;return golden;}}).status,'unavailable');assert.equal(reads,0);
  assert.equal(observation('x'.repeat(8*1024*1024+1)).status,'unavailable');
});

test('sidefact normalizer refuses getters, proxies, extras, symbols and malformed fixed fields without invoking them',()=>{
  const good=observation(golden);let reads=0;
  const getter={...good};Object.defineProperty(getter,'status',{get(){reads++;throw Error('unread');}});
  const proxy=new Proxy(good,{ownKeys(){reads++;throw Error('unread');},getPrototypeOf(){reads++;throw Error('unread');}});
  for(const value of [getter,proxy,{...good,raw:'forbidden'},{...good,[Symbol('raw')]:true},{...good,status:'other'},
    {...good,scope:'other'},{...good,commandKind:'owned-app-install'},{...good,coreSimulatorObserved:1},
    {...good,status:'unavailable'},{...good,scope:'cold-boot-first-owned-list',commandKind:'owned-proof-app-prewarm'},[good],null])
    assert.equal(normalizeIosStartupCommandObservation(value),undefined);
  assert.equal(reads,0);
  const error=Error('IOS_COMMAND_TIMEOUT');Object.defineProperty(error,'startupCommandObservation',{get(){reads++;throw Error('unread');}});
  assert.equal(readIosStartupCommandObservation(error),undefined);
  assert.equal(readIosStartupCommandObservation(new Proxy(Error('x'),{get(){reads++;throw Error('unread');}})),undefined);
  assert.equal(reads,0);
});

test('primitive observation transfers across module copies while original fact and primary failure stay fixed',async()=>{
  const fact=observation(golden),copy=JSON.parse(JSON.stringify(fact));
  const error=retainIosStartupCommandObservation(Error('IOS_COMMAND_TIMEOUT'),copy);
  retainIosStartupCommandObservation(error,observation('none'));
  const wrapped=retainIosStartupCommandObservation(Error('IOS_DEVICE_CLEANUP_UNCONFIRMED'),readIosStartupCommandObservation(error));
  assert.equal(wrapped.message,'IOS_DEVICE_CLEANUP_UNCONFIRMED');assert.deepEqual(readIosStartupCommandObservation(wrapped),fact);
  assert.equal(readIosStartupCommandObservation({startupCommandObservation:fact}),undefined);
});

function commandFixture(options={}){
  let clock=0,samples=0,stops=0,identities=0,targets=0,target,sampleState;
  const controller=new AbortController(),policy=createIosDiagnosticPolicy({prewarmDiagnostics:true}),lease=policy.beginPrewarm();
  const captured=createIosDeviceCapture(),outputs=[],identityOptions=[],sampledCommandResults=new WeakMap();
  const context={Error,Object,JSON,Buffer,Math,Number,Promise,WeakMap,performance:{now:()=>clock},Date,
    process:{pid:123},root:'/owned',env:{},signal:controller.signal,closing:false,commands:new Set(),diagnosticTasks:new Set(),
    diagnosticCleanupUncertain:false,commandStopUnconfirmed:false,LIMIT:8*1024*1024,captured,capture:captured.append,sampledCommandResults,
    fail:code=>Error(code),live(){if(controller.signal.aborted||context.closing)throw Error('IOS_CANCELLED');},
    commandKind:executable=>executable==='/usr/bin/sample'?'owned-prewarm-stack-sample':kind,
    captureIosCommandOutput,iosPrewarmDiagnosticDue,verifyIosDiagnosticIdentity,iosPrewarmDiagnosticFailure,
    iosStartupCommandObservation,retainIosStartupCommandObservation,tagIosCommandFailure,fixedIosDeviceFailureCode,
    processInfo:async(pid,budget)=>{identityOptions.push({...budget});return{pid,ppid:++identities===options.badIdentityAt?999:123,pgid:pid,zombie:false,started:'Tue Oct 20 01:20:30 2026'};},
    async sleep(){
      clock+=30;options.onSleep?.({clock,controller,context,lease,target,sampleState,policy});
      if(options.finishAfterSample&&samples&&clock>=17000&&target?.sequence===1&&!target.closed){target.closed=true;target.exited=true;target.code=options.commandCode??0;}
      await Promise.resolve();
    },
    launch(executable,args){
      const child=new EventEmitter();child.pid=executable==='/usr/bin/sample'?3456:2345;
      child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end(){}};
      const state={child,pid:child.pid,spawned:true,exited:false,closed:false,code:null,started:Promise.resolve(true)};
      if(executable==='/usr/bin/sample'){
        samples++;sampleState=state;assert.deepEqual(Array.from(args),['2345','1','1','-file','/dev/stdout']);
        options.atSample?.({target,controller,context,lease,policy});
        Promise.resolve().then(()=>{
          child.stdout.emit('data',Buffer.from(options.sampleText??golden));child.stderr.emit('data',Buffer.from('UNEXPORTED_SAMPLE_STDERR'));
          state.exited=true;state.closed=true;state.code=options.sampleCode??0;outputs.push('sample-closed');
        });
      }else{target=state;target.sequence=++targets;if(options.acquisitionMs!==undefined)state.started=Promise.resolve().then(()=>{clock=options.acquisitionMs;return true;});}
      return state;
    },
    async stop(state){stops++;state.closed=true;state.exited=true;state.code=null;outputs.push('stopped');},
  };
  context.stopOwnedGroups=context.stop;
  const run=actualRun.runInNewContext(context);
  return{context,controller,policy,lease,captured,outputs,sampledCommandResults,
    samples:()=>samples,stops:()=>stops,clock:()=>clock,identities:()=>identities,identityOptions,
    invoke:extra=>run('/usr/bin/xcrun',['synthetic'],{timeoutMs:30000,deadlineAt:30000,prewarmDiagnostic:lease,observationScope:scope,...extra}),
    list:()=>{context.simctl=(_args,opts)=>run('/usr/bin/xcrun',['synthetic'],opts);return actualList.runInNewContext(context)(false,30000,lease,30000,scope);},
  };
}

test('actual retained run joins one accepted sample and exports no raw sample payload on command timeout',async()=>{
  const canary=randomBytes(32).toString('base64url'),f=commandFixture({sampleText:golden+' '+canary});
  let failure;await assert.rejects(f.invoke(),error=>{failure=error;return error.message==='IOS_COMMAND_TIMEOUT';});
  assert.equal(f.samples(),1);assert.equal(f.stops(),1);
  assert.deepEqual(f.identityOptions,[{timeoutMs:1000,deadlineAt:30000},{timeoutMs:1000,deadlineAt:30000}]);
  assert.deepEqual(readIosStartupCommandObservation(failure),observation(golden));
  assert.equal(f.outputs[0],'sample-closed');assert.equal(f.context.diagnosticTasks.size,0);
  for(const text of [canary,golden,'UNEXPORTED_SAMPLE_STDERR'])assert.equal(f.captured.text().includes(text),false);
  assert.equal(f.captured.overflowed(),false);
});

test('sample nonzero, target closure, lease revocation and cancellation cannot promote captured',async()=>{
  for(const options of [{sampleCode:1},{sampleText:'  \r\n'},{atSample:({target})=>{target.closed=true;target.exited=true;target.code=0;}},
    {atSample:({policy,lease})=>policy.finishPrewarm(lease)},{atSample:({controller})=>controller.abort()}]){
    const f=commandFixture(options);let result,error;
    try{result=await f.invoke();}catch(caught){error=caught;}
    const fact=error?readIosStartupCommandObservation(error):f.sampledCommandResults.get(result);
    assert.equal(f.samples(),1);assert.deepEqual(fact,observation());
    assert.equal(f.context.diagnosticTasks.size,0);
  }
});

test('cancelled or already closed target never grants a sampler and no late callback can start one',async()=>{
  for(const abort of [false,true]){
    const f=commandFixture({onSleep:({clock,controller,target})=>{if(clock>=1000){if(abort)controller.abort();else{target.closed=true;target.exited=true;target.code=0;}}}});
    let result,error;try{result=await f.invoke();}catch(caught){error=caught;}
    assert.equal(f.samples(),0);assert.equal(error?readIosStartupCommandObservation(error):f.sampledCommandResults.get(result),undefined);
    await Promise.resolve();assert.equal(f.samples(),0);
  }
});

test('one actual sample claim is shared across cold and prewarm while later same-kind failure has no stale fact',async()=>{
  const f=commandFixture();await assert.rejects(f.invoke(),/IOS_COMMAND_TIMEOUT/);assert.equal(f.samples(),1);
  let later;await assert.rejects(f.invoke({deadlineAt:60000,observationScope:'proof-app-prewarm'}),error=>{later=error;return true;});
  assert.equal(f.samples(),1);assert.equal(readIosStartupCommandObservation(later),undefined);
  f.policy.finishPrewarm(f.lease);assert.equal(f.lease.isActive(),false);assert.equal(f.policy.beginPrewarm(),undefined);
});

test('same-command nonzero and malformed inventory acknowledgements preserve only that result observation',async()=>{
  for(const commandCode of [0,70]){
    const f=commandFixture({finishAfterSample:true,commandCode});let error;
    await assert.rejects(f.list(),caught=>{error=caught;return caught.message==='IOS_SIMULATOR_LIST_FAILED';});
    assert.deepEqual(readIosStartupCommandObservation(error),observation(golden));assert.equal(f.samples(),1);
  }
});

test('a short parent window cannot schedule a sample that needs six remaining seconds',async()=>{
  const f=commandFixture();await assert.rejects(f.invoke({timeoutMs:18000,deadlineAt:18000}),/IOS_COMMAND_TIMEOUT/);
  assert.equal(f.samples(),0);assert.equal(f.context.diagnosticTasks.size,0);
});

test('actual close entry revokes the shared lease before any stop or cleanup work',async()=>{
  const policy=createIosDiagnosticPolicy({prewarmDiagnostics:true}),lease=policy.beginPrewarm();
  const prefix=section('  async function close() {','      const failures = [];');
  const context={diagnosticPolicy:policy,startupDiagnosticLease:lease,closing:undefined,signal:undefined,abortLifecycle:()=>{}};
  const close=new vm.Script('(function(){'+prefix+'return true;})();return closing;}return close;})()').runInNewContext(context);
  const closing=close();assert.equal(lease.isActive(),false);await closing;
  assert.equal(lease.claimSample(kind),false);
});


test('a sampled successful command cannot donate its observation to a later same-kind failure',async()=>{
  const f=commandFixture({finishAfterSample:true}),first=await f.invoke();
  assert.equal(first.code,0);assert.equal(f.sampledCommandResults.get(first).status,'captured');
  let error;await assert.rejects(f.invoke({deadlineAt:60000}),caught=>{error=caught;return caught.message==='IOS_COMMAND_TIMEOUT';});
  assert.equal(f.samples(),1);assert.equal(readIosStartupCommandObservation(error),undefined);
});

test('both actual retained identity checks must pass before the sole sample claim',async()=>{
  for(const badIdentityAt of [1,2]){
    const f=commandFixture({badIdentityAt});let error;
    await assert.rejects(f.invoke(),caught=>{error=caught;return caught.message==='IOS_COMMAND_TIMEOUT';});
    assert.equal(f.samples(),0);assert.equal(readIosStartupCommandObservation(error),undefined);
    assert.equal(f.context.diagnosticTasks.size,0);
  }
});


test('actual retained-child acquisition cannot enqueue the first identity probe after parent expiry',async()=>{
  const f=commandFixture({acquisitionMs:30001});let error;
  await assert.rejects(f.invoke(),caught=>{error=caught;return caught.message==='IOS_COMMAND_TIMEOUT';});
  assert.equal(f.identities(),0);assert.equal(f.samples(),0);
  assert.equal(readIosStartupCommandObservation(error),undefined);
});

test('actual diagnostic wait cannot enqueue its second identity probe after the parent clock jumps past expiry',async()=>{
  let clock=0,identities=0,samples=0;
  const policy=createIosDiagnosticPolicy({prewarmDiagnostics:true}),lease=policy.beginPrewarm();
  const state={spawned:true,pid:2345,child:{pid:2345},exited:false,closed:false};
  const context={Error,Promise,JSON,performance:{now:()=>clock},process:{pid:123},signal:undefined,closing:false,state,kind,
    began:0,monotonicDeadline:20000,remaining:()=>20000-clock,prewarmDiagnostic:lease,observationScope:scope,
    iosPrewarmDiagnosticDue,verifyIosDiagnosticIdentity,iosPrewarmDiagnosticFailure,iosStartupCommandObservation,
    processInfo:async(_pid,budget)=>{identities++;assert.deepEqual({...budget},{timeoutMs:1000,deadlineAt:20000});return{pid:2345,ppid:123,pgid:2345,zombie:false,started:'Tue Oct 20 01:20:30 2026'};},
    sleep:async()=>{clock=20001;},run:async()=>{samples++;assert.fail('expired parent cannot launch a sample');},capture:()=>{},diagnosticCleanupUncertain:false};
  await new vm.Script('(async()=>{let diagnosticTask,commandObservation;'+actualDiagnostic+'await diagnosticTask;})()').runInNewContext(context);
  assert.equal(identities,1);assert.equal(samples,0);assert.equal(lease.canSample(kind),true,'refused probes never consume the actual sample claim');
});

test('actual processInfo forwards only a supplied parent deadline and keeps ordinary identity defaults',async()=>{
  const calls=[],context={Error,Number,fail:code=>Error(code),run:async(executable,args,options)=>{
    calls.push({executable,args:Array.from(args),options:{...options}});
    return{code:0,stdout:'2345 123 2345 S Tue Oct 20 01:20:30 2026 synthetic-command'};
  }};
  const processInfo=actualProcessInfo.runInNewContext(context);
  assert.equal((await processInfo(2345,{timeoutMs:1000,deadlineAt:123450})).pid,2345);
  assert.equal((await processInfo(2345)).pid,2345);
  assert.deepEqual(calls.map(call=>call.options),[{ignoreSignal:true,timeoutMs:1000,deadlineAt:123450},{ignoreSignal:true,timeoutMs:30000,deadlineAt:undefined}]);
  assert.ok(calls.every(call=>call.executable==='/bin/ps'));
});
