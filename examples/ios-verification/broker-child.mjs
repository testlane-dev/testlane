/** Fixed proof entry: actual installed CLI, explicit real temporary-keychain adapter. */
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {requireIosBrokerCi,validateIosBrokerMarker} from './broker.mjs';

async function main(){
  requireIosBrokerCi();
  const root=process.env.TESTLANE_IOS_BROKER_ROOT,home=process.env.TESTLANE_HOME;
  if(!root||!home||await realpath(root)!==root||(await lstat(root)).isSymbolicLink())throw Error('IOS_BROKER_OWNERSHIP_REFUSED');
  const keychain=path.join(root,'proof.keychain-db'),marker=JSON.parse(await readFile(path.join(root,'testlane-ios-broker.json'),'utf8'));
  validateIosBrokerMarker({root,home,keychain,marker,parentPid:process.ppid});
  for(const file of [home,keychain,path.join(root,'testlane.profiles.json')])if((await lstat(file)).isSymbolicLink()||await realpath(file)!==file)throw Error('IOS_BROKER_OWNERSHIP_REFUSED');
  if(process.env.TESTLANE_PROFILES!==path.join(root,'testlane.profiles.json'))throw Error('IOS_BROKER_REGISTRY_REFUSED');
  const {KeychainMacosStore,redactor}=await import('../../dist/index.js');
  const {runCli}=await import('../../dist/cli.js');
  redactor.install();
  process.exitCode=await runCli(process.argv.slice(2),{deps:{store:new KeychainMacosStore({dir:path.join(home,'store'),keychain}),cwd:root},isTTY:false});
}
main().catch(()=>{console.error('IOS_BROKER_CHILD_FAILED');process.exitCode=1;});
