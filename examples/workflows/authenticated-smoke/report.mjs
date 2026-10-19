let contracts;
try { contracts = await import('../../../dist/workflows/contracts.js'); }
catch { contracts = null; }

export function deriveReport(input) {
  if (!contracts?.deriveReport) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.deriveReport(input);
}
export function parseReport(input) {
  if (!contracts?.parseReport) throw new Error('workflow contracts are unavailable; build the broker first');
  return contracts.parseReport(input);
}
