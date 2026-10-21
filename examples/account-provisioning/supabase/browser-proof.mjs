#!/usr/bin/env node
/** Source-only form-post browser lifecycle; never a hosted-project provisioning tool. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerProject, assertNoLeaks } from '../../playwright/tests/consumer.mjs';
import { createRealBrokerHarness, realBrokerSupport } from '../../workflows/test-support/real-broker.mjs';
import { runDemoChild } from '../../verification-demo/native.mjs';
import { createProvisioner } from '../controller.mjs';
import { canonical, emailFor, reviewedSupabasePolicy } from '../contracts.mjs';
import { installedTreeHash } from '../proof.mjs';
import { finalizeProvisioningProof } from '../proof-finalization.mjs';
import { disposePrivateProofDirectories } from './proof.mjs';
import { startSupabaseProvisioningApp } from './app.mjs';
import { startOwnedSupabase } from './runtime.mjs';
import { createPrivateRuntimeDirectory } from './tools/private-directory.mjs';
import { readBrowserGate, writeBrowserGate } from './browser-gate.mjs';
import { prepareBrowserSuite } from './browser-suite.mjs';
import { startOwnedBrowserServer } from './browser-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..', '..', '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FILES = ['examples/account-provisioning/contracts.mjs', 'examples/account-provisioning/controller.mjs',
  'examples/account-provisioning/app.mjs', 'examples/account-provisioning/proof.mjs', 'examples/account-provisioning/proof-finalization.mjs',
  ...['app.mjs','authority.mjs','runtime.mjs','request-drain.mjs','nextauth-app.mjs','ledger.sql','proof.mjs','browser-proof.mjs',
    'browser-fixture.mjs','browser-gate.mjs','browser-suite.mjs','browser-server.mjs','browser.spec.mjs',
    'tools/package.json','tools/package-lock.json','tools/setup.mjs','tools/process.mjs','tools/private-directory.mjs']
    .map(file => 'examples/account-provisioning/supabase/' + file),
  'examples/verification-demo/native.mjs', 'examples/playwright/tests/consumer.mjs', 'examples/playwright/fixtures.mjs',
  'examples/agent-verification/authoring.mjs', 'examples/workflows/test-support/real-broker.mjs'];
const sources = async () => Object.fromEntries(await Promise.all(FILES.map(async file => [file, sha(await readFile(path.join(REPO, file)))])));
async function textTree(root) {
  let result = '';
  for (const item of await readdir(root, { withFileTypes: true })) {
    assert.equal(item.isSymbolicLink(), false);
    const file = path.join(root, item.name);
    if (item.isDirectory()) result += await textTree(file); else if (item.isFile()) result += (await readFile(file)).toString('utf8') + '\n';
  }
  return result;
}
function checkedReport(result, injected, expected) {
  const report = JSON.parse(result.stdout), item = report.cases?.[0];
  assert.equal(result.code, injected ? 1 : 0); assert.equal(report.verdict, injected ? 'failed' : 'passed');
  assert.deepEqual(report.reasonCodes, []); assert.deepEqual(report.diagnostics, []);
  assert.equal(report.cases.length, 1); assert.equal(item.id, 'provisioned-browser-lifecycle');
  assert.equal(item.status, injected ? 'failed' : 'passed'); assert.equal(item.attempts, 1);
  assert.equal(item.cleanup.required, true); assert.equal(item.cleanup.status, 'completed'); assert.ok(item.assertionsObserved > 20);
  assert.deepEqual(report.execution, { exitCode: injected ? 1 : 0, cancelled: false, forced: false });
  assert.equal(report.plan.sha256, expected.planSha256);
  assert.deepEqual(report.specs, [{ id: expected.specId, sha256: expected.specSha256 }]); assert.equal(item.specId, expected.specId);
  if (injected) { assert.equal(item.reason, 'CASE_FAILED'); assert.equal(item.diagnostic.code, 'ASSERTION_FAILED');
    assert.equal(item.failureLocation?.line, expected.injectionLine);
    assert.ok(Number.isSafeInteger(item.failureLocation.column) && item.failureLocation.column >= expected.injectionColumnStart && item.failureLocation.column <= expected.injectionColumnEnd); }
  else { assert.equal(item.reason, 'CASE_PASSED'); assert.equal(item.diagnostic, undefined); }
  return { verdict: report.verdict, attempts: item.attempts, assertionsObserved: item.assertionsObserved,
    cleanup: item.cleanup.status, injectedAssertionFailure: injected };
}
export async function runSupabaseBrowserProof({ toolsRoot, outputDir, signal, onStage = () => {} } = {}) {
  signal?.throwIfAborted();
  assert.ok(!['DEBUG','PWDEBUG','NODE_DEBUG'].some(key=>process.env[key]), 'disable debug logging before the browser lifecycle proof');
  const support = realBrokerSupport(); assert.ok(support.supported, 'requires Windows DPAPI or explicitly isolated Linux Secret Service');
  assert.ok(typeof outputDir === 'string' && path.isAbsolute(outputDir));
  const output = path.resolve(outputDir), parent = path.dirname(output);
  assert.equal(await realpath(parent), parent); assert.equal((await lstat(parent)).isSymbolicLink(), false);
  await createPrivateRuntimeDirectory(output, { signal });
  await writeFile(path.join(output, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  const sourceHashes = await sources(), releaseId = sha(canonical(sourceHashes));
  const runIds = [randomUUID(), randomUUID(), randomUUID()], namespace = 'browser-' + randomBytes(8).toString('hex');
  const profileFor = (index, role) => namespace + ':testing:p' + index + ':' + role.toLowerCase();
  const credentials = [], endpoints = [], attempted = new Set(), handles = [], providerSessions = new Map(), runs = [];
  const cleanupFailures = new Set(); let cleanupFailed = false, terminationConfirmed = true, accountCleanupConfirmed = false;
  let runtime, app, manager, consumer, harness, env, before, receipt, failure, sessionRoot, scratchRoot, browserRoot, browser, activeRunner, activeAbort;
  let captured = '', stage = 'setup', restore = () => {};
  const at = value => { stage = value; onStage(value); };
  const issue = code => { cleanupFailed = true; cleanupFailures.add(code); };
  const execute = async (args, options = {}) => {
    try {
      const result = await runDemoChild({ entry: consumer.brokerCli, args, cwd: consumer.root, env, timeoutMs: 35_000, signal, ...options });
      captured += result.stdout + result.stderr; return result;
    } catch (error) {
      if (error?.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') terminationConfirmed = false;
      throw error;
    }
  };
  try {
    at('private-directories'); sessionRoot = await createPrivateRuntimeDirectory(path.join(output, 'sessions'), { signal });
    scratchRoot = await createPrivateRuntimeDirectory(path.join(output, 'scratch'), { signal });
    browserRoot = await createPrivateRuntimeDirectory(path.join(output, 'browser'), { signal });
    const previous = ['TMP','TEMP','TMPDIR','NODE_DISABLE_COMPILE_CACHE'].map(key => [key, Object.hasOwn(process.env, key), process.env[key]]);
    for (const key of ['TMP','TEMP','TMPDIR']) process.env[key] = scratchRoot; process.env.NODE_DISABLE_COMPILE_CACHE = '1';
    restore = () => { for (const [key, present, value] of previous) { if (present) process.env[key] = value; else delete process.env[key]; } };
    at('installed-broker'); consumer = await consumerProject({ tarball: process.env.TESTLANE_PACKAGE_TARBALL }); before = await installedTreeHash(consumer.packageRoot);
    for (const file of ['examples/verification-demo/native.mjs','examples/playwright/fixtures.mjs','examples/agent-verification/authoring.mjs'])
      assert.equal(sha(await readFile(path.join(consumer.packageRoot, file))), sourceHashes[file]);
    assert.equal(await lstat(path.join(consumer.packageRoot, 'examples/account-provisioning')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
    at('owned-local-supabase'); runtime = await startOwnedSupabase({ toolsRoot, outputDir: path.join(output, 'runtime'), signal });
    const control = await runtime.signInControl(); assert.equal(control.status, 200);
    app = await startSupabaseProvisioningApp({ runtime, releaseId });
    manager = await createProvisioner({ app, root: path.join(output, 'state'), policy: reviewedSupabasePolicy(app.target, releaseId) });
    const registry = { version: 1, profiles: Object.fromEntries(runIds.flatMap((runId, index) => ['Editor','Reviewer'].map(role => [profileFor(index, role), {
      app: 'testlane-browser-provisioning-proof', environment: 'testing', baseUrl: app.origin, strategy: 'form-post',
      account: { email: emailFor(runId, role), role }, session: { ttlMinutes: 10 },
      options: { loginPath: '/api/login', bodyFormat: 'json', fields: '{"email":"{{email}}","password":"{{secret}}"}',
        sessionCookieName: 'tlp_supabase_session', mePath: '/api/me', emailField: 'email', roleField: 'role' },
    }]))) };
    harness = await createRealBrokerHarness({ brokerCli: consumer.brokerCli, registry, support });
    env = { ...harness.env, DEBUG: '', NODE_DEBUG: '', PWDEBUG: '', TMP: sessionRoot, TEMP: sessionRoot, TMPDIR: sessionRoot,
      PWTEST_CACHE_DIR: path.join(output, 'playwright-cache'), NODE_DISABLE_COMPILE_CACHE: '1' }; delete env.NODE_OPTIONS; delete env.FORCE_COLOR;
    const suite = await prepareBrowserSuite(consumer, app.origin), planSha256 = sha(await readFile(suite.planFile)), specBytes = await readFile(suite.specFile), specSha256 = sha(specBytes);
    const copiedHashes = Object.fromEntries(await Promise.all([
      ['fixtures.mjs',path.join(consumer.packageRoot,'examples/playwright/fixtures.mjs')],
      ['testlane-authoring.mjs',path.join(consumer.packageRoot,'examples/agent-verification/authoring.mjs')],
      ['browser-gate.mjs',path.join(HERE,'browser-gate.mjs')],['browser.spec.mjs',path.join(HERE,'browser.spec.mjs')],
    ].map(async ([file,original])=>[file,sha(await readFile(original))])));
    const assertCopied = async () => { for(const [file,digest] of Object.entries(copiedHashes)) assert.equal(sha(await readFile(path.join(suite.directory,file))),digest); };
    await assertCopied();
    const injectionLines = specBytes.toString('utf8').split('\n').flatMap((line, index) => line.includes("expect(config.injectBodyFailure === false,") ? [index + 1] : []);
    assert.equal(injectionLines.length, 1);
    const injectionSource = specBytes.toString('utf8').split('\n')[injectionLines[0] - 1];
    const expected = { planSha256, specSha256, specId: sha('e2e/provisioning/browser.spec.mjs'), injectionLine: injectionLines[0],
      injectionColumnStart: injectionSource.indexOf('expect(') + 1, injectionColumnEnd: injectionSource.length + 1 };
    for (const [index, injected] of [[0,false],[1,true],[2,false]]) {
      signal?.throwIfAborted();
      at('browser-start-p' + index); browser = await startOwnedBrowserServer({ consumerRoot: consumer.root, temporaryRoot: browserRoot, signal }); endpoints.push(browser.endpoint);
      at('create-and-seed-p' + index);
      const handle = await manager.beginRun({ runId: runIds[index], releaseId }); handles.push(handle);
      for (const role of ['Editor','Reviewer']) {
        await manager.createAccount(handle, role, async credential => {
          credentials.push(credential); const profile = profileFor(index, role); attempted.add(profile);
          assert.equal((await execute(['store','set',profile], { input: credential.password })).code, 0);
        });
        const credential = credentials.find(value => value.email === emailFor(runIds[index], role));
        const session = await runtime.signIn(credential.email, credential.password); assert.equal(session.status, 200);
        assert.equal(session.user.id, credential.accountId); providerSessions.set(index + role, session);
      }
      const gateDirectory = await createPrivateRuntimeDirectory(path.join(output, 'phase-' + index), { signal }), nonce = randomBytes(24).toString('hex');
      const configFile = path.join(suite.directory, 'browser-config.json');
      await writeFile(configFile, JSON.stringify({ fixture: { cliPath: consumer.brokerCli, baseURL: app.origin,
        roles: { editor: [profileFor(index,'Editor')], reviewer: [profileFor(index,'Reviewer')] } },
        privateBrowserEndpoint: browser.endpoint, gateDirectory, nonce, editorEmail: emailFor(runIds[index],'Editor'),
        reviewerEmail: emailFor(runIds[index],'Reviewer'), injectBodyFailure: injected }) + '\n', { flag: 'wx', mode: 0o600 });
      let settled = false, outcome; activeAbort = new AbortController();
      const operationSignal = signal ? AbortSignal.any([signal, activeAbort.signal]) : activeAbort.signal;
      at('browser-lifecycle-p' + index);
      activeRunner = execute(['verify','run','--plan',suite.planFile,'--output-dir',path.join(output,'report-' + index),'--json'],
        { signal: operationSignal, timeoutMs: 210_000 }).then(result => { settled = true; outcome = { result }; }, error => { settled = true; outcome = { error }; });
      try {
        const deadline = performance.now() + 180_000;
        while (!await readBrowserGate(gateDirectory, nonce, 'records-absent')) {
          signal?.throwIfAborted(); if (settled || performance.now() >= deadline) throw Error('BROWSER_GATE_NOT_REACHED');
          await pause(25, undefined, { signal });
        }
        assert.equal((await runtime.summary()).proofRecords, 0);
        assert.equal(await lstat(path.join(gateDirectory,'record.json')).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;}),true);
        at('same-context-revocation-p' + index); assert.equal((await manager.cleanupRun(handle)).cleanup, 'completed');
        const revoked = await runtime.summary(); assert.equal(revoked.ownedAccounts, 0); assert.equal(revoked.activeReservations, 0);
        assert.equal(revoked.pendingDeliveries, 0); assert.equal(revoked.proofRecords, 0); assert.equal(revoked.controlPresent, true);
        assert.equal((await runtime.getUser(control.accessToken)).status, 200);
        await writeBrowserGate(gateDirectory, nonce, 'accounts-revoked');
        await activeRunner;
        if (outcome.error) throw outcome.error;
        let report;
        try { report = checkedReport(outcome.result, injected, expected); }
        catch { terminationConfirmed = false; throw Error('BROWSER_RUN_OUTCOME_UNCONFIRMED'); }
        runs.push({ phase: index === 0 ? 'positive' : index === 1 ? 'injected-body-failure' : 'corrected', ...report,
          sameContextSessionsRefused: 2, recordsRemaining: 0 });
      } finally {
        if (!settled) activeAbort.abort();
        await activeRunner; activeRunner = undefined; activeAbort = undefined;
        try { await browser.close(); browser = undefined; } catch { terminationConfirmed = false; issue('browser-stop'); }
        if (!browser && terminationConfirmed) await unlink(configFile);
      }
      for (const role of ['Editor','Reviewer']) assert.equal((await execute(['--json','check',profileFor(index,role)])).code, 3);
      const summary = await runtime.summary(); assert.equal(summary.ownedAccounts, 0); assert.equal(summary.activeReservations, 0);
      assert.equal(summary.pendingDeliveries, 0); assert.equal(summary.proofRecords, 0); assert.equal(summary.controlPresent, true);
      assert.equal(summary.reservations, (index + 1) * 2);
      assert.equal((await runtime.getUser(control.accessToken)).status, 200);
      assert.equal(sha(await readFile(suite.planFile)), planSha256); assert.equal(sha(await readFile(suite.specFile)), specSha256);
      await assertCopied();
      assert.equal(await lstat(path.join(gateDirectory,'record.json')).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;}),true);
      if (!terminationConfirmed) throw Error('BROWSER_RUN_OUTCOME_UNCONFIRMED');
    }
    assert.equal(runtime.requestCounts().authCreate, 6); // Six attempts remain under the unchanged ten/hour target quota.
    assert.equal(await installedTreeHash(consumer.packageRoot), before); assert.deepEqual(await sources(), sourceHashes);
    receipt = { schemaVersion: 1, experiment: 'source-only local Supabase form-post browser account lifecycle', passed: true,
      prototypeIncludedInInstalledPackage: false, hostedProjectTested: false, agentAuthoredTests: false, nativeBridgeTested: false,
      releaseId, sourceHashes, installedBrokerTreeSha256: before, brokerArtifactMode: process.env.TESTLANE_PACKAGE_TARBALL ? 'supplied-tarball' : 'fresh-source-pack',
      nativeStore: support.store, provider: runtime.metadata, browser: 'Chromium via consumer-installed Playwright 1.64.0',
      planSha256, specSha256, copiedHashes, runs, controllerRoutesExposed: false, providerTokensDeliveredToBrowser: false,
      ownedAccountsRemaining: 0, foreignControlUnchanged: true, cleanupVerified: false, credentialLeakScanPassed: false };
  } catch (error) { if (error?.preserveConsumer === true) terminationConfirmed = false; failure = error; }
  finally {
    const failedStage = stage; at('cleanup');
    if (activeRunner) { activeAbort?.abort(); await activeRunner; activeRunner = undefined; }
    if (browser) { try { await browser.close(); } catch { terminationConfirmed = false; issue('browser-stop'); } }
    if (!terminationConfirmed) issue('owned-child-stop');
    // Browser closure alone cannot settle a request already accepted by the
    // app. Stop new HTTP work and await its tracked handlers before fallback.
    try { await app?.stopAndDrainRequests(); } catch { terminationConfirmed = false; issue('application-drain'); }
    // Only the dedicated Editor's independently returned rows can authorize fallback deletion.
    // An unknown browser/runner may still own an accepted app request. Do not
    // delete or reinterpret its backend data; preserve it for reconciliation.
    if (runtime && terminationConfirmed) for (const [key, session] of providerSessions) if (key.endsWith('Editor')) try {
      const rows = await runtime.rest('GET','/proof_records',session.accessToken); assert.equal(rows.status, 200); assert.ok(Array.isArray(rows.body));
      for (const row of rows.body) { assert.equal(row.owner_id,session.user.id); assert.equal(row.note,'synthetic');
        assert.match(row.id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        assert.ok([200,204].includes((await runtime.rest('DELETE','/proof_records?id=eq.'+row.id,session.accessToken)).status)); }
    } catch { issue('owned-record-cleanup'); }
    if (terminationConfirmed) for (const handle of handles) try { await manager.cleanupRun(handle); } catch { issue('coordinator-cleanup'); }
    if (runtime && terminationConfirmed) try { const value=await runtime.summary(); accountCleanupConfirmed=value.ownedAccounts===0&&value.activeReservations===0&&value.pendingDeliveries===0&&value.proofRecords===0;
      if (!accountCleanupConfirmed) issue('account-summary'); } catch { issue('account-summary'); }
    if (harness && terminationConfirmed) for (const profile of attempted) {
      try { if ((await execute(['store','delete',profile],{signal:null})).code!==0) issue('native-entry-delete');
        if ((await execute(['check',profile],{signal:null})).code!==4) issue('native-entry-absence'); } catch { issue('native-entry-cleanup'); }
      if (!terminationConfirmed) break;
    }
    const material=credentials.map(value=>value.password).concat(endpoints,app?.issuedSessionTokens()??[]);
    try { await app?.close(); } catch { issue('application-close'); }
    try { const result=await runtime?.close({preserveData:!accountCleanupConfirmed||!terminationConfirmed});
      if(runtime&&result?.cleanupVerified!==true)issue('provider-close'); } catch { issue('provider-close'); }
    try { if(consumer&&(await readdir(consumer.sessionTemp)).length)issue('session-file-absence');if(sessionRoot&&(await readdir(sessionRoot)).length)issue('session-file-absence');
      const retained=captured+(runtime?.capturedText()??'')+await textTree(output)+(harness?await textTree(harness.root):'')+(consumer?await textTree(consumer.e2e):'');
      assertNoLeaks(retained,material);runtime?.assertNoLeaks(retained); } catch { issue('retained-artifact-scan'); }
    if(!cleanupFailed){try{await harness?.dispose();}catch{issue('native-home-disposal');}if(!cleanupFailed)try{await consumer?.dispose();}catch{issue('consumer-disposal');}}
    if(!cleanupFailed&&browserRoot)try{
      assert.equal(await realpath(browserRoot),browserRoot);assert.equal(path.dirname(browserRoot),output);assert.equal(path.basename(browserRoot),'browser');
      assert.equal((await lstat(browserRoot)).isSymbolicLink(),false);await rm(browserRoot,{recursive:true,force:false});
    }catch{issue('browser-storage-disposal');}
    if(!cleanupFailed)try{await disposePrivateProofDirectories([scratchRoot,sessionRoot]);}catch{issue('private-directory-disposal');}
    restore();
    if(cleanupFailed){const error=Object.assign(Error('SUPABASE_BROWSER_CLEANUP_INCOMPLETE'),{preserveConsumer:true});
      await writeFile(path.join(output,'recovery.json'),canonical({schemaVersion:1,status:'manual-inspection-required',stage:failedStage,
        nativeHome:harness?.root??null,consumerRoot:consumer?.root??null,childTerminationConfirmed:terminationConfirmed,accountCleanupConfirmed,
        attemptedProfiles:[...attempted],cleanupFailures:[...cleanupFailures].sort()})+'\n',{flag:'wx',mode:0o600}).catch(()=>{});throw error;}
    if(failure)await writeFile(path.join(output,'failure.json'),canonical({schemaVersion:1,stage:failedStage,code:'SUPABASE_BROWSER_PROOF_FAILED',cleanupVerified:true})+'\n',{flag:'wx',mode:0o600});
  }
  if(failure)throw Error('SUPABASE_BROWSER_PROOF_FAILED');
  receipt.cleanupVerified=true;receipt.credentialLeakScanPassed=true;
  return finalizeProvisioningProof({outputDir:output,receipt,kind:'supabase',signal});
}
async function main(){const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i++){
  const key={'--tools-root':'toolsRoot','--output-dir':'outputDir'}[args[i]];if(!key||options[key]||!args[i+1])throw Error();options[key]=args[++i];}
  if(!options.toolsRoot||!options.outputDir)throw Error();
  const provisional=process.exitCode===undefined||process.exitCode===0;
  if(provisional)process.exitCode=1;
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
    if(!provisional)throw Error('SUPABASE_BROWSER_COMPLETION_REFUSED');
    const result=await runSupabaseBrowserProof({...options,signal:controller.signal,
      onStage:value=>console.log('SUPABASE_BROWSER_STAGE '+value)});
    if(controller.signal.aborted)throw Error('SUPABASE_BROWSER_CANCELLED');
    if(process.exitCode!==1)throw Error('SUPABASE_BROWSER_COMPLETION_REFUSED');
    // Final synchronous commit: all awaited work precedes success output.
    console.log(JSON.stringify(result));process.exitCode=0;
  }finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}}
function entry(){try{const a=realpathSync(process.argv[1]),b=realpathSync(fileURLToPath(import.meta.url));return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}catch{return false;}}
if(entry())main().catch(()=>{console.error('SUPABASE_BROWSER_PROOF_FAILED: inspect private fixed-code recovery evidence');if(process.exitCode===undefined||process.exitCode===0)process.exitCode=1;});
