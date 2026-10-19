import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {requireIosBrokerCi,validateIosBrokerMarker,scanIosCredentials,startIosBroker,reconcileIosKeychain} from '../broker.mjs';
test('real iOS broker requires explicit ephemeral hosted-Mac context before allocation',async()=>{
  for(const input of [{platform:'win32',env:{}},{platform:'darwin',env:{}},{platform:'darwin',env:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'self-hosted',TESTLANE_IOS_PROOF_CI:'1'}}])assert.throws(()=>requireIosBrokerCi(input),/IOS_BROKER_EPHEMERAL_CI_REQUIRED/);
  assert.doesNotThrow(()=>requireIosBrokerCi({platform:'darwin',env:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',TESTLANE_IOS_PROOF_CI:'1'}}));
  if(process.platform!=='darwin')await assert.rejects(startIosBroker(),/IOS_BROKER_EPHEMERAL_CI_REQUIRED/);
});
test('cleanup reconciles a keychain created before an interrupted initialization and restores search state',async()=>{
  let present=true,removed=0,restored=0;
  const inspect=async()=>{if(!present)throw Object.assign(Error('absent'),{code:'ENOENT'});return {isFile:()=>true,isSymbolicLink:()=>false};};
  await reconcileIosKeychain({inspect,remove:async()=>{removed++;present=false;return {code:0};},restoreSearch:async()=>{restored++;}});
  assert.equal(removed,1);assert.equal(restored,1);assert.equal(present,false);
  present=true;
  await assert.rejects(reconcileIosKeychain({inspect,remove:async()=>({code:1}),restoreSearch:async()=>{restored++;}}),/IOS_BROKER_KEYCHAIN_DELETE_FAILED/);
  assert.equal(restored,2,'search restoration is attempted even after deletion failure');
});
test('explicit native keychain and home cannot escape their owned marker',()=>{
  const root='/private/tmp/tld-ios-broker-abcdef',home=root+'/home',keychain=root+'/proof.keychain-db';
  const marker={schemaVersion:1,root,home,keychain,ownerPid:123,nonce:'a'.repeat(24)};
  assert.equal(validateIosBrokerMarker({root,home,keychain,marker,parentPid:123}),true);
  for(const change of [{home:'/private/tmp/personal'},{keychain:root+'/../login.keychain-db'},{parentPid:124},{root:root+'/..'},{marker:{...marker,nonce:'bad'}}])assert.throws(()=>validateIosBrokerMarker({root,home,keychain,marker,parentPid:123,...change}),/IOS_BROKER_OWNERSHIP_REFUSED/);
});
test('credential leak guard covers raw, encoded and base64 forms without echoing them',()=>{
  const secret='generated-'+randomBytes(20).toString('hex')+'/+=';
  for(const value of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')])assert.throws(()=>scanIosCredentials(value,[secret]),error=>error.message==='IOS_BROKER_CREDENTIAL_LEAK');
  assert.doesNotThrow(()=>scanIosCredentials('fixed public status',[secret]));
});
