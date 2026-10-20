/** Controller ordering fixtures only; these do not claim a native device or business-case pass. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runIosProof } from '../../../scripts/ios-proof.mjs';
import { publicIosFailure } from '../failure.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(mode, { failPostReadinessCheck = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tld-ios-readiness-'));
  const packageRoot = path.join(root, 'package'), appDirectory = path.join(root, 'TestlaneIOSProof.app');
  const outputDir = path.join(root, 'output'), sessionTemp = path.join(root, 'sessions');
  async function file(relative, source) {
    const target = path.join(packageRoot, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source);
  }
  await Promise.all([mkdir(appDirectory), mkdir(sessionTemp)]);
  await file('state.mjs', `export const state=${JSON.stringify({ mode, failPostReadinessCheck, events: [], accounts: 0, broker: 0, close: 0, wdaChecks: 0 })};`);
  const stateUrl = pathToFileURL(path.join(packageRoot, 'state.mjs')).href;
  const stateImport = 'import {state} from ' + JSON.stringify(stateUrl) + ';\n';
  await file('examples/ios-verification/broker.mjs', stateImport + `
    export function requireIosBrokerCi(){}
    export function scanIosCredentials(text,secrets){state.scannedPasswordCount=secrets.length;}
    export async function startIosBroker(){state.broker++;throw Error('FIXTURE_BROKER_NOT_EXPECTED');}
  `);
  await file('examples/verification-demo/app.mjs', stateImport + `
    export async function startDemoApp({accounts}){state.accounts++;state.events.push('account-backend-start');
      state.roles=Object.values(accounts).map(account=>account.role);throw Error('FIXTURE_AFTER_READINESS');}
  `);
  await file('examples/ios-verification/device.mjs', stateImport + `
    export async function startOwnedIos(){state.events.push('device-start');const binding={schemaVersion:1,scope:'ephemeral-hosted-standard-device-set',
      nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-abc123',
      udid:'FA001122-3344-5566-7788-9900AABBCCDD',nonce:'a'.repeat(24)};
      return {udid:binding.udid,deviceBinding:binding,deviceSetPath:binding.deviceSetPath,derivedDataPath:binding.privateRoot+'/derived-data',
        serverUrl:'http://127.0.0.1:4723',wdaPort:8211,mjpegPort:8212,
        async installApp(){state.events.push('app-install');},async prewarmProofApp(){state.events.push('app-prewarm');return {appPrewarmed:true};},
        async assertOwned(){return true;},async assertWdaPrepared(){state.events.push('wda-check');
          if(++state.wdaChecks===2&&state.failPostReadinessCheck)throw Error('IOS_WDA_ARTIFACT_CHANGED');},
        async close(){state.close++;state.events.push('device-close');},capturedText(){return '';}};}
  `);
  await file('examples/ios-verification/driver.mjs', stateImport + `
    export async function createNativeDriver(options){state.events.push('installed-driver-create');
      state.privacy={showXcodeLog:options.capabilities['appium:showXcodeLog'],showIOSLog:options.capabilities['appium:showIOSLog'],
        skipLogCapture:options.capabilities['appium:skipLogCapture']};
      if(state.mode==='create-failed')throw Object.assign(Error('private-fixture-native-message'),{code:'NATIVE_DRIVER_SESSION_TIMEOUT'});
      return {context:state.mode==='context-failed'?'WEBVIEW':'NATIVE_APP',async close(){state.events.push('installed-driver-close');
        if(state.mode==='close-failed')throw Object.assign(Error('private-fixture-native-message'),{code:'NATIVE_DRIVER_TIMEOUT'});}};}
  `);
  for (const name of ['readiness.mjs', 'device-scope.mjs']) await file('examples/ios-verification/' + name, await readFile(new URL('../' + name, import.meta.url)));
  await file('examples/android-verification/worker-host.mjs', 'export function runNativeWorker(){throw Error("WORKER_NOT_EXPECTED");}');
  await file('examples/android-verification/contracts.mjs', 'export const validateNativePlan=value=>value,sanitizeNativeReport=value=>value,NATIVE_DRIVER_FAILURE_CODES=["NATIVE_DRIVER_SESSION_TIMEOUT","NATIVE_DRIVER_CONTEXT_REFUSED","NATIVE_DRIVER_TIMEOUT"];');
  await file('examples/android-verification/proof-cases.mjs', 'export const APPROVAL_REQUIREMENTS=[];');
  await file('examples/android-verification/budgets.mjs', 'export const NATIVE_PROOF_BUDGETS={};');
  const appSHA256 = 'a'.repeat(64);
  const builder = 'export async function hashIosTree(){return {sha256:' + JSON.stringify(appSHA256) + '};}';
  await file('examples/mobile-approval-app/build-ios.mjs', builder);
  const publicSourceSHA256 = {};
  for (const name of ['package.json', 'package-lock.json', 'app.ios.config.cjs', 'index.js', 'App.js', 'bootstrap.mjs', 'plugins/withIosProofBuild.cjs']) {
    const source = 'synthetic fixture: ' + name; await file('examples/mobile-approval-app/' + name, source); publicSourceSHA256[name] = sha(source);
  }
  await writeFile(path.join(root, 'build-manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'ios-simulator', package: 'dev.testlane.iosproof',
    proofOnly: true, configuration: 'Release', signature: 'none', unsigned: true, codeSigningAllowed: false, embeddedBundle: true,
    architecture: 'arm64', appSHA256, builderSHA256: sha(builder), publicSourceSHA256 }));
  const { state } = await import(stateUrl);
  return { state, outputDir, options: { consumer: { root, packageRoot, sessionTemp }, appDirectory, toolsRoot: path.join(root, 'tools'), outputDir,
    onStage: value => state.events.push('stage:' + value) }, close: () => rm(root, { recursive: true, force: true }) };
}

test('controller refuses all credential/backend/broker work until installed-driver readiness and exact-session close succeed', async () => {
  for (const mode of ['create-failed', 'close-failed', 'context-failed']) {
    const owned = await fixture(mode);
    try {
      let error;
      await assert.rejects(runIosProof(owned.options), value => { error = value; return true; });
      assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0);
      assert.equal(owned.state.scannedPasswordCount, 0, 'failure before readiness has not even allocated generated passwords');
      assert.equal(owned.state.close, 1, 'the same owned device receives final teardown');
      assert.equal(owned.state.events.filter(value => value === 'installed-driver-create').length, 1);
      assert.equal(owned.state.events.filter(value => value === 'installed-driver-close').length, mode === 'create-failed' ? 0 : 1);
      await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
      const summary = await publicIosFailure({ output: owned.outputDir, stage: 'wda-readiness', error });
      assert.equal(summary.stage, 'wda-readiness'); assert.match(summary.code, /^NATIVE_DRIVER_/);
      assert.equal(JSON.stringify(summary).includes('private-fixture-native-message'), false);
    } finally { await owned.close(); }
  }
});

test('a successful single-session readiness record precedes credential creation and omits device teardown claims', async () => {
  const owned = await fixture('passed');
  try {
    await assert.rejects(runIosProof(owned.options), /FIXTURE_AFTER_READINESS/);
    const events = owned.state.events;
    assert.ok(events.indexOf('installed-driver-close') < events.indexOf('account-backend-start'));
    assert.equal(owned.state.accounts, 1); assert.deepEqual(owned.state.roles, ['Editor', 'Reviewer']);
    assert.equal(owned.state.broker, 0); assert.equal(owned.state.close, 1);
    assert.equal(events.filter(value => value === 'installed-driver-close').length, 1);
    assert.deepEqual(owned.state.privacy, { showXcodeLog: false, showIOSLog: false, skipLogCapture: true });
    assert.equal(owned.state.wdaChecks, 2, 'WDA artifacts are checked again after the readiness driver closes');
    const record = JSON.parse(await readFile(path.join(owned.outputDir, 'readiness.json'), 'utf8'));
    assert.equal(record.installedDriver, true); assert.equal(record.nativeContextVerified, true); assert.equal(record.sessionCleanup, 'deleted');
    assert.equal(Object.hasOwn(record, 'deviceCleanup'), false); assert.equal(Object.hasOwn(record, 'cleanupVerified'), false);
    assert.equal(JSON.stringify(record).includes('FA001122'), false);
  } finally { await owned.close(); }
});

test('post-readiness WDA artifact drift prevents both the success record and all credential work', async () => {
  const owned = await fixture('passed', { failPostReadinessCheck: true });
  try {
    await assert.rejects(runIosProof(owned.options), /IOS_WDA_ARTIFACT_CHANGED/);
    assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.scannedPasswordCount, 0);
    assert.equal(owned.state.events.filter(value => value === 'installed-driver-close').length, 1); assert.equal(owned.state.close, 1);
    await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
  } finally { await owned.close(); }
});
