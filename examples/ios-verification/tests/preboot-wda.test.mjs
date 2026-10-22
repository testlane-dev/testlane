/** Controlled source sequencing, not a Simulator/compiler or filesystem-permission proof. */
import nodeTest from 'node:test';
const test=(name,callback)=>nodeTest(name,{timeout:5000},callback);
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import {getEventListeners} from 'node:events';
import {acknowledgedIosCreate,ownedSimctlArguments,ownedIosWdaBuildArguments,runIosColdBoot,selectIosTarget,
  validateIosWdaPreparation,verifyOwnedSimulator,verifyOwnedWdaPreparationSimulator} from '../device.mjs';
import {IOS_DEVICE_SCOPE,validateIosDeviceBinding,snapshotIosForeignDevices,assertIosForeignSnapshot} from '../device-scope.mjs';
import {createIosStartupFailure,fixedIosDeviceFailureCode,readIosStartupFailure,retainIosStartupFailure} from '../failure-facts.mjs';

const udid='12345678-1234-1234-1234-123456789ABC',other='87654321-1234-1234-1234-123456789ABC';
const runtimeId='com.apple.CoreSimulator.SimRuntime.iOS-26-4',deviceType='com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const deferred=()=>Promise.withResolvers();
function inventoryFixture(state='Shutdown'){
  const expected={nonce:'a'.repeat(24),name:'testlane_ios_'+'a'.repeat(24),udid,ownerPid:123,runtimeId,deviceType,
    deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',nativeHome:'/Users/runner',privateRoot:'/private/tmp/tld-ios-Abc123',baselineSHA256:'b'.repeat(64)};
  const row={udid,name:expected.name,state,isAvailable:true,deviceTypeIdentifier:deviceType};
  const foreign={...row,udid:other,name:'Hosted default phone',state:'Shutdown'};
  return{expected,marker:{schemaVersion:2,scope:IOS_DEVICE_SCOPE,...expected},row,foreign,
    baseline:snapshotIosForeignDevices({[runtimeId]:[foreign]}),devices:{[runtimeId]:[foreign,row]}};
}

test('preparation accepts only the exact owned Shutdown row and cannot widen public Booted ownership',()=>{
  const fixture=inventoryFixture();
  assert.equal(verifyOwnedWdaPreparationSimulator(fixture).state,'Shutdown');
  assert.throws(()=>verifyOwnedSimulator(fixture),/IOS_OWNERSHIP_REFUSED/);
  for(const state of ['Booted','Booting','Shutting Down']){
    const changed={...fixture,devices:{[runtimeId]:[fixture.foreign,{...fixture.row,state}]},requireBooted:false,verifyForeign:false};
    assert.throws(()=>verifyOwnedWdaPreparationSimulator(changed),/IOS_OWNERSHIP_REFUSED/);
  }
  for(const change of [{marker:{...fixture.marker,nonce:'c'.repeat(24)}},{marker:{...fixture.marker,ownerPid:456}},
    {devices:{[runtimeId]:[fixture.foreign,{...fixture.row,isAvailable:false}]}},
    {devices:{[runtimeId]:[fixture.foreign,{...fixture.row,deviceTypeIdentifier:'com.apple.CoreSimulator.SimDeviceType.iPhone-16'}]}},
    {devices:{'com.apple.CoreSimulator.SimRuntime.iOS-26-3':[fixture.foreign,fixture.row]}},
    {devices:{[runtimeId]:[{...fixture.foreign,state:'Booted'},fixture.row]}}]){
    assert.throws(()=>verifyOwnedWdaPreparationSimulator({...fixture,...change}),/IOS_OWNERSHIP_REFUSED|IOS_FOREIGN_INVENTORY_CHANGED/);
  }
});

// Execute the actual factory startup try/catch and its actual private guards.
// Effects are explicit controlled dependencies in this test context, never a
// production injection API. Only dynamic Manifest loading is replaced here.
const source=await readFile(new URL('../device.mjs',import.meta.url),'utf8');
function once(needle){assert.equal(source.split(needle).length,2,'controlled source anchor must be unique');return source.indexOf(needle);}
function section(from,to){const begin=once(from),end=once(to);assert.ok(end>begin);return source.slice(begin,end);}
const privateFunctions=section('  async function assertOwned(','  async function assertListeners(')
  +section('  async function prepareWda()','  async function processInfo(');
const fixedCommandKind=new vm.Script(section('function commandKind(','export function selectIosTarget(')+'\ncommandKind').runInNewContext();
const abortAnchor=once('  const abortLifecycle = () => { void close().catch(() => {}); };');
const start=once('  try {\n    await writeMarker();');assert.ok(start>abortAnchor);
const tail="    Object.defineProperty(result, 'capturedText', { value: captured.text }); throw result;\n  }\n}\n";
assert.equal(once(tail)+tail.length,source.length,'startup must end at the anchored factory close');
let startup=source.slice(start,source.length-3);
const manifest="await import(pathToFileURL(path.join(appiumRoot, 'build', 'lib', 'extension', 'manifest.js')).href)";
assert.equal(startup.split(manifest).length,2);startup=startup.replace(manifest,'await testManifest()');
const program=new vm.Script('(async()=>{\n'+privateFunctions+'\n'+startup+'\n})()', {filename:'controlled-ios-factory-startup.mjs'});

function controlled(options={}){
  const events=[],controller=new AbortController(),fixture=inventoryFixture(options.initialState??'Shutdown');
  let created=false,state=fixture.row.state,booted=false,closePromise,closeCalls=0,ownedInventories=0,clock=1000;
  const queries=[],cacheStarted=()=>events.includes('stage:selected-runtime-cache-preparing');
  const context={
    signal:controller.signal,Error,Object,JSON,Buffer,Date,performance:{now:()=>clock},URL,Promise,Math,Number,Set,AbortSignal,
    process:{execPath:process.execPath,pid:123,arch:process.arch},path:path.posix,
    root:fixture.expected.privateRoot,nativeHome:fixture.expected.nativeHome,deviceSetPath:fixture.expected.deviceSetPath,
    derivedDataPath:fixture.expected.privateRoot+'/derived-data',appiumHome:fixture.expected.privateRoot+'/appium',
    appiumRoot:'/private/tmp/pinned-tools/node_modules/appium',driverRoot:'/private/tmp/pinned-tools/node_modules/appium-xcuitest-driver',
    driverPackage:{version:'12.19.1'},tools:'/private/tmp/pinned-tools',runtimeId,deviceType,
    appiumPort:8123,wdaPort:8124,mjpegPort:8125,env:undefined,baseline:undefined,wdaPreparation:undefined,target:undefined,xcodeVersion:undefined,
    marker:{...fixture.marker,udid:null,runtimeId:null,deviceType:null,baselineSHA256:null,wdaPreparationSHA256:null},
    wdaBuildIncomplete:false,createAttempted:false,createSettled:false,ready:false,closed:false,closing:undefined,appium:undefined,
    startupStage:'owned-simulator-start',WDA_BUILD_MS:600000,wdaStartupPatch:{schemaVersion:1},
    fail:code=>Error(code),digest:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    safePath:value=>typeof value==='string'&&path.posix.isAbsolute(value),capture:()=>{},captured:{text:()=>''},
    createIosDeviceEnvironment:()=>Object.freeze({}),diagnosticPolicy:{appiumLogLevel:'error'},
    IOS_DEVICE_SCOPE,selectIosTarget,snapshotIosForeignDevices,assertIosForeignSnapshot,acknowledgedIosCreate,ownedSimctlArguments,
    ownedIosWdaBuildArguments,runIosColdBoot:options=>runIosColdBoot({...options,now:()=>clock}),validateIosWdaPreparation,verifyOwnedSimulator,verifyOwnedWdaPreparationSimulator,validateIosDeviceBinding:value=>validateIosDeviceBinding(JSON.parse(JSON.stringify(value))),
    createIosStartupFailure,fixedIosDeviceFailureCode,retainIosStartupFailure,
    mkdir:async()=>{},writeFile:async()=>{events.push('write');},
    realpath:async file=>{if(cacheStarted())clock+=options.cachePathMs??0;return options.alias&&file.endsWith(udid)?file+'-alias':file;},
    lstat:async()=>{if(cacheStarted())clock+=options.cachePathMs??0;return{isSymbolicLink:()=>options.symlink===true};},
    assertRoot:async()=>{events.push('root');if(cacheStarted())clock+=options.cacheRootMs??0;if(options.markerRefused||(options.markerRefusedAfterCache&&events.includes('cache')))throw Error('IOS_OWNERSHIP_REFUSED');return{...context.marker};},
    writeMarker:async()=>{events.push('marker');if(options.abortAfterPreparation&&context.marker.wdaPreparationSHA256)controller.abort();},
    live:()=>{if(controller.signal.aborted||context.closed||context.closing)throw Error('IOS_CANCELLED');},
    listOwned:async(ignoreSignal=false,timeoutMs=30000,prewarmDiagnostic,deadlineAt)=>{
      queries.push({cache:cacheStarted(),afterCache:events.includes('cache'),ignoreSignal,timeoutMs,prewarmDiagnostic,deadlineAt});
      if(cacheStarted())clock+=options.cacheInventoryMs??0;
      if(created&&++ownedInventories===options.refuseAtOwnedInventory)state='Booted';
      events.push('inventory:'+state);
      const foreign=(options.foreignDriftAfterBuild&&events.includes('build'))||(options.foreignDriftAfterBoot&&booted)||(options.foreignDriftAfterCache&&events.includes('cache'))?{...fixture.foreign,state:'Booted'}:fixture.foreign;
      return{[runtimeId]:[foreign,...created?[{...fixture.row,state}]:[]]};
    },
    wdaSourceBinding:async()=>{events.push('source');return{projectPath:'/private/tmp/pinned-tools/WebDriverAgent.xcodeproj',
      projectSHA256:(options.sourceChangedAfterBoot&&booted?'e':'a').repeat(64),packageSHA256:'b'.repeat(64)};},
    wdaArtifactBinding:async()=>{events.push('artifacts');if(options.artifactRefused)throw Error('IOS_WDA_ARTIFACT_INVALID');return{
      runnerSHA256:(options.artifactChangedAfterBoot&&booted?'e':'c').repeat(64),xctestrunSHA256:'d'.repeat(64)};},
    verifyPinnedWdaStartupPatch:async()=>{events.push('patch');},
    assertListeners:async()=>{events.push('listeners');},
    testManifest:async()=>({Manifest:class{async read(){events.push('manifest');}addExtensionFromPackage(){}async write(){}}}),
    launch:()=>{events.push('appium');return{started:Promise.resolve(true),spawned:true,closed:false,pid:321,child:{stdin:{end(){}}}};},
    fetch:async()=>({ok:true,json:async()=>({value:{ready:true,build:{version:'3.8.0'}}})}),
    sleep:async()=>{throw Error('CONTROLLED_UNEXPECTED_WAIT');},
  };
  context.startupAt=name=>{context.startupStage='device-'+name;events.push('stage:'+name);};
  context.close=()=>{
    if(closePromise)return closePromise;
    closeCalls++;events.push('close');context.closing=true;
    closePromise=(async()=>{if(options.closeGate)await options.closeGate.promise;if(options.closeRefused)throw Error('IOS_DEVICE_CLEANUP_UNCONFIRMED');context.closed=true;events.push('closed');})();
    return closePromise;
  };
  context.abortLifecycle=()=>{void context.close().catch(()=>{});};
  context.simctl=async args=>{
    if(args[0]==='create'){events.push('create');if(options.createCode)return{code:options.createCode,stdout:udid};created=true;return{code:0,stdout:udid+'\n'};}
    assert.equal(args[0],'bootstatus');events.push('bootstatus');
    if(options.statusCode)return{code:options.statusCode};state='Booted';booted=true;return{code:0};
  };
  context.run=async(executable,args,budget)=>{
    context.live();
    if(executable==='/usr/bin/xcodebuild'&&args[0]==='-version')return{code:0,stdout:'Xcode 26.6\n'};
    if(executable==='/usr/bin/xcrun'&&args[1]==='list')return{code:0,stdout:JSON.stringify(args[2]==='runtimes'?{runtimes:[{identifier:runtimeId,version:'26.4',isAvailable:true}]}:{devicetypes:[{identifier:deviceType}]})};
    if(executable==='/usr/bin/xcodebuild'){
      events.push('build');assert.equal(args[0],'build-for-testing');assert.equal(args.includes('id='+udid),true);
      assert.equal(budget.timeoutMs,600000);assert.equal(Number.isFinite(budget.deadlineAt),true);
      assert.equal(getEventListeners(controller.signal,'abort').length,0,'no boot lifecycle listener during preboot preparation');
      if(options.buildEntered)options.buildEntered.resolve();if(options.buildGate)await options.buildGate.promise;
      if(options.buildError)throw options.buildError;
      if(options.stateAfterBuild)state=options.stateAfterBuild;
      return{code:options.buildCode??0};
    }
    if(executable==='/usr/bin/xcrun'&&args[1]==='runtime'){
      assert.deepEqual(Array.from(args),['simctl','runtime','dyld_shared_cache','update',runtimeId]);
      assert.equal(fixedCommandKind(executable,args),'selected-runtime-cache-update');
      assert.equal(context.target.runtimeId,runtimeId);assert.ok(Object.isFrozen(context.target));
      assert.equal(budget.deadlineAt,601000);assert.equal(budget.timeoutMs,600000-(options.cacheRootMs??0)-(options.cacheInventoryMs??0)-2*(options.cachePathMs??0));
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      events.push('cache');if(options.cacheEntered)options.cacheEntered.resolve();if(options.cacheGate)await options.cacheGate.promise;
      clock+=options.cacheMs??0;if(options.cacheError)throw options.cacheError;
      if(options.stateAfterCache)state=options.stateAfterCache;
      return{code:options.cacheCode??0};
    }
    assert.equal(executable,'/usr/bin/xcrun');assert.equal(args[3],'boot');events.push('boot');
    assert.ok(budget.timeoutMs<=30000);assert.equal(budget.deadlineAt,Math.min(601000,clock+30000));
    return{code:options.bootCode??0};
  };
  const execution=()=>program.runInNewContext(context);
  return{events,queries,context,controller,execution,setState:value=>{state=value;},closeCalls:()=>closeCalls};
}

test('actual startup prepares while Shutdown, then boots, revalidates and only then returns an Appium handle',async()=>{
  const f=controlled(),device=await f.execution();
  const index=value=>f.events.indexOf(value);
  assert.ok(index('create')<index('build'));assert.ok(index('build')<index('cache'));assert.ok(index('cache')<index('boot'));assert.ok(index('boot')<index('bootstatus'));
  assert.equal(f.events[index('cache')-1],'inventory:Shutdown');
  assert.ok(f.events.slice(index('cache')+1,index('boot')).includes('inventory:Shutdown'));
  assert.ok(index('bootstatus')<index('patch'));assert.ok(index('patch')<index('appium'));
  assert.equal(f.context.wdaBuildIncomplete,false);assert.equal(device.wdaPreparation.wdaPrepared,true);assert.equal(f.closeCalls(),0);
  f.setState('Shutdown');await assert.rejects(device.assertOwned(),/IOS_OWNERSHIP_REFUSED/);await assert.rejects(device.assertWdaPrepared(),/IOS_OWNERSHIP_REFUSED/);
  await device.close();assert.equal(f.closeCalls(),1);
});

test('fresh preboot marker/path/state refusal never starts compilation or boot',async()=>{
  for(const options of [{initialState:'Booted'},{initialState:'Booting'},{initialState:'Shutting Down'},{markerRefused:true},{alias:true},{symlink:true}]){
    const f=controlled(options);await assert.rejects(f.execution(),/IOS_OWNERSHIP_REFUSED/);
    assert.equal(f.events.includes('build'),false);assert.equal(f.events.includes('boot'),false);assert.equal(f.closeCalls(),1);
  }
});

test('compile failure, artifact failure or unexpected state/foreign drift prevents the first boot',async()=>{
  for(const options of [{buildCode:65},{artifactRefused:true},{stateAfterBuild:'Booted'},{stateAfterBuild:'Booting'},{stateAfterBuild:'Shutting Down'},{foreignDriftAfterBuild:true}]){
    const f=controlled(options);await assert.rejects(f.execution(),/IOS_WDA_PREPARE_FAILED|IOS_WDA_ARTIFACT_INVALID|IOS_OWNERSHIP_REFUSED|IOS_FOREIGN_INVENTORY_CHANGED/);
    assert.equal(f.events.filter(item=>item==='build').length,1);assert.equal(f.events.includes('boot'),false);assert.equal(f.events.includes('appium'),false);assert.equal(f.closeCalls(),1);
    assert.equal(f.context.wdaBuildIncomplete,true);
  }
});

test('preboot cancellation awaits the command and independent close before returning failure',async()=>{
  const buildEntered=deferred(),buildGate=deferred(),closeGate=deferred();
  const f=controlled({buildEntered,buildGate,closeGate});let done=false;
  const pending=f.execution().finally(()=>{done=true;});await buildEntered.promise;f.controller.abort();
  await Promise.resolve();assert.equal(done,false);assert.equal(f.closeCalls(),0);
  buildGate.resolve();while(!f.closeCalls())await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
  closeGate.resolve();await assert.rejects(pending,/IOS_CANCELLED/);assert.equal(f.events.includes('boot'),false);assert.equal(f.context.wdaBuildIncomplete,true);
});

test('uncertain preboot command stop remains the startup fact when independent cleanup also fails',async()=>{
  const f=controlled({buildError:Error('IOS_PROCESS_STOP_UNCONFIRMED'),closeRefused:true});
  await assert.rejects(f.execution(),error=>{
    assert.equal(error.message,'IOS_DEVICE_CLEANUP_UNCONFIRMED');
    assert.deepEqual(readIosStartupFailure(error),{stage:'device-wda-build-for-testing',code:'IOS_PROCESS_STOP_UNCONFIRMED',commandKind:'not-recorded'});
    return true;
  });
  assert.equal(f.events.includes('boot'),false);assert.equal(f.closeCalls(),1);
});

test('failed boot/status or postboot prepared-artifact recheck returns no device handle or Appium process',async()=>{
  for(const options of [{bootCode:70},{statusCode:1},{foreignDriftAfterBoot:true},{sourceChangedAfterBoot:true},{artifactChangedAfterBoot:true}]){
    const f=controlled(options);await assert.rejects(f.execution(),/IOS_SIMULATOR_BOOT_FAILED|IOS_SIMULATOR_BOOT_TIMEOUT|IOS_FOREIGN_INVENTORY_CHANGED|IOS_WDA_ARTIFACT_CHANGED/);
    assert.equal(f.context.wdaBuildIncomplete,false);assert.equal(f.events.includes('appium'),false);assert.equal(f.closeCalls(),1);
    if(options.bootCode)assert.equal(f.events.includes('bootstatus'),false);
  }
});


test('fresh create acknowledgement and each of the three build guards are mandatory before boot',async()=>{
  const failedCreate=controlled({createCode:70});await assert.rejects(failedCreate.execution(),/IOS_SIMULATOR_CREATE_FAILED/);
  assert.equal(failedCreate.context.createSettled,false);assert.equal(failedCreate.events.includes('build'),false);assert.equal(failedCreate.events.includes('boot'),false);
  for(const refuseAtOwnedInventory of [1,2,3,4]){
    const f=controlled({refuseAtOwnedInventory});await assert.rejects(f.execution(),/IOS_OWNERSHIP_REFUSED/);
    assert.equal(f.events.filter(item=>item==='build').length,refuseAtOwnedInventory<=2?0:1);
    assert.equal(f.events.includes('boot'),false);assert.equal(f.events.includes('appium'),false);assert.equal(f.closeCalls(),1);
  }
});

test('cancellation after prepared marker persistence still prevents the first boot',async()=>{
  const f=controlled({abortAfterPreparation:true});await assert.rejects(f.execution(),/IOS_CANCELLED/);
  assert.equal(f.events.filter(item=>item==='build').length,1);assert.equal(f.events.includes('boot'),false);assert.equal(f.events.includes('appium'),false);assert.equal(f.closeCalls(),1);
});

test('actual cache adapter charges root, inventory and path checks before and after its exact command',async()=>{
  const f=controlled({cacheRootMs:5000,cacheInventoryMs:1000,cachePathMs:500,cacheMs:575000});
  const device=await f.execution(),cacheQueries=f.queries.filter(row=>row.cache&&!row.afterCache);
  assert.equal(cacheQueries.length,1);assert.equal(cacheQueries[0].timeoutMs,30000);assert.equal(cacheQueries[0].deadlineAt,601000);
  const after=f.queries.find(row=>row.cache&&row.afterCache);assert.equal(after.timeoutMs,13000);assert.equal(after.deadlineAt,601000);
  assert.equal(cacheQueries[0].ignoreSignal,false);assert.equal(cacheQueries[0].prewarmDiagnostic,undefined);
  assert.ok(f.events.indexOf('stage:selected-runtime-cache-prepared')>f.events.indexOf('cache'));
  assert.ok(f.events.indexOf('stage:selected-runtime-cache-prepared')<f.events.indexOf('boot'));
  await device.close();
});

test('actual cache guards refuse elapsed root, inventory or path work before dispatch',async()=>{
  for(const options of [{cacheRootMs:600000},{cacheInventoryMs:600000},{cachePathMs:300000}]){
    const f=controlled(options);await assert.rejects(f.execution(),error=>{
      assert.equal(error.message,'IOS_SIMULATOR_BOOT_TIMEOUT');
      assert.deepEqual(readIosStartupFailure(error),{stage:'device-selected-runtime-cache-preparing',code:'IOS_SIMULATOR_BOOT_TIMEOUT',commandKind:'selected-runtime-cache-update'});
      return true;
    });
    assert.equal(f.events.includes('cache'),false);assert.equal(f.events.includes('boot'),false);assert.equal(f.closeCalls(),1);
    if(options.cacheRootMs)assert.equal(f.queries.some(row=>row.cache),false);
  }
});

test('closed zero cache result cannot bypass a late post-command root check or renewed inventory budget',async()=>{
  const f=controlled({cacheRootMs:5000,cacheInventoryMs:1000,cachePathMs:500,cacheMs:590000});
  await assert.rejects(f.execution(),/IOS_SIMULATOR_BOOT_TIMEOUT/);
  assert.equal(f.events.filter(row=>row==='cache').length,1);assert.equal(f.events.includes('stage:selected-runtime-cache-prepared'),false);
  assert.equal(f.queries.some(row=>row.cache&&row.afterCache),false);assert.equal(f.events.includes('boot'),false);assert.equal(f.closeCalls(),1);
});

test('actual cache completion followed by changed owned or foreign state never boots or repairs',async()=>{
  for(const options of [{cacheCode:1},{cacheCode:70},{stateAfterCache:'Booted'},{stateAfterCache:'Booting'},
    {stateAfterCache:'Shutting Down'},{foreignDriftAfterCache:true},{markerRefusedAfterCache:true}]){
    const f=controlled(options);await assert.rejects(f.execution(),/IOS_RUNTIME_CACHE_PREPARE_FAILED|IOS_OWNERSHIP_REFUSED|IOS_FOREIGN_INVENTORY_CHANGED/);
    assert.equal(f.events.filter(row=>row==='cache').length,1);assert.equal(f.events.includes('boot'),false);
    assert.equal(f.events.includes('appium'),false);assert.equal(f.closeCalls(),1);
  }
});

test('cache cancellation joins its retained callback then independent cleanup before returning',async()=>{
  const cacheEntered=deferred(),cacheGate=deferred(),closeGate=deferred();
  const f=controlled({cacheEntered,cacheGate,closeGate});let done=false;
  const pending=f.execution().finally(()=>{done=true;});await cacheEntered.promise;f.controller.abort();
  await Promise.resolve();assert.equal(done,false);assert.equal(f.closeCalls(),0);
  cacheGate.resolve();while(!f.closeCalls())await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
  assert.equal(f.events.includes('boot'),false);closeGate.resolve();await assert.rejects(pending,/IOS_CANCELLED/);
  assert.equal(f.closeCalls(),1);assert.equal(f.events.includes('stage:selected-runtime-cache-prepared'),false);
});

test('uncertain cache stop retains its original fixed kind even when cleanup also fails',async()=>{
  const f=controlled({cacheError:Error('IOS_PROCESS_STOP_UNCONFIRMED'),closeRefused:true});
  await assert.rejects(f.execution(),error=>{
    assert.equal(error.message,'IOS_DEVICE_CLEANUP_UNCONFIRMED');
    assert.deepEqual(readIosStartupFailure(error),{stage:'device-selected-runtime-cache-preparing',code:'IOS_PROCESS_STOP_UNCONFIRMED',commandKind:'selected-runtime-cache-update'});return true;
  });
  assert.equal(f.events.includes('boot'),false);assert.equal(f.closeCalls(),1);
});
