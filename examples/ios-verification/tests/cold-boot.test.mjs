/** Pure policy/settlement tests. These do not boot a Simulator or prove iOS acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runIosColdBoot as runColdBoot} from '../device.mjs';
const runIosColdBoot=options=>runColdBoot({prepareRuntime:async()=>({code:0,closed:true}),...options});
import {createIosStartupFailure} from '../failure-facts.mjs';
import {isAllowedUrl} from '../../../scripts/export-public.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const observed=(error,code,kind)=>error.message===code&&error.nativeCommandKind===kind;

test('one shared window charges boot/status time and gives first ownership only the remainder',async()=>{
  let now=1000;const calls=[];
  assert.equal(await runIosColdBoot({now:()=>now,
    boot:async budget=>{calls.push(['boot',budget.timeoutMs,budget.deadlineAt]);assert.ok(Object.isFrozen(budget));now+=20000;return{code:0};},
    onBootStarted:()=>calls.push(['started']),
    bootStatus:async budget=>{calls.push(['status',budget.timeoutMs,budget.deadlineAt]);now+=570000;return{code:0};},
    confirmOwned:async budget=>{calls.push(['ownership',budget.timeoutMs,budget.deadlineAt]);now+=9999;budget.check();return true;},
  }),true);
  assert.deepEqual(calls,[['boot',30000,31000],['started'],['status',580000,601000],['ownership',10000,601000]]);
});

test('first fresh confirmation keeps its own 90-second cap even with more shared time available',async()=>{
  let now=0;const calls=[];
  await assert.rejects(runIosColdBoot({now:()=>now,
    boot:async()=>{now+=5000;return{code:0};},bootStatus:async()=>{now+=400000;return{code:0};},
    confirmOwned:async budget=>{calls.push(budget.timeoutMs,budget.deadlineAt);now+=90001;return true;},
  }),error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','owned-device-list'));
  assert.deepEqual(calls,[90000,495000]);
});

test('boot cannot consume the 600-second window and a closed zero result after 30 seconds is refused',async()=>{
  let now=0,later=0;
  await assert.rejects(runIosColdBoot({now:()=>now,
    boot:async budget=>{assert.equal(budget.timeoutMs,30000);now=30001;return{code:0};},
    bootStatus:async()=>{later++;return{code:0};},confirmOwned:async()=>{later++;return true;},
  }),error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','owned-device-boot'));
  assert.equal(later,0);
});

test('bootstatus zero observed at the absolute deadline cannot start fresh ownership',async()=>{
  let now=0,ownership=0;
  await assert.rejects(runIosColdBoot({now:()=>now,
    boot:async()=>{now=5000;return{code:0};},
    bootStatus:async budget=>{assert.equal(budget.timeoutMs,595000);now=600000;return{code:0};},
    confirmOwned:async()=>{ownership++;return true;},
  }),error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','owned-device-bootstatus'));
  assert.equal(ownership,0);
});

test('printed Finished is ignored unless the retained bootstatus client actually exits zero',async()=>{
  for(const code of [null,1,70,undefined]){
    let ownership=0,statusCalls=0;
    await assert.rejects(runIosColdBoot({now:()=>0,boot:async()=>({code:0}),
      bootStatus:async()=>{statusCalls++;return{code,stdout:'Finished\n'};},
      confirmOwned:async()=>{ownership++;return true;},
    }),error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','owned-device-bootstatus'));
    assert.equal(statusCalls,1);assert.equal(ownership,0);
  }
});

test('nonzero boot and failed fresh owned/foreign confirmation stop the sequence without retry',async()=>{
  let status=0;
  await assert.rejects(runIosColdBoot({now:()=>0,boot:async()=>({code:1}),bootStatus:async()=>{status++;return{code:0};},confirmOwned:async()=>true}),
    error=>observed(error,'IOS_SIMULATOR_BOOT_FAILED','owned-device-boot'));
  assert.equal(status,0);
  const drift=Error('IOS_FOREIGN_INVENTORY_CHANGED');
  await assert.rejects(runIosColdBoot({now:()=>0,boot:async()=>({code:0}),bootStatus:async()=>({code:0}),confirmOwned:async()=>{throw drift;}}),error=>{
    assert.equal(error,drift);assert.deepEqual(createIosStartupFailure({stage:'device-owned-simulator-boot-started',error}),
      {stage:'device-owned-simulator-boot-started',code:'IOS_FOREIGN_INVENTORY_CHANGED',commandKind:'owned-device-list'});return true;
  });
  await assert.rejects(runIosColdBoot({now:()=>0,boot:async()=>({code:0}),bootStatus:async()=>({code:0}),confirmOwned:async()=>false}),
    error=>observed(error,'IOS_OWNERSHIP_REFUSED','owned-device-list'));
});

test('ownership root work consumes its same budget before a fresh inventory may launch',async()=>{
  let now=0,inventory=0;
  await assert.rejects(runIosColdBoot({now:()=>now,boot:async()=>({code:0}),bootStatus:async()=>({code:0}),
    confirmOwned:async budget=>{
      budget.check();await Promise.resolve();now+=90000;
      budget.check();inventory++;return true;
    },
  }),error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','owned-device-list'));
  assert.equal(inventory,0);
});

test('pre-abort launches no boot or later operation',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(runIosColdBoot({signal:controller.signal,now:()=>0,
    boot:async()=>{calls++;return{code:0};},bootStatus:async()=>{calls++;return{code:0};},confirmOwned:async()=>{calls++;return true;},
  }),{message:'IOS_CANCELLED'});assert.equal(calls,0);
});

test('abort during bootstatus waits for its retained stop/close callback before rejection',async()=>{
  const controller=new AbortController(),entered=deferred(),closed=deferred();let done=false,ownership=0;
  const result=runIosColdBoot({signal:controller.signal,now:()=>0,boot:async()=>({code:0}),
    bootStatus:async()=>{entered.resolve();await closed.promise;return{code:0};},
    confirmOwned:async()=>{ownership++;return true;},
  }).finally(()=>{done=true;});
  await entered.promise;controller.abort();await Promise.resolve();await Promise.resolve();assert.equal(done,false);
  closed.resolve();await assert.rejects(result,error=>observed(error,'IOS_CANCELLED','owned-device-bootstatus'));assert.equal(ownership,0);
});

test('elapsed shared deadline never detaches a pending command or hides uncertain stop',async()=>{
  let now=0,done=false;const entered=deferred(),closed=deferred(),stopFailure=Error('IOS_PROCESS_STOP_UNCONFIRMED');
  const result=runIosColdBoot({now:()=>now,boot:async()=>({code:0}),
    bootStatus:async()=>{entered.resolve();await closed.promise;throw stopFailure;},confirmOwned:async()=>assert.fail('must not confirm'),
  }).finally(()=>{done=true;});
  await entered.promise;now=700000;await Promise.resolve();assert.equal(done,false);
  closed.resolve();await assert.rejects(result,error=>{
    assert.equal(error,stopFailure);assert.deepEqual(createIosStartupFailure({stage:'device-owned-simulator-boot-started',error}),
      {stage:'device-owned-simulator-boot-started',code:'IOS_PROCESS_STOP_UNCONFIRMED',commandKind:'owned-device-bootstatus'});return true;
  });
});

test('abort after the zero boot acknowledgement prevents bootstatus from launching',async()=>{
  const controller=new AbortController();let later=0;
  await assert.rejects(runIosColdBoot({signal:controller.signal,now:()=>0,boot:async()=>({code:0}),onBootStarted:()=>controller.abort(),
    bootStatus:async()=>{later++;return{code:0};},confirmOwned:async()=>{later++;return true;},
  }),error=>observed(error,'IOS_CANCELLED','owned-device-bootstatus'));assert.equal(later,0);
});

test('non-monotonic observation is refused instead of renewing the cold-start window',async()=>{
  let now=100;
  await assert.rejects(runIosColdBoot({now:()=>now,boot:async()=>{now=50;return{code:0};},bootStatus:async()=>assert.fail('must not run'),confirmOwned:async()=>true}),
    error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','owned-device-boot'));
});

test('cache preparation and its guards debit the original window without renewing boot or first ownership caps',async()=>{
  let now=1000;const calls=[];
  assert.equal(await runColdBoot({now:()=>now,
    prepareRuntime:async budget=>{calls.push(['cache',budget.timeoutMs,budget.deadlineAt]);now+=100000;return{code:0,closed:true};},
    onRuntimePrepared:()=>calls.push(['prepared']),
    boot:async budget=>{calls.push(['boot',budget.timeoutMs,budget.deadlineAt]);now+=20000;return{code:0};},
    bootStatus:async budget=>{calls.push(['status',budget.timeoutMs,budget.deadlineAt]);now+=470000;return{code:0};},
    confirmOwned:async budget=>{calls.push(['owned',budget.timeoutMs,budget.deadlineAt]);return true;},
  }),true);
  assert.deepEqual(calls,[['cache',600000,601000],['prepared'],['boot',30000,131000],['status',480000,601000],['owned',10000,601000]]);
});

test('cache preparation is mandatory and closed zero acknowledgement cannot be inferred from output',async()=>{
  let boot=0,prepared=0;const callbacks={boot:async()=>{boot++;return{code:0};},bootStatus:async()=>({code:0}),confirmOwned:async()=>true,onRuntimePrepared:()=>{prepared++;},now:()=>0};
  await assert.rejects(runColdBoot(callbacks),{message:'IOS_DEVICE_INPUT_INVALID'});
  for(const result of [{code:0},{code:0,closed:false},{code:1,closed:true},{code:null,closed:true},null]){
    await assert.rejects(runColdBoot({...callbacks,prepareRuntime:async()=>result}),error=>observed(error,'IOS_RUNTIME_CACHE_PREPARE_FAILED','selected-runtime-cache-update'));
  }
  assert.equal(boot,0);assert.equal(prepared,0);
});

test('cache late zero and cancellation never advance hooks or boot, and pending work is joined',async()=>{
  let now=0,boot=0,prepared=0;
  const callbacks={now:()=>now,boot:async()=>{boot++;return{code:0};},bootStatus:async()=>({code:0}),confirmOwned:async()=>true,onRuntimePrepared:()=>{prepared++;}};
  await assert.rejects(runColdBoot({...callbacks,prepareRuntime:async()=>{now=600000;return{code:0,closed:true};}}),
    error=>observed(error,'IOS_SIMULATOR_BOOT_TIMEOUT','selected-runtime-cache-update'));
  const controller=new AbortController(),entered=deferred(),settled=deferred();let done=false;now=0;
  const pending=runColdBoot({...callbacks,signal:controller.signal,prepareRuntime:async()=>{entered.resolve();await settled.promise;return{code:0,closed:true};}}).finally(()=>{done=true;});
  await entered.promise;controller.abort();await Promise.resolve();assert.equal(done,false);
  settled.resolve();await assert.rejects(pending,error=>observed(error,'IOS_CANCELLED','selected-runtime-cache-update'));
  assert.equal(boot,0);assert.equal(prepared,0);
});

test('only the two reviewed primary reference paths are permitted, not their neighboring pages or hosts',()=>{
  const apple='https://developer.apple.com/forums/thread/807025',chromium='https://chromium.googlesource.com/chromium/src/ios/+/58fd493aeb99385b57fb7c5108837bc372b4d4b4%5E%21/';
  assert.equal(isAllowedUrl(apple),true);assert.equal(isAllowedUrl(chromium),true);
  for(const url of [apple+'1',apple.replace('807025','807026'),apple.replace('developer.apple.com','other.apple.com'),
    chromium.replace('58fd493','58fd494'),chromium.replace('/src/ios/','/src/other/')])assert.equal(isAllowedUrl(url),false);
});
