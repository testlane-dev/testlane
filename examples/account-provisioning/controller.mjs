/** Single-host durable capability/quota ledger for the fixed synthetic adapter. */
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isSyntheticApp } from './app.mjs';
import { canonical, digest, emailFor, exact, fail, HASH, ProvisionError, ROLES, UUID, validOwner, validatePolicy, WINDOW_MS } from './contracts.mjs';

const STATES = ['creating', 'created', 'seeding', 'ready', 'create-unknown', 'seed-unknown', 'deleted'];
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function createProvisioner({ app, root: requested, policy: input, now = Date.now } = {}) {
  if (!isSyntheticApp(app)) throw fail('PROVISION_TARGET_REFUSED');
  const policy = validatePolicy(input, app.target), policyHash = digest(policy);
  if (typeof now !== 'function' || typeof requested !== 'string' || !path.isAbsolute(requested) || /[\r\n\0]/.test(requested)) throw fail('PROVISION_INPUT_REFUSED');
  const root = path.resolve(requested), parent = await realpath(path.dirname(root));
  if (!samePath(parent, path.dirname(root)) || (await lstat(parent)).isSymbolicLink()) throw fail('PROVISION_STATE_INVALID');
  const markerFile = path.join(root, 'owner.json'), stateFile = path.join(root, 'ledger.json'), lock = path.join(root, 'ledger.lock');
  const bound = app.coordinatorBinding();
  if (bound && (!samePath(bound.root, root) || bound.policyHash !== policyHash)) throw fail('PROVISION_STATE_INVALID');
  let nonce, fresh = false;
  if (bound) { const info = await lstat(root).catch(() => null); if (!info || !info.isDirectory() || info.isSymbolicLink()) throw fail('PROVISION_STATE_INVALID'); }
  try { await mkdir(root, { mode: 0o700 }); fresh = true; }
  catch (error) { if (error.code !== 'EEXIST') throw fail('PROVISION_STATE_IO_FAILED'); }
  async function plainFile(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || !samePath(await realpath(file), file)) throw fail('PROVISION_STATE_INVALID');
  }
  async function assertRoot() {
    if ((await lstat(root)).isSymbolicLink() || !samePath(await realpath(root), root)) throw fail('PROVISION_STATE_INVALID');
    await plainFile(markerFile);
    const marker = JSON.parse(await readFile(markerFile, 'utf8'));
    if (!exact(marker, ['schemaVersion', 'nonce', 'targetId', 'policyHash']) || marker.schemaVersion !== 1 || marker.nonce !== nonce ||
      marker.targetId !== app.target.targetId || marker.policyHash !== policyHash) throw fail('PROVISION_STATE_INVALID');
  }
  async function durable(file, value, exclusive = false) {
    const temporary = exclusive ? file : path.join(root, 'write-' + randomUUID() + '.json');
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(canonical(value) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
      if (!exclusive) await rename(temporary, file);
      if (process.platform !== 'win32') { const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } catch { throw fail('PROVISION_STATE_IO_FAILED'); }
    finally { await handle?.close().catch(() => {}); if (!exclusive) await unlink(temporary).catch(() => {}); }
  }
  function validateState(state) {
    if (!exact(state, ['schemaVersion', 'targetId', 'policyHash', 'lastNow', 'runs', 'operations']) || state.schemaVersion !== 1 ||
      state.targetId !== app.target.targetId || state.policyHash !== policyHash || !Number.isSafeInteger(state.lastNow) || state.lastNow < 0 ||
      !Array.isArray(state.runs) || state.runs.length > 1000 || !Array.isArray(state.operations) || state.operations.length > 1000) throw fail('PROVISION_STATE_INVALID');
    const ids = new Set(), operations = new Set(), roles = new Set();
    for (const run of state.runs) {
      if (!exact(run, ['runId', 'releaseId', 'expiresAt', 'status']) || typeof run.runId !== 'string' || !UUID.test(run.runId) || ids.has(run.runId) ||
        run.releaseId !== policy.releaseId || !Number.isSafeInteger(run.expiresAt) || run.expiresAt < 1 || !['active', 'recovery-required', 'cleaning', 'released'].includes(run.status)) throw fail('PROVISION_STATE_INVALID');
      ids.add(run.runId);
    }
    for (const entry of state.operations) {
      const run = state.runs.find(run => run.runId === entry.owner?.runId), slot = entry.owner?.runId + ':' + entry.owner?.role;
      if (!exact(entry, ['owner', 'accountId', 'status', 'createdAt']) || !validOwner(entry.owner) || entry.owner.targetId !== state.targetId || entry.owner.policyHash !== policyHash ||
        !run || entry.owner.releaseId !== run.releaseId || entry.owner.expiresAt !== run.expiresAt || operations.has(entry.owner.operationId) || roles.has(slot) ||
        (entry.accountId !== null && (typeof entry.accountId !== 'string' || !UUID.test(entry.accountId))) || !STATES.includes(entry.status) ||
        !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || entry.createdAt > entry.owner.expiresAt) throw fail('PROVISION_STATE_INVALID');
      operations.add(entry.owner.operationId); roles.add(slot);
    }
    return state;
  }
  async function readState() {
    try { await assertRoot(); await plainFile(stateFile); return validateState(JSON.parse(await readFile(stateFile, 'utf8'))); }
    catch { throw fail('PROVISION_STATE_INVALID'); }
  }
  if (fresh) {
    if (bound) throw fail('PROVISION_STATE_INVALID');
    nonce = randomBytes(32).toString('hex');
    await durable(markerFile, { schemaVersion: 1, nonce, targetId: app.target.targetId, policyHash }, true);
    await durable(stateFile, { schemaVersion: 1, targetId: app.target.targetId, policyHash, lastNow: 0, runs: [], operations: [] }, true);
  } else {
    if ((await lstat(root)).isSymbolicLink() || !samePath(await realpath(root), root)) throw fail('PROVISION_STATE_INVALID');
    await plainFile(markerFile); let marker; try { marker = JSON.parse(await readFile(markerFile, 'utf8')); } catch { throw fail('PROVISION_STATE_INVALID'); }
    if (typeof marker.nonce !== 'string' || !HASH.test(marker.nonce) || (bound && marker.nonce !== bound.nonce)) throw fail('PROVISION_STATE_INVALID'); nonce = marker.nonce;
    await readState();
  }
  app.bindCoordinator({ root, policyHash, nonce });
  async function transaction(callback, allowRollback = false) {
    await assertRoot(); const deadline = Date.now() + 3000; let acquired = false;
    while (!acquired) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw fail('PROVISION_STATE_IO_FAILED');
        const info = await lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw fail('PROVISION_STATE_INVALID'); });
        if (!info) continue;
        if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PROVISION_STATE_INVALID');
        if (Date.now() >= deadline) throw fail('PROVISION_STATE_LOCKED'); await sleep(20);
      }
    }
    try {
      const state = await readState(), clock = now();
      if (!Number.isSafeInteger(clock) || clock < 0 || (!allowRollback && clock < state.lastNow)) throw fail('PROVISION_CLOCK_REFUSED');
      const current = Math.max(clock, state.lastNow); state.lastNow = current;
      const before = structuredClone(state); let result;
      try { result = await callback(state, current); validateState(state); }
      catch (error) { await durable(stateFile, before); throw error; }
      await durable(stateFile, state); return result;
    } catch (error) { if (error instanceof ProvisionError) throw error; throw fail('PROVISION_STATE_INVALID'); }
    finally {
      const info = await lstat(lock).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(lock), lock)) await rmdir(lock);
      else throw fail('PROVISION_STATE_INVALID');
    }
  }
  function matchingRun(state, handle) {
    if (!exact(handle, ['runId', 'releaseId', 'expiresAt', 'policyHash', 'targetId']) || handle.policyHash !== policyHash || handle.targetId !== app.target.targetId) throw fail('PROVISION_RUN_REFUSED');
    const run = state.runs.find(run => run.runId === handle.runId);
    if (!run || run.releaseId !== handle.releaseId || run.expiresAt !== handle.expiresAt) throw fail('PROVISION_RUN_REFUSED'); return run;
  }
  const handleFor = run => Object.freeze({ runId: run.runId, releaseId: run.releaseId, expiresAt: run.expiresAt, policyHash, targetId: app.target.targetId });
  async function markUnknown(handle, operationId, status) {
    await transaction(state => { const run = matchingRun(state, handle), entry = state.operations.find(item => item.owner.operationId === operationId);
      if (entry && entry.status !== 'deleted') { entry.status = status; run.status = 'recovery-required'; } }, true);
  }
  return Object.freeze({
    policyHash,
    async beginRun({ runId, releaseId } = {}) {
      if (typeof runId !== 'string' || !UUID.test(runId) || releaseId !== policy.releaseId) throw fail('PROVISION_RUN_REFUSED');
      return transaction((state, current) => {
        if (state.runs.some(run => ['recovery-required', 'cleaning'].includes(run.status)) || state.operations.some(entry => !['ready', 'deleted'].includes(entry.status))) throw fail('PROVISION_CLEANUP_INCOMPLETE');
        if (state.runs.some(run => run.runId === runId)) throw fail('PROVISION_REPLAY_REFUSED');
        const run = { runId, releaseId, expiresAt: current + policy.ttlMs, status: 'active' }; state.runs.push(run); return handleFor(run);
      });
    },
    async createAccount(handle, role, acceptCredential) {
      if (!ROLES.includes(role)) throw fail('PROVISION_ROLE_REFUSED');
      if (typeof acceptCredential !== 'function') throw fail('PROVISION_INPUT_REFUSED');
      const owner = await transaction((state, current) => {
        const run = matchingRun(state, handle);
        if (run.status !== 'active') throw fail('PROVISION_RUN_REFUSED'); if (current >= run.expiresAt) throw fail('PROVISION_EXPIRED');
        const mine = state.operations.filter(entry => entry.owner.runId === run.runId);
        if (mine.some(entry => entry.owner.role === role)) throw fail('PROVISION_REPLAY_REFUSED');
        if (mine.length >= policy.maxAccountsPerRun || state.operations.filter(entry => entry.status !== 'deleted').length >= policy.maxActiveAccounts ||
          state.operations.filter(entry => entry.createdAt > current - WINDOW_MS).length >= policy.maxCreateAttemptsPerHour) throw fail('PROVISION_QUOTA_REFUSED');
        const owner = { targetId: app.target.targetId, policyHash, runId: run.runId, releaseId: run.releaseId, operationId: randomUUID(), role,
          email: emailFor(run.runId, role), expiresAt: run.expiresAt };
        state.operations.push({ owner, accountId: null, status: 'creating', createdAt: current }); return structuredClone(owner);
      });
      let password = randomBytes(32).toString('base64url'), created, phase = 'create';
      try {
        try { created = await app.createOwned(owner, password); }
        catch { await markUnknown(handle, owner.operationId, 'create-unknown'); throw fail('PROVISION_CREATE_UNKNOWN'); }
        if (!exact(created, ['id']) || !UUID.test(created.id)) { await markUnknown(handle, owner.operationId, 'create-unknown'); throw fail('PROVISION_CREATE_UNKNOWN'); }
        await transaction(state => { const run = matchingRun(state, handle), entry = state.operations.find(item => item.owner.operationId === owner.operationId);
          if (run.status !== 'active' || entry.status === 'deleted') throw fail('PROVISION_RUN_REFUSED'); entry.accountId = created.id; entry.status = 'seeding'; });
        phase = 'seed';
        app.beginCredentialDelivery(owner);
        try { await acceptCredential(Object.freeze({ email: owner.email, password, role, accountId: created.id })); }
        catch { await markUnknown(handle, owner.operationId, 'seed-unknown'); throw fail('PROVISION_SEED_UNKNOWN'); }
        finally { app.endCredentialDelivery(owner); }
        await transaction(state => { const run = matchingRun(state, handle), entry = state.operations.find(item => item.owner.operationId === owner.operationId);
          if (run.status !== 'active' || entry.status !== 'seeding') throw fail('PROVISION_RUN_REFUSED'); entry.status = 'ready'; });
        return Object.freeze({ id: created.id, role, expiresAt: owner.expiresAt });
      } catch (error) {
        // A post-create/post-seed ledger failure is still unresolved even if the
        // provider or private credential sink already committed successfully.
        await markUnknown(handle, owner.operationId, phase === 'seed' ? 'seed-unknown' : 'create-unknown');
        if (error instanceof ProvisionError) throw error;
        throw fail(phase === 'seed' ? 'PROVISION_SEED_UNKNOWN' : 'PROVISION_CREATE_UNKNOWN');
      } finally { password = undefined; }
    },
    async cleanupRun(handle) {
      const entries = await transaction(state => { const run = matchingRun(state, handle); run.status = 'cleaning';
        return structuredClone(state.operations.filter(entry => entry.owner.runId === run.runId)); }, true);
      try {
        for (const entry of entries) {
          const before = app.inspectOwned(entry.owner);
          if (entry.accountId !== null && before.present && before.id !== entry.accountId) throw fail('PROVISION_OWNERSHIP_REFUSED');
          app.revokeDeleteOwned(entry.owner);
          const absent = app.inspectOwned(entry.owner);
          if (absent.present || absent.revoked !== true || absent.deliveryPending) throw fail('PROVISION_CLEANUP_INCOMPLETE');
          await transaction(state => { const item = state.operations.find(item => item.owner.operationId === entry.owner.operationId); item.status = 'deleted'; }, true);
        }
        await transaction(state => { const run = matchingRun(state, handle);
          if (state.operations.some(entry => entry.owner.runId === run.runId && entry.status !== 'deleted')) throw fail('PROVISION_CLEANUP_INCOMPLETE'); run.status = 'released'; }, true);
        return { scope: 'accounts-and-sessions', cleanup: 'completed', operations: entries.length };
      } catch { throw fail('PROVISION_CLEANUP_INCOMPLETE'); }
    },
    async recoverRun(runId) {
      return transaction(state => { const run = state.runs.find(item => item.runId === runId); if (!run) throw fail('PROVISION_RUN_REFUSED'); return handleFor(run); }, true);
    },
    async snapshot() { return structuredClone(await readState()); },
  });
}
