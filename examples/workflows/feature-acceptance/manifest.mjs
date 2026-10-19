/**
 * Thin loader for the feature-acceptance v1 contract, built alongside the
 * broker to `dist/workflows/feature-contracts.js`. Mirrors
 * `authenticated-smoke/manifest.mjs`: a missing build throws a fixed message
 * rather than falling back to a permissive local shape.
 */
let contracts;
try {
  contracts = await import('../../../dist/workflows/feature-contracts.js');
} catch {
  contracts = null;
}

/** Canonical contract constants are built with the broker and required at runtime. */
export const REQUIRED_FEATURE_STEPS = Object.freeze(contracts?.REQUIRED_FEATURE_STEPS ? [...contracts.REQUIRED_FEATURE_STEPS] : []);
export const FEATURE_RECORD_ID_RE = contracts?.FEATURE_RECORD_ID_RE ?? /^[a-z0-9][a-z0-9-]{7,63}$/u;

export function parseFeatureWorkflow(input) {
  if (!contracts?.parseFeatureWorkflow) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.parseFeatureWorkflow(input);
}

export function parseTestEnvironmentReceipt(input) {
  if (!contracts?.parseTestEnvironmentReceipt) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.parseTestEnvironmentReceipt(input);
}

export function verifyReceiptForRun(receipt, manifest, options) {
  if (!contracts?.verifyReceiptForRun) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.verifyReceiptForRun(receipt, manifest, options);
}

/** The broker session strategies this runner knows how to drive. */
export function allowedStrategy(strategy) {
  return strategy === 'nextauth-credentials' || strategy === 'form-post';
}
