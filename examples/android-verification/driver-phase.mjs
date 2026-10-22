/** Cooperative phase cancellation shared by the narrow native clients. */
export function combineDriverSignals(current, phase) {
  if (!(phase instanceof AbortSignal)) throw new TypeError('NATIVE_DRIVER_SIGNAL_INVALID');
  return current ? AbortSignal.any([current, phase]) : phase;
}

export async function withDriverSignal(operation, signal, cancelled) {
  if (signal?.aborted) throw cancelled();
  if (!signal) return operation();
  let abort;
  try {
    const stopped = new Promise((_, reject) => { abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true }); });
    return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return operation(); }), stopped]);
  } finally { signal.removeEventListener('abort', abort); }
}

export async function waitDriverSignal(milliseconds, signal, cancelled) {
  let timer;
  try { await withDriverSignal(() => new Promise(resolve => { timer = setTimeout(resolve, milliseconds); }), signal, cancelled); }
  finally { clearTimeout(timer); }
}
