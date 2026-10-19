/**
 * Thin loader for the feature-acceptance report contract, mirroring
 * `authenticated-smoke/report.mjs`.
 */
let contracts;
try {
  contracts = await import('../../../dist/workflows/feature-contracts.js');
} catch {
  contracts = null;
}

export function deriveFeatureReport(input) {
  if (!contracts?.deriveFeatureReport) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.deriveFeatureReport(input);
}

export function parseFeatureReport(input) {
  if (!contracts?.parseFeatureReport) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.parseFeatureReport(input);
}
