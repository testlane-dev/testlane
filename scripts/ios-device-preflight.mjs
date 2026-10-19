#!/usr/bin/env node
/** Pre-authentication only: own, boot, inspect and remove a new private Simulator. */
import {randomBytes} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startOwnedIos} from '../examples/ios-verification/device.mjs';

const MARKER='testlane-ios-device-preflight.json',CAPTURE_LIMIT=8*1024*1024;
const STAGES=new Set(['starting','xcode-runtime-and-pinned-tools-validated','owned-simulator-created',
  'owned-simulator-boot-started','owned-simulator-booted','private-appium-ready','ownership-verified']);
const CODES=new Set(['IOS_MACOS_REQUIRED','IOS_CANCELLED','IOS_CAPTURE_LIMIT','IOS_COMMAND_START_FAILED','IOS_COMMAND_TIMEOUT',
  'IOS_DEVICE_CLEANUP_UNCONFIRMED','IOS_DEVICE_INPUT_INVALID','IOS_DEVICE_ENV_INVALID','IOS_DEVICE_START_FAILED','IOS_DEVICE_TYPE_UNAVAILABLE',
  'IOS_APPIUM_READY_TIMEOUT','IOS_APPIUM_START_FAILED','IOS_APPIUM_STOPPED','IOS_LISTENER_BINDING_REFUSED',
  'IOS_LISTENER_STOP_UNCONFIRMED','IOS_OUTPUT_PATH_REFUSED','IOS_OWNERSHIP_REFUSED','IOS_PROCESS_OWNERSHIP_REFUSED',
  'IOS_PROCESS_STOP_UNCONFIRMED','IOS_PROCESS_TREE_LIMIT','IOS_RUNTIME_METADATA_INVALID','IOS_RUNTIME_UNAVAILABLE',
  'IOS_SIMCTL_SCOPE_REFUSED','IOS_SIMULATOR_BOOT_FAILED','IOS_SIMULATOR_BOOT_TIMEOUT','IOS_SIMULATOR_CREATE_FAILED',
  'IOS_SIMULATOR_CREATE_UNSETTLED','IOS_SIMULATOR_DELETE_UNCONFIRMED','IOS_SIMULATOR_LIST_FAILED',
  'IOS_SIMULATOR_SHUTDOWN_UNCONFIRMED','IOS_TARGET_INCOMPATIBLE','IOS_TARGET_SELECTOR_INVALID','IOS_TOOLS_MISSING',
  'IOS_TOOLS_VERSION_MISMATCH','IOS_XCODE_PREREQUISITE_FAILED','IOS_XCODE_PREREQUISITE_MISSING']);
const fail=code=>new Error(code);
const same=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&!/[\r\n\0]/.test(value)&&same(path.resolve(value),value);
export const fixedIosDevicePreflightCode=error=>CODES.has(error?.message)?error.message:'IOS_DEVICE_PREFLIGHT_FAILED';

/** No allocation: the destination must be new beneath an existing canonical parent. */
export async function validateIosDevicePreflightOutput(outputDir) {
  if(!absolute(outputDir)||path.parse(outputDir).root===outputDir)throw fail('IOS_DEVICE_PREFLIGHT_OUTPUT_INVALID');
  const parent=path.dirname(outputDir);
  try {
    if(!same(await realpath(parent),parent)||(await lstat(parent)).isSymbolicLink())throw Error();
  }catch{throw fail('IOS_DEVICE_PREFLIGHT_PARENT_REFUSED');}
  try{await lstat(outputDir);throw fail('IOS_DEVICE_PREFLIGHT_OUTPUT_EXISTS');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return outputDir;
}

function publicVersions(value) {
  if(!value||value.appium!=='3.8.0'||value.xcuitest!=='12.19.1'||value.webdriveragent!=='16.16.3'||
    ![value.xcode,value.ios].every(item=>typeof item==='string'&&/^\d+\.\d+(?:\.\d+)?$/.test(item))||
    !/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+-\d+(?:-\d+)?$/.test(value.runtimeId??'')||
    !/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[A-Za-z0-9-]+$/.test(value.deviceType??''))throw fail('IOS_DEVICE_PREFLIGHT_VERSIONS_INVALID');
  return Object.fromEntries(['appium','xcuitest','webdriveragent','xcode','ios','runtimeId','deviceType'].map(key=>[key,value[key]]));
}

export async function runIosDevicePreflight({toolsRoot,outputDir,signal,onStage=()=>{}}={}) {
  // These refusals deliberately precede output creation or native tool execution.
  if(signal?.aborted)throw fail('IOS_CANCELLED');
  if(process.platform!=='darwin')throw fail('IOS_MACOS_REQUIRED');
  if(!absolute(toolsRoot))throw fail('IOS_DEVICE_PREFLIGHT_TOOLS_INVALID');
  try{if(!same(await realpath(toolsRoot),toolsRoot)||(await lstat(toolsRoot)).isSymbolicLink())throw Error();}
  catch{throw fail('IOS_DEVICE_PREFLIGHT_TOOLS_INVALID');}
  const output=await validateIosDevicePreflightOutput(outputDir);
  if(signal?.aborted)throw fail('IOS_CANCELLED');
  try{await mkdir(output,{mode:0o700});}catch{throw fail('IOS_DEVICE_PREFLIGHT_OUTPUT_CREATE_FAILED');}
  const marker={schemaVersion:1,purpose:'pre-auth-device-readiness',nonce:randomBytes(12).toString('hex'),ownerPid:process.pid,output};
  await writeFile(path.join(output,MARKER),JSON.stringify(marker)+'\n',{flag:'wx',mode:0o600});
  async function assertOutput() {
    if(!same(await realpath(output),output)||(await lstat(output)).isSymbolicLink())throw fail('IOS_DEVICE_PREFLIGHT_OUTPUT_OWNERSHIP_REFUSED');
    const file=path.join(output,MARKER),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(marker))throw fail('IOS_DEVICE_PREFLIGHT_OUTPUT_OWNERSHIP_REFUSED');
  }
  let device,error,stage='starting',ownershipVerified=false,versions,cleanup='not-required',captureTruncated=false;
  const at=name=>{if(STAGES.has(name)){stage=name;onStage(name);}};
  try {
    await assertOutput();at('starting');
    // This module never loads an app, backend, accounts, broker or native store.
    // Device commands and cleanup retain their existing per-command bounds.
    device=await startOwnedIos({toolsRoot,outputDir:path.join(output,'device'),signal,onStage:at});
    cleanup='unconfirmed';
    await device.assertOwned();ownershipVerified=true;versions=publicVersions(device.versions);at('ownership-verified');
    if(signal?.aborted)throw fail('IOS_CANCELLED');
  }catch(caught){
    error=caught;
    if(!device){
      // startOwnedIos attaches capture only after its own bounded cleanup attempt.
      // Its explicit unconfirmed code overrides every apparent startup success.
      cleanup=caught?.message==='IOS_DEVICE_CLEANUP_UNCONFIRMED'?'unconfirmed':
        typeof caught?.capturedText==='function'?'completed':'not-required';
    }
  }finally{
    if(device)try{await device.close();cleanup='completed';}catch{cleanup='unconfirmed';error=fail('IOS_DEVICE_CLEANUP_UNCONFIRMED');}
  }
  if(signal?.aborted&&!error)error=fail('IOS_CANCELLED');
  const status={schemaVersion:1,purpose:'pre-auth-device-readiness',status:error?'failed':'passed',stage,
    code:error?fixedIosDevicePreflightCode(error):'IOS_DEVICE_PREFLIGHT_READY',ownershipVerified,
    cleanup:{status:cleanup},...(versions?{versions}:{}),node:process.version};
  await assertOutput();
  if(error){
    let text='';
    try{text=device?.capturedText()??error?.capturedText?.()??'';}catch{/* A capture error is never rendered into a public log. */}
    if(typeof text!=='string')text='';
    let bytes=Buffer.from(text,'utf8');
    if(bytes.length>CAPTURE_LIMIT){bytes=bytes.subarray(0,CAPTURE_LIMIT);captureTruncated=true;}
    await writeFile(path.join(output,'preauth-device.log'),bytes,{flag:'wx',mode:0o600});
    status.capture={bytes:bytes.length,truncated:captureTruncated};
  }
  await assertOutput();
  await writeFile(path.join(output,'status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx',mode:0o600});
  if(error)throw fail(status.code);
  return status;
}

async function main() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    const key={'--tools-root':'toolsRoot','--output-dir':'outputDir'}[args[i]];
    if(!key||options[key]||!args[i+1])throw fail('IOS_DEVICE_PREFLIGHT_ARGUMENTS_INVALID');
    options[key]=path.resolve(args[++i]);
  }
  if(!options.toolsRoot||!options.outputDir)throw fail('IOS_DEVICE_PREFLIGHT_ARGUMENTS_INVALID');
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{console.log(JSON.stringify(await runIosDevicePreflight({...options,signal:controller.signal,
    onStage:name=>console.log('IOS_DEVICE_PREFLIGHT_STAGE '+name)})));}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
function entry(){try{return same(realpathSync(process.argv[1]),realpathSync(fileURLToPath(import.meta.url)));}catch{return false;}}
if(entry())main().catch(error=>{console.error(CODES.has(error?.message)||/^IOS_DEVICE_PREFLIGHT_[A-Z_]+$/.test(error?.message??'')?error.message:'IOS_DEVICE_PREFLIGHT_FAILED');process.exitCode=1;});
