/** Pure descriptor/inventory checks; they do not authorize host or device use. */
import path from 'node:path';

export const IOS_DEVICE_SCOPE='ephemeral-hosted-standard-device-set';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuid=value=>typeof value==='string'&&UUID.test(value);
const BINDING_KEYS=['schemaVersion','scope','nativeHome','deviceSetPath','privateRoot','udid','nonce'];
const ROW_KEYS=['udid','name','deviceTypeIdentifier','runtimeId','state','isAvailable'];
const STATES=new Set(['Shutdown','Booted','Booting','Shutting Down']);
const STABLE=new Set(['Shutdown','Booted']);
const fail=code=>Object.assign(new Error(code),{code});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,expected)=>record(value)&&Reflect.ownKeys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
const text=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim().length>0&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
const canonicalPath=value=>text(value,2048)&&!value.includes('\\')&&value!=='/'&&!value.endsWith('/')&&path.posix.isAbsolute(value)&&path.posix.normalize(value)===value;
const runtime=value=>text(value,256)&&/^com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value);
const deviceType=value=>text(value,256)&&/^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value);
const compare=(a,b)=>a.udid<b.udid?-1:a.udid>b.udid?1:0;

export function validateIosDeviceBinding(binding,options={}) {
  if(!keys(binding,BINDING_KEYS)||!record(options)||Reflect.ownKeys(options).some(key=>key!=='capabilities')||binding.schemaVersion!==1||binding.scope!==IOS_DEVICE_SCOPE||
    !canonicalPath(binding.nativeHome)||!canonicalPath(binding.deviceSetPath)||!canonicalPath(binding.privateRoot)||
    binding.deviceSetPath!==path.posix.join(binding.nativeHome,'Library','Developer','CoreSimulator','Devices')||
    !/^tld-ios-[A-Za-z0-9]+$/.test(path.posix.basename(binding.privateRoot))||!uuid(binding.udid)||typeof binding.nonce!=='string'||!/^[a-f0-9]{24}$/.test(binding.nonce))throw fail('IOS_DEVICE_BINDING_REFUSED');
  const caps=options.capabilities;
  if(Object.hasOwn(options,'capabilities')&&(!record(caps)||caps['appium:udid']!==binding.udid||caps['appium:simulatorDevicesSetPath']!==binding.deviceSetPath||
    caps['appium:derivedDataPath']!==path.posix.join(binding.privateRoot,'derived-data')))throw fail('IOS_DEVICE_BINDING_REFUSED');
  // The owner must separately validate real paths, the hosted-runner opt-in,
  // nonce marker and exact Simulator identity before performing mutations.
  return Object.freeze(Object.fromEntries(BINDING_KEYS.map(key=>[key,binding[key]])));
}

function normalizeRows(rows,{strictKeys=false}={}) {
  if(!Array.isArray(rows)||rows.length>4096)throw fail('IOS_DEVICE_INVENTORY_INVALID');
  const seen=new Set(),copied=[];
  for(const row of rows){
    if(!record(row)||strictKeys&&!keys(row,ROW_KEYS)||!uuid(row.udid)||seen.has(row.udid.toLowerCase())||!text(row.name)||
      !deviceType(row.deviceTypeIdentifier)||!runtime(row.runtimeId)||!STATES.has(row.state)||typeof row.isAvailable!=='boolean')throw fail('IOS_DEVICE_INVENTORY_INVALID');
    seen.add(row.udid.toLowerCase());
    copied.push(Object.freeze(Object.fromEntries(ROW_KEYS.map(key=>[key,row[key]]))));
  }
  return Object.freeze(copied.sort(compare));
}

/** Accepts only the inner `devices` map returned by `simctl list devices --json`. */
export function normalizeIosDeviceInventory(devices) {
  if(!record(devices)||Reflect.ownKeys(devices).length>128)throw fail('IOS_DEVICE_INVENTORY_INVALID');
  const rows=[];
  for(const runtimeId of Reflect.ownKeys(devices)){
    const list=devices[runtimeId];
    if(typeof runtimeId!=='string'||!runtime(runtimeId)||!Array.isArray(list)||rows.length+list.length>4096)throw fail('IOS_DEVICE_INVENTORY_INVALID');
    for(const row of list){
      if(!record(row))throw fail('IOS_DEVICE_INVENTORY_INVALID');
      // Avoid retaining data/log paths, diagnostics or other unneeded metadata.
      rows.push({udid:row.udid,name:row.name,deviceTypeIdentifier:row.deviceTypeIdentifier,runtimeId,state:row.state,isAvailable:row.isAvailable});
    }
  }
  return normalizeRows(rows);
}

function foreignRows(rows,ownedUdid) {
  if(ownedUdid!==undefined&&!uuid(ownedUdid))throw fail('IOS_FOREIGN_INVENTORY_CHANGED');
  if(ownedUdid!==undefined&&rows.some(row=>row.udid.toLowerCase()===ownedUdid.toLowerCase()&&row.udid!==ownedUdid))throw fail('IOS_FOREIGN_INVENTORY_CHANGED');
  const foreign=rows.filter(row=>row.udid!==ownedUdid);
  if(foreign.some(row=>!STABLE.has(row.state)))throw fail('IOS_FOREIGN_INVENTORY_CHANGED');
  return Object.freeze(foreign);
}

export function snapshotIosForeignDevices(devices,ownedUdid) {
  try{return foreignRows(normalizeIosDeviceInventory(devices),ownedUdid);}
  catch{throw fail('IOS_FOREIGN_INVENTORY_CHANGED');}
}

export function assertIosForeignSnapshot(devices,baseline,ownedUdid) {
  try{
    const expected=foreignRows(normalizeRows(baseline,{strictKeys:true}),ownedUdid);
    // A baseline must already exclude the owned UUID; silently filtering one
    // out could hide a caller that accidentally captured the wrong scope.
    if(expected.length!==baseline.length)throw fail('IOS_FOREIGN_INVENTORY_CHANGED');
    const actual=snapshotIosForeignDevices(devices,ownedUdid);
    if(actual.length!==expected.length||actual.some((row,index)=>ROW_KEYS.some(key=>row[key]!==expected[index][key])))throw fail('IOS_FOREIGN_INVENTORY_CHANGED');
    return true;
  }catch{throw fail('IOS_FOREIGN_INVENTORY_CHANGED');}
}
