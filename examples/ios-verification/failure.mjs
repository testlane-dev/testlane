/** Public diagnostics consist only of fixed stages/codes and validated native reports. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sanitizeNativeReport,NATIVE_DRIVER_FAILURE_CODES} from '../android-verification/contracts.mjs';
import {APPROVAL_REQUIREMENTS} from '../android-verification/proof-cases.mjs';
import {ownIosErrorString,readIosStartupFailure} from './failure-facts.mjs';

const STAGES=new Set(['consumer-install','setup','owned-simulator-start','device-xcode-runtime-and-pinned-tools-validated',
  'device-owned-simulator-created','device-owned-simulator-boot-started','device-owned-simulator-booted','device-wda-build-for-testing','device-wda-prepared','device-private-appium-ready','app-prewarm','wda-readiness','broker-setup','positive','fault','corrected','cleanup']);
const CODES=new Set(['IOS_PROOF_CLEANUP_INCOMPLETE','IOS_DEVICE_CLEANUP_UNCONFIRMED','IOS_BROKER_KEYCHAIN_CREATE_FAILED',
  'IOS_BROKER_KEYCHAIN_DELETE_FAILED','IOS_BROKER_KEYCHAIN_DELETE_UNCONFIRMED','IOS_BROKER_SEARCH_LIST_RESTORE_FAILED',
  'IOS_BROKER_DEFAULT_CHANGED','IOS_BROKER_CHILD_FAILED','IOS_BROKER_CREDENTIAL_LEAK','IOS_COMMAND_TIMEOUT','IOS_SIMULATOR_BOOT_TIMEOUT',
  'IOS_SIMULATOR_BOOT_FAILED','IOS_SIMULATOR_CREATE_FAILED','IOS_APPIUM_READY_TIMEOUT','IOS_APPIUM_STOPPED','IOS_OWNERSHIP_REFUSED','IOS_APP_LAUNCH_FAILED',
  'IOS_WDA_PREPARE_FAILED','IOS_WDA_PROJECT_REFUSED','IOS_WDA_ARTIFACT_INVALID','IOS_WDA_ARTIFACT_CHANGED']);
const DRIVER_CODES=new Set([...NATIVE_DRIVER_FAILURE_CODES,'NATIVE_DRIVER_CANCELLED']);
export async function publicIosFailure({output,stage,error}) {
  const message=ownIosErrorString(error,'message'),code=ownIosErrorString(error,'code');
  const summary={schemaVersion:1,status:'failed',stage:STAGES.has(stage)?stage:'setup',
    code:CODES.has(message)?message:DRIVER_CODES.has(code)?code:code==='ERR_ASSERTION'?'IOS_PROOF_ASSERTION_FAILED':'IOS_PROOF_FAILED',reports:[]};
  const startupFailure=readIosStartupFailure(error);if(startupFailure)summary.startupFailure=startupFailure;
  try{
    const plan=JSON.parse(await readFile(path.join(output,'plan.json'),'utf8'));
    if(plan.runner!=='ios-xcuitest'||JSON.stringify(plan.cases.map(item=>item.id))!==JSON.stringify(APPROVAL_REQUIREMENTS.map(item=>item.id)))return summary;
    for(const phase of ['positive','fault','corrected']){
      try{
        const report=sanitizeNativeReport(JSON.parse(await readFile(path.join(output,phase+'.json'),'utf8')),plan);
        summary.reports.push({phase,...report});
      }catch{/* Unvalidated or missing bytes are never retained in public output. */}
    }
  }catch{/* Prerequisite failures may occur before a reviewed plan exists. */}
  return summary;
}
