/** Fixed public evidence for the independently authored synthetic Android proof. */
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {types,isDeepStrictEqual} from 'node:util';
import {sanitizeNativeReport,validateNativePlan,NATIVE_DRIVER_FAILURE_CODES} from './contracts.mjs';
import {APPROVAL_REQUIREMENTS} from './proof-cases.mjs';

const MAX_BYTES=512*1024;
const PHASES=['positive','fault','corrected'];
const STAGES=new Set(['consumer-install','setup','owned-device-start','device-sdk-and-pinned-tools-validated',
  'device-private-adb-started','device-owned-emulator-started','device-owned-emulator-booted','device-private-appium-ready',
  'android-readiness','credential-allocation','broker-setup',...PHASES,'cleanup']);
const CODES=new Set(['ANDROID_PROOF_FAILED','ANDROID_PROOF_ASSERTION_FAILED','ANDROID_PROOF_CLEANUP_INCOMPLETE',
  'ANDROID_DEVICE_CLEANUP_UNCONFIRMED','ANDROID_DEVICE_INPUT_INVALID','ANDROID_DEVICE_ENV_INVALID','ANDROID_HOST_POLICY_REFUSED',
  'ANDROID_SYSTEM_IMAGE_REFUSED','ANDROID_SYSTEM_IMAGE_UNSUPPORTED','ANDROID_TOOLS_VERSION_MISMATCH','ANDROID_TOOLS_PATH_TOO_DEEP',
  'ANDROID_AUTOMATION_APK_REFUSED','ANDROID_OUTPUT_PATH_REFUSED','ANDROID_CANCELLED','ANDROID_CAPTURE_LIMIT',
  'ANDROID_PROCESS_TERMINATION_UNCONFIRMED','ANDROID_PROCESS_IDENTITY_UNSUPPORTED','ANDROID_OWNERSHIP_REFUSED',
  'ANDROID_ADB_KEY_SETUP_FAILED','ANDROID_ADB_SERVER_START_FAILED','ANDROID_ADB_SERVER_STOPPED','ANDROID_ADB_SCOPE_REFUSED',
  'ANDROID_AVD_CONFIGURATION_REFUSED','ANDROID_EMULATOR_PORT_UNAVAILABLE','ANDROID_EMULATOR_START_FAILED',
  'ANDROID_EMULATOR_BOOT_TIMEOUT','ANDROID_EMULATOR_STOPPED','ANDROID_OWNED_PROCESS_STOPPED','ANDROID_COMMAND_START_FAILED',
  'ANDROID_COMMAND_TIMEOUT','ANDROID_APPIUM_START_FAILED','ANDROID_APPIUM_READY_TIMEOUT','ANDROID_APPIUM_STOPPED',
  'ANDROID_APK_INPUT_INVALID','ANDROID_APK_INSTALL_FAILED','ANDROID_BOOTSTRAP_INPUT_INVALID','ANDROID_BOOTSTRAP_WRITE_FAILED',
  'ANDROID_BOOTSTRAP_CLEANUP_UNCONFIRMED','ANDROID_DEVICE_START_FAILED','DEMO_CHILD_TERMINATION_UNCONFIRMED',
  'DEMO_CHILD_INPUT_INVALID','DEMO_CHILD_OUTPUT_LIMIT','DEMO_CHILD_START_FAILED','DEMO_CHILD_TIMEOUT',
  'NATIVE_WORKER_FAILED','NATIVE_WORKER_TIMEOUT','NATIVE_WORKER_PROTOCOL_INVALID','NATIVE_WORKER_OUTPUT_LIMIT',
  'NATIVE_WORKER_TERMINATION_UNCONFIRMED','NATIVE_WORKER_RPC_UNSETTLED','NATIVE_DRIVER_CANCELLED',...NATIVE_DRIVER_FAILURE_CODES]);
const nativeError=value=>value!==null&&typeof value==='object'&&!types.isProxy(value)&&types.isNativeError(value);
function own(value,key){try{const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}}
function errorCode(error){
  if(!nativeError(error))return 'ANDROID_PROOF_FAILED';
  const message=own(error,'message'),code=own(error,'code');
  return CODES.has(message)?message:CODES.has(code)?code:code==='ERR_ASSERTION'?'ANDROID_PROOF_ASSERTION_FAILED':'ANDROID_PROOF_FAILED';
}
/** Copy JSON data without invoking a getter, proxy trap, toJSON or coercion. */
function data(value){
  let nodes=0,characters=0;
  const copy=(item,depth)=>{
    if(++nodes>20000||depth>16)throw Error('ANDROID_FAILURE_REFUSED');
    if(item===null||typeof item==='boolean')return item;
    if(typeof item==='string'){characters+=item.length;if(characters>MAX_BYTES)throw Error('ANDROID_FAILURE_REFUSED');return item;}
    if(typeof item==='number'&&Number.isFinite(item))return item;
    if(!item||typeof item!=='object'||types.isProxy(item))throw Error('ANDROID_FAILURE_REFUSED');
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw Error('ANDROID_FAILURE_REFUSED');
    const names=Object.getOwnPropertyNames(item);
    if(Object.getOwnPropertySymbols(item).length)throw Error('ANDROID_FAILURE_REFUSED');
    if(array){
      const length=own(item,'length');if(!Number.isSafeInteger(length)||length>10000||names.length!==length+1)throw Error('ANDROID_FAILURE_REFUSED');
      return Array.from({length},(_,index)=>{const d=Object.getOwnPropertyDescriptor(item,String(index));if(!d||!Object.hasOwn(d,'value'))throw Error('ANDROID_FAILURE_REFUSED');return copy(d.value,depth+1);});
    }
    const result=Object.create(null);
    for(const name of names){const d=Object.getOwnPropertyDescriptor(item,name);if(!d||!Object.hasOwn(d,'value'))throw Error('ANDROID_FAILURE_REFUSED');result[name]=copy(d.value,depth+1);}
    return result;
  };
  return copy(value,0);
}
const exact=(value,names)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
function fact(value){
  try{const safe=data(value);if(!exact(safe,['stage','code'])||!STAGES.has(safe.stage)||!CODES.has(safe.code))return undefined;
    return Object.freeze({stage:safe.stage,code:safe.code});}catch{return undefined;}
}
export function createAndroidFailureFact({stage,error}){return Object.freeze({stage:STAGES.has(stage)?stage:'setup',code:errorCode(error)});}
export function readAndroidFailureFact(error){return nativeError(error)?fact(own(error,'originalFailure')):undefined;}
export function retainAndroidFailureFact(error,value){
  const safe=fact(value);
  if(nativeError(error)&&safe)try{if(!Object.getOwnPropertyDescriptor(error,'originalFailure'))Object.defineProperty(error,'originalFailure',{value:safe});}catch{}
  return error;
}
function syntheticPlan(baseUrl='http://127.0.0.1:4555',apkSha256='0'.repeat(64)){
  return {schemaVersion:1,runner:'android-uiautomator2',status:'reviewed',title:'Synthetic native approval proof',
    target:{baseUrl,environment:'testing'},app:{package:'dev.testlane.androidproof',apkSha256},
    cases:APPROVAL_REQUIREMENTS.map(item=>({...item,cleanup:{required:item.id!=='anonymous-denied',
      description:item.id==='anonymous-denied'?'No state is created':'Delete only the unique owned marker and verify absence'}}))};
}
function checkedPlan(value){
  const plan=validateNativePlan(value),expected=syntheticPlan(plan.target.baseUrl,plan.app.apkSha256);
  if(!isDeepStrictEqual(plan,expected))throw Error('ANDROID_FAILURE_REFUSED');return plan;
}
/** A regular bounded file is read through its retained handle; symlinks are refused. */
async function jsonFile(file){
  let handle;
  try{
    const absolute=path.resolve(file);
    if(await realpath(path.dirname(absolute))!==path.dirname(absolute))return undefined;
    const before=await lstat(absolute,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.size>BigInt(MAX_BYTES))return undefined;
    handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)return undefined;
    const bytes=Buffer.alloc(MAX_BYTES+1);let offset=0;
    while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,null);if(!result.bytesRead)break;offset+=result.bytesRead;}
    if(offset>MAX_BYTES)return undefined;
    const after=await lstat(absolute,{bigint:true}),end=await handle.stat({bigint:true});
    if(!after.isFile()||after.isSymbolicLink()||after.dev!==opened.dev||after.ino!==opened.ino||
      end.size!==opened.size||end.mtimeNs!==opened.mtimeNs||end.ctimeNs!==opened.ctimeNs||BigInt(offset)!==end.size)return undefined;
    return JSON.parse(bytes.subarray(0,offset).toString('utf8'));
  }catch{return undefined;}finally{try{await handle?.close();}catch{}}
}
/** Rebuild every public field. An untrusted field never becomes an upload path or message. */
export function projectPublicAndroidFailure(value){
  try{
    const input=data(value),names=['schemaVersion','status','stage','code','reports'];
    if(Object.hasOwn(input,'originalFailure'))names.push('originalFailure');
    if(!exact(input,names)||input.schemaVersion!==1||input.status!=='failed'||!STAGES.has(input.stage)||!CODES.has(input.code)||
      !Array.isArray(input.reports)||input.reports.length>3)return undefined;
    const summary={schemaVersion:1,status:'failed',stage:input.stage,code:input.code,reports:[]};
    if(Object.hasOwn(input,'originalFailure')){const original=fact(input.originalFailure);if(!original)return undefined;summary.originalFailure=original;}
    let prior=-1;
    for(const row of input.reports){
      const index=PHASES.indexOf(row.phase);if(index<=prior||index<0) return undefined;prior=index;
      if(!exact(row,['phase','schemaVersion','runner','verdict','reasonCodes','diagnostics','cases','limits']))return undefined;
      const {phase,...report}=row,safe=sanitizeNativeReport(report,syntheticPlan());
      // The sanitizer reconstructs fixed descriptions. Require equality so even
      // discarded extra fields cannot hide inside an apparently valid file.
      if(JSON.stringify(report)!==JSON.stringify(safe))return undefined;
      summary.reports.push({phase,...safe});
    }
    return summary;
  }catch{return undefined;}
}
export async function readPublicAndroidFailure(file){
  if(typeof file!=='string'||path.basename(file)!=='public-failure.json')return undefined;
  return projectPublicAndroidFailure(await jsonFile(file));
}
export async function publicAndroidFailure({output,stage,error}){
  const summary={schemaVersion:1,status:'failed',...createAndroidFailureFact({stage,error}),reports:[]};
  const original=readAndroidFailureFact(error);if(original)summary.originalFailure=original;
  try{
    const plan=checkedPlan(await jsonFile(path.join(output,'plan.json')));
    for(const phase of PHASES)try{
      const report=sanitizeNativeReport(await jsonFile(path.join(output,phase+'.json')),plan);
      summary.reports.push({phase,...report});
    }catch{/* Absent or unvalidated phase bytes remain omitted. */}
  }catch{/* Early failures do not require a plan or a native report. */}
  return summary;
}
