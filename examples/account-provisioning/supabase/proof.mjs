#!/usr/bin/env node
/** Real local Auth/database acceptance; no hosted project or public provisioning command. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerProject, assertNoLeaks } from '../../playwright/tests/consumer.mjs';
import { createRealBrokerHarness, realBrokerSupport } from '../../workflows/test-support/real-broker.mjs';
import { runDemoChild } from '../../verification-demo/native.mjs';
import { createProvisioner } from '../controller.mjs';
import { canonical, emailFor, reviewedSupabasePolicy, TTL_MS } from '../contracts.mjs';
import { installedTreeHash } from '../proof.mjs';
import { finalizeProvisioningProof } from '../proof-finalization.mjs';
import { startSupabaseProvisioningApp } from './app.mjs';
import { startNextAuthSupabaseApp } from './nextauth-app.mjs';
import { startOwnedSupabase } from './runtime.mjs';
import { assertPrivateRuntimeDirectory, createPrivateRuntimeDirectory } from './tools/private-directory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..', '..', '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FILES = ['examples/account-provisioning/contracts.mjs', 'examples/account-provisioning/controller.mjs',
  'examples/account-provisioning/app.mjs', 'examples/account-provisioning/proof.mjs', 'examples/account-provisioning/proof-finalization.mjs',
  'examples/account-provisioning/supabase/app.mjs', 'examples/account-provisioning/supabase/runtime.mjs',
  'examples/account-provisioning/supabase/request-drain.mjs',
  'examples/account-provisioning/supabase/authority.mjs', 'examples/account-provisioning/supabase/nextauth-app.mjs',
  'examples/account-provisioning/supabase/ledger.sql', 'examples/account-provisioning/supabase/proof.mjs',
  'examples/account-provisioning/supabase/tools/package.json', 'examples/account-provisioning/supabase/tools/package-lock.json',
  'examples/account-provisioning/supabase/tools/setup.mjs', 'examples/account-provisioning/supabase/tools/process.mjs',
  'examples/account-provisioning/supabase/tools/private-directory.mjs', 'examples/verification-demo/native.mjs',
  'examples/playwright/tests/consumer.mjs', 'examples/workflows/test-support/real-broker.mjs'];
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
const api = (app, cookie, route) => fetch(app.origin + route, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(10_000) });
const login = (app, credential) => fetch(app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: credential.email, password: credential.password }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
function tokenExpiresLater(token) {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  // This observation does not validate a JWT. Auth and PostgREST independently
  // validate the same token before/after grant revocation in the live proof.
  return Number.isSafeInteger(claims.exp) && claims.exp * 1000 > Date.now() + 30_000;
}

export async function runSupabaseProvisioningProof({ toolsRoot, outputDir, authMode = 'form-post', signal, onStage = () => {} } = {}) {
  signal?.throwIfAborted();
  assert.ok(['form-post', 'nextauth'].includes(authMode), 'a fixed public authentication fixture is required');
  const support = realBrokerSupport();
  assert.ok(support.supported, 'Windows DPAPI or an explicitly isolated Linux Secret Service session is required');
  assert.ok(typeof outputDir === 'string' && path.isAbsolute(outputDir), 'a new absolute output directory is required');
  const output = path.resolve(outputDir), parent = path.dirname(output);
  assert.equal(await realpath(parent), parent); assert.equal((await lstat(parent)).isSymbolicLink(), false);
  await createPrivateRuntimeDirectory(output, { signal }); assert.equal(await realpath(output), output);
  await writeFile(path.join(output, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  const sourceHashes = await sources(), releaseId = sha(canonical({ sourceHashes, authMode })), runId = randomUUID();
  const cookieName = authMode === 'nextauth' ? 'next-auth.session-token' : 'tlp_supabase_session';
  const namespace = 'supabase-' + randomBytes(8).toString('hex'), profileFor = role => namespace + ':testing:' + role.toLowerCase();
  const credentials = [], cookies = new Map(), providerSessions = new Map(), attempted = new Set(), directOwners = [];
  const unconfirmedOwnedChildPids = new Set(), observed = {};
  let runtime, app, manager, handle, consumer, harness, env, before, receipt, failure, sessionRoot, scratchRoot, stage = 'setup';
  let restoreTemporaryEnvironment = () => {};
  let captured = '', terminationConfirmed = true, cleanupFailed = false, accountCleanupConfirmed = false;
  const cleanupFailures = new Set();
  const cleanupIssue = code => { cleanupFailed = true; cleanupFailures.add(code); };
  const at = value => { stage = value; onStage(value); };
  const checkSignal = () => signal?.throwIfAborted();
  const execute = async (args, options = {}) => {
    try {
      const result = await runDemoChild({ entry: consumer.brokerCli, args, cwd: consumer.root, env, timeoutMs: 35_000, signal, ...options });
      captured += result.stdout + result.stderr; return result;
    } catch (error) {
      if (error.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') {
        terminationConfirmed = false;
        if (Number.isSafeInteger(error.ownedChildPid) && error.ownedChildPid > 0) unconfirmedOwnedChildPids.add(error.ownedChildPid);
      }
      throw error;
    }
  };
  try {
    at('private-session-directory'); sessionRoot = await createPrivateRuntimeDirectory(path.join(output, 'sessions'), { signal });
    scratchRoot = await createPrivateRuntimeDirectory(path.join(output, 'scratch'), { signal });
    // Reused helpers resolve os.tmpdir() at allocation and disposal. Keep their
    // entire scratch trees beneath the verified private root until both settle.
    const previousTemp = ['TMP', 'TEMP', 'TMPDIR', 'NODE_DISABLE_COMPILE_CACHE'].map(key => [key, Object.hasOwn(process.env, key), process.env[key]]);
    for (const key of ['TMP', 'TEMP', 'TMPDIR']) process.env[key] = scratchRoot;
    // npm may enable Node's optional compile cache in os.tmpdir(). Disable it
    // for owned children so it cannot outlive the consumer's verified cleanup.
    process.env.NODE_DISABLE_COMPILE_CACHE = '1';
    restoreTemporaryEnvironment = () => { for (const [key, present, value] of previousTemp) {
      if (present) process.env[key] = value; else delete process.env[key];
    } };
    at('installed-broker'); consumer = await consumerProject({ tarball: process.env.TESTLANE_PACKAGE_TARBALL });
    before = await installedTreeHash(consumer.packageRoot);
    assert.equal(sha(await readFile(path.join(consumer.packageRoot, 'examples/verification-demo/native.mjs'))), sourceHashes['examples/verification-demo/native.mjs']);
    assert.equal(await lstat(path.join(consumer.packageRoot, 'examples/account-provisioning')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    }), false, 'provider authority is absent from the installed broker inventory');
    checkSignal(); at('owned-local-supabase'); runtime = await startOwnedSupabase({ toolsRoot, outputDir: path.join(output, 'runtime'), signal,
      onStage: value => { if (['owned-network', 'database-start', 'database-bootstrap', 'auth-start', 'control-seed', 'ledger-migration', 'rest-start', 'gateway-start'].includes(value)) at('owned-' + value); } });
    assert.deepEqual(runtime.metadata.privacy, { type: process.platform === 'win32' ? 'windows-dacl' : 'posix-mode',
      currentUserOnly: true, immediateParentVerified: true });
    const controlBefore = await runtime.signInControl(); assert.equal(controlBefore.status, 200);
    assert.equal((await runtime.getUser(controlBefore.accessToken)).status, 200);
    assert.equal((await runtime.ledger('identity', controlBefore.user.id)).role, 'Control');
    at('public-provisioning-refused');
    const unauthenticatedAdmin = await fetch(runtime.authOrigin + '/admin/users', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    observed.unauthenticatedAdminStatus = unauthenticatedAdmin.status;
    assert.equal(unauthenticatedAdmin.status, 401); await unauthenticatedAdmin.body?.cancel();
    const signupPassword = randomBytes(32).toString('base64url'); credentials.push({ password: signupPassword });
    const signup = await fetch(runtime.authOrigin + '/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unreserved-' + randomUUID() + '@example.test', password: signupPassword }),
      redirect: 'error', signal: AbortSignal.timeout(10_000) });
    observed.publicSignupStatus = signup.status;
    assert.equal(signup.status, 422); assert.equal((await signup.json()).error_code, 'signup_disabled');
    app = authMode === 'nextauth' ? await startNextAuthSupabaseApp({ runtime, releaseId, toolsRoot }) : await startSupabaseProvisioningApp({ runtime, releaseId });
    manager = await createProvisioner({ app, root: path.join(output, 'state'), policy: reviewedSupabasePolicy(app.target, releaseId) });
    handle = await manager.beginRun({ runId, releaseId });
    const registry = { version: 1, profiles: Object.fromEntries(['Editor', 'Reviewer'].map(role => [profileFor(role), {
      app: 'testlane-supabase-proof', environment: 'testing', baseUrl: app.origin, strategy: authMode === 'nextauth' ? 'nextauth-credentials' : 'form-post',
      account: { email: emailFor(runId, role), role }, session: { ttlMinutes: 10 },
      options: authMode === 'nextauth' ? { csrfPath: '/api/auth/csrf', callbackPath: '/api/auth/callback/credentials', sessionPath: '/api/auth/session',
        sessionCookieName: cookieName, emailField: 'email', passwordField: 'password', roleField: 'user.role' } :
        { loginPath: '/api/login', bodyFormat: 'json', fields: '{"email":"{{email}}","password":"{{secret}}"}',
          sessionCookieName: cookieName, mePath: '/api/me', emailField: 'email', roleField: 'role' },
    }])) };
    harness = await createRealBrokerHarness({ brokerCli: consumer.brokerCli, registry, support });
    env = { ...harness.env, DEBUG: '', NODE_DEBUG: '', PWDEBUG: '', TMP: sessionRoot, TEMP: sessionRoot, TMPDIR: sessionRoot };
    delete env.NODE_OPTIONS;
    for (const role of ['Editor', 'Reviewer']) {
      checkSignal(); at('create-and-seed-' + role.toLowerCase());
      await manager.createAccount(handle, role, async credential => {
        credentials.push(credential); const profile = profileFor(role); attempted.add(profile);
        assert.equal((await execute(['store', 'set', profile], { input: credential.password })).code, 0);
      });
      at('live-role-' + role.toLowerCase());
      const checked = await execute(['--json', 'check', profileFor(role)]); assert.equal(checked.code, 0);
      const identity = JSON.parse(checked.stdout);
      assert.equal(identity.ok, true); assert.equal(identity.roleSource, 'app'); assert.equal(identity.role, role); assert.equal(identity.email, emailFor(runId, role));
      const file = path.join(sessionRoot, role.toLowerCase() + '.json');
      try {
        assert.equal((await execute(['session', profileFor(role), '--format', 'storage-state', '--out', file])).code, 0);
        const state = JSON.parse(await readFile(file, 'utf8')), found = state.cookies.filter(item => item.name === cookieName);
        assert.equal(found.length, 1);
        if (authMode === 'form-post') assert.match(found[0].value, /^[A-Za-z0-9_-]{43}$/);
        else assert.ok(typeof found[0].value === 'string' && found[0].value.length >= 32 && found[0].value.length < 4096 && !/[\r\n]/.test(found[0].value));
        cookies.set(role, cookieName + '=' + found[0].value);
      } finally { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      assert.deepEqual(await (await api(app, cookies.get(role), '/api/me')).json(), { email: emailFor(runId, role), role });
      assert.equal((await api(app, cookies.get(role), '/api/editor-only')).status, role === 'Editor' ? 200 : 403);
      assert.equal((await api(app, cookies.get(role), '/api/reviewer-only')).status, role === 'Reviewer' ? 200 : 403);
      const credential = credentials.find(item => item.role === role), session = await runtime.signIn(credential.email, credential.password);
      assert.equal(session.status, 200); assert.equal(session.user.id, credential.accountId); assert.equal(tokenExpiresLater(session.accessToken), true);
      providerSessions.set(role, session);
    }
    checkSignal(); at('live-rls');
    const editor = providerSessions.get('Editor'), reviewer = providerSessions.get('Reviewer');
    const inserted = await runtime.rest('POST', '/proof_records', editor.accessToken, { owner_id: editor.user.id, note: 'synthetic' });
    observed.editorInsertStatus = inserted.status; assert.equal(inserted.status, 201); assert.equal(inserted.body.length, 1);
    assert.equal(inserted.body[0].owner_id, editor.user.id); assert.equal(inserted.body[0].note, 'synthetic');
    const denied = await runtime.rest('POST', '/proof_records', reviewer.accessToken, { owner_id: reviewer.user.id, note: 'synthetic' });
    observed.reviewerInsertStatus = denied.status; assert.equal(denied.status, 403); assert.equal(denied.body.code, '42501');
    const removed = await runtime.rest('DELETE', '/proof_records?id=eq.' + inserted.body[0].id, editor.accessToken);
    observed.editorDeleteStatus = removed.status; assert.ok([200, 204].includes(removed.status));
    assert.deepEqual((await runtime.rest('GET', '/proof_records', editor.accessToken)).body, []);
    assert.equal((await api(app, undefined, '/api/me')).status, 401);
    for (const route of ['/api/accounts', '/api/users', '/api/admin', '/api/create', '/api/reset']) assert.equal((await api(app, cookies.get('Editor'), route)).status, 404);
    const owners = (await manager.snapshot()).operations.map(entry => entry.owner);
    at('revoke-before-provider-deletion');
    await runtime.ledger('revoke', owners.find(item => item.role === 'Editor'));
    assert.equal((await runtime.getUser(editor.accessToken)).status, 200, 'the Auth user still exists during the revocation check');
    assert.equal(tokenExpiresLater(editor.accessToken), true);
    observed.revokedAppStatus = (await api(app, cookies.get('Editor'), '/api/me')).status; assert.equal(observed.revokedAppStatus, 401);
    if (authMode === 'nextauth') {
      const response = await api(app, cookies.get('Editor'), '/api/auth/session');
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.ok(session?.user === null || session?.user === undefined, 'framework session exposes no identity after revocation');
    }
    const revokedIdentity = await runtime.rest('POST', '/rpc/whoami', editor.accessToken, {});
    assert.equal(revokedIdentity.status, 200); assert.equal(revokedIdentity.body, null);
    assert.deepEqual((await runtime.rest('GET', '/proof_records', editor.accessToken)).body, []);
    const revokedWrite = await runtime.rest('POST', '/proof_records', editor.accessToken, { owner_id: editor.user.id, note: 'synthetic' });
    observed.revokedInsertStatus = revokedWrite.status; assert.equal(revokedWrite.status, 403); assert.equal(revokedWrite.body.code, '42501');
    at('owned-account-deletion'); assert.equal((await manager.cleanupRun(handle)).cleanup, 'completed');
    for (const [role, session] of providerSessions) {
      at('deleted-provider-rejection-' + role.toLowerCase());
      const appStatus = (await api(app, cookies.get(role), '/api/me')).status;
      observed['deleted' + role + 'AppStatus'] = appStatus; assert.equal(appStatus, 401);
      const providerStatus = (await runtime.getUser(session.accessToken)).status;
      // Pinned GoTrue maps an otherwise valid JWT whose user was deleted to
      // forbidden/user_not_found, rather than an invalid-token 401 response.
      observed['deleted' + role + 'UserStatus'] = providerStatus; assert.equal(providerStatus, 403);
      const refreshed = await runtime.refresh(session.refreshToken);
      observed['deleted' + role + 'RefreshStatus'] = refreshed.status; assert.ok([400, 401].includes(refreshed.status));
    }
    for (const credential of credentials.filter(item => item.role)) {
      at('deleted-signin-refused-' + credential.role.toLowerCase());
      if (authMode === 'form-post') {
        const status = (await login(app, credential)).status;
        observed['deleted' + credential.role + 'SigninStatus'] = status; assert.equal(status, 401);
      }
      const rejected = await execute(['--json', 'check', profileFor(credential.role)]);
      observed['deleted' + credential.role + 'BrokerExit'] = rejected.code; assert.equal(rejected.code, 3);
      if (authMode === 'nextauth') assert.match(rejected.stderr, /credentials rejected/);
    }
    assert.equal((await api(app, cookies.get('Editor'), '/api/accounts')).status, 404);
    assert.equal((await runtime.getUser(controlBefore.accessToken)).status, 200);
    assert.deepEqual(await runtime.ledger('identity', controlBefore.user.id), { id: controlBefore.user.id, email: 'foreign-control@example.test', role: 'Control' });

    at('database-fencing-and-quotas');
    const ownerFor = (id, role, expiresAt = Date.now() + TTL_MS) => ({ targetId: runtime.targetId, policyHash: manager.policyHash, runId: id, releaseId,
      operationId: randomUUID(), role, email: emailFor(id, role), expiresAt });
    const late = ownerFor(randomUUID(), 'Editor'); directOwners.push(late);
    await runtime.ledger('reserve', late); await runtime.ledger('revoke', late);
    const latePassword = randomBytes(32).toString('base64url'); credentials.push({ password: latePassword });
    const createsBefore = runtime.requestCounts().authCreate;
    await assert.rejects(runtime.createOwnedUser(late, latePassword), error => Number.isInteger(error.httpStatus) && [400, 422, 500].includes(error.httpStatus));
    assert.equal(runtime.requestCounts().authCreate, createsBefore + 1);
    const lateState = await runtime.ledger('inspect', late); assert.equal(lateState.present, false); assert.equal(lateState.revoked, true);
    assert.equal((await runtime.getUser(controlBefore.accessToken)).status, 200);
    const quotaRuns = [randomUUID(), randomUUID()], quotaExpiry = Date.now() + TTL_MS;
    const reservations = quotaRuns.flatMap(id => ['Editor', 'Reviewer'].map(role => ownerFor(id, role, quotaExpiry)));
    directOwners.push(...reservations); await Promise.all(reservations.map(owner => runtime.ledger('reserve', owner)));
    const overflow = ownerFor(randomUUID(), 'Editor');
    await assert.rejects(runtime.ledger('reserve', overflow), { code: 'PROVISION_QUOTA_REFUSED' });
    for (const owner of reservations) await runtime.ledger('revoke', owner);
    // Two real users, one delayed-create reservation and four concurrent slots
    // consumed seven attempts. Churn must not reset the shared hourly ledger.
    for (let i = 0; i < 3; i++) {
      const owner = ownerFor(randomUUID(), 'Editor'); directOwners.push(owner);
      await runtime.ledger('reserve', owner); await runtime.ledger('revoke', owner);
    }
    await assert.rejects(runtime.ledger('reserve', ownerFor(randomUUID(), 'Editor')), { code: 'PROVISION_QUOTA_REFUSED' });
    for (const owner of directOwners) await app.revokeDeleteOwned(owner);
    const summary = await runtime.summary();
    assert.equal(summary.ownedAccounts, 0); assert.equal(summary.activeReservations, 0); assert.equal(summary.pendingDeliveries, 0); assert.equal(summary.proofRecords, 0); assert.equal(summary.controlPresent, true);
    assert.equal((await runtime.getUser(controlBefore.accessToken)).status, 200);
    assert.equal(await installedTreeHash(consumer.packageRoot), before); assert.deepEqual(await sources(), sourceHashes);
    const metadata = JSON.parse(await readFile(path.join(consumer.packageRoot, 'package.json'), 'utf8'));
    receipt = { schemaVersion: 1, experiment: 'source-only local Supabase Auth/database provisioning', passed: true,
      hostedProjectTested: false, authentication: app.authentication, prototypeIncludedInInstalledPackage: false, releaseId, sourceHashes,
      brokerArtifactMode: process.env.TESTLANE_PACKAGE_TARBALL ? 'supplied-tarball' : 'fresh-source-pack',
      installedBrokerVersion: metadata.version, installedBrokerTreeSha256: before, nativeStore: support.store,
      provider: runtime.metadata, roles: ['Editor', 'Reviewer'], oldAppSessionsRefused: 2, deletedAccountSignInRefused: 2,
      privateScratchAndSessionDirectories: true,
      liveGrantBlocksUnexpiredJwt: true, liveGrantCheckedBeforeProviderDeletion: true, directRlsChecked: true,
      lateCreateFenced: true, databaseQuotaChecked: true, rateLimitSurvivesChurn: true, foreignControlUnchanged: true,
      ownedAccountsRemaining: 0, controllerRoutesExposed: false, observed, cleanupVerified: false, credentialLeakScanPassed: false };
  } catch (error) { failure = error; }
  finally {
    const failedStage = stage; at('cleanup');
    if (!terminationConfirmed) cleanupIssue('owned-child-stop');
    // Inspect and remove only rows independently returned for this owned user
    // before revoking its grant. RLS failure never authorizes a broad delete.
    if (runtime && providerSessions.has('Editor')) try {
      const session = providerSessions.get('Editor'), rows = await runtime.rest('GET', '/proof_records', session.accessToken);
      assert.equal(rows.status, 200); assert.ok(Array.isArray(rows.body));
      for (const row of rows.body) {
        assert.equal(row.owner_id, session.user.id); assert.equal(row.note, 'synthetic');
        assert.match(row.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        assert.ok([200, 204].includes((await runtime.rest('DELETE', '/proof_records?id=eq.' + row.id, session.accessToken)).status));
      }
    } catch { cleanupIssue('owned-record-cleanup'); }
    if (manager && handle) try { await manager.cleanupRun(handle); } catch { cleanupIssue('coordinator-cleanup'); }
    if (app) for (const owner of directOwners) try { await app.revokeDeleteOwned(owner); } catch { cleanupIssue('direct-owner-cleanup'); }
    if (runtime) try {
      const summary = await runtime.summary(); accountCleanupConfirmed = summary.ownedAccounts === 0 && summary.activeReservations === 0 && summary.pendingDeliveries === 0 && summary.proofRecords === 0;
      if (!accountCleanupConfirmed) cleanupIssue('account-summary');
    } catch { cleanupIssue('account-summary'); }
    if (harness && terminationConfirmed) for (const profile of attempted) {
      try {
        if ((await execute(['store', 'delete', profile], { signal: null })).code !== 0) cleanupIssue('native-entry-delete');
        if ((await execute(['check', profile], { signal: null })).code !== 4) cleanupIssue('native-entry-absence');
      } catch { cleanupIssue('native-entry-cleanup'); }
      if (!terminationConfirmed) break;
    }
    const material = credentials.map(item => item.password).concat(app?.issuedSessionTokens() ?? []);
    try { await app?.close(); } catch { cleanupIssue('application-close'); }
    try {
      const closed = await runtime?.close({ preserveData: !accountCleanupConfirmed });
      if (runtime && closed?.cleanupVerified !== true) cleanupIssue('provider-close');
    } catch { cleanupIssue('provider-close'); }
    try {
      if (consumer && (await readdir(consumer.sessionTemp)).length) cleanupIssue('session-file-absence');
      if (sessionRoot && (await readdir(sessionRoot)).length) cleanupIssue('session-file-absence');
      const retained = captured + (runtime?.capturedText() ?? '') + await textTree(output) + (harness ? await textTree(harness.root) : '') + (consumer ? await textTree(consumer.sessionTemp) : '');
      assertNoLeaks(retained, material); runtime?.assertNoLeaks(retained);
    } catch { cleanupIssue('retained-artifact-scan'); }
    if (!cleanupFailed) {
      try { await harness?.dispose(); } catch { cleanupIssue('native-home-disposal'); }
      if (!cleanupFailed) try { await consumer?.dispose(); } catch { cleanupIssue('consumer-disposal'); }
    }
    if (!cleanupFailed) for (const directory of [scratchRoot, sessionRoot].filter(Boolean)) try {
      await assertPrivateRuntimeDirectory(directory); assert.equal((await readdir(directory)).length, 0); await rmdir(directory);
    } catch { cleanupIssue('private-directory-disposal'); }
    restoreTemporaryEnvironment();
    if (cleanupFailed) {
      await writeFile(path.join(output, 'recovery.json'), canonical({ schemaVersion: 1, status: 'manual-inspection-required', stage: failedStage,
        nativeHome: harness?.root ?? null, consumerRoot: consumer?.root ?? null, attemptedProfiles: [...attempted],
        childTerminationConfirmed: terminationConfirmed, unconfirmedOwnedChildPids: [...unconfirmedOwnedChildPids], accountCleanupConfirmed,
        cleanupFailures: [...cleanupFailures].sort() }) + '\n', { flag: 'wx', mode: 0o600 });
      throw Error('SUPABASE_PROOF_CLEANUP_INCOMPLETE');
    }
    if (failure) await writeFile(path.join(output, 'failure.json'), canonical({ schemaVersion: 1, stage: failedStage, code: 'SUPABASE_PROOF_FAILED', observed }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (failure) throw Error('SUPABASE_PROOF_FAILED');
  receipt.cleanupVerified = true; receipt.credentialLeakScanPassed = true;
  return finalizeProvisioningProof({ outputDir: output, receipt, kind: 'supabase', signal });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = { '--tools-root': 'toolsRoot', '--output-dir': 'outputDir', '--auth-mode': 'authMode' }[args[i]];
    if (!key || options[key] || !args[i + 1]) throw Error('SUPABASE_PROOF_ARGUMENTS_INVALID'); options[key] = args[++i];
  }
  if (!options.toolsRoot || !options.outputDir) throw Error('SUPABASE_PROOF_ARGUMENTS_INVALID');
  const controller = new AbortController(), cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log(JSON.stringify(await runSupabaseProvisioningProof({ ...options, signal: controller.signal,
    onStage: stage => console.log('SUPABASE_PROOF_STAGE ' + stage) }))); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
function entry() {
  try { const a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url)); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return false; }
}
if (entry()) main().catch(() => { console.error('SUPABASE_PROOF_FAILED: inspect private fixed-code recovery evidence'); process.exitCode = 1; });
