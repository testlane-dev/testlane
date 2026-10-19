import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { consumerProject, assertNoLeaks, publicArtifacts } from './consumer.mjs';

const brokerSource = `
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
const data = JSON.parse(await readFile(new URL('./broker-data.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--json' && args[1] === 'profiles') {
  console.log(JSON.stringify({ profiles: data.profiles.map(p => ({
    name: p.name, email: data.mode === 'duplicate-account' ? data.profiles[0].email : p.email,
    role: p.role, environment: 'testing', strategy: 'form-post',
    baseUrl: data.mode === 'origin-mismatch' ? 'http://127.0.0.1:1' : data.origin,
  })), sources: [] }));
} else {
  const profile = data.profiles.find(p => p.name === args[1]);
  if (!profile || args[0] !== 'session') process.exit(2);
  const file = args[args.indexOf('--out') + 1];
  await appendFile(new URL('./issued.ndjson', import.meta.url), JSON.stringify({file,profile:profile.name}) + '\\n');
  if (data.mode === 'reflected-failure') { console.error(profile.value); process.exit(3); }
  const state = { cookies: [{ name: 'fixture_session', value: profile.value,
    domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now()/1000)+300,
    httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
  await writeFile(file, data.mode === 'bad-state' ? profile.value : JSON.stringify(state), {flag:'wx',mode:0o600});
  if (data.mode === 'slow') await new Promise(resolve=>setTimeout(resolve,60000));
  if (data.mode === 'warning') console.error('warning: unsupported additional header');
  const expiresAt = new Date(Date.now() + (data.mode === 'expired' ? -1000 : 300000)).toISOString();
  console.log('wrote storage-state session for ' + profile.name + ' to ' + file + ' (expires ' + expiresAt + ')');
}
`;
const preamble = `
import { readFileSync, appendFileSync } from 'node:fs';
import { createTestlaneTest, expect } from './fixtures.mjs';
const options = JSON.parse(readFileSync(new URL('../fixture-config.json',import.meta.url),'utf8'));
const test = createTestlaneTest(options);
`;

const observed = `
for (const role of ['qa','admin']) {
  let stage='session setup';
  try {
  const session = await testlane.open(role);
  session.context.on('close', () => appendFileSync(new URL('../closed.txt',import.meta.url),'closed\\n'));
  session.assertFresh();
  stage='identity request';
  const response = await session.context.request.get('/api/me',{maxRedirects:0});
  expect(response.status()).toBe(200);
  stage='identity response';
  const identity = await response.json();
  expect(identity.email === session.account.email).toBe(true);
  expect(identity.role === session.account.role).toBe(true);
  await session.page.goto('/dashboard');
  await expect(session.page.getByRole('heading',{name:'Dashboard',exact:true})).toBeVisible();
  expect(session.remainingMs() > 0).toBe(true);
  expect(Number.isFinite(Date.parse(session.expiresAt))).toBe(true);
  } catch { throw new Error('App verification failed: '+stage); }
}
`;

test('packed fixture in a clean Playwright consumer', { timeout: 240_000 }, async (t) => {
  const consumer = await consumerProject();
  t.after(() => consumer.dispose());
  const profiles = ['qa','admin'].flatMap(role => [0,1].map(worker => ({
    name: 'shop:testing:' + role + ':worker-' + worker,
    email: role + worker + '@example.test', role,
    value: randomBytes(32).toString('base64url'),
  })));
  const values = profiles.map(p => p.value);
  let serverFault='happy';
  let origin;
  let externalOrigin;
  const server = http.createServer((req,res) => {
    const account = profiles.find(p => req.headers.cookie === 'fixture_session=' + p.value);
    if (!account) { res.writeHead(401); res.end(); return; }
    if (req.url === '/api/me' && serverFault === 'drop-identity') { req.socket.destroy(); return; }
    if (req.url === '/api/me' && serverFault === 'malformed-identity') { res.end(account.value); return; }
    if (req.url === '/api/me') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({email:account.email,role:account.role})); return; }
    if (req.url === '/dashboard' && serverFault.includes('redirect')) {
      const location = serverFault === 'same-origin-redirect' ? '/dashboard?complete=1' : externalOrigin + '/dashboard';
      res.writeHead(302, { location }); res.end(); return;
    }
    if (req.url?.startsWith('/dashboard')) { res.setHeader('content-type','text/html'); res.end('<h1>Dashboard</h1>'); return; }
    res.writeHead(404); res.end();
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  origin = 'http://127.0.0.1:' + server.address().port;
  const external = http.createServer((req,res) => {
    if (serverFault === 'returning-redirect') { res.writeHead(302,{location:origin+'/dashboard?complete=1'}); res.end(); return; }
    res.setHeader('content-type','text/html'); res.end('<h1>Dashboard</h1>');
  });
  external.listen(0,'127.0.0.1');
  await once(external,'listening');
  externalOrigin = 'http://127.0.0.1:' + external.address().port;
  t.after(() => new Promise(resolve => { external.closeAllConnections(); external.close(resolve); }));
  const broker = path.join(consumer.root,'broker.mjs');
  const log = path.join(consumer.root,'issued.ndjson');
  const config = {
    cliPath: broker, baseURL: origin,
    roles: Object.fromEntries(['qa','admin'].map(role => [role, profiles.filter(p => p.role === role).map(p => p.name)])),
  };
  await writeFile(broker,brokerSource);
  let previous = 0;
  async function runCase(mode, body, args = [], overrides = {}) {
    serverFault=mode;
    await consumer.config({...config,...overrides});
    await writeFile(path.join(consumer.root,'broker-data.json'),JSON.stringify({origin,profiles,mode}));
    let source = preamble + body;
    if (body === null) {
      source = await readFile(path.join(consumer.packageRoot,'examples/playwright/app.spec.mjs'),'utf8');
      // Only the human-owned public configuration changes; run the shipped spec itself.
      source = source.replace("'/absolute/path/to/testlane/dist/cli.js'",JSON.stringify(broker))
        .replace("'http://localhost:3000'",JSON.stringify(origin));
    }
    await consumer.spec('case',source);
    const result = await consumer.run(['case.spec.mjs','--workers=1',...args]);
    assertNoLeaks(result.stdout + result.stderr + await publicArtifacts(consumer.root),values);
    let issued = [];
    try { issued = (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const item of issued) {
      assert.equal(await access(item.file).then(() => true, () => false),false,'state file removed');
      assert.equal(await access(path.dirname(item.file)).then(() => true, () => false),false,'private run directory removed');
    }
    const newIssues = issued.slice(previous);
    previous = issued.length;
    return {...result, issued:newIssues};
  }
  await t.test('fresh two-role sessions, repeatable cleanup and context teardown',async () => {
    const body = `test('roles',async ({testlane}) => {${observed}});`;
    for (let i=0;i<2;i++) {
      const result = await runCase('happy',body);
      assert.equal(result.code,0,'consumer role test passes: ' + result.stdout + result.stderr);
      assert.equal(result.issued.length,2);
    }
    const closed = await readFile(path.join(consumer.root,'closed.txt'),'utf8');
    assert.equal(closed.trim().split('\n').length,4,'all authenticated contexts closed');
  });
  for (const mode of ['same-origin-redirect','external-redirect','returning-redirect']) {
    await t.test('document navigation validates ' + mode + ' even without assertFresh',async () => {
      // The external page deliberately has the same path and heading. The test
      // body would pass without the fixture's sticky teardown validation.
      const result = await runCase(mode,`test('redirect',async ({testlane}) => {
        const session=await testlane.open('qa');
        await session.page.goto('/dashboard');
        await expect(session.page.getByRole('heading',{name:'Dashboard',exact:true})).toBeVisible();
      });`);
      assert.equal(result.code,mode === 'same-origin-redirect' ? 0 : 1);
      if (mode !== 'same-origin-redirect') assert.equal(result.stdout.includes('off-origin document navigation observed'),true);
      assert.equal(result.issued.length,1);
    });
  }
  await t.test('assertFresh rejects an observed external redirect',async () => {
    const result = await runCase('external-redirect',`test('redirect guard',async ({testlane}) => {
      const session=await testlane.open('qa');
      await session.page.goto('/dashboard');
      expect(()=>session.assertFresh()).toThrow(/off-origin document navigation observed/);
    });`);
    // Catching the guard error does not turn the escaped run into a pass.
    assert.equal(result.code,1);
    assert.equal(result.stdout.includes('off-origin document navigation observed'),true);
  });
  await t.test('cleanup after a user assertion fails',async () => {
    const result = await runCase('happy',`test('failure',async ({testlane}) => {${observed} throw new Error('intentional consumer failure');});`);
    assert.equal(result.code,1);
    assert.equal(result.issued.length,2);
  });
  for (const mode of ['happy','malformed-identity','drop-identity']) {
    await t.test('shipped sample spec handles ' + mode + ' without exposing credentials',async () => {
      const result=await runCase(mode,null);
      assert.equal(result.code,mode === 'happy' ? 0 : 1);
      if (mode !== 'happy') assert.equal(result.stdout.includes('App verification failed: identity'),true);
      assert.equal(result.issued.length,mode === 'happy' ? 2 : 1);
    });
  }
  await t.test('timeout cancels pending issuance and removes its state',async () => {
    const result = await runCase('slow',`test('timeout',async ({testlane}) => {test.setTimeout(10000); await testlane.open('qa');});`);
    assert.equal(result.code,1);
    assert.equal(result.issued.length,1);
  });
  for (const mode of ['expired','bad-state','warning','reflected-failure','origin-mismatch','duplicate-account']) {
    await t.test('refuses ' + mode + ' without leaking or retaining state',async () => {
      const result = await runCase(mode,`test('refusal',async ({testlane}) => {await testlane.open('qa');});`);
      assert.equal(result.code,1);
      const expected = { expired: 'session expired', 'bad-state': 'browser context setup failed', warning: 'broker refused, warned or unavailable', 'reflected-failure': '(exit 3)', 'origin-mismatch': 'profile mismatch', 'duplicate-account': 'accounts must differ' };
      assert.equal(result.stdout.includes(expected[mode]),true,'refuses for the expected reason');
      assert.equal(result.issued.length,['origin-mismatch','duplicate-account'].includes(mode) ? 0 : 1);
    });
  }
  await t.test('refuses traces before issuance',async () => {
    const result = await runCase('happy',`test('recording',async ({testlane}) => {await testlane.open('qa');});`,['--trace=on']);
    assert.equal(result.code,1);
    assert.equal(result.issued.length,0);
  });
  await t.test('expiry guard stops work without refreshing or replaying',async () => {
    const result = await runCase('happy',`test('expiry',async ({testlane}) => {
      const session=await testlane.open('qa');
      const now=Date.now;
      try { Date.now=()=>Date.parse(session.expiresAt)+1; expect(()=>session.assertFresh()).toThrow(/session expired/); expect(session.remainingMs()).toBe(0); }
      finally { Date.now=now; }
    });`);
    assert.equal(result.code,0);
    assert.equal(result.issued.length,1);
  });
  await t.test('a missing worker slot is refused rather than sharing an account',async () => {
    const result = await runCase('happy',`test('mapping',async ({testlane}) => {await testlane.open('qa');});`,[],{roles:{qa:[profiles[0].name]}});
    assert.equal(result.code,0);
    await consumer.spec('second',preamble + `test('worker two',async ({testlane}) => {await testlane.open('qa');});`);
    const parallel = await consumer.run(['case.spec.mjs','second.spec.mjs','--workers=2']);
    assertNoLeaks(parallel.stdout+parallel.stderr,values);
    assert.equal(parallel.code,1);
    assert.equal(parallel.stdout.includes('no profile for this parallel worker'),true);
  });
  await t.test('parallel workers use distinct mapped accounts and private files',async () => {
    await consumer.config(config);
    await consumer.spec('case',preamble + `test('worker one',async ({testlane}) => {${observed}});`);
    await consumer.spec('second',preamble + `test('worker two',async ({testlane}) => {${observed}});`);
    const result=await consumer.run(['--workers=2']);
    assertNoLeaks(result.stdout+result.stderr+await publicArtifacts(consumer.root),values);
    assert.equal(result.code,0,'parallel two-role consumer passes');
    const issued=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const last=issued.slice(-4);
    assert.equal(new Set(last.map(x=>x.profile)).size,4);
    assert.equal(new Set(issued.map(x=>x.file)).size,issued.length,'all issuances have different state paths');
    for(const item of last) assert.equal(await access(item.file).then(()=>true,()=>false),false);
  });
});
