export const HARNESS_VERSION = '1';
export const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const environments = ['local', 'sandbox', 'testing', 'preview'];
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function text(value, max = 1000) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
export function validatePlan(value) {
  if (!keys(value, ['schemaVersion', 'status', 'title', 'projectDir', 'target', 'cases', 'evidence']) ||
      value.schemaVersion !== 1 || !['draft', 'reviewed'].includes(value.status) || !text(value.title, 160) ||
      (value.projectDir !== undefined && !text(value.projectDir, 4096)) ||
      !keys(value.target, ['baseUrl', 'environment']) || !environments.includes(value.target.environment)) throw new Error('PLAN_INVALID');
  let url;
  try { url = new URL(value.target.baseUrl); } catch { throw new Error('PLAN_INVALID'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.hostname.toLowerCase().split('.').some(label => ['prod', 'production', 'live'].includes(label)) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('PLAN_INVALID');
  if (value.evidence !== undefined && (!keys(value.evidence, ['screenshots']) || !['off', 'manual'].includes(value.evidence.screenshots))) throw new Error('PLAN_INVALID');
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > 100) throw new Error('PLAN_INVALID');
  const ids = new Set();
  for (const item of value.cases) {
    if (!keys(item, ['id', 'title', 'spec', 'expected', 'cleanup']) || typeof item.id !== 'string' || !CASE_ID.test(item.id) || ids.has(item.id) ||
        !text(item.title, 160) || !text(item.spec, 4096) || !/\.spec\.(?:[cm]?[jt]s)$/.test(item.spec) ||
        !Array.isArray(item.expected) || item.expected.length === 0 || item.expected.length > 30 || !item.expected.every(x => text(x)) ||
        !keys(item.cleanup, ['required', 'description']) || typeof item.cleanup.required !== 'boolean' || !text(item.cleanup.description)) throw new Error('PLAN_INVALID');
    ids.add(item.id);
  }
  return { ...value, projectDir: value.projectDir ?? '.', target: { baseUrl: url.origin, environment: value.target.environment },
    evidence: value.evidence ?? { screenshots: 'off' } };
}
