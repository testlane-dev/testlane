/** Source-only fixtures: no Docker, broker, browser, network listener or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { browserAsset, browserRecordResponse } from '../browser-fixture.mjs';
import { readBrowserGate, writeBrowserGate } from '../browser-gate.mjs';
import { runSupabaseBrowserProof } from '../browser-proof.mjs';
import { createRequestDrain } from '../request-drain.mjs';
import { reconcile } from '../../../agent-verification/runtime.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = async name => readFile(path.join(HERE,'..',name),'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => JSON.parse(JSON.stringify(value));

test('browser record bridge derives ownership and projects no provider credentials', async () => {
  const id=randomUUID(),owner=randomUUID(),canary=randomBytes(32).toString('base64url'),calls=[];
  const row={id,owner_id:owner,note:'synthetic',created_at:new Date().toISOString()};
  const rest=async(...args)=>{calls.push(args);return {status:201,body:[row]};};
  assert.deepEqual(await browserRecordResponse({method:'POST',route:'/api/records',user:{id:owner,role:'Editor'},readBody:async()=>({note:'synthetic'}),rest}),{status:201,body:row});
  assert.deepEqual(calls,[['POST','/proof_records',{owner_id:owner,note:'synthetic'}]]);
  const unsafe=await browserRecordResponse({method:'POST',route:'/api/records',user:{id:owner,role:'Editor'},readBody:async()=>({note:'synthetic',owner_id:randomUUID()}),rest});
  assert.equal(unsafe.status,400);assert.equal(calls.length,1);
  await assert.rejects(browserRecordResponse({method:'GET',route:'/api/records',user:{id:owner,role:'Editor'},rest:async()=>({status:200,body:[{...row,accessToken:canary}]})}),{message:'BROWSER_RECORD_INVALID'});
  assert.equal(JSON.stringify(unsafe).includes(canary),false);
});
test('Reviewer writes retain the real RLS refusal and foreign rows are refused', async () => {
  const owner=randomUUID(),record=randomUUID();let count=0;
  const denied=await browserRecordResponse({method:'POST',route:'/api/records',user:{id:owner,role:'Reviewer'},readBody:async()=>({note:'synthetic'}),rest:async()=>{count++;return {status:403,body:{code:'42501'}};}});
  assert.deepEqual(denied,{status:403,body:{error:'ROLE_REFUSED'}});assert.equal(count,1);
  assert.equal((await browserRecordResponse({method:'DELETE',route:'/api/records/'+record,user:{id:owner,role:'Reviewer'},rest:async()=>{throw Error();}})).status,403);
  await assert.rejects(browserRecordResponse({method:'GET',route:'/api/records',user:{id:owner,role:'Editor'},rest:async()=>({status:200,body:[{id:record,owner_id:randomUUID(),note:'synthetic',created_at:new Date().toISOString()}]})}),{message:'BROWSER_RECORD_INVALID'});
  assert.equal(await browserRecordResponse({method:'POST',route:'/api/accounts',user:{id:owner,role:'Editor'}}),null);
});
test('workspace uses text-only DOM writes and exposes no authentication/provisioning collector', () => {
  assert.match(browserAsset('/workspace').body,/Sandbox records/);
  const script=browserAsset('/workspace.js').body;
  assert.equal(script.includes('innerHTML'),false);assert.equal(script.includes('document.cookie'),false);
  assert.equal(script.includes('/api/accounts'),false);assert.equal(script.includes('console.'),false);
  assert.match(script,/identity-role.*textContent/);assert.match(script,/AUTHENTICATION_REQUIRED/);
});
test('private gate refuses wrong nonce, duplicate/extra fields and noncanonical parents', async t => {
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tlp-browser-gate-')),nonce=randomBytes(24).toString('hex');
  t.after(async()=>{assert.equal(path.dirname(await realpath(root)),parent);assert.match(path.basename(root),/^tlp-browser-gate-/);await rm(root,{recursive:true,force:false});});
  assert.equal(await readBrowserGate(root,nonce,'records-absent'),false);
  await writeBrowserGate(root,nonce,'records-absent');assert.equal(await readBrowserGate(root,nonce,'records-absent'),true);
  await assert.rejects(readBrowserGate(root,randomBytes(24).toString('hex'),'records-absent'),{message:'BROWSER_GATE_REFUSED'});
  await writeFile(path.join(root,'records-absent.json'),JSON.stringify({schemaVersion:1,nonce,stage:'records-absent',extra:true}));
  await assert.rejects(readBrowserGate(root,nonce,'records-absent'),{message:'BROWSER_GATE_REFUSED'});
  await writeFile(path.join(root,'records-absent.json'),'\x7b"schemaVersion":1,"nonce":'+JSON.stringify(nonce)+',"nonce":'+JSON.stringify(nonce)+',"stage":"records-absent"}\n');
  await assert.rejects(readBrowserGate(root,nonce,'records-absent'),{message:'BROWSER_GATE_REFUSED'});
  await assert.rejects(readBrowserGate(path.join(root,'..',path.basename(root)),nonce,'records-absent'),{message:'BROWSER_GATE_REFUSED'});
});

async function ownerFixture(mode='success') {
  const events=[],child=new EventEmitter();child.pid=1234;
  const endpoint='ws://127.0.0.1:12345/'+randomBytes(16).toString('hex');
  const server={process:()=>child,wsEndpoint:()=>mode==='malformed'?randomBytes(24).toString('base64url'):endpoint,
    close:async()=>{events.push('server-close');if(mode==='close-reject')throw Error(randomBytes(24).toString('base64url'));if(mode!=='close-without-child')child.emit('close',0);},
    kill:async()=>{events.push('server-kill');child.emit('close',0);}};
  const code=(await source('browser-server.mjs')).replace(/^import .*;\r?\n/gm,'').replace('export async function startOwnedBrowserServer','async function startOwnedBrowserServer');
  const require=name=>name.endsWith('package.json')?{version:'1.64.0'}:{chromium:{launchServer:async options=>{events.push('launch');assert.equal(options.host,'127.0.0.1');assert.equal(options.port,0);assert.equal(options.timeout,30000);assert.equal(Object.hasOwn(options.env,'SYNTHETIC_PRIVATE_CANARY'),false);return server;}}};
  const context={path,URL,Promise,setTimeout:(fn)=>setTimeout(fn,0),clearTimeout,process:{platform:'linux',execPath:process.execPath,env:{SYNTHETIC_PRIVATE_CANARY:randomBytes(32).toString('base64url')}},createRequire:()=>require};
  const methods=vm.runInNewContext(code+'\n({startOwnedBrowserServer,retainBrowserServer});',context);
  return {events,child,server,endpoint,methods};
}
test('parent browser close requires retained child closure and is single-flight', async()=>{
  const fixture=await ownerFixture(),owner=await fixture.methods.startOwnedBrowserServer({consumerRoot:path.resolve('consumer'),temporaryRoot:path.resolve('private')});
  const first=owner.close();assert.equal(owner.close(),first);assert.deepEqual(normalized(await first),{browserProcessClosed:true,closeAcknowledged:true});
  assert.deepEqual(fixture.events,['launch','server-close']);
});
test('rejected browser close remains latched and nonpassing after exact kill/child closure', async()=>{
  const fixture=await ownerFixture('close-reject'),owner=fixture.methods.retainBrowserServer(fixture.server);
  const first=owner.close();await assert.rejects(first,{message:'BROWSER_SERVER_CLEANUP_UNCONFIRMED',preserveConsumer:true});
  assert.equal(owner.close(),first);await assert.rejects(owner.close());assert.deepEqual(fixture.events,['server-close','server-kill']);
});
test('acknowledged browser close without retained process close is unconfirmed', async()=>{
  const fixture=await ownerFixture('close-without-child'),owner=fixture.methods.retainBrowserServer(fixture.server);
  await assert.rejects(owner.close(),{message:'BROWSER_SERVER_CLEANUP_UNCONFIRMED',preserveConsumer:true});
});
test('malformed private endpoint closes its exact owner and returns only a fixed error', async()=>{
  const fixture=await ownerFixture('malformed');
  await assert.rejects(fixture.methods.startOwnedBrowserServer({consumerRoot:path.resolve('consumer'),temporaryRoot:path.resolve('private')}),{message:'BROWSER_SERVER_START_FAILED'});
  assert.deepEqual(fixture.events,['launch','server-close']);
});
test('pre-cancelled browser owner never resolves or launches a tool',async()=>{
  const fixture=await ownerFixture(),abort=new AbortController();abort.abort();
  await assert.rejects(fixture.methods.startOwnedBrowserServer({consumerRoot:path.resolve('consumer'),temporaryRoot:path.resolve('private'),signal:abort.signal}),{name:'AbortError'});
  assert.deepEqual(fixture.events,[]);
});

async function finalizationFixture({unknown=false,drainFailure=false,writeFailure=false,drainGate}={}) {
  const events=[],output=path.resolve('owned-output');let cleanupFailed=false;
  const controller=await source('browser-proof.mjs'),start=controller.indexOf('    const failedStage = stage; at(\'cleanup\');'),end=controller.indexOf('\n  if(failure)throw');
  assert.ok(start>0&&end>start);
  const body=controller.slice(start,end).replace(/\n  }\s*$/,'');
  const value={stage:'browser-lifecycle-p0',output,path,assert,canonical:JSON.stringify,at:()=>{},activeRunner:undefined,activeAbort:undefined,browser:undefined,
    terminationConfirmed:!unknown,accountCleanupConfirmed:false,handles:[{}],attempted:new Set(['owned-profile']),providerSessions:new Map([['0Editor',{accessToken:randomBytes(32).toString('base64url'),user:{id:randomUUID()}}]]),
    credentials:[],endpoints:[],captured:'',failure:Error('fixed failure'),cleanupFailures:new Set(),causeCode:undefined,retainCause:()=>{},
    issue:code=>{cleanupFailed=true;value.cleanupFailed=true;value.cleanupFailures.add(code);},cleanupFailed:false,
    app:{issuedSessionTokens:()=>[],stopAndDrainRequests:async()=>{events.push('drain-start');if(drainGate)await drainGate;if(drainFailure)throw Error('fixed drain failure');events.push('drain-settled');},close:async()=>{events.push('app-close');}},
    runtime:{rest:async()=>{events.push('record-read');return {status:200,body:[]};},summary:async()=>{events.push('summary');return {ownedAccounts:0,activeReservations:0,pendingDeliveries:0,proofRecords:0};},
      close:async options=>{events.push(options.preserveData?'runtime-preserve':'runtime-delete');return {cleanupVerified:!options.preserveData};},capturedText:()=>'',assertNoLeaks:()=>{}},
    manager:{cleanupRun:async()=>{events.push('account-delete');}},harness:{root:'home',dispose:async()=>{events.push('vault-dispose');}},
    consumer:{root:'consumer',e2e:'e2e',sessionTemp:'sessions',dispose:async()=>{events.push('consumer-dispose');}},
    execute:async args=>{events.push('vault-'+args[0]);return {code:args[0]==='store'?0:4};},
    sessionRoot:undefined,scratchRoot:undefined,browserRoot:undefined,readdir:async()=>[],textTree:async()=>'',assertNoLeaks:()=>{},
    writeFile:async file=>{events.push(path.basename(file));if(writeFailure)throw Error('fixed metadata failure');},restore:()=>{events.push('restore');},disposePrivateProofDirectories:async()=>{events.push('empty-directories');}};
  return {events,value,run:vm.runInNewContext('(async()=>{'+body+'})',value)};
}
test('unknown runner/browser stop preserves backend data, vault and consumer without deletion',async()=>{
  const fixture=await finalizationFixture({unknown:true});
  await assert.rejects(fixture.run(),{message:'SUPABASE_BROWSER_CLEANUP_INCOMPLETE',preserveConsumer:true});
  assert.equal(fixture.events.includes('runtime-preserve'),true);
  for(const forbidden of ['record-read','account-delete','vault-store','vault-dispose','consumer-dispose'])assert.equal(fixture.events.includes(forbidden),false);
});
test('known browser stop still waits accepted HTTP work before fallback deletion',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),fixture=await finalizationFixture({drainGate:gate});
  const operation=fixture.run();await Promise.resolve();assert.deepEqual(fixture.events,['drain-start']);release();await operation;
  assert.ok(fixture.events.indexOf('drain-settled')<fixture.events.indexOf('record-read'));
  assert.ok(fixture.events.indexOf('drain-settled')<fixture.events.indexOf('account-delete'));
});
test('failed app drain prevents backend and vault deletion and preserves fixed uncertainty even when metadata fails',async()=>{
  const fixture=await finalizationFixture({drainFailure:true,writeFailure:true});
  await assert.rejects(fixture.run(),{message:'SUPABASE_BROWSER_CLEANUP_INCOMPLETE',preserveConsumer:true});
  for(const forbidden of ['record-read','account-delete','vault-store','vault-dispose','consumer-dispose'])assert.equal(fixture.events.includes(forbidden),false);
  assert.equal(fixture.events.includes('runtime-preserve'),true);
});
test('existing drain waits a delayed accepted write without opening a server',async()=>{
  const drain=createRequestDrain(),events=[];let release;
  const gate=new Promise(resolve=>{release=resolve;}),request=drain.run(async()=>{await gate;events.push('committed');});
  const close=drain.close(async()=>{events.push('acceptance-stopped');});
  assert.throws(()=>drain.run(async()=>{}),{code:'PROVISION_APP_CLOSED'});await Promise.resolve();assert.deepEqual(events,['acceptance-stopped']);
  release();await close;await request;assert.deepEqual(events,['acceptance-stopped','committed']);
});
test('fallback deletes a delayed accepted record only after the actual request drain settles',async()=>{
  const fixture=await finalizationFixture(),drain=createRequestDrain();let release;
  const gate=new Promise(resolve=>{release=resolve;}),owner=fixture.value.providerSessions.get('0Editor').user.id,rows=[];
  const request=drain.run(async()=>{await gate;rows.push({id:randomUUID(),owner_id:owner,note:'synthetic'});fixture.events.push('late-record-committed');});
  const appSource=await source('app.mjs'),start=appSource.indexOf('  const stopAndDrainRequests = () => {'),end=appSource.indexOf('\n  const app = Object.freeze',start);
  const state={requests:drain,drainPromise:undefined,quiescing:false,closed:false,Promise,fail:code=>Error(code),
    server:{close:callback=>{fixture.events.push('acceptance-stopped');callback();},closeAllConnections:()=>{fixture.events.push('connections-stopped');}}};
  fixture.value.app.stopAndDrainRequests=vm.runInNewContext(appSource.slice(start,end)+'\nstopAndDrainRequests;',state);
  fixture.value.runtime.rest=async(method,route)=>{fixture.events.push(method==='DELETE'?'owned-record-delete':'record-read');
    if(method==='DELETE'){assert.equal(route,'/proof_records?id=eq.'+rows[0].id);rows.splice(0);return {status:204};}
    return {status:200,body:[...rows]};};
  const operation=fixture.run();await Promise.resolve();assert.equal(fixture.events.includes('record-read'),false);
  assert.equal(state.quiescing,true);assert.equal(state.closed,false,'local account cleanup authority is not closed by HTTP draining');
  release();await request;await operation;assert.equal(rows.length,0);
  assert.ok(fixture.events.indexOf('late-record-committed')<fixture.events.indexOf('record-read'));
  assert.ok(fixture.events.indexOf('owned-record-delete')<fixture.events.indexOf('account-delete'));
});
test('injected expect remains outside the arbitrary-browser-error wrapper and runCase retains original failure',async()=>{
  const spec=await source('browser.spec.mjs'),author=await readFile(path.join(HERE,'../../../agent-verification/authoring.mjs'),'utf8');
  const start=spec.indexOf('run: async () => {'),end=spec.indexOf('\n  }, cleanup:',start);
  const runText=spec.slice(start+5,end+4).replace(/,\s*$/,'');
  const safeFailure=Error('CONTROLLED_ASSERTION'),annotations=[];let cleanup=false;
  const run=vm.runInNewContext('('+runText+')',{fixed:async()=>{},config:{injectBodyFailure:true},expect:actual=>({toBe:expected=>{assert.notEqual(actual,expected);throw safeFailure;}})});
  const begin=author.indexOf('export async function runCase'),finish=author.indexOf('\n/**',begin+10);
  const runCase=vm.runInNewContext('('+author.slice(begin,finish).replace('export ','')+')',{control:()=>({cases:[{id:'provisioned-browser-lifecycle',cleanupRequired:true}]}),active:new WeakMap(),AUTHORING_VERSION:'1',selfHash:hash(author),
    fail:code=>Error(code),annotate:(info,type,description)=>info.annotations.push({type,description})});
  const info={annotations:[{type:'testlane-case',description:'provisioned-browser-lifecycle'}]};
  await assert.rejects(runCase(info,'provisioned-browser-lifecycle',{run,cleanup:async()=>{cleanup=true;}}),error=>error===safeFailure);
  assert.equal(cleanup,true);assert.equal(info.annotations.some(value=>value.type==='testlane-body'&&value.description==='failed'),true);
  assert.equal(info.annotations.some(value=>value.type==='testlane-cleanup'&&value.description==='completed'),true);
});
test('fault acceptance requires the bound spec and injected source coordinates, not an arbitrary failed test',async()=>{
  const controller=await source('browser-proof.mjs'),spec=await source('browser.spec.mjs');
  const begin=controller.indexOf('function checkedReport('),end=controller.indexOf('\nexport async function runSupabaseBrowserProof',begin);
  const checked=vm.runInNewContext('('+controller.slice(begin,end)+')',{assert});
  const lines=spec.split('\n'),line=lines.findIndex(value=>value.includes('expect(config.injectBodyFailure === false,'))+1;
  const expected={planSha256:hash('plan'),specSha256:hash(spec),specId:hash('e2e/provisioning/browser.spec.mjs'),injectionLine:line,
    injectionColumnStart:lines[line-1].indexOf('expect(')+1,injectionColumnEnd:lines[line-1].length+1};
  const row={id:'provisioned-browser-lifecycle',mapped:true,status:'failed',expectedPassed:true,retry:0,assertionsObserved:40,helper:true,started:true,
    cleanup:'completed',screenshots:[],unexpectedAttachments:false,diagnosticCode:'ASSERTION_FAILED',failureLocation:{line,column:expected.injectionColumnStart}};
  const plan={cases:[{id:row.id,cleanup:{required:true}}]},execution={exitCode:1,cancelled:false,forced:false};
  const report={...reconcile(plan,{schemaVersion:1,discovered:1,errors:[],outcome:'failed',results:[row]},execution),execution,
    plan:{sha256:expected.planSha256},specs:[{id:expected.specId,sha256:expected.specSha256}]};
  report.cases[0].specId=expected.specId;
  assert.equal(checked({code:1,stdout:JSON.stringify(report)},true,expected).injectedAssertionFailure,true);
  const passed=structuredClone(row);passed.status='passed';delete passed.diagnosticCode;passed.failureLocation=null;
  const passingExecution={exitCode:0,cancelled:false,forced:false};
  const passing={...reconcile(plan,{schemaVersion:1,discovered:1,errors:[],outcome:'passed',results:[passed]},passingExecution),execution:passingExecution,
    plan:report.plan,specs:report.specs};passing.cases[0].specId=expected.specId;
  assert.equal(checked({code:0,stdout:JSON.stringify(passing)},false,expected).verdict,'passed');
  for(const change of [value=>{value.cases[0].failureLocation.line++;},value=>{value.cases[0].failureLocation.column=expected.injectionColumnEnd+1;},
    value=>{value.cases[0].specId=hash('another spec');},value=>{value.cases[0].cleanup.status='failed';},
    value=>{value.execution.forced=true;},value=>{value.cases[0].diagnostic.code='CASE_BODY_FAILED';}]){
    const altered=structuredClone(report);change(altered);assert.throws(()=>checked({code:1,stdout:JSON.stringify(altered)},true,expected));
  }
});
test('proof refuses pre-cancellation before allocating directories or starting dependencies',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runSupabaseBrowserProof({outputDir:path.resolve('must-not-exist'),toolsRoot:path.resolve('not-installed'),signal:controller.signal}),{name:'AbortError'});
});
