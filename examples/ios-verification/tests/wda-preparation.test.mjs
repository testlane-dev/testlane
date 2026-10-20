import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { ownedIosWdaBuildArguments, validateIosWdaBundleMetadata, validateIosWdaPreparation } from '../device.mjs';

const inputs=()=>({projectPath:path.join(os.tmpdir(),'pinned-tools','WebDriverAgent.xcodeproj'),
  derivedDataPath:path.join(os.tmpdir(),'tld-ios-abc123','derived-data'),udid:'12345678-1234-1234-1234-123456789ABC',platformVersion:'26.4.1'});
test('WDA preparation compiles only for the exact UUID and private DerivedData with no launch or signing authority',()=>{
  const value=inputs(),args=ownedIosWdaBuildArguments(value);
  assert.deepEqual(args,['build-for-testing','-project',value.projectPath,'-scheme','WebDriverAgentRunner','-derivedDataPath',value.derivedDataPath,
    '-destination','id='+value.udid,'IPHONEOS_DEPLOYMENT_TARGET=26.4','GCC_TREAT_WARNINGS_AS_ERRORS=0','COMPILER_INDEX_STORE_ENABLE=NO','APPIUM_XCODEBUILD_WDA_MARKER=1']);
  assert.equal(args.includes('test-without-building'),false);assert.equal(args.some(item=>/signing|provisioning/i.test(item)),false);
  for(const change of [{projectPath:'relative'}, {projectPath:path.join(os.tmpdir(),'Other.xcodeproj')}, {derivedDataPath:path.join(os.tmpdir(),'shared','derived-data')},
    {udid:'booted'},{udid:'all'},{platformVersion:'26.4; arbitrary'}])assert.throws(()=>ownedIosWdaBuildArguments({...value,...change}),/IOS_WDA_PREPARE_INPUT_INVALID/);
});

const metadata=()=>({app:{CFBundleIdentifier:'com.facebook.WebDriverAgentRunner.xctrunner',CFBundleExecutable:'WebDriverAgentRunner-Runner',DTPlatformName:'iphonesimulator',CFBundleSupportedPlatforms:['iPhoneSimulator']},
  test:{CFBundleIdentifier:'com.facebook.WebDriverAgentRunner',CFBundleExecutable:'WebDriverAgentRunner',DTPlatformName:'iphonesimulator',CFBundleSupportedPlatforms:['iPhoneSimulator']},
  architecture:'arm64',expectedArchitecture:'arm64',platform:'platform IOSSIMULATOR\n'});
test('prepared products must be the pinned Simulator runner and test bundle for this host architecture',()=>{
  const value=metadata();assert.equal(validateIosWdaBundleMetadata(value),true);
  for(const change of [{app:{...value.app,CFBundleIdentifier:'dev.testlane.iosproof'}},{test:{...value.test,CFBundleIdentifier:'other'}},
    {app:{...value.app,DTPlatformName:'iphoneos'}},{test:{...value.test,CFBundleSupportedPlatforms:['iPhoneOS']}},
    {architecture:'x86_64'},{platform:'platform IOS\n'},{expectedArchitecture:null}])assert.throws(()=>validateIosWdaBundleMetadata({...value,...change}),/IOS_WDA_ARTIFACT_INVALID/);
});

const preparation=()=>({schemaVersion:1,wdaPrepared:true,buildBudgetMs:300000,buildMs:12345,webdriveragent:'16.16.3',projectSHA256:'a'.repeat(64),
  packageSHA256:'b'.repeat(64),runnerSHA256:'c'.repeat(64),xctestrunSHA256:'d'.repeat(64)});
test('public WDA preparation evidence copies only measured hash primitives and the separate compile budget',()=>{
  const original=preparation(),value=validateIosWdaPreparation(original);assert.deepEqual(value,original);assert.equal(Object.isFrozen(value),true);
  original.runnerSHA256='e'.repeat(64);assert.equal(value.runnerSHA256,'c'.repeat(64));
  for(const change of [{wdaPrepared:false},{buildBudgetMs:600000},{buildMs:300001},{buildMs:-1},{webdriveragent:'other'},
    {runnerSHA256:'missing'},{xctestrunSHA256:null},{runnerSHA256:['c'.repeat(64)]},{packageSHA256:{toString:()=> 'b'.repeat(64)}},
    {raw:'untrusted-native-output'},{root:'/private/arbitrary'}]){
    assert.throws(()=>validateIosWdaPreparation({...preparation(),...change}),error=>error.message==='IOS_WDA_PREPARE_FAILED'&&!String(error.stack).includes('untrusted-native-output'));
  }
});
