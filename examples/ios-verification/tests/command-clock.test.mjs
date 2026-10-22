/** Logical clocks and inert retained children; never launches a native command. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createIosDiagnosticPolicy} from '../device.mjs';
import {tagIosCommandFailure,fixedIosDeviceFailureCode,normalizeIosPreauthCommandFailure,
  readIosPreauthCommandFailure,retainIosPreauthCommandFailure,retainIosStartupCommandObservation,
  createIosStartupFailure,retainIosStartupFailure} from '../failure-facts.mjs';
import {publicIosFailure} from '../failure.mjs';

const source=await readFile(new URL('../device.mjs',import.meta.url),'utf8');
const start='  async function run(',end='  const simctl =';assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
const runSource=source.slice(source.indexOf(start),source.indexOf(end));
const emptyOutput=fileURLToPath(new URL('./absent-command-clock-fixture',import.meta.url));
const kind='owned-device-list',scope='proof-app-prewarm';
function fixture(options={}){
 let clock=0,wall=0,stops=0,sleeps=0,wallReads=0,state;
 const controller=new AbortController(),policy=createIosDiagnosticPolicy({prewarmDiagnostics:false}),lease=policy.beginPrewarm();
 const started=options.pendingStart?Promise.withResolvers():undefined;
 const context={Error,Object,JSON,Buffer,Math,Number,Promise,WeakMap,performance:{now:()=>clock},Date:{now(){wallReads++;return wall;}},
  root:'/synthetic-owned-root',env:{},signal:controller.signal,closing:false,commands:new Set(),diagnosticTasks:new Set(),
  sampledCommandResults:new WeakMap(),diagnosticCleanupUncertain:false,commandStopUnconfirmed:false,startupDiagnosticLease:lease,
  captured:{overflowed:()=>false},capture:()=>{},captureIosCommandOutput:(_capture,_kind,text)=>text,
  commandKind:()=>options.kind??kind,PREWARM_DIAGNOSTIC_KINDS:new Set([kind,'owned-proof-app-prewarm']),
  normalizeIosPreauthCommandFailure,retainIosPreauthCommandFailure,retainIosStartupCommandObservation,tagIosCommandFailure,fixedIosDeviceFailureCode,
  fail:code=>Error(code),live(){if(controller.signal.aborted)throw Error('IOS_CANCELLED');},LIMIT:8*1024*1024,
  launch(){
   const child={stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:{end(){}}};
   state={child,pid:2345,spawned:true,exited:false,closed:false,code:null,
    started:(started?.promise??Promise.resolve()).then(()=>{clock+=options.acquisitionMs??0;return true;})};return state;
  },
  async sleep(){
   clock+=options.tickMs??30;wall+=options.wallDelta??30;sleeps++;
   if(options.closeAt!==undefined&&clock>=options.closeAt){state.exited=true;state.closed=true;state.code=0;}
   if(options.abortAt!==undefined&&clock>=options.abortAt)controller.abort();
   await options.onSleep?.({state,controller,clock});
  },
  async stop(target){
   assert.equal(target,state);stops++;await options.stopWait;
   target.exited=true;target.closed=true;target.code=null;
   if(options.stopError)throw options.stopError;
  },
 };
 context.stopOwnedGroups=context.stop;
 // Compile the actual private body in this realm so its strict own-data
 // normalizer observes ordinary objects, as it does in installed modules.
 const api=vm.compileFunction(runSource+';return {run,uncertain:()=>commandStopUnconfirmed};',Object.keys(context))(...Object.values(context));
 return{...api,policy,lease,controller,context,started,state:()=>state,clock:()=>clock,stops:()=>stops,sleeps:()=>sleeps,wallReads:()=>wallReads,
  invoke:extra=>api.run('synthetic',[],{timeoutMs:30000,prewarmDiagnostic:lease,observationScope:scope,...extra})};
}
async function rejection(promise){try{await promise;}catch(error){return error;}assert.fail('expected rejection');}
const fact=extra=>({commandKind:kind,event:'timeout-before-stop',spawned:true,exited:false,closed:false,code:null,elapsedMs:30000,effectiveBudgetMs:30000,...extra});

test('timely closed acknowledgement succeeds without a failure fact or stop',async()=>{
 const f=fixture({closeAt:1200});const result=await f.invoke();assert.equal(result.code,0);assert.equal(f.stops(),0);assert.equal(f.wallReads(),0);
 assert.equal(Object.hasOwn(result,'preauthCommandFailure'),false);assert.equal(f.context.commands.size,0);
});

test('settled startup consumes the original allowance without renewal',async()=>{
 const f=fixture({acquisitionMs:10000});const error=await rejection(f.invoke());
 assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.equal(f.clock(),30010);assert.equal(f.stops(),1);
 assert.deepEqual(readIosPreauthCommandFailure(error),fact({elapsedMs:30010}));
});

test('already-expired settled startup stops without a wait or new query and records that boundary',async()=>{
 const f=fixture({acquisitionMs:31000});const error=await rejection(f.invoke());
 assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.equal(f.sleeps(),0);assert.equal(f.stops(),1);
 assert.deepEqual(readIosPreauthCommandFailure(error),fact({event:'settled-start-expired',elapsedMs:31000}));
});

test('late closed zero is refused on an ordinary command and is never replayed',async()=>{
 const f=fixture({closeAt:30001,tickMs:31});const error=await rejection(f.invoke());
 assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.equal(f.stops(),0);
 assert.deepEqual(readIosPreauthCommandFailure(error),fact({event:'late-close',exited:true,closed:true,code:0,elapsedMs:30008}));
});

test('wall-clock jumps cannot renew or shorten the monotonic allowance',async()=>{
 for(const wallDelta of [-1000000,1000000]){
  const f=fixture({wallDelta,closeAt:29900});assert.equal((await f.invoke()).code,0);assert.equal(f.wallReads(),0);
  const expired=fixture({wallDelta});const error=await rejection(expired.invoke());assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.equal(expired.clock(),30000);assert.equal(expired.wallReads(),0);
 }
});

test('an earlier absolute parent deadline clips the existing cap and snapshot allowance',async()=>{
 const f=fixture();const error=await rejection(f.invoke({deadlineAt:4500}));
 assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.deepEqual(readIosPreauthCommandFailure(error),fact({elapsedMs:4500,effectiveBudgetMs:4500}));
 for(const deadlineAt of [null,NaN]){
  const invalid=fixture();const error=await rejection(invalid.invoke({deadlineAt}));
  assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.equal(invalid.state(),undefined);assert.equal(invalid.stops(),0);assert.equal(readIosPreauthCommandFailure(error),undefined);
 }
});

test('cancellation cannot turn closed zero into success while explicit cleanup ignoreSignal still works',async()=>{
 for(const closeAt of [undefined,1]){
  const f=fixture({closeAt,abortAt:1});const error=await rejection(f.invoke());
  assert.equal(error.message,'IOS_CANCELLED');assert.equal(readIosPreauthCommandFailure(error),undefined);assert.equal(f.stops(),closeAt===undefined?1:0);
 }
 const cleanup=fixture({closeAt:1,abortAt:1});assert.equal((await cleanup.invoke({ignoreSignal:true})).code,0);assert.equal(cleanup.controller.signal.aborted,true);
});

test('the original snapshot precedes stop mutation and the rejection joins that exact stop',async()=>{
 const stop=Promise.withResolvers(),f=fixture({stopWait:stop.promise});let settled=false;
 const pending=f.invoke().finally(()=>{settled=true;});while(f.stops()===0)await Promise.resolve();
 assert.equal(settled,false);assert.equal(f.state().closed,false);stop.resolve();const error=await rejection(pending);
 assert.equal(f.state().closed,true);assert.equal(readIosPreauthCommandFailure(error).closed,false);assert.equal(readIosPreauthCommandFailure(error).exited,false);
 assert.ok(Object.isFrozen(readIosPreauthCommandFailure(error)));
});

test('unconfirmed stop latches failure even when local close arrives and keeps the original pre-stop snapshot',async()=>{
 const original=Error('IOS_PROCESS_STOP_UNCONFIRMED'),f=fixture({stopError:original});const error=await rejection(f.invoke());
 assert.equal(error,original);assert.equal(f.uncertain(),true);assert.equal(f.state().closed,true);assert.equal(f.context.commands.size,0);
 assert.deepEqual(readIosPreauthCommandFailure(error),fact());
 retainIosPreauthCommandFailure(error,fact({event:'late-close',closed:true,exited:true,code:0,elapsedMs:30001}));assert.deepEqual(readIosPreauthCommandFailure(error),fact());
});

test('private active lease and exact prewarm kind-scope pair are required independently of the default scope',async()=>{
 for(const mode of ['no-lease','different-lease','revoked','cold-scope','other-kind']){
  const f=fixture({kind:mode==='other-kind'?'loopback-listeners':kind});let options={};
  if(mode==='no-lease')options.prewarmDiagnostic=undefined;
  if(mode==='different-lease')options.prewarmDiagnostic=createIosDiagnosticPolicy().beginPrewarm();
  if(mode==='revoked')f.policy.finishPrewarm(f.lease);
  if(mode==='cold-scope')options.observationScope='cold-boot-first-owned-list';
  assert.equal(readIosPreauthCommandFailure(await rejection(f.invoke(options))),undefined,mode);
 }
 const first=fixture();const old=await rejection(first.invoke());const later=await rejection(first.invoke({deadlineAt:36000}));
 assert.deepEqual(readIosPreauthCommandFailure(old),fact());assert.deepEqual(readIosPreauthCommandFailure(later),fact({elapsedMs:6000,effectiveBudgetMs:6000}));
 assert.equal(first.lease.isActive(),true);assert.equal(first.lease.canSample(kind),false,'failure capture did not enable or renew sampling');
 const unrelated=await rejection(first.invoke({prewarmDiagnostic:undefined,deadlineAt:42000}));assert.equal(readIosPreauthCommandFailure(unrelated),undefined);assert.deepEqual(readIosPreauthCommandFailure(old),fact());
});

test('strict fixed normalizer and Error reader refuse hostile metadata without exposing canaries',()=>{
 const canary=randomBytes(32).toString('base64url')+'/+=',good=fact();let reads=0;
 const getter={...good};Object.defineProperty(getter,'event',{get(){reads++;throw Error(canary);}});
 const proxy=new Proxy(good,{ownKeys(){reads++;throw Error(canary);},getPrototypeOf(){reads++;throw Error(canary);}});
 for(const value of [null,[],getter,proxy,{...good,raw:canary},{...good,[Symbol('raw')]:true},{...good,event:encodeURIComponent(canary)},
  {...good,commandKind:canary},{...good,elapsedMs:NaN},{...good,effectiveBudgetMs:Infinity},{...good,effectiveBudgetMs:30001},
  {...good,elapsedMs:3600001},{...good,elapsedMs:29999},{...good,spawned:false},{...good,closed:true},{...good,code:0}])assert.equal(normalizeIosPreauthCommandFailure(value),undefined);
 const error=retainIosPreauthCommandFailure(Error('IOS_COMMAND_TIMEOUT'),good);good.elapsedMs=1;assert.deepEqual(readIosPreauthCommandFailure(error),fact());
 const forged=Error('IOS_COMMAND_TIMEOUT');Object.defineProperty(forged,'preauthCommandFailure',{get(){reads++;throw Error(canary);}});
 assert.equal(readIosPreauthCommandFailure(forged),undefined);assert.equal(readIosPreauthCommandFailure({preauthCommandFailure:fact()}),undefined);
 assert.equal(readIosPreauthCommandFailure(new Proxy(error,{get(){reads++;throw Error(canary);}})),undefined);assert.equal(reads,0);
 for(const encoded of [canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64')])assert.equal(JSON.stringify(readIosPreauthCommandFailure(error)).includes(encoded),false);
});

test('public projection requires the original companion method stage and kind even when cleanup is primary',async()=>{
 for(const [stage,commandKind,expected] of [['proof-app-prewarm',kind,true],['proof-app-prewarm','owned-proof-app-prewarm',false],['preauth-wda-revalidation',kind,false]]){
  const original=retainIosStartupFailure(retainIosPreauthCommandFailure(Error('IOS_COMMAND_TIMEOUT'),fact()),{stage,code:'IOS_COMMAND_TIMEOUT',commandKind});
  const wrapped=retainIosPreauthCommandFailure(retainIosStartupFailure(Error('IOS_PROOF_CLEANUP_INCOMPLETE'),createIosStartupFailure({stage,error:tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),commandKind)})),readIosPreauthCommandFailure(original));
  for(const [error,outer] of [[original,'app-prewarm'],[wrapped,'cleanup']]){
   const summary=await publicIosFailure({output:emptyOutput,stage:outer,error});assert.equal(Object.hasOwn(summary,'preauthCommandFailure'),expected);
   assert.deepEqual(summary.startupFailure,{stage,code:'IOS_COMMAND_TIMEOUT',commandKind});
  }
 }
});

test('a never-settling start is still awaited without a false stop claim or new startup race',async()=>{
 const f=fixture({pendingStart:true,acquisitionMs:31000});let done=false;
 const pending=f.invoke().finally(()=>{done=true;});await Promise.resolve();f.controller.abort();await Promise.resolve();
 assert.equal(done,false);assert.equal(f.stops(),0);f.started.resolve();const error=await rejection(pending);
 assert.equal(error.message,'IOS_CANCELLED');assert.equal(f.stops(),1);assert.equal(readIosPreauthCommandFailure(error),undefined);
});
