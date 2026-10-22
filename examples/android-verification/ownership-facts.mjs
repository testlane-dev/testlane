/** Fixed ownership-refusal observations only; these grant no execution authority. */
import {types} from 'node:util';

const early = ['root-path','marker'];
const queried = ['adb-query-status','adb-device-state','guest-identity'];
const checks = ['stateDevice','allQueriesSucceeded','qemuMatches','avdNamePresent','avdNameMatches',
  'avdNameNonceMatches','markerPidMatches','markerNonceMatches','retainedProcessesAlive'];
function ownData(value,names){
  if(!value||typeof value!=='object'||types.isProxy(value))return;
  try{
    if(![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertyNames(value).length!==names.length||Object.getOwnPropertySymbols(value).length)return;
    const result={};
    for(const name of names){const property=Object.getOwnPropertyDescriptor(value,name);if(!property||!Object.hasOwn(property,'value'))return;result[name]=property.value;}
    return result;
  }catch{return;}
}
export function normalizeAndroidOwnershipFailure(value){
  if(!value||typeof value!=='object'||types.isProxy(value))return;
  try{
    const gate=Object.getOwnPropertyDescriptor(value,'gate');if(!gate||!Object.hasOwn(gate,'value'))return;
    if(early.includes(gate.value)){const data=ownData(value,['gate']);return data?Object.freeze(data):undefined;}
    if(!queried.includes(gate.value))return;
    const data=ownData(value,['gate','checks']),safe=data&&ownData(data.checks,checks);
    if(!safe||!checks.every(name=>typeof safe[name]==='boolean'))return;
    return Object.freeze({gate:data.gate,checks:Object.freeze(safe)});
  }catch{return;}
}
const nativeError=value=>value!==null&&typeof value==='object'&&!types.isProxy(value)&&types.isNativeError(value);
export function retainAndroidOwnershipFailure(error,value){
  const fact=normalizeAndroidOwnershipFailure(value);
  if(nativeError(error)&&fact)try{if(!Object.getOwnPropertyDescriptor(error,'ownershipFailure'))Object.defineProperty(error,'ownershipFailure',{value:fact});}catch{}
  return error;
}
export function readAndroidOwnershipFailure(error){
  if(!nativeError(error))return;
  try{const property=Object.getOwnPropertyDescriptor(error,'ownershipFailure');return property&&Object.hasOwn(property,'value')?normalizeAndroidOwnershipFailure(property.value):undefined;}catch{return;}
}
