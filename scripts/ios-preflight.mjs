/** Fixed, read-only iOS toolchain inspection; never selects or boots a device. */
import {execFile} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
export const IOS_RUNTIME='com.apple.CoreSimulator.SimRuntime.iOS-26-4';
export const IOS_DEVICE_TYPE='com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const refused=code=>new Error(code);
export function parseIosPrerequisites({xcode,sdk,runtimes,deviceTypes,architecture}) {
  const match=/^Xcode (\d+)\.(\d+)(?:\.(\d+))?\r?\nBuild version ([A-Za-z0-9]+)\s*$/.exec(xcode);
  if(!match||Number(match[1])<26||(Number(match[1])===26&&Number(match[2])<4))throw refused('IOS_XCODE_PREREQUISITE_MISSING');
  if(!/^\d+\.\d+(?:\.\d+)?$/.test(sdk.trim())||!['arm64','x64'].includes(architecture))throw refused('IOS_SIMULATOR_SDK_UNSUPPORTED');
  let runtime,type;
  try {
    runtime=JSON.parse(runtimes).runtimes.find(item=>item.identifier===IOS_RUNTIME&&item.isAvailable===true);
    type=JSON.parse(deviceTypes).devicetypes.find(item=>item.identifier===IOS_DEVICE_TYPE);
  }catch{throw refused('IOS_SIMULATOR_METADATA_INVALID');}
  if(!runtime||!type)throw refused('IOS_SIMULATOR_RUNTIME_MISSING');
  return {schemaVersion:1,hostOS:'macOS',architecture,xcodeVersion:match.slice(1,4).filter(Boolean).join('.'),xcodeBuild:match[4],
    simulatorSdkVersion:sdk.trim(),runtimeId:IOS_RUNTIME,deviceTypeId:IOS_DEVICE_TYPE};
}
export async function inspectIosPrerequisites({platform=process.platform,architecture=process.arch,run,onStage=()=>{}}={}) {
  if(platform!=='darwin')throw refused('IOS_MACOS_REQUIRED');
  const env={...process.env,DEBUG:'',NODE_DEBUG:''};delete env.NODE_OPTIONS;
  const command=run??(async(entry,args,timeout)=>(await execute(entry,args,{env,timeout,maxBuffer:1024*1024,windowsHide:true})).stdout);
  const values=[];
  for(const [name,entry,args,budget] of [
    ['XCODE','/usr/bin/xcodebuild',['-version'],60000],['SDK','/usr/bin/xcrun',['--sdk','iphonesimulator','--show-sdk-version'],60000],
    ['RUNTIMES','/usr/bin/xcrun',['simctl','list','runtimes','--json'],120000],['DEVICE_TYPES','/usr/bin/xcrun',['simctl','list','devicetypes','--json'],60000],
  ]) {
    onStage(name);
    try {values.push(await command(entry,args,budget));}
    catch(error){throw refused('IOS_PREFLIGHT_'+name+(error?.killed===true?'_TIMEOUT':'_FAILED'));}
  }
  return parseIosPrerequisites({xcode:values[0],sdk:values[1],runtimes:values[2],deviceTypes:values[3],architecture});
}
async function main() {
  if(process.argv.length!==3)throw refused('IOS_PREFLIGHT_ARGUMENTS_INVALID');
  const result=await inspectIosPrerequisites({onStage:name=>console.log('IOS_PREFLIGHT_STAGE '+name)}),file=path.resolve(process.argv[2]);
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify({...result,node:process.version},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result));
}
function entry(){try{return realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}}
if(entry())main().catch(error=>{console.error(/^IOS_[A-Z_]+$/.test(error.message)?error.message:'IOS_PREFLIGHT_FAILED');process.exitCode=1;});
