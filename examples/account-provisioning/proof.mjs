#!/usr/bin/env node
/** Source-only adapter acceptance through a freshly installed real broker. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerProject, assertNoLeaks } from '../playwright/tests/consumer.mjs';
import { createRealBrokerHarness, realBrokerSupport } from '../workflows/test-support/real-broker.mjs';
import { runDemoChild } from '../verification-demo/native.mjs';
import { startProvisioningApp } from './app.mjs';
import { createProvisioner } from './controller.mjs';
import { canonical, emailFor, reviewedSyntheticPolicy } from './contracts.mjs';
import { assertPrivateRuntimeDirectory, createPrivateRuntimeDirectory } from './supabase/tools/private-directory.mjs';
import { finalizeProvisioningProof } from './proof-finalization.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sha = value => createHash('sha256').update(value).digest('hex');
async function sources() { return Object.fromEntries(await Promise.all(['contracts.mjs', 'app.mjs', 'controller.mjs', 'proof.mjs'].map(async file => [file, sha(await readFile(path.join(HERE, file)))]))); }
async function supportSources() {
  return Object.fromEntries(await Promise.all(['examples/verification-demo/native.mjs', 'examples/playwright/tests/consumer.mjs',
    'examples/workflows/test-support/real-broker.mjs', 'examples/account-provisioning/supabase/tools/private-directory.mjs',
    'examples/account-provisioning/supabase/tools/process.mjs', 'examples/account-provisioning/proof-finalization.mjs']
    .map(async file => [file, sha(await readFile(path.join(REPO, file)))])));
}
/** Source-only proof setup. Reuses the provider's platform permission verifier. */
export async function prepareProvisioningProofDirectories(outputDir, { signal } = {}) {
  signal?.throwIfAborted();
  assert.ok(typeof outputDir === 'string' && path.isAbsolute(outputDir), 'a NEW absolute output directory is required');
  const output = path.resolve(outputDir);
  await createPrivateRuntimeDirectory(output, { signal });
  const sessionRoot = await createPrivateRuntimeDirectory(path.join(output, 'sessions'), { signal });
  const scratchRoot = await createPrivateRuntimeDirectory(path.join(output, 'scratch'), { signal });
  signal?.throwIfAborted();
  // Reused consumer and broker helpers consult os.tmpdir() on creation AND
  // disposal. Lease these values until their owned children and trees settle.
  const keys = ['TMP', 'TEMP', 'TMPDIR', 'NODE_DISABLE_COMPILE_CACHE'];
  const previous = keys.map(key => [key, Object.hasOwn(process.env, key), process.env[key]]);
  for (const key of ['TMP', 'TEMP', 'TMPDIR']) process.env[key] = scratchRoot;
  process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [key, present, value] of previous) {
      if (present) process.env[key] = value; else delete process.env[key];
    }
  };
  return Object.freeze({ output, sessionRoot, scratchRoot, restore,
    async removeEmpty() {
      for (const directory of [scratchRoot, sessionRoot]) {
        await assertPrivateRuntimeDirectory(directory);
        assert.equal((await readdir(directory)).length, 0, 'private proof directories must be empty before disposal');
      }
      for (const directory of [scratchRoot, sessionRoot]) {
        await rmdir(directory);
      }
    },
  });
}
async function tree(root) {
  const entries = [];
  async function walk(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.equal(item.isSymbolicLink(), false, 'owned proof paths must not be symlinks');
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file); else if (item.isFile()) entries.push([path.relative(root, file).replaceAll('\\', '/'), await readFile(file)]);
    }
  }
  await walk(root); return entries;
}
export const installedTreeHash = async root => sha(canonical((await tree(root))
  .map(([name, bytes]) => [name, sha(bytes)])
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const textTree = async root => (await tree(root)).map(([, bytes]) => bytes.toString('utf8')).join('\n');
async function api(app, cookie, route) { return fetch(app.origin + route, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(5000) }); }
async function login(app, credential) {
  return fetch(app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credential.email, password: credential.password }), redirect: 'error', signal: AbortSignal.timeout(5000) });
}
export async function runProvisioningProof({ outputDir, signal, onStage = () => {} } = {}) {
  signal?.throwIfAborted();
  const support = realBrokerSupport();
  assert.ok(support.supported, 'requires Windows DPAPI or explicitly isolated Linux Secret Service');
  assert.ok(typeof outputDir === 'string' && path.isAbsolute(outputDir), 'a NEW absolute output directory is required');
  const output = path.resolve(outputDir);
  const sourceHashes = await sources(), supportHashes = await supportSources(), releaseId = sha(canonical({ sourceHashes, supportHashes })), runId = randomUUID();
  const credentials = [], cookies = new Map(), attempted = new Set(), namespace = 'provision-' + randomBytes(8).toString('hex');
  const unconfirmedOwnedChildPids = new Set();
  const profileFor = role => namespace + ':testing:' + role.toLowerCase();
  let app, manager, handle, consumer, harness, env, before, receipt, failure, storage, captured = '', terminationConfirmed = true, cleanupFailed = false, stage = 'setup';
  const at = value => { stage = value; onStage(value); };
  const execute = async (args, options = {}) => {
    try { const result = await runDemoChild({ entry: consumer.brokerCli, args, cwd: consumer.root, env, timeoutMs: 35_000, signal, ...options }); captured += result.stdout + result.stderr; return result; }
    catch (error) {
      if (error.message === 'DEMO_CHILD_TERMINATION_UNCONFIRMED') {
        terminationConfirmed = false;
        if (Number.isSafeInteger(error.ownedChildPid) && error.ownedChildPid > 0) unconfirmedOwnedChildPids.add(error.ownedChildPid);
      }
      throw error;
    }
  };
  try {
    at('private-session-directory'); storage = await prepareProvisioningProofDirectories(output, { signal });
    await writeFile(path.join(output, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    at('installed-broker'); consumer = await consumerProject({ tarball: process.env.TESTLANE_PACKAGE_TARBALL }); before = await installedTreeHash(consumer.packageRoot);
    assert.equal(sha(await readFile(path.join(consumer.packageRoot, 'examples/verification-demo/native.mjs'))), supportHashes['examples/verification-demo/native.mjs'],
      'the actual imported bounded native helper must match the installed broker helper');
    assert.equal(await lstat(path.join(consumer.packageRoot, 'examples/account-provisioning')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false,
      'the installed broker package does not silently acquire experimental account authority');
    at('local-target'); app = await startProvisioningApp();
    const foreign = { email: 'foreign-control@example.test', password: randomBytes(32).toString('base64url'), role: 'Editor' }; credentials.push(foreign);
    app.seedForeign(foreign); const foreignBefore = app.snapshot();
    const foreignLogin = await login(app, foreign); assert.equal(foreignLogin.status, 200);
    const foreignCookie = foreignLogin.headers.get('set-cookie').split(';')[0];
    const policy = reviewedSyntheticPolicy(app.target, releaseId);
    manager = await createProvisioner({ app, root: path.join(output, 'state'), policy }); handle = await manager.beginRun({ runId, releaseId });
    const profiles = { version: 1, profiles: Object.fromEntries(['Editor', 'Reviewer'].map(role => [profileFor(role), {
      app: 'testlane-account-provisioning', environment: 'testing', baseUrl: app.origin, strategy: 'form-post',
      account: { email: emailFor(runId, role), role }, session: { ttlMinutes: 10 },
      options: { loginPath: '/api/login', bodyFormat: 'json', fields: '{"email":"{{email}}","password":"{{secret}}"}',
        sessionCookieName: 'tlp_session', mePath: '/api/me', emailField: 'email', roleField: 'role' },
    }])) };
    harness = await createRealBrokerHarness({ brokerCli: consumer.brokerCli, registry: profiles, support });
    env = { ...harness.env, DEBUG: '', NODE_DEBUG: '', PWDEBUG: '', TMP: storage.sessionRoot, TEMP: storage.sessionRoot, TMPDIR: storage.sessionRoot };
    delete env.NODE_OPTIONS;
    const roleResults = [];
    for (const role of ['Editor', 'Reviewer']) {
      signal?.throwIfAborted(); at('create-and-seed-' + role.toLowerCase());
      await manager.createAccount(handle, role, async credential => {
        credentials.push(credential); const profile = profileFor(role); attempted.add(profile);
        assert.equal((await execute(['store', 'set', profile], { input: credential.password })).code, 0, 'seed generated password through stdin');
      });
      at('live-role-' + role.toLowerCase());
      const check = await execute(['--json', 'check', profileFor(role)]); assert.equal(check.code, 0);
      const identity = JSON.parse(check.stdout);
      assert.equal(identity.ok, true); assert.equal(identity.roleSource, 'app'); assert.equal(identity.role, role); assert.equal(identity.email, emailFor(runId, role));
      const file = path.join(storage.sessionRoot, role.toLowerCase() + '.json');
      try {
        assert.equal((await execute(['session', profileFor(role), '--format', 'storage-state', '--out', file])).code, 0);
        const state = JSON.parse(await readFile(file, 'utf8')), found = state.cookies.filter(item => item.name === 'tlp_session');
        assert.equal(found.length, 1); assert.match(found[0].value, /^[A-Za-z0-9_-]{43}$/); cookies.set(role, 'tlp_session=' + found[0].value);
      } finally { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      assert.deepEqual(await (await api(app, cookies.get(role), '/api/me')).json(), { email: emailFor(runId, role), role });
      assert.equal((await api(app, cookies.get(role), '/api/editor-only')).status, role === 'Editor' ? 200 : 403);
      assert.equal((await api(app, cookies.get(role), '/api/reviewer-only')).status, role === 'Reviewer' ? 200 : 403);
      roleResults.push({ role, liveIdentityVerified: true, allowedOperation: 200, deniedOperation: 403 });
    }
    assert.equal((await api(app, undefined, '/api/me')).status, 401);
    for (const route of ['/api/accounts', '/api/users', '/api/admin', '/api/create', '/api/reset']) assert.equal((await api(app, cookies.get('Editor'), route)).status, 404);
    at('owned-account-revocation'); assert.equal((await manager.cleanupRun(handle)).cleanup, 'completed');
    assert.equal(app.snapshot().filter(item => item.owner?.runId === runId).length, 0);
    for (const cookie of cookies.values()) assert.equal((await api(app, cookie, '/api/me')).status, 401, 'old live session is refused before server shutdown');
    for (const credential of credentials.filter(item => item.accountId)) assert.equal((await login(app, credential)).status, 401);
    assert.deepEqual(app.snapshot(), foreignBefore); assert.equal((await api(app, foreignCookie, '/api/me')).status, 200);
    assert.equal(await installedTreeHash(consumer.packageRoot), before); assert.deepEqual(await sources(), sourceHashes);
    assert.deepEqual(await supportSources(), supportHashes);
    const metadata = JSON.parse(await readFile(path.join(consumer.packageRoot, 'package.json'), 'utf8'));
    receipt = { schemaVersion: 1, experiment: 'source-only synthetic account provisioning; no provider integration or public CLI/MCP authority',
      passed: true, prototypeSourceOnly: true, prototypeIncludedInInstalledPackage: false, releaseId, sourceHashes, supportHashes,
      installedNativeHelperSha256: supportHashes['examples/verification-demo/native.mjs'],
      brokerArtifactMode: process.env.TESTLANE_PACKAGE_TARBALL ? 'supplied-tarball' : 'fresh-source-pack',
      installedBrokerVersion: metadata.version, installedBrokerTreeSha256: before, nativeStore: support.store,
      roles: roleResults, ownedAccountsRemaining: 0, oldSessionsRefused: 2, deletedAccountSignInRefused: 2, foreignAccountUnchanged: true,
      controllerRoutesExposed: false, nativeEntriesRemoved: 2, cleanupVerified: false, credentialLeakScanPassed: false };
    receipt.privateScratchAndSessionDirectories = true;
  } catch (error) { failure = error; }
  finally {
    at('cleanup');
    if (!terminationConfirmed) cleanupFailed = true;
    if (manager && handle) try { await manager.cleanupRun(handle); } catch { cleanupFailed = true; }
    // Every seed command was awaited through the bounded owned-child helper.
    // An unconfirmed child may still write later: never claim store cleanup then.
    if (harness && terminationConfirmed) for (const profile of attempted) {
      try { if ((await execute(['store', 'delete', profile], { signal: null })).code !== 0) cleanupFailed = true;
        if ((await execute(['check', profile], { signal: null })).code !== 4) cleanupFailed = true; }
      catch { cleanupFailed = true; }
      if (!terminationConfirmed) break;
    }
    try {
      if (consumer && (await readdir(consumer.sessionTemp)).length) cleanupFailed = true;
      if (storage && (await readdir(storage.sessionRoot)).length) cleanupFailed = true;
      const material = credentials.map(item => item.password).concat(app?.issuedSessionTokens() ?? []);
      assertNoLeaks(captured + await textTree(output) + (harness ? await textTree(harness.root) : '') + (consumer ? await textTree(consumer.sessionTemp) : ''), material);
    } catch { cleanupFailed = true; }
    if (app?.snapshot().some(item => item.owner !== null)) cleanupFailed = true;
    try { await app?.close(); } catch { cleanupFailed = true; }
    if (!cleanupFailed) {
      try { await harness?.dispose(); } catch { cleanupFailed = true; }
      if (!cleanupFailed) try { await consumer?.dispose(); } catch { cleanupFailed = true; }
    }
    if (!cleanupFailed && storage) try { await storage.removeEmpty(); } catch { cleanupFailed = true; }
    storage?.restore();
    if (cleanupFailed) {
      if (storage) await writeFile(path.join(output, 'recovery.json'), canonical({ schemaVersion: 1, status: 'manual-inspection-required', stage,
        profiles: [...attempted], nativeHome: harness?.root ?? null, consumerRoot: consumer?.root ?? null,
        childTerminationConfirmed: terminationConfirmed, unconfirmedOwnedChildPids: [...unconfirmedOwnedChildPids] }) + '\n', { mode: 0o600 });
      throw new Error('PROVISION_PROOF_CLEANUP_INCOMPLETE');
    }
  }
  if (failure) throw new Error('PROVISION_PROOF_FAILED');
  receipt.cleanupVerified = true; receipt.credentialLeakScanPassed = true;
  return finalizeProvisioningProof({ outputDir: output, receipt, kind: 'synthetic', signal });
}
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--output-dir') throw new Error('PROVISION_PROOF_ARGUMENTS_INVALID');
  const controller = new AbortController(), cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log(JSON.stringify(await runProvisioningProof({ outputDir: process.argv[3], signal: controller.signal,
    onStage: stage => console.log('PROVISION_PROOF_STAGE ' + stage) }))); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
function isEntryPoint() {
  try { const a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url)); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return false; }
}
if (isEntryPoint()) try { await main(); } catch { console.error('PROVISION_PROOF_FAILED: inspect private recovery evidence; no provider support is established'); process.exitCode = 1; }
