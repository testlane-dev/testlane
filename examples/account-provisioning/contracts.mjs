/** Fixed local experiment, not provider or production provisioning authority. */
import { createHash } from 'node:crypto';

export const ROLES = Object.freeze(['Editor', 'Reviewer']);
export const TTL_MS = 10 * 60_000, WINDOW_MS = 60 * 60_000;
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
const CODES = new Set(['PROVISION_POLICY_REFUSED', 'PROVISION_TARGET_REFUSED', 'PROVISION_INPUT_REFUSED', 'PROVISION_STATE_INVALID',
  'PROVISION_STATE_LOCKED', 'PROVISION_STATE_IO_FAILED', 'PROVISION_RUN_REFUSED', 'PROVISION_EXPIRED', 'PROVISION_CLOCK_REFUSED',
  'PROVISION_QUOTA_REFUSED', 'PROVISION_REPLAY_REFUSED', 'PROVISION_ROLE_REFUSED', 'PROVISION_OWNERSHIP_REFUSED',
  'PROVISION_CREATE_UNKNOWN', 'PROVISION_SEED_UNKNOWN', 'PROVISION_CLEANUP_INCOMPLETE', 'PROVISION_APP_CLOSED', 'PROVISION_ACCOUNT_COLLISION']);
export class ProvisionError extends Error {
  constructor(code) { const fixed = CODES.has(code) ? code : 'PROVISION_INPUT_REFUSED'; super(fixed); this.name = 'ProvisionError'; this.code = fixed; }
}
export const fail = code => new ProvisionError(code);
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const emailFor = (runId, role) => 'tlp-' + runId + '-' + role.toLowerCase() + '@example.test';
export function validOwner(value) {
  return exact(value, ['targetId', 'policyHash', 'runId', 'releaseId', 'operationId', 'role', 'email', 'expiresAt']) &&
    [value.targetId, value.runId, value.operationId].every(item => typeof item === 'string' && UUID.test(item)) &&
    [value.policyHash, value.releaseId].every(item => typeof item === 'string' && HASH.test(item)) && ROLES.includes(value.role) &&
    value.email === emailFor(value.runId, value.role) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
}
export function reviewedSyntheticPolicy(target, releaseId) {
  return { schemaVersion: 1, enabled: true, environment: 'testing', target: { ...target }, releaseId,
    roles: [...ROLES], ttlMs: TTL_MS, maxAccountsPerRun: 2, maxActiveAccounts: 4, maxCreateAttemptsPerHour: 10,
    effects: { email: false, sms: false, billing: false, webhooks: false } };
}
export function validatePolicy(input, target) {
  if (!exact(input, ['schemaVersion', 'enabled', 'environment', 'target', 'releaseId', 'roles', 'ttlMs', 'maxAccountsPerRun', 'maxActiveAccounts', 'maxCreateAttemptsPerHour', 'effects']) ||
    !exact(input.target, ['kind', 'targetId', 'origin']) || input.schemaVersion !== 1 || input.enabled !== true || input.environment !== 'testing' ||
    !HASH.test(input.releaseId ?? '') || canonical(input.roles) !== canonical(ROLES) || input.ttlMs !== TTL_MS ||
    input.maxAccountsPerRun !== 2 || input.maxActiveAccounts !== 4 || input.maxCreateAttemptsPerHour !== 10 ||
    !exact(input.effects, ['email', 'sms', 'billing', 'webhooks']) || Object.values(input.effects).some(value => value !== false)) throw fail('PROVISION_POLICY_REFUSED');
  if (canonical(input.target) !== canonical(target) || target.kind !== 'synthetic-local') throw fail('PROVISION_TARGET_REFUSED');
  const url = new URL(target.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== target.origin || !url.port || !UUID.test(target.targetId)) throw fail('PROVISION_TARGET_REFUSED');
  return structuredClone(input);
}
