import test from 'node:test';
import assert from 'node:assert/strict';
import {IOS_DEVICE_SCOPE,validateIosDeviceBinding,normalizeIosDeviceInventory,snapshotIosForeignDevices,assertIosForeignSnapshot} from '../device-scope.mjs';

const owned='12345678-1234-1234-1234-123456789ABC',first='23456789-1234-1234-1234-123456789ABC',second='34567890-1234-1234-1234-123456789ABC';
const runtime='com.apple.CoreSimulator.SimRuntime.iOS-26-4',watchRuntime='com.apple.CoreSimulator.SimRuntime.watchOS-26-4';
const type='com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const binding=()=>({schemaVersion:1,scope:IOS_DEVICE_SCOPE,nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/var/tmp/tld-ios-aB12cD',udid:owned,nonce:'a'.repeat(24)});
const row=(udid,state='Shutdown')=>({udid,name:'Hosted Simulator',deviceTypeIdentifier:type,state,isAvailable:true});
const caps=value=>({'appium:udid':value.udid,'appium:simulatorDevicesSetPath':value.deviceSetPath,'appium:derivedDataPath':value.privateRoot+'/derived-data'});

test('binding descriptors copy and freeze only the exact hosted standard-set fields and bind capability targets',()=>{
  const supplied=binding(),copied=validateIosDeviceBinding(supplied,{capabilities:caps(supplied)});
  assert.deepEqual(copied,supplied);assert.notEqual(copied,supplied);assert.equal(Object.isFrozen(copied),true);
  supplied.udid=first;assert.equal(copied.udid,owned);
  for(const field of ['appium:udid','appium:simulatorDevicesSetPath','appium:derivedDataPath']){
    const value=binding();assert.throws(()=>validateIosDeviceBinding(value,{capabilities:{...caps(value),[field]:'another-target'}}),{code:'IOS_DEVICE_BINDING_REFUSED'});
  }
});

test('binding validation rejects additional authority, uncanonical paths, foreign sets and malformed scope identities',()=>{
  for(const patch of [{scope:'private-device-set'},{schemaVersion:2},{ownerPid:123},{nativeHome:'/'},{nativeHome:'relative'},
    {deviceSetPath:'/Users/another/Library/Developer/CoreSimulator/Devices'},{deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices/'},
    {privateRoot:'/tmp/other-root'},{privateRoot:'/tmp/tld-ios-a/../tld-ios-a'},{privateRoot:'/tmp//tld-ios-a'},{privateRoot:'/tmp/tld-ios-a\\b'},
    {privateRoot:'/tmp/tld-ios-a\n'},{privateRoot:'/tmp/tld-ios-a\u2028'},{nonce:'b'.repeat(23)},{nonce:'A'.repeat(24)},{udid:'booted'}]){
    assert.throws(()=>validateIosDeviceBinding({...binding(),...patch}),{code:'IOS_DEVICE_BINDING_REFUSED'});
  }
  const missing=binding();delete missing.nonce;assert.throws(()=>validateIosDeviceBinding(missing),{code:'IOS_DEVICE_BINDING_REFUSED'});
  assert.throws(()=>validateIosDeviceBinding(binding(),null),{code:'IOS_DEVICE_BINDING_REFUSED'});
  assert.throws(()=>validateIosDeviceBinding(binding(),{capabilities:{}}),{code:'IOS_DEVICE_BINDING_REFUSED'});
  for(const capabilities of [undefined,null])assert.throws(()=>validateIosDeviceBinding(binding(),{capabilities}),{code:'IOS_DEVICE_BINDING_REFUSED'});
  assert.throws(()=>validateIosDeviceBinding({...binding(),udid:{toString:()=>owned}}),{code:'IOS_DEVICE_BINDING_REFUSED'});
});

test('inventory normalization is order-independent, deeply frozen, and excludes raw diagnostic/path fields',()=>{
  const input={[watchRuntime]:[{...row(second,'Booted'),deviceTypeIdentifier:'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm',dataPath:'/private/data',error:'unreviewed'}],
    [runtime]:[row(first)]};
  const normalized=normalizeIosDeviceInventory(input);
  assert.deepEqual(normalized.map(value=>value.udid),[first,second]);
  assert.equal(normalized[1].runtimeId,watchRuntime);assert.equal(Object.isFrozen(normalized),true);assert.equal(normalized.every(Object.isFrozen),true);
  assert.deepEqual(Object.keys(normalized[1]).sort(),['udid','name','deviceTypeIdentifier','runtimeId','state','isAvailable'].sort());
  input[runtime][0].name='changed';assert.equal(normalized[0].name,'Hosted Simulator');
  assert.deepEqual(normalizeIosDeviceInventory({}),[]);
});

test('malformed inventory and duplicate UUIDs cannot be normalized into an incomplete foreign baseline',()=>{
  for(const value of [null,[],{devices:{[runtime]:[row(first)]}},{[runtime]:{}},{foreignRuntime:[row(first)]},
    {[runtime]:[row(first),row(first.toLowerCase())]}, {[runtime]:[row(first)],[watchRuntime]:[row(first)]},
    {[runtime]:[{...row(first),isAvailable:undefined}]},{[runtime]:[{...row(first),name:'unsafe\nname'}]},
    {[runtime]:[{...row(first),deviceTypeIdentifier:'foreign.phone'}]},{[runtime]:[{...row(first),state:'Unknown'}]},
    {[runtime]:[{...row(first),udid:'all'}]}])assert.throws(()=>normalizeIosDeviceInventory(value),{code:'IOS_DEVICE_INVENTORY_INVALID'});
});

test('only the exact owned UUID may transition or disappear while all foreign rows stay fixed',()=>{
  const original={[runtime]:[row(first),row(second,'Booted')]},baseline=snapshotIosForeignDevices(original);
  assert.equal(assertIosForeignSnapshot({[runtime]:[row(owned,'Booting'),...original[runtime].toReversed()]},baseline,owned),true);
  assert.equal(assertIosForeignSnapshot({[runtime]:[row(owned,'Shutting Down'),...original[runtime]]},baseline,owned),true);
  assert.equal(assertIosForeignSnapshot(original,baseline,owned),true);
  assert.equal(Object.isFrozen(baseline),true);
  assert.throws(()=>snapshotIosForeignDevices({[runtime]:[row(first,'Booting')]}),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
  assert.throws(()=>snapshotIosForeignDevices({[runtime]:[row(first,'Shutting Down')]}),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
  assert.equal(normalizeIosDeviceInventory({[runtime]:[row(owned,'Booting')]}).length,1);
});

test('foreign additions, removals, state/name/type/runtime/availability changes all fail closed',()=>{
  const original={[runtime]:[row(first)]},baseline=snapshotIosForeignDevices(original);
  for(const current of [{},{[runtime]:[row(first),row(second)]},{[runtime]:[row(first,'Booted')]},
    {[runtime]:[{...row(first),name:'renamed'}]},{[runtime]:[{...row(first),isAvailable:false}]},
    {[runtime]:[{...row(first),deviceTypeIdentifier:'com.apple.CoreSimulator.SimDeviceType.iPhone-16'}]},
    {[watchRuntime]:[row(first)]}])assert.throws(()=>assertIosForeignSnapshot(current,baseline,owned),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
  assert.throws(()=>assertIosForeignSnapshot(original,[{...baseline[0],rawDiagnostic:'not-a-baseline'}],owned),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
  assert.throws(()=>assertIosForeignSnapshot({[runtime]:[row(owned)]},snapshotIosForeignDevices({[runtime]:[row(owned)]}),owned),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
  assert.throws(()=>snapshotIosForeignDevices({[runtime]:[row(owned.toLowerCase())]},owned),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
  assert.throws(()=>assertIosForeignSnapshot(original,baseline,'booted'),{code:'IOS_FOREIGN_INVENTORY_CHANGED'});
});
