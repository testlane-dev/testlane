/** Bound shutdown of already-started local request handlers; no provider authority. */
import { fail } from '../contracts.mjs';

export function createRequestDrain({ timeoutMs = 20_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw fail('PROVISION_INPUT_REFUSED');
  const active = new Set();
  let closing = false, closePromise;
  return Object.freeze({
    run(handler) {
      if (closing) throw fail('PROVISION_APP_CLOSED');
      if (typeof handler !== 'function') throw fail('PROVISION_INPUT_REFUSED');
      const pending = Promise.resolve().then(handler);
      active.add(pending);
      void pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
    close(stopAccepting) {
      if (closePromise) return closePromise;
      if (typeof stopAccepting !== 'function') throw fail('PROVISION_INPUT_REFUSED');
      closing = true;
      closePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fail('PROVISION_CLEANUP_INCOMPLETE')), timeoutMs);
        const settle = async () => {
          try {
            await stopAccepting();
            await Promise.allSettled([...active]);
            resolve();
          } catch { reject(fail('PROVISION_CLEANUP_INCOMPLETE')); }
          finally { clearTimeout(timer); }
        };
        void settle();
      });
      return closePromise;
    },
  });
}
