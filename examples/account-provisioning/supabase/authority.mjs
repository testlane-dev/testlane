/** Shared account authority for the two explicitly local provider fixtures. */
import { exact, fail, HASH, ROLES, UUID, validOwner } from '../contracts.mjs';
import { isOwnedSupabaseRuntime } from './runtime.mjs';

export function requireSupabaseTarget(runtime, releaseId) {
  if (!isOwnedSupabaseRuntime(runtime) || !HASH.test(releaseId ?? '') || !UUID.test(runtime.targetId ?? '')) throw fail('PROVISION_TARGET_REFUSED');
}

export function supabaseIdentity(value) {
  return exact(value, ['id', 'email', 'role']) && UUID.test(value.id ?? '') && typeof value.email === 'string' &&
    value.email.length > 0 && value.email.length <= 254 && [...ROLES, 'Control'].includes(value.role) ?
    { id: value.id, email: value.email, role: value.role } : null;
}

// This helper cannot register an adapter: the owned runtime brand is mandatory.
export function createSupabaseAuthority({ runtime, releaseId, assertLive }) {
  requireSupabaseTarget(runtime, releaseId);
  if (typeof assertLive !== 'function') throw fail('PROVISION_TARGET_REFUSED');
  const owner = value => {
    assertLive();
    if (!validOwner(value) || value.targetId !== runtime.targetId || value.releaseId !== releaseId) throw fail('PROVISION_OWNERSHIP_REFUSED');
  };
  return Object.freeze({
    async coordinatorBinding() { assertLive(); return runtime.ledger('bind', null); },
    async bindCoordinator(binding) {
      assertLive(); if (!exact(binding, ['root', 'policyHash', 'nonce'])) throw fail('PROVISION_STATE_INVALID');
      return runtime.ledger('bind', { ...binding, targetId: runtime.targetId, releaseId });
    },
    async createOwned(value, password) {
      owner(value); await runtime.ledger('reserve', value);
      const result = await runtime.createOwnedUser(value, password);
      if (!exact(result, ['id']) || !UUID.test(result.id ?? '')) throw fail('PROVISION_CREATE_UNKNOWN');
      const observed = await runtime.ledger('inspect', value);
      if (!observed.present || observed.id !== result.id || observed.revoked) throw fail('PROVISION_CREATE_UNKNOWN');
      return result;
    },
    async inspectOwned(value) { owner(value); return runtime.ledger('inspect', value); },
    async beginCredentialDelivery(value) { owner(value); await runtime.ledger('delivery', value, true); },
    async endCredentialDelivery(value) { owner(value); await runtime.ledger('delivery', value, false); },
    async revokeDeleteOwned(value) {
      owner(value); const revoked = await runtime.ledger('revoke', value);
      if (revoked.revoked !== true) throw fail('PROVISION_CLEANUP_INCOMPLETE');
      await runtime.deleteOwnedUser(value);
      const after = await runtime.ledger('inspect', value);
      if (after.present || !after.revoked || after.id !== revoked.id) throw fail('PROVISION_CLEANUP_INCOMPLETE');
    },
  });
}
