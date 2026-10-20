/** One live post-session check. A failed wait never represents callback settlement. */
export async function stabilizeIosSetupOwnership({ assertOwned, signal, deadline }) {
  const began = performance.now();
  const result = status => Object.freeze({ status, completed: status === 'completed', elapsedMs: Math.max(0, Math.round(performance.now() - began)) });
  if (signal?.aborted) return result('cancelled');
  if (typeof assertOwned !== 'function' || !Number.isFinite(deadline)) return result('refused');
  const remaining = deadline - began;
  if (remaining <= 0) return result('timeout');
  const budget = Math.min(20_000, remaining);
  let timer, abort;
  try {
    const stopped = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), budget);
      if (signal) {
        abort = () => resolve('cancelled');
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    // The callback is trusted but may not cooperate with cancellation. Attach
    // both settlement handlers and return no continuation that can send HTTP.
    const owned = Promise.resolve().then(() => {
      if (signal?.aborted) return 'cancelled';
      if (performance.now() >= began + budget) return 'timeout';
      return Promise.resolve(assertOwned()).then(value => value === true ? 'completed' : 'refused');
    }).catch(() => 'refused');
    const status = await Promise.race([owned, stopped]);
    if (signal?.aborted) return result('cancelled');
    if (performance.now() >= began + budget) return result('timeout');
    return result(status);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
