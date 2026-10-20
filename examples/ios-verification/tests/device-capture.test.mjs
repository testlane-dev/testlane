import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIosCommandOutput, createIosDeviceCapture, retainIosCommandPayload, validateIosListener } from '../device.mjs';
import { assertIosForeignSnapshot, snapshotIosForeignDevices } from '../device-scope.mjs';

const runtime='com.apple.CoreSimulator.SimRuntime.iOS-26-4',type='com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const row=index=>({udid:index.toString(16).padStart(8,'0')+'-1111-2222-3333-444444444444',name:'Synthetic phone '+index,
  deviceTypeIdentifier:type,state:'Shutdown',isAvailable:true});
const marker=(kind,event)=>'\nIOS_DEVICE_COMMAND '+JSON.stringify({kind,event,spawned:true,exited:event==='end',closed:event==='end',code:event==='end'?0:null,elapsedMs:event==='end'?123:0})+'\n';

test('1202 representative standard-set responses remain fully valid without exhausting aggregate capture',()=>{
  const foreign=Array.from({length:60},(_,index)=>row(index+1)),owned={...row(61),name:'Synthetic owned phone',state:'Booted'};
  const devices={[runtime]:[...foreign,owned]},baseline=snapshotIosForeignDevices({[runtime]:foreign});
  const value={devices,rawDiagnosticCanary:'PUBLIC_FIXTURE_PAYLOAD_ONLY',unusedDiagnosticPadding:''};
  value.unusedDiagnosticPadding='x'.repeat(37559-Buffer.byteLength(JSON.stringify(value)));
  const payload=JSON.stringify(value);assert.equal(Buffer.byteLength(payload),37559);
  const capture=createIosDeviceCapture();
  // Leave room for real retained startup/build diagnostics, rather than testing
  // the ownership loop with an otherwise empty aggregate log.
  capture.append('WDA_BUILD_DIAGNOSTIC\n'.repeat(180000));
  let observed=0;
  for(let index=0;index<1202;index++){
    capture.append(marker('owned-device-list','start'));
    const stdout=captureIosCommandOutput(capture.append,'owned-device-list',payload);
    observed+=Buffer.byteLength(stdout);assert.equal(stdout,payload);
    assert.equal(assertIosForeignSnapshot(JSON.parse(stdout).devices,baseline,owned.udid),true);
    capture.append(marker('owned-device-list','end'));
    for(const port of [49343,49344,49345]){
      capture.append(marker('loopback-listeners','start'));
      const text=captureIosCommandOutput(capture.append,'loopback-listeners','p123\nn127.0.0.1:'+port+'\n');
      assert.equal(validateIosListener(text,port),true);
      capture.append(marker('loopback-listeners','end'));
    }
  }
  assert.equal(observed,37559*1202);assert.ok(observed>40*1024*1024);
  assert.equal(capture.overflowed(),false);assert.ok(Buffer.byteLength(capture.text())<8*1024*1024);
  assert.equal(capture.text().includes(value.rawDiagnosticCanary),false);
  assert.equal((capture.text().match(/"kind":"owned-device-list"/g)??[]).length,2404);
  const changed=JSON.parse(captureIosCommandOutput(capture.append,'owned-device-list',payload));
  changed.devices[runtime][0].state='Booted';
  assert.throws(()=>assertIosForeignSnapshot(changed.devices,baseline,owned.udid),/IOS_FOREIGN_INVENTORY_CHANGED/);
});

test('only repeated inventory/listener/process payloads are transient, on both command streams',()=>{
  const capture=createIosDeviceCapture(),text='PUBLIC_FIXTURE_TRANSIENT_ERROR';
  for(const kind of ['owned-device-list','loopback-listeners','process-identity','owned-descendants','owned-process-group']){
    assert.equal(retainIosCommandPayload(kind),false);
    assert.equal(captureIosCommandOutput(capture.append,kind,text),text);
  }
  assert.equal(capture.text(),'');
  for(const kind of ['owned-wda-prebuild','owned-prewarm-stack-sample','owned-proof-app-prewarm','runtime-list','other']){
    assert.equal(retainIosCommandPayload(kind),true);
    assert.equal(captureIosCommandOutput(capture.append,kind,text),text);
  }
  assert.equal(capture.text(),text.repeat(5));
});

test('retained native diagnostics still fail the unchanged eight-MiB byte limit',()=>{
  const capture=createIosDeviceCapture(),exact='é'.repeat(4*1024*1024);
  assert.equal(captureIosCommandOutput(capture.append,'owned-wda-prebuild',exact),exact);
  assert.equal(Buffer.byteLength(capture.text()),8*1024*1024);assert.equal(capture.overflowed(),false);
  capture.append('x');assert.equal(capture.overflowed(),true);assert.equal(capture.text(),exact);
  const oversized=createIosDeviceCapture(),bytes='x'.repeat(8*1024*1024+1);
  assert.equal(captureIosCommandOutput(oversized.append,'owned-prewarm-stack-sample',bytes),bytes);
  assert.equal(oversized.overflowed(),true);assert.equal(oversized.text(),'');
});
