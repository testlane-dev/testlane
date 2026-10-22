import test from 'node:test';
import assert from 'node:assert/strict';
import {lstat,mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixedIosDevicePreflightCode,runIosDevicePreflight,validateIosDevicePreflightOutput} from '../../../scripts/ios-device-preflight.mjs';

async function fixture(t){
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-ios-preflight-test-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent);assert.equal(await realpath(root),root);assert.equal((await lstat(root)).isSymbolicLink(),false);await rm(root,{recursive:true,maxRetries:5,retryDelay:100});});
  return root;
}

test('device preflight refuses non-macOS before allocating output or native resources',{skip:process.platform==='darwin'},async t=>{
  const root=await fixture(t),outputDir=path.join(root,'not-created');
  await assert.rejects(runIosDevicePreflight({toolsRoot:path.join(root,'missing-tools'),outputDir}),/IOS_MACOS_REQUIRED/);
  await assert.rejects(lstat(outputDir),{code:'ENOENT'});
});

test('pre-aborted device preflight allocates no output or native resources',async t=>{
  const root=await fixture(t),outputDir=path.join(root,'not-created'),controller=new AbortController();controller.abort();
  await assert.rejects(runIosDevicePreflight({toolsRoot:root,outputDir,signal:controller.signal}),/IOS_CANCELLED/);
  await assert.rejects(lstat(outputDir),{code:'ENOENT'});
});

test('device preflight output validation requires a new canonical child and creates nothing',async t=>{
  const root=await fixture(t),output=path.join(root,'new-output');
  assert.equal(await validateIosDevicePreflightOutput(output),output);await assert.rejects(lstat(output),{code:'ENOENT'});
  await assert.rejects(validateIosDevicePreflightOutput(root),/IOS_DEVICE_PREFLIGHT_OUTPUT_EXISTS/);
  await assert.rejects(validateIosDevicePreflightOutput(path.join(root,'missing-parent','new-output')),/IOS_DEVICE_PREFLIGHT_PARENT_REFUSED/);
  await assert.rejects(validateIosDevicePreflightOutput(path.parse(root).root),/IOS_DEVICE_PREFLIGHT_OUTPUT_INVALID/);
});

test('device failure metadata preserves known source codes and refuses arbitrary error text',()=>{
  assert.equal(fixedIosDevicePreflightCode(Error('IOS_COMMAND_TIMEOUT')),'IOS_COMMAND_TIMEOUT');
  assert.equal(fixedIosDevicePreflightCode(Error('IOS_DEVICE_CLEANUP_UNCONFIRMED')),'IOS_DEVICE_CLEANUP_UNCONFIRMED');
  assert.equal(fixedIosDevicePreflightCode(Error('private-payload')),'IOS_DEVICE_PREFLIGHT_FAILED');
  assert.equal(fixedIosDevicePreflightCode(Error('IOS_PRIVATE_PAYLOAD')),'IOS_DEVICE_PREFLIGHT_FAILED');
});
