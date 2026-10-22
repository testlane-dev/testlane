import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectIosPrerequisites,parseIosPrerequisites,IOS_RUNTIME,IOS_DEVICE_TYPE} from '../../../scripts/ios-preflight.mjs';
const values=()=>({xcode:'Xcode 26.6\nBuild version 17F113\n',sdk:'26.5\n',architecture:'arm64',
  runtimes:JSON.stringify({runtimes:[{identifier:IOS_RUNTIME,isAvailable:true}]}),deviceTypes:JSON.stringify({devicetypes:[{identifier:IOS_DEVICE_TYPE}]})});
test('preflight refuses unsupported hosts before running any tool',async()=>{
  let called=false;await assert.rejects(inspectIosPrerequisites({platform:'win32',run:()=>{called=true;}}),/IOS_MACOS_REQUIRED/);assert.equal(called,false);
});
test('preflight binds the supported Xcode and exact available simulator metadata',()=>{
  const report=parseIosPrerequisites(values());assert.equal(report.runtimeId,IOS_RUNTIME);assert.equal(report.deviceTypeId,IOS_DEVICE_TYPE);assert.equal(report.xcodeVersion,'26.6');
  for(const change of [{xcode:'Xcode 26.3\nBuild version 17C529\n'},{runtimes:JSON.stringify({runtimes:[{identifier:IOS_RUNTIME,isAvailable:false}]})},
    {architecture:'ia32'},{sdk:'raw-payload'},{runtimes:'invalid'}])assert.throws(()=>parseIosPrerequisites({...values(),...change}),/^Error: IOS_/);
});
test('tool failures keep arbitrary stderr out of the fixed preflight error',async()=>{
  await assert.rejects(inspectIosPrerequisites({platform:'darwin',run:()=>{throw Error('private-tool-payload');}}),error=>error.message==='IOS_PREFLIGHT_XCODE_FAILED');
});
