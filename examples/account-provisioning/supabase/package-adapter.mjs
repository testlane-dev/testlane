/** Test-only bridge to the branded, disposable local provider. Never an existing-project installer. */
import { isSupabaseApp } from './app.mjs';
import { isOwnedSupabaseRuntime } from './runtime.mjs';
import { exact, HASH, validOwner } from '../contracts.mjs';

const refuse = () => new Error('PACKAGE_ACCOUNT_ADAPTER_REFUSED');
export function createPackageProofAdapter({ app, runtime, releaseId }) {
  if (!isSupabaseApp(app) || !isOwnedSupabaseRuntime(runtime) || app.target.targetId !== runtime.targetId || !HASH.test(releaseId ?? '')) throw refuse();
  const target = Object.freeze({ id: runtime.targetId, origin: app.origin, environment: 'testing' });
  function owner(value) {
    if (!exact(value, ['targetId', 'bindingHash', 'runId', 'operationId', 'role', 'email', 'expiresAt'])) throw refuse();
    const mapped = { targetId: value.targetId, policyHash: value.bindingHash, runId: value.runId, releaseId,
      operationId: value.operationId, role: value.role, email: value.email, expiresAt: value.expiresAt };
    if (!validOwner(mapped) || mapped.targetId !== target.id) throw refuse();
    return mapped;
  }
  return Object.freeze({
    metadata: Object.freeze({ protocol: 'testlane-disposable-browser-v1', target }),
    async verifyTarget(binding, bindingHash) {
      if (binding.target.id !== target.id || binding.target.origin !== target.origin || binding.target.environment !== target.environment ||
          runtime.metadata.internalNetwork !== true || runtime.metadata.loopbackOnly !== true || runtime.metadata.backendEgress !== false ||
          !HASH.test(bindingHash)) throw refuse();
      const summary = await runtime.summary();
      if (summary.controlPresent !== true) throw refuse();
      return { target, bindingHash, enforced: { targetBinding: true, immutableOwnership: true, targetWideQuotas: true,
        expiry: true, disabledEffects: true, tombstones: true, liveRevocation: true } };
    },
    async coordinatorBinding() {
      const current = await app.coordinatorBinding();
      return current === null ? null : { root: current.root, targetId: target.id, bindingHash: current.policyHash, nonce: current.nonce };
    },
    async bindCoordinator(binding) {
      if (!exact(binding, ['root', 'targetId', 'bindingHash', 'nonce']) || binding.targetId !== target.id) throw refuse();
      await app.bindCoordinator({ root: binding.root, policyHash: binding.bindingHash, nonce: binding.nonce });
      return { bound: true };
    },
    async createOwned(value, password) { return app.createOwned(owner(value), password); },
    async inspectOwned(value) {
      const inspected = await app.inspectOwned(owner(value)), summary = await runtime.summary();
      // This isolated proof target has one managed run and no other record
      // writers. Global absence is a conservative, stronger record-count gate;
      // it cannot authorize deletion of another owner's row.
      return { ...inspected, ownedRecords: summary.proofRecords, activeReservations: inspected.revoked ? 0 : 1 };
    },
    async beginCredentialDelivery(value) { await app.beginCredentialDelivery(owner(value)); return { pending: true }; },
    async endCredentialDelivery(value) { await app.endCredentialDelivery(owner(value)); return { pending: false }; },
    async revokeDeleteOwned(value) {
      const original = owner(value);
      // Auth cleanup cannot strand business records after their grant is revoked.
      // The authored browser cleanup must first prove this target's records absent.
      if ((await runtime.summary()).proofRecords !== 0) throw refuse();
      await app.revokeDeleteOwned(original);
      return { revoked: true };
    },
  });
}
