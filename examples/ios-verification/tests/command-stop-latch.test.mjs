/** Exact private source with finite Node children/VM effects; no native tools. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once,EventEmitter} from 'node:events';
import {createServer} from 'node:net';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {fixedIosDeviceFailureCode,tagIosCommandFailure,iosStartupCommandObservation,retainIosStartupCommandObservation} from '../failure-facts.mjs';
import {createIosDiagnosticPolicy,iosPrewarmDiagnosticDue,verifyIosDiagnosticIdentity,iosPrewarmDiagnosticFailure,captureIosCommandOutput} from '../device.mjs';

const source=(await readFile(new URL('../device.mjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
function section(from,to){
  assert.equal(source.split(from).length,2);assert.equal(source.split(to).length,2);
  const begin=source.indexOf(from),end=source.indexOf(to);assert.ok(end>begin);return source.slice(begin,end);
}
const childSource=section('function launch(executable, args, { cwd, env, capture }) {','\n// Terminal failure releases this Node process');
const runSource=section('  async function run(executable, args, { timeoutMs = 30000,','\n  const simctl =');
const closeSource=section('  const recover = async (reason, failures = []) => {','\n  const abortLifecycle =');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('LOCAL_FIXTURE_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
function baseContext(root){
  let captured='';
  const diagnosticPolicy=createIosDiagnosticPolicy({prewarmDiagnostics:true}),startupDiagnosticLease=diagnosticPolicy.beginPrewarm();
  return{Error,Object,Promise,Buffer,Date,performance,Number,Math,JSON,Map,Set,WeakMap,setTimeout,clearTimeout,sleep,path,
    root,output:root,env:{},signal:undefined,commands:new Set(),diagnosticTasks:new Set(),closing:undefined,closed:false,
    diagnosticPolicy,startupDiagnosticLease,sampledCommandResults:new WeakMap(),
    diagnosticCleanupUncertain:false,commandStopUnconfirmed:false,wdaBuildIncomplete:false,ready:false,appium:undefined,
    marker:{udid:null,name:'synthetic',baselineSHA256:null},deviceSetPath:root,IOS_DEVICE_SCOPE:'hosted-standard-device-set',
    captured:{overflowed:()=>false},capture:text=>{captured+=text;},captureText:()=>captured,
    captureIosCommandOutput,iosPrewarmDiagnosticDue,verifyIosDiagnosticIdentity,iosPrewarmDiagnosticFailure,iosStartupCommandObservation,retainIosStartupCommandObservation,
    commandKind:()=> 'owned-device-list',LIMIT:8*1024*1024,fail:code=>Error(code),fixedIosDeviceFailureCode,tagIosCommandFailure,
    live:()=>{},stopOwnedGroups:async state=>{assert.equal(state,undefined);},writeFile,
    assertRoot:async()=>assert.fail('uncertain command must fence root/SDK cleanup'),
    listOwned:async()=>assert.fail('uncertain command must fence new inventory'),
    rm:async()=>assert.fail('uncertain command must preserve its owned root'),abortLifecycle:()=>{},
  };
}
async function realRunFixture(callback){
  const root=await mkdtemp(path.join(os.tmpdir(),'tld-local-command-stop-'));
  const children=[],controller=new AbortController(),context=baseContext(root);
  Object.assign(context,{spawn:(...args)=>{const child=spawn(...args);children.push(child);return child;},process,signal:controller.signal,
    live:()=>{if(controller.signal.aborted)throw Error('IOS_CANCELLED');}});
  const api=vm.runInNewContext(childSource+'\n'+runSource+'\n'+closeSource+'\n({run,stop,close,uncertain:()=>commandStopUnconfirmed})',context);
  try{await callback({...api,children,controller,context,root});}
  finally{
    for(const state of context.commands){await api.stop(state);assert.equal(state.closed,true);context.commands.delete(state);}
    assert.equal(children.every(child=>child.exitCode!==null||child.signalCode!==null),true,'every exact local child exited');
    await rm(root,{recursive:true,force:false});
  }
}
function controlledRun(error){
  const context=baseContext('/synthetic/owned-root'),state={spawned:true,exited:false,closed:false,code:null};let clock=0;
  const stdout=new EventEmitter(),stderr=new EventEmitter();
  state.started=Promise.resolve(true);state.child={stdout,stderr,stdin:{end(){}}};
  Object.assign(context,{performance:{now:()=>clock},launch:()=>state,
    sleep:async()=>{clock=2;state.exited=true;},
    stop:async()=>{state.closed=true;throw error;}});
  const api=vm.runInNewContext(runSource+'\n'+closeSource+'\n({run,close,uncertain:()=>commandStopUnconfirmed})',context);
  return{...api,context,state};
}

test('actual run drains concurrent stdout/stderr pressure while inventory payload stays transient',{timeout:15000},async()=>{
  await realRunFixture(async f=>{
    const size=2*1024*1024;
    const script=`Promise.all([new Promise(r=>process.stdout.write(Buffer.alloc(${size},120),r)),new Promise(r=>process.stderr.write(Buffer.alloc(${size},121),r))]).then(()=>{process.exitCode=0;});`;
    const result=await f.run(process.execPath,['-e',script],{timeoutMs:5000,deadlineAt:performance.now()+5000});
    assert.equal(result.code,0);assert.equal(result.stdout.length,size);assert.equal(result.stderr.length,size);
    assert.equal(f.context.commands.size,0);assert.ok(Buffer.byteLength(f.context.captureText())<1024);assert.equal(f.uncertain(),false);
  });
});

test('confirmed local timeout stop remains unchanged and precedes a fresh cleanup query',{timeout:15000},async()=>{
  await realRunFixture(async f=>{
    await assert.rejects(f.run(process.execPath,['-e',"process.stdout.write('synthetic-ready');setTimeout(()=>process.exit(2),10000);"],
      {timeoutMs:1500,deadlineAt:performance.now()+1500}),error=>{
      assert.equal(error.message,'IOS_COMMAND_TIMEOUT');assert.equal(error.nativeCommandKind,'owned-device-list');return true;
    });
    assert.equal(f.children.length,1);assert.equal(f.context.commands.size,0);assert.equal(f.uncertain(),false);
    const cleanup=await f.run(process.execPath,['-e',"process.stdout.write(JSON.stringify({devices:{}}));"],{timeoutMs:5000});
    assert.equal(cleanup.code,0);assert.deepEqual(JSON.parse(cleanup.stdout),{devices:{}});assert.equal(f.children.length,2);
    const markers=f.context.captureText().split('\n').filter(line=>line.startsWith('IOS_DEVICE_COMMAND ')).map(line=>JSON.parse(line.slice(19)));
    assert.deepEqual(markers.map(row=>row.event),['start','timeout-before-stop','error','start','end']);
    assert.equal(markers[1].spawned,true);assert.equal(markers[1].exited,false);assert.equal(markers[1].closed,false);
    assert.equal(markers[2].exited,true);assert.equal(markers[2].closed,true);
  });
});

test('exact run catch permanently fences cleanup after closed state was forgotten and preserves its original error',async()=>{
  const original=Error('IOS_PROCESS_STOP_UNCONFIRMED'),f=controlledRun(original),writes=[];
  f.context.writeFile=async(file,bytes)=>writes.push({file,body:JSON.parse(bytes)});
  await assert.rejects(f.run('synthetic',[],{timeoutMs:1,deadlineAt:1}),error=>error===original);
  assert.equal(original.nativeCommandKind,'owned-device-list');assert.equal(f.state.closed,true);
  assert.equal(f.context.commands.size,0,'the late local close may have removed the command state');assert.equal(f.uncertain(),true);
  for(let i=0;i<2;i++)await assert.rejects(f.close(),{message:'IOS_DEVICE_CLEANUP_UNCONFIRMED'});
  assert.equal(writes.length,1);assert.equal(writes[0].body.status,'manual-inspection-required');
  assert.equal(writes[0].body.reason,'process-stop-unconfirmed');
  assert.deepEqual(writes[0].body.processes,[{kind:'command-stop-unconfirmed'}]);assert.equal(f.context.closed,false);
});

test('only genuine fixed stop errors arm the latch; unknown objects, getters and proxies are not read',async()=>{
  let reads=0;const getter=Error('unused');Object.defineProperty(getter,'message',{get(){reads++;throw Error('unexpected getter');}});
  const proxy=new Proxy({},{get(){reads++;throw Error('unexpected proxy');},getPrototypeOf(){reads++;throw Error('unexpected proxy');}});
  for(const error of [{message:'IOS_PROCESS_STOP_UNCONFIRMED'},getter,proxy,Error('IOS_COMMAND_TIMEOUT')]){
    const f=controlledRun(error);let observed;
    // assert.rejects itself inspects an arbitrary rejection; catch by identity.
    try{await f.run('synthetic',[],{timeoutMs:1,deadlineAt:1});}catch(value){observed=value;}
    assert.equal(observed,error);
    assert.equal(f.uncertain(),false);
  }
  assert.equal(reads,0);
});

test('a finite inherited-pipe descendant survives local close but cannot revive factory cleanup',{timeout:25000},async()=>{
  const nonce=randomBytes(24).toString('hex'),ready=Promise.withResolvers(),socketDone=Promise.withResolvers();
  let socket,socketClosed=false,server;
  await realRunFixture(async f=>{
    try{
      server=createServer(connection=>{
        if(socket){connection.destroy();ready.reject(Error('LOCAL_EXTRA_CONNECTION'));return;}
        socket=connection;socket.setEncoding('utf8');let input='';
        socket.once('close',()=>{socketClosed=true;socketDone.resolve();});
        socket.once('error',()=>ready.reject(Error('LOCAL_SOCKET_FAILED')));
        socket.on('data',text=>{input+=text;if(input.length>1024){ready.reject(Error('LOCAL_SOCKET_LIMIT'));return;}
          if(!input.endsWith('\n'))return;
          try{assert.deepEqual(JSON.parse(input),{nonce,status:'ready'});socket.write('ACK\n');ready.resolve();}catch{ready.reject(Error('LOCAL_NONCE_REFUSED'));}});
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},resolve);});
      const fixture=fileURLToPath(new URL('./terminal-unknown-handles.test.mjs',import.meta.url));
      const pending=f.run(process.execPath,[fixture,'--fixture-root','exited',String(server.address().port),nonce],{timeoutMs:1500,deadlineAt:performance.now()+1500});
      const rejection=assert.rejects(pending,{message:'IOS_PROCESS_STOP_UNCONFIRMED'});
      await bounded(ready.promise,5000);const child=f.children[0];if(child.exitCode===null&&child.signalCode===null)await bounded(once(child,'exit'),5000);
      assert.equal(socketClosed,false);await rejection;
      assert.equal(f.uncertain(),true);assert.equal(socketClosed,false,'local pipe destruction is not descendant termination');
      await assert.rejects(f.close(),{message:'IOS_DEVICE_CLEANUP_UNCONFIRMED'});
      const recovery=JSON.parse(await readFile(path.join(f.root,'ios-device-recovery.json'),'utf8'));
      assert.equal(recovery.reason,'process-stop-unconfirmed');assert.ok(recovery.processes.some(row=>row.kind==='command-stop-unconfirmed'));
      assert.equal(socketClosed,false);
    }finally{
      if(socket&&!socketClosed){socket.write('STOP\n');await bounded(socketDone.promise,2500);}
      if(server)await bounded(new Promise(resolve=>server.close(resolve)),2500);
      assert.equal(socketClosed,true,'retained nonce socket confirms fixture descendant settlement');
    }
  });
});
