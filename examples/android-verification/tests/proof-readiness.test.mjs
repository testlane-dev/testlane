/** Controller-ordering fixtures only. All native/broker boundaries are doubles; no native acceptance is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {spawn} from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {publicAndroidFailure} from '../failure.mjs';
import {writeNativeProofReceipt} from '../../../scripts/native-proof-support.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const IDs = ['editor-native-total', 'editor-cannot-approve', 'reviewer-native-approval', 'duplicate-approval-unchanged', 'anonymous-denied'];

async function fixture(mode = 'passed', temporaryParent = os.tmpdir()) {
  const root = await realpath(await mkdtemp(path.join(temporaryParent, 'tld-android-readiness-')));
  const packageRoot = path.join(root, 'package'), controllerRoot = path.join(root, 'controller');
  const outputDir = path.join(root, 'output'), sessionTemp = path.join(root, 'sessions'), apkFile = path.join(root, 'proof.apk');
  async function file(base, relative, source) {
    const target = path.join(base, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source);
  }
  const put = (relative, source) => file(packageRoot, relative, source);
  await mkdir(sessionTemp);
  await put('state.mjs', `export const state=${JSON.stringify({ mode, events: [], accounts: 0, broker: 0, driverCloses: 0,
    deviceCloses: 0, seeds: 0, scans: [], workers: [], defect: false })};`);
  const stateUrl = pathToFileURL(path.join(packageRoot, 'state.mjs')).href, stateImport = 'import {state} from ' + JSON.stringify(stateUrl) + ';\n';
  const controller = await readFile(new URL('../../../scripts/android-proof.mjs', import.meta.url));
  // Execute the exact production controller bytes. Only its dependency modules
  // are fixture substitutes, so tests work without a supported native keychain.
  await file(controllerRoot, 'scripts/android-proof.mjs', controller);
  assert.equal(sha(await readFile(path.join(controllerRoot, 'scripts/android-proof.mjs'))), sha(controller));
  await file(controllerRoot, 'scripts/native-proof-support.mjs', await readFile(new URL('../../../scripts/native-proof-support.mjs', import.meta.url)));
  for(const name of ['failure.mjs','contracts.mjs','proof-cases.mjs'])await file(controllerRoot,'examples/android-verification/'+name,await readFile(new URL('../'+name,import.meta.url)));
  await file(controllerRoot, 'examples/playwright/tests/consumer.mjs', stateImport + `
    export function consumerProject(){throw Error('FIXTURE_CONSUMER_NOT_EXPECTED');}
    export function assertNoLeaks(text,secrets){state.scans.push(secrets.length);}
  `);
  await file(controllerRoot, 'examples/workflows/test-support/real-broker.mjs', stateImport + `
    export function realBrokerSupport(){return {supported:true,store:'fixture-only'};}
    export async function createRealBrokerHarness(){state.broker++;state.events.push('broker-start');
      return {env:{},async auditText(){return '';},async dispose(){state.events.push('broker-dispose');}};}
  `);
  await put('examples/verification-demo/app.mjs', stateImport + `
    export async function startDemoApp({accounts}){state.accounts++;state.events.push('account-backend-start');
      state.roles=Object.values(accounts).map(account=>account.role);
      if(state.mode==='backend-failed')throw Error('private-backend-canary');
      return {origin:'http://127.0.0.1:42999',setDefect(value){state.defect=value;},records(){if(state.mode==='worker-device-records-uncertain')throw Error('FIXTURE_RECORDS_UNAVAILABLE');return [];},
        issuedSessionTokens(){return [];},async close(){state.events.push('backend-close');}};}
  `);
  await put('examples/verification-demo/native.mjs', stateImport + `
    import {writeFile} from 'node:fs/promises';
    import {randomBytes} from 'node:crypto';
    export async function runDemoChild({args,input}){
      if(args[0]==='store'&&args[1]==='set'){state.seeds++;state.events.push('store-set');if(typeof input!=='string')throw Error('FIXTURE_STDIN_REQUIRED');}
      if(args[0]==='store'&&args[1]==='delete')state.events.push('store-delete');
      if(args[0]==='check')state.events.push('store-check');
      if(args[0]==='session')await writeFile(args[args.indexOf('--out')+1],JSON.stringify({cookies:[{name:'tldemo_session',value:randomBytes(24).toString('base64url')}]}));
      return {code:args[0]==='check'?4:0,stdout:'',stderr:''};}
  `);
  await put('examples/android-verification/device.mjs', stateImport + `
    import {mkdir,rmdir,writeFile} from 'node:fs/promises';
    import path from 'node:path';
    export async function startOwnedAndroid(options){state.events.push('device-start');
      if(['factory-cleanup-failed','factory-cleanup-diagnostics-failed','factory-cleanup-status-failed'].includes(state.mode)){
        await mkdir(options.outputDir,{recursive:true});
        await writeFile(path.join(options.outputDir,'android-device-recovery.json'),JSON.stringify({status:'manual-inspection-required',retainedOwnedState:true}));
        if(state.mode==='factory-cleanup-status-failed')await mkdir(path.join(path.dirname(options.outputDir),'cleanup-status.json'));
        const error=Error('ANDROID_DEVICE_CLEANUP_UNCONFIRMED');
        Object.defineProperty(error,'capturedText',{value:()=>{
          if(state.mode==='factory-cleanup-diagnostics-failed')throw Error('private-diagnostics-canary');
          return 'private-factory-preauth-canary';}});throw error;
      }
      return {
      serial:'emulator-5556',serverUrl:'http://127.0.0.1:4723',adbPort:5039,systemPort:8211,versions:{fixture:true},
      async installApk(){state.events.push('app-install');if(state.mode==='install-failed')throw Error('private-install-canary');},
      async assertOwned(){return true;},async adb(){state.events.push('adb-reverse');return {code:0};},
      async close(){state.deviceCloses++;state.events.push('device-close');
        if(state.mode==='worker-device-status-uncertain')await mkdir(path.join(path.dirname(options.outputDir),'cleanup-status.json'));
        if(state.mode==='worker-device-recovery-uncertain')await rmdir(path.join(path.dirname(options.outputDir),'recovery'));
        if(state.mode==='close-and-device-failed'||state.mode.startsWith('worker-device-'))throw Error('ANDROID_PROCESS_TERMINATION_UNCONFIRMED');},
      capturedText(){if(state.mode==='worker-device-capture-uncertain')throw Error('FIXTURE_CAPTURE_UNAVAILABLE');
        return state.mode==='capture-overflow'?'x'.repeat(8*1024*1024+1):'private-preauth-native-canary';}};}
  `);
  await put('examples/android-verification/driver.mjs', stateImport + `
    import {writeFile} from 'node:fs/promises';
    export class NativeDriverError extends Error{constructor(code){super('private-native-error-canary');this.code=code;}}
    export async function createNativeDriver(options){state.events.push('installed-driver-create');state.installedCaps=options.capabilities;state.installedUrl=options.url;
      if(state.mode==='create-failed')throw new NativeDriverError('NATIVE_DRIVER_SESSION_TIMEOUT');
      return {context:state.mode==='context-failed'?'WEBVIEW':'NATIVE_APP',async waitFor(id){state.events.push('installed-driver-wait');state.waitId=id;
        if(state.mode==='wait-failed')throw new NativeDriverError('NATIVE_DRIVER_READINESS_TIMEOUT');},
        async close(){state.driverCloses++;state.events.push('installed-driver-close');
          if(state.mode==='close-failed'||state.mode==='close-and-device-failed')throw new NativeDriverError('NATIVE_DRIVER_TIMEOUT');
          if(state.mode==='cancel-close')state.aborter.abort();
          if(state.mode==='artifact-drift')await writeFile(new URL('../../state.mjs',import.meta.url),'// mutated owned fixture');}};}
  `);
  await put('examples/android-verification/readiness.mjs', await readFile(new URL('../readiness.mjs', import.meta.url)));
  const driverCodes = ['NATIVE_DRIVER_CONFIGURATION_INVALID', 'NATIVE_DRIVER_SESSION_TIMEOUT', 'NATIVE_DRIVER_CONTEXT_REFUSED', 'NATIVE_DRIVER_TIMEOUT',
    'NATIVE_DRIVER_READINESS_TIMEOUT', 'NATIVE_DRIVER_COMMAND_FAILED'];
  await put('examples/android-verification/contracts.mjs', `export const validateNativePlan=value=>value,sanitizeNativeReport=value=>value,NATIVE_DRIVER_FAILURE_CODES=${JSON.stringify(driverCodes)};`);
  await put('examples/android-verification/proof-cases.mjs', `export const APPROVAL_REQUIREMENTS=${JSON.stringify(IDs.map(id => ({ id })))};`);
  await put('examples/android-verification/budgets.mjs', 'export const NATIVE_PROOF_BUDGETS={workerMs:600000};');
  await put('examples/android-verification/worker-host.mjs', stateImport + `
    export async function runNativeWorker({plan,driverOptions}){state.events.push('worker-start');state.workers.push({
      sameCaps:driverOptions.capabilities===state.installedCaps,sameUrl:driverOptions.url===state.installedUrl,
      frozenOptions:Object.isFrozen(driverOptions),frozenCaps:Object.isFrozen(driverOptions.capabilities)});
      if(state.mode==='worker-failed')throw Error('private-worker-canary');
      if(state.mode.startsWith('worker-device-'))throw Error('NATIVE_WORKER_TERMINATION_UNCONFIRMED');
      return {report:{verdict:state.defect?'failed':'passed',reasonCodes:[],cases:plan.cases.map(row=>{
        const failed=state.defect&&['editor-native-total','reviewer-native-approval'].includes(row.id);
        return {id:row.id,status:failed?'failed':'passed',reason:failed?'NATIVE_ASSERTION_FAILED':undefined,attempts:1,
          bodyAssertionsObserved:1,cleanup:{status:row.cleanup.required?'completed':'not-required'}};})}};}
  `);
  const publicSourceSHA256 = {};
  for (const name of ['package.json', 'package-lock.json', 'app.config.cjs', 'index.js', 'App.js', 'bootstrap.mjs', 'plugins/withProofBuild.cjs']) {
    const source = 'synthetic controller fixture: ' + name; await put('examples/mobile-approval-app/' + name, source); publicSourceSHA256[name] = sha(source);
  }
  await writeFile(apkFile, 'synthetic test bytes; not an APK');
  await writeFile(path.join(root, 'build-manifest.json'), JSON.stringify({ package: 'dev.testlane.androidproof', proofOnly: true,
    embeddedBundle: true, debuggable: true, architecture: 'x86_64', apkSHA256: sha(await readFile(apkFile)), publicSourceSHA256 }));
  const { state } = await import(stateUrl), { runAndroidProof } = await import(pathToFileURL(path.join(controllerRoot, 'scripts/android-proof.mjs')).href);
  const aborter = new AbortController(); state.aborter = aborter;
  return { state, root, outputDir, run: () => runAndroidProof({ consumer: { root, packageRoot, sessionTemp, brokerCli: path.join(packageRoot, 'fake-cli.mjs') },
    apkFile, outputDir, toolsRoot: path.join(root, 'tools'), sdkRoot: path.join(root, 'sdk'), javaHome: path.join(root, 'java'),
    systemImagePath: path.join(root, 'image'), signal: aborter.signal, onStage: value => {
      state.events.push('stage:' + value);
      if(state.mode==='allocation-failed'&&value==='credential-allocation')throw Error('private-allocation-canary');
    } }),
    async runMain(){
      await file(controllerRoot,'examples/playwright/tests/consumer.mjs',stateImport+`
        import {writeFile} from 'node:fs/promises';
        export async function consumerProject(){return {...${JSON.stringify({root,packageRoot,sessionTemp,brokerCli:path.join(packageRoot,'fake-cli.mjs')})},
          dispose:async()=>writeFile(${JSON.stringify(path.join(root,'consumer-disposed'))},'disposed')};}
        export function assertNoLeaks(text,secrets){state.scans.push(secrets.length);}
      `);
      return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(controllerRoot,'scripts/android-proof.mjs'),'--apk',apkFile,'--output-dir',outputDir,
          '--tools-root',path.join(root,'tools'),'--sdk-root',path.join(root,'sdk'),'--java-home',path.join(root,'java')],
          {shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',part=>{stdout+=part;});child.stderr.on('data',part=>{stderr+=part;});
        const timer=setTimeout(()=>{child.kill();reject(Error('FIXTURE_NODE_TIMEOUT'));},5000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
      });
    },
    close: () => rm(root, { recursive: true, force: true }) };
}

test('controller blocks passwords/backend/broker/bootstrap on failed create, context, readiness, close, cancellation or artifact recheck', async () => {
  for (const mode of ['create-failed', 'context-failed', 'wait-failed', 'close-failed', 'cancel-close', 'artifact-drift']) {
    const owned = await fixture(mode);
    try {
      await assert.rejects(owned.run());
      assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.seeds, 0);
      assert.deepEqual(owned.state.scans, [0], 'preauth diagnostics observes no allocated account passwords');
      assert.equal(owned.state.events.includes('adb-reverse'), false); assert.equal(owned.state.workers.length, 0);
      assert.equal(owned.state.driverCloses, mode === 'create-failed' ? 0 : 1); assert.equal(owned.state.deviceCloses, 1);
      await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(owned.outputDir, 'preauth-device.log'), 'utf8'), 'private-preauth-native-canary');
      const fixed = await readFile(path.join(owned.outputDir, 'readiness-failure.json'), 'utf8');
      assert.equal(fixed.includes('private-'), false); assert.equal(fixed.includes('emulator-'), false);
      assert.equal(JSON.parse(fixed).stage, 'android-readiness');
      assert.equal((await readdir(path.join(owned.outputDir, 'recovery'))).length, 0);
    } finally { await owned.close(); }
  }
});

test('uncertain authenticated native teardown preserves credential state and consumer even if diagnostic/status writes fail', async () => {
  for (const mode of ['worker-device-uncertain','worker-device-capture-uncertain','worker-device-status-uncertain','worker-device-recovery-uncertain','worker-device-records-uncertain']) {
    const owned = await fixture(mode);
    try {
      let failure;
      await assert.rejects(owned.run(), error => {failure=error;return error.message === 'ANDROID_PROOF_CLEANUP_INCOMPLETE' && error.preserveConsumer === true;});
      const summary=await publicAndroidFailure({output:owned.outputDir,stage:'cleanup',error:failure});
      assert.deepEqual(summary.originalFailure,{stage:'positive',code:'NATIVE_WORKER_TERMINATION_UNCONFIRMED'});
      assert.equal(summary.code,'ANDROID_PROOF_CLEANUP_INCOMPLETE');
      assert.equal(owned.state.seeds, 2); assert.equal(owned.state.workers.length, 1);
      assert.equal(owned.state.events.includes('stage:fault'), false); assert.equal(owned.state.events.includes('stage:corrected'), false);
      assert.equal(owned.state.events.includes('store-delete'), false); assert.equal(owned.state.events.includes('store-check'), false);
      assert.equal(owned.state.events.includes('broker-dispose'), false); assert.equal(owned.state.events.includes('backend-close'), true);
      await assert.rejects(readFile(path.join(owned.outputDir, 'receipt.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(owned.outputDir, 'preauth-device.log')), { code: 'ENOENT' });
      if (mode !== 'worker-device-status-uncertain') {
        const status = JSON.parse(await readFile(path.join(owned.outputDir, 'cleanup-status.json'), 'utf8'));
        assert.ok(status.steps.includes('device-stop')); assert.ok(status.steps.includes('credential-cleanup-deferred'));
      }
    } finally { await owned.close(); }
  }
});

test('pre-aborted controller allocates neither an output nor any native or credential resource', async () => {
  const owned = await fixture();
  try {
    owned.state.aborter.abort();
    await assert.rejects(owned.run(), { name: 'AbortError' });
    assert.deepEqual(owned.state.events, []); assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0);
    assert.equal(owned.state.driverCloses, 0); assert.equal(owned.state.deviceCloses, 0);
    await assert.rejects(readdir(owned.outputDir), { code: 'ENOENT' });
  } finally { await owned.close(); }
});

test('an unacknowledged session close plus uncertain factory teardown retains recovery and cannot open credentials', async () => {
  const owned = await fixture('close-and-device-failed');
  try {
    await assert.rejects(owned.run(), error => error.message === 'ANDROID_PROOF_CLEANUP_INCOMPLETE' && error.preserveConsumer === true);
    assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.seeds, 0);
    assert.equal(owned.state.driverCloses, 1); assert.equal(owned.state.deviceCloses, 1);
    const cleanup = JSON.parse(await readFile(path.join(owned.outputDir, 'cleanup-status.json'), 'utf8'));
    assert.equal(cleanup.status, 'incomplete'); assert.deepEqual(cleanup.steps, ['device-stop']); assert.equal(cleanup.consumerRoot, owned.root);
    const failure = JSON.parse(await readFile(path.join(owned.outputDir, 'readiness-failure.json'), 'utf8'));
    assert.equal(failure.code, 'NATIVE_DRIVER_TIMEOUT');
    await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'receipt.json')), { code: 'ENOENT' });
  } finally { await owned.close(); }
});

test('factory cleanup uncertainty before a returned handle preserves consumer and recovery without unknown device operations', async () => {
  for (const mode of ['factory-cleanup-failed', 'factory-cleanup-diagnostics-failed']) {
    const owned = await fixture(mode);
    try {
    await assert.rejects(owned.run(), error => error.message === 'ANDROID_PROOF_CLEANUP_INCOMPLETE' && error.preserveConsumer === true);
    assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.seeds, 0);
    assert.equal(owned.state.driverCloses, 0); assert.equal(owned.state.deviceCloses, 0);
    assert.deepEqual(owned.state.events, ['stage:owned-device-start', 'device-start', 'stage:cleanup']);
    const cleanup = JSON.parse(await readFile(path.join(owned.outputDir, 'cleanup-status.json'), 'utf8'));
    assert.equal(cleanup.status, 'incomplete'); assert.deepEqual(cleanup.steps, ['device-start']); assert.equal(cleanup.consumerRoot, owned.root);
    const recovery = JSON.parse(await readFile(path.join(owned.outputDir, 'device/android-device-recovery.json'), 'utf8'));
    assert.deepEqual(recovery, { status: 'manual-inspection-required', retainedOwnedState: true });
    if (mode === 'factory-cleanup-failed') assert.equal(await readFile(path.join(owned.outputDir, 'preauth-device.log'), 'utf8'), 'private-factory-preauth-canary');
    else await assert.rejects(readFile(path.join(owned.outputDir, 'preauth-device.log')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'receipt.json')), { code: 'ENOENT' });
    } finally { await owned.close(); }
  }
});

test('cleanup metadata write failure cannot replace the flagged preserved error or remove owned factory recovery', async () => {
  const owned = await fixture('factory-cleanup-status-failed');
  try {
    await assert.rejects(owned.run(), error => error.message === 'ANDROID_PROOF_CLEANUP_INCOMPLETE' && error.preserveConsumer === true);
    assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.seeds, 0);
    assert.equal(owned.state.driverCloses, 0); assert.equal(owned.state.deviceCloses, 0);
    assert.deepEqual(await readdir(path.join(owned.outputDir, 'cleanup-status.json')), [], 'fixture forces the exact status path to reject writeFile');
    const recovery = JSON.parse(await readFile(path.join(owned.outputDir, 'device/android-device-recovery.json'), 'utf8'));
    assert.deepEqual(recovery, { status: 'manual-inspection-required', retainedOwnedState: true });
    await assert.rejects(readFile(path.join(owned.outputDir, 'readiness.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'receipt.json')), { code: 'ENOENT' });
  } finally { await owned.close(); }
});

test('controller reuses identical immutable options after acknowledged close and records readiness separately from final device teardown', async () => {
  const owned = await fixture();
  try {
    const receipt = await owned.run(), events = owned.state.events;
    assert.ok(events.indexOf('installed-driver-create') < events.indexOf('installed-driver-wait'));
    assert.ok(events.indexOf('installed-driver-wait') < events.indexOf('installed-driver-close'));
    assert.ok(events.indexOf('installed-driver-close') < events.indexOf('account-backend-start'));
    assert.ok(events.indexOf('account-backend-start') < events.indexOf('broker-start'));
    assert.equal(owned.state.waitId, 'session-status'); assert.equal(owned.state.driverCloses, 1); assert.equal(owned.state.deviceCloses, 1);
    assert.equal(owned.state.accounts, 1); assert.equal(owned.state.broker, 1); assert.equal(owned.state.seeds, 2);
    assert.deepEqual(owned.state.roles, ['Editor', 'Reviewer']);
    assert.deepEqual(owned.state.workers, Array.from({ length: 3 }, () => ({ sameCaps: true, sameUrl: true, frozenOptions: true, frozenCaps: true })));
    const record = JSON.parse(await readFile(path.join(owned.outputDir, 'readiness.json'), 'utf8'));
    assert.deepEqual(record, receipt.androidReadiness); assert.equal(record.sessionCleanup, 'deleted');
    assert.equal(record.appReadinessObserved, true); assert.equal(Object.hasOwn(record, 'deviceCleanup'), false); assert.equal(Object.hasOwn(record, 'cleanupVerified'), false);
    assert.equal(receipt.cleanupVerified, true); assert.equal(receipt.credentialLeakScanPassed, true);
    await assert.rejects(readFile(path.join(owned.outputDir, 'preauth-device.log')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'readiness-failure.json')), { code: 'ENOENT' });
  } finally { await owned.close(); }
});

test('controller fixture canonicalizes an owned temporary alias while the production receipt writer still refuses raw aliases', { timeout: 10000 }, async () => {
  const parent = await realpath(os.tmpdir()), container = await mkdtemp(path.join(parent, 'tld-readiness-alias-'));
  const target = path.join(container, 'target'), alias = path.join(container, 'alias');
  let owned, linked = false;
  try {
    await mkdir(target); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); linked = true;
    const rawOutput = path.join(target, 'raw-output'); await mkdir(rawOutput);
    const aliasedOutput = path.join(alias, 'raw-output');
    assert.notEqual(aliasedOutput, await realpath(aliasedOutput));
    await assert.rejects(writeNativeProofReceipt({ outputDir: aliasedOutput,
      receipt: { passed: true, cleanupVerified: true, credentialLeakScanPassed: true }, cancelCode: 'ANDROID_CANCELLED' }),
      error => error.message === 'NATIVE_PROOF_FINALIZATION_FAILED');
    await assert.rejects(readFile(path.join(rawOutput, 'receipt.json')), { code: 'ENOENT' });
    owned = await fixture('passed', alias);
    const receipt = await owned.run();
    assert.equal(owned.root, await realpath(owned.root)); assert.equal(path.dirname(owned.root), target);
    assert.equal(receipt.passed, true); assert.equal(receipt.cleanupVerified, true); assert.equal(receipt.credentialLeakScanPassed, true);
    assert.equal(receipt.androidReadiness.sessionCleanup, 'deleted'); assert.equal(owned.state.deviceCloses, 1);
    assert.equal(owned.state.workers.length, 3);
    assert.ok(owned.state.events.indexOf('installed-driver-close') < owned.state.events.indexOf('account-backend-start'));
    assert.equal(JSON.parse(await readFile(path.join(owned.outputDir, 'receipt.json'), 'utf8')).passed, true);
  } finally {
    if (owned) {
      assert.equal(path.dirname(await realpath(owned.root)), target); await owned.close();
    }
    if (linked) {
      assert.equal((await lstat(alias)).isSymbolicLink(), true); assert.equal(await realpath(alias), target);
      await rm(alias, { recursive: false });
    }
    assert.equal(path.dirname(container), parent); assert.ok(path.basename(container).startsWith('tld-readiness-alias-'));
    assert.equal(await realpath(container), container); assert.equal((await lstat(container)).isSymbolicLink(), false);
    await rm(container, { recursive: true, force: true });
    await assert.rejects(lstat(container), { code: 'ENOENT' });
  }
});

test('raw diagnostic allocation boundary excludes even an early backend failure after password creation, and all worker failures', async () => {
  for (const mode of ['backend-failed', 'worker-failed']) {
    const owned = await fixture(mode);
    try {
      await assert.rejects(owned.run());
      assert.equal(owned.state.accounts, 1); assert.equal(owned.state.driverCloses, 1); assert.equal(owned.state.deviceCloses, 1);
      await assert.rejects(readFile(path.join(owned.outputDir, 'preauth-device.log')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(owned.outputDir, 'readiness-failure.json')), { code: 'ENOENT' });
    } finally { await owned.close(); }
  }
});

test('preauth diagnostic permission is revoked before allocation begins even when accounts stays empty', async () => {
  const owned = await fixture('allocation-failed');
  try {
    await assert.rejects(owned.run(), /private-allocation-canary/);
    assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.seeds, 0);
    assert.equal(owned.state.driverCloses, 1); assert.equal(owned.state.deviceCloses, 1);
    assert.ok(owned.state.events.includes('stage:credential-allocation'));
    assert.deepEqual(owned.state.scans, [], 'revoked logging does not inspect or retain the native buffer');
    assert.equal(JSON.parse(await readFile(path.join(owned.outputDir, 'readiness.json'), 'utf8')).sessionCleanup, 'deleted');
    await assert.rejects(readFile(path.join(owned.outputDir, 'preauth-device.log')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'readiness-failure.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(owned.outputDir, 'receipt.json')), { code: 'ENOENT' });
  } finally { await owned.close(); }
});

test('pre-readiness native failure capture stays credential-free and the existing eight-MiB limit is not expanded', async () => {
  for (const mode of ['install-failed', 'capture-overflow']) {
    const owned = await fixture(mode);
    try {
      if (mode === 'capture-overflow') {
        // Fail the first client constructor after the fixture factory allocates
        // its bounded-capture scenario, without starting real native processes.
        owned.state.mode = 'create-failed';
        const source = path.join(owned.root, 'package/examples/android-verification/device.mjs');
        await writeFile(source, (await readFile(source, 'utf8')).replace("state.mode==='capture-overflow'", 'true'));
      }
      await assert.rejects(owned.run()); assert.equal(owned.state.accounts, 0); assert.equal(owned.state.broker, 0); assert.equal(owned.state.deviceCloses, 1);
      if (mode === 'capture-overflow') await assert.rejects(readFile(path.join(owned.outputDir, 'preauth-device.log')), { code: 'ENOENT' });
      else assert.equal(await readFile(path.join(owned.outputDir, 'preauth-device.log'), 'utf8'), 'private-preauth-native-canary');
    } finally { await owned.close(); }
  }
});

test('actual controller main writes only fixed failure evidence and keeps consumer preservation after unknown factory cleanup',async()=>{
  for(const mode of ['create-failed','factory-cleanup-failed']){
    const owned=await fixture(mode);
    try{
      const result=await owned.runMain();assert.equal(result.code,1);
      const summary=JSON.parse(await readFile(path.join(owned.outputDir,'public-failure.json'),'utf8'));
      assert.equal(summary.code,mode==='create-failed'?'NATIVE_DRIVER_SESSION_TIMEOUT':'ANDROID_PROOF_CLEANUP_INCOMPLETE');
      assert.equal(summary.stage,mode==='create-failed'?'android-readiness':'cleanup');
      assert.deepEqual(summary.originalFailure,{stage:mode==='create-failed'?'android-readiness':'owned-device-start',
        code:mode==='create-failed'?'NATIVE_DRIVER_SESSION_TIMEOUT':'ANDROID_DEVICE_CLEANUP_UNCONFIRMED'});
      assert.deepEqual(summary.reports,[]);
      for(const text of [JSON.stringify(summary),result.stdout,result.stderr])assert.equal(text.includes('private-'),false);
      if(mode==='factory-cleanup-failed')await assert.rejects(readFile(path.join(owned.root,'consumer-disposed')),{code:'ENOENT'});
      else assert.equal(await readFile(path.join(owned.root,'consumer-disposed'),'utf8'),'disposed');
    }finally{await owned.close();}
  }
});
