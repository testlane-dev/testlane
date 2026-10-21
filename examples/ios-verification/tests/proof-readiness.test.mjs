/** Controller ordering fixtures only; these do not claim a native device or business-case pass. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runIosProof } from '../../../scripts/ios-proof.mjs';
import { publicIosFailure } from '../failure.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(mode, { failPostReadinessCheck = false, lateStartupFailure = false, deviceCloseFails = false, statusWriteFails = false, captureThrows = false, preauthControls = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tld-ios-readiness-'));
  const packageRoot = path.join(root, 'package'), appDirectory = path.join(root, 'TestlaneIOSProof.app');
  const outputDir = path.join(root, 'output'), sessionTemp = path.join(root, 'sessions');
  async function file(relative, source) {
    const target = path.join(packageRoot, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source);
  }
  await Promise.all([mkdir(appDirectory), mkdir(sessionTemp)]);
  await file('state.mjs', `export const state=${JSON.stringify({ mode, failPostReadinessCheck, lateStartupFailure, deviceCloseFails, statusWriteFails, captureThrows,
    cookie: randomBytes(24).toString('base64url'), events: [], accounts: 0, broker: 0, close: 0, wdaChecks: 0 })};`);
  const stateUrl = pathToFileURL(path.join(packageRoot, 'state.mjs')).href;
  const stateImport = 'import {state} from ' + JSON.stringify(stateUrl) + ';\n';
  await file('examples/ios-verification/broker.mjs', stateImport + `
    export function requireIosBrokerCi(){}
    export function scanIosCredentials(text,secrets){state.scannedPasswordCount=secrets.length;}
    export async function startIosBroker(){state.broker++;
      if(!state.lateStartupFailure)throw Error('FIXTURE_BROKER_NOT_EXPECTED');
      return {root:'owned-fixture-broker',async cli(args){
        if(args[0]==='session'){const {writeFile}=await import('node:fs/promises');await writeFile(args[args.indexOf('--out')+1],JSON.stringify({cookies:[{name:'tldemo_session',value:state.cookie}]}));}
        if(args[0]==='store'&&args[1]==='delete')state.events.push('store-delete');
        if(args[0]==='check'){state.events.push('store-check');return {code:4};}
        return {code:0};},async auditText(){return '';},scan(){},async dispose(){state.events.push('broker-dispose');}};
    }
  `);
  await file('examples/verification-demo/app.mjs', stateImport + `
    export async function startDemoApp({accounts}){state.accounts++;state.events.push('account-backend-start');
      state.roles=Object.values(accounts).map(account=>account.role);
      if(!state.lateStartupFailure)throw Error('FIXTURE_AFTER_READINESS');
      return {origin:'http://127.0.0.1:43111',records(){return [];},issuedSessionTokens(){return [state.cookie];},setDefect(){},async close(){state.events.push('backend-close');}};}
  `);
  await file('examples/ios-verification/device.mjs', stateImport + `
    import {createIosStartupFailure,retainIosStartupFailure,tagIosCommandFailure} from './failure-facts.mjs';
    export async function startOwnedIos(options){state.events.push('device-start');
      if(state.mode==='factory-unknown'){const {mkdir,writeFile}=await import('node:fs/promises');await mkdir(options.outputDir);await writeFile(options.outputDir+'/recovery.json','{"status":"manual-inspection-required"}');
        const original=createIosStartupFailure({stage:'device-owned-simulator-boot-started',error:tagIosCommandFailure(Error('IOS_COMMAND_TIMEOUT'),'owned-device-list')});
        const error=retainIosStartupFailure(Error('IOS_DEVICE_CLEANUP_UNCONFIRMED'),original);
        error.capturedText=()=>{if(state.captureThrows)throw Error('FIXTURE_CAPTURE_UNAVAILABLE');return '';};throw error;}
      state.deviceDiagnostics={diagnostics:options.diagnostics??false,prewarmDiagnostics:options.prewarmDiagnostics??false};const binding={schemaVersion:1,scope:'ephemeral-hosted-standard-device-set',
      nativeHome:'/Users/runner',deviceSetPath:'/Users/runner/Library/Developer/CoreSimulator/Devices',privateRoot:'/private/tmp/tld-ios-abc123',
      udid:'FA001122-3344-5566-7788-9900AABBCCDD',nonce:'a'.repeat(24)};
      return {udid:binding.udid,deviceBinding:binding,deviceSetPath:binding.deviceSetPath,derivedDataPath:binding.privateRoot+'/derived-data',
        serverUrl:'http://127.0.0.1:4723',wdaPort:8211,mjpegPort:8212,
        async installApp(){state.events.push('app-install');},async prewarmProofApp(){state.events.push('app-prewarm');return {appPrewarmed:true};},
        async assertOwned(){return true;},async assertWdaPrepared(){state.events.push('wda-check');
          if(++state.wdaChecks===2&&state.failPostReadinessCheck)throw Error('IOS_WDA_ARTIFACT_CHANGED');},
        async close(){state.close++;state.events.push('device-close');
          if(state.statusWriteFails){const {mkdir}=await import('node:fs/promises');await mkdir(${JSON.stringify(path.join(outputDir, 'cleanup-status.json'))});}
          if(state.deviceCloseFails)throw Error('IOS_DEVICE_CLEANUP_UNCONFIRMED');},capturedText(){if(state.captureThrows)throw Error('FIXTURE_CAPTURE_UNAVAILABLE');return '';}};}
  `);
  await file('examples/ios-verification/driver.mjs', stateImport + `
    export class NativeDriverError extends Error{constructor(code){super('FIXTURE_NATIVE_FAILURE');this.code=code;}}
    export function readIosRequestFailure(){return undefined;}
    export function readIosRequestProgress(){return undefined;}
    export function readIosStartupResponse(){return undefined;}
    export async function createNativeDriver(options){state.events.push('installed-driver-create');
      state.privacy={showXcodeLog:options.capabilities['appium:showXcodeLog'],showIOSLog:options.capabilities['appium:showIOSLog'],
        skipLogCapture:options.capabilities['appium:skipLogCapture']};
      if(state.mode==='create-failed')throw Object.assign(Error('private-fixture-native-message'),{code:'NATIVE_DRIVER_SESSION_TIMEOUT'});
      return {context:state.mode==='context-failed'?'WEBVIEW':'NATIVE_APP',
        async scrollIntoView(id){state.events.push('control-visibility:'+id);if(state.mode==='controls-failed'&&id==='quantity')throw new NativeDriverError('NATIVE_DRIVER_ELEMENT_TIMEOUT');},
        async click(id){state.events.push('control-focus:'+id);},async hideKeyboard(){state.events.push('control-keyboard-check');},
        async close(){state.events.push('installed-driver-close');
        if(state.mode==='close-failed')throw Object.assign(Error('private-fixture-native-message'),{code:'NATIVE_DRIVER_TIMEOUT'});}};}
  `);
  for (const name of ['readiness.mjs', 'device-scope.mjs', 'preauth-controls.mjs', 'failure-facts.mjs']) await file('examples/ios-verification/' + name, await readFile(new URL('../' + name, import.meta.url)));
  await file('examples/android-verification/worker-host.mjs', stateImport + `export function runNativeWorker(){
    if(!state.lateStartupFailure)throw Error('WORKER_NOT_EXPECTED');state.events.push('worker-start');
    return {report:{verdict:'blocked',reasonCodes:['NATIVE_DRIVER_SESSION_TIMEOUT'],cases:[]},captured:''};}`);
  await file('examples/android-verification/contracts.mjs', 'export const validateNativePlan=value=>value,sanitizeNativeReport=value=>value,NATIVE_DRIVER_FAILURE_CODES=["NATIVE_DRIVER_SESSION_TIMEOUT","NATIVE_DRIVER_CONTEXT_REFUSED","NATIVE_DRIVER_TIMEOUT","NATIVE_DRIVER_ELEMENT_TIMEOUT","NATIVE_DRIVER_COMMAND_FAILED"];');
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
  return { state, outputDir, options: { consumer: { root, packageRoot, sessionTemp }, appDirectory, toolsRoot: path.join(root, 'tools'), outputDir, preauthControls,
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
      assert.deepEqual(owned.state.deviceDiagnostics, { diagnostics: false, prewarmDiagnostics: true });
      assert.equal(owned.state.events.filter(value => value === 'installed-driver-create').length, 1);
      assert.equal(owned.state.events.filter(value => value === 'installed-driver-close').length, mode === 'create-failed' ? 0 : 1);
      await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
      const summary = await publicIosFailure({ output: owned.outputDir, stage: 'wda-readiness', error });
      assert.equal(summary.stage, 'wda-readiness'); assert.match(summary.code, /^NATIVE_DRIVER_/);
      assert.equal(JSON.stringify(summary).includes('private-fixture-native-message'), false);
    } finally { await owned.close(); }
  }
});

test('explicit fixed-controls probe uses the installed helper before account allocation and retains no values', async () => {
  for (const mode of ['passed', 'controls-failed']) {
    const owned = await fixture(mode, { preauthControls: true });
    try {
      await assert.rejects(runIosProof(owned.options));
      const result = JSON.parse(await readFile(path.join(owned.outputDir, 'preauth-controls.json'), 'utf8'));
      assert.equal(result.completed, mode === 'passed'); assert.equal(result.sessionCleanupAcknowledged, true);
      assert.equal(owned.state.events.filter(value => value === 'installed-driver-close').length, 1);
      assert.equal(owned.state.close, 1);
      if (mode === 'controls-failed') {
        assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.scannedPasswordCount, 0);
        assert.deepEqual(result.steps.at(-1), { controlId: 'quantity', step: 'visibility', completed: false, code: 'NATIVE_DRIVER_ELEMENT_TIMEOUT' });
        assert.equal(owned.state.events.includes('control-focus:quantity'), false);
        await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
      } else {
        assert.equal(result.steps.length, 11);
        assert.ok(owned.state.events.indexOf('control-visibility:session-status') < owned.state.events.indexOf('installed-driver-close'));
        assert.ok(owned.state.events.indexOf('installed-driver-close') < owned.state.events.indexOf('account-backend-start'));
      }
      const text = JSON.stringify(result);
      assert.equal(text.includes(owned.state.cookie), false); assert.equal(text.includes('FA001122'), false);
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
    assert.deepEqual(owned.state.deviceDiagnostics, { diagnostics: false, prewarmDiagnostics: true });
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

test('later authenticated setup failure blocks later phases and requires device settlement before credential cleanup', async () => {
  for (const deviceCloseFails of [false, true]) {
    const owned = await fixture('passed', { lateStartupFailure: true, deviceCloseFails });
    try {
      let failure; await assert.rejects(runIosProof(owned.options), error => { failure = error; return true; });
      const events = owned.state.events;
      assert.equal(events.filter(value => value === 'worker-start').length, 1, 'a failed first phase cannot start fault/corrected workers');
      assert.equal(events.includes('stage:fault'), false); assert.equal(events.includes('stage:corrected'), false);
      assert.equal(owned.state.broker, 1); assert.equal(owned.state.close, 1);
      assert.equal(events.filter(value => value === 'store-delete').length, deviceCloseFails ? 0 : 2);
      assert.equal(events.filter(value => value === 'store-check').length, deviceCloseFails ? 0 : 2);
      assert.equal(events.includes('broker-dispose'), !deviceCloseFails);
      if (deviceCloseFails) {
        assert.equal(failure.message, 'IOS_PROOF_CLEANUP_INCOMPLETE'); assert.equal(failure.preserveConsumer, true);
        const status = JSON.parse(await readFile(path.join(owned.outputDir, 'cleanup-status.json'), 'utf8'));
        assert.ok(status.steps.includes('device-stop')); assert.ok(status.steps.includes('credential-cleanup-deferred'));
      } else assert.ok(events.indexOf('device-close') < events.indexOf('store-delete'));
      await assert.rejects(readFile(path.join(owned.outputDir, 'receipt.json')), { code: 'ENOENT' });
    } finally { await owned.close(); }
  }
});

test('cleanup status write failure cannot erase the preservation flag after unconfirmed device termination', async () => {
  for (const extra of [{ statusWriteFails: true }, { captureThrows: true }]) {
    const owned = await fixture('passed', { lateStartupFailure: true, deviceCloseFails: true, ...extra });
    try {
      await assert.rejects(runIosProof(owned.options), error => error.message === 'IOS_PROOF_CLEANUP_INCOMPLETE' && error.preserveConsumer === true);
      assert.equal(owned.state.events.includes('broker-dispose'), false); assert.equal(owned.state.events.includes('store-delete'), false);
      assert.equal(owned.state.events.includes('store-check'), false);
    } finally { await owned.close(); }
  }
});

test('unconfirmed factory cleanup preserves recovery and consumer before any handle or credentials exist', async () => {
  for (const captureThrows of [false, true]) {
    const owned = await fixture('factory-unknown', { captureThrows });
    try {
      let failure;
      await assert.rejects(runIosProof(owned.options), error => { failure=error; return error.message === 'IOS_PROOF_CLEANUP_INCOMPLETE' && error.preserveConsumer === true; });
      const summary=await publicIosFailure({output:owned.outputDir,stage:'cleanup',error:failure});
      assert.equal(summary.code,'IOS_PROOF_CLEANUP_INCOMPLETE');
      assert.deepEqual(summary.startupFailure,{stage:'device-owned-simulator-boot-started',code:'IOS_COMMAND_TIMEOUT',commandKind:'owned-device-list'});
      assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.close, 0);
      const status = JSON.parse(await readFile(path.join(owned.outputDir, 'cleanup-status.json'), 'utf8'));
      assert.ok(status.steps.includes('device-start'));
      const recovery = JSON.parse(await readFile(path.join(owned.outputDir, 'device/recovery.json'), 'utf8'));
      assert.equal(recovery.status, 'manual-inspection-required');
    } finally { await owned.close(); }
  }
});
