let contracts;
try { contracts = await import('../../../dist/workflows/contracts.js'); }
catch { contracts = null; }

/** Canonical contract constants are built with the broker and required at runtime. */
export const REQUIRED_SMOKE_STEPS = Object.freeze(contracts?.REQUIRED_SMOKE_STEPS ? [...contracts.REQUIRED_SMOKE_STEPS] : []);
export function parseWorkflow(input) {
  if (!contracts?.parseWorkflow) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.parseWorkflow(input);
}
export function allowedStrategy(strategy) { return strategy === 'nextauth-credentials' || strategy === 'form-post'; }
