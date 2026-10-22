/** Optional fixed synthetic-control discriminator before any account or backend. */
import { types } from 'node:util';
import { NativeDriverError, readIosRequestFailure, readIosRequestProgress, readIosCommandResponse } from './driver.mjs';
import { NATIVE_DRIVER_FAILURE_CODES } from '../android-verification/contracts.mjs';

const codes = new Set([...NATIVE_DRIVER_FAILURE_CODES, 'NATIVE_DRIVER_CANCELLED']);
const visibility = Object.freeze(['run-marker', 'quantity', 'unit-price', 'create-request',
  'selected-id', 'load-request', 'approve-request', 'anonymous-check']);
const fail = (code, request, progress) => new NativeDriverError(code, request, progress);
function fixedCode(error) {
  if (error === null || typeof error !== 'object' || types.isProxy(error) || !types.isNativeError(error)) return undefined;
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (Object.getPrototypeOf(error) === NativeDriverError.prototype && code && Object.hasOwn(code, 'value') &&
        typeof code.value === 'string' && codes.has(code.value)) return code.value;
  } catch { /* No thrown value, getter, text or payload becomes public metadata. */ }
  return undefined;
}

/** onStep is a trusted in-process collector; callers cannot supply IDs/actions. */
export async function probeIosPreauthControls({ driver, signal, onStep = () => {} } = {}) {
  async function step(controlId, kind, action) {
    try {
      if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
      await action();
      if (signal?.aborted) throw fail('NATIVE_DRIVER_CANCELLED');
    } catch (error) {
      const trustedCode = fixedCode(error);
      const code = signal?.aborted ? 'NATIVE_DRIVER_CANCELLED' : trustedCode ?? 'NATIVE_DRIVER_COMMAND_FAILED';
      const request = trustedCode ? readIosRequestFailure(error) : undefined;
      const requestProgress = trustedCode ? readIosRequestProgress(error) : undefined;
      const commandResponse = trustedCode && controlId === 'quantity' && kind === 'focus' && request?.operation === 'click' && ['http', 'response'].includes(request.phase) ? readIosCommandResponse(error) : undefined;
      onStep(Object.freeze({ controlId, step: kind, completed: false, code, ...(request ? { request } : {}), ...(requestProgress ? { requestProgress } : {}), ...(commandResponse ? { commandResponse } : {}) }));
      throw fail(code, request, requestProgress);
    }
    onStep(Object.freeze({ controlId, step: kind, completed: true }));
  }
  for (const id of visibility) await step(id, 'visibility', () => driver.scrollIntoView(id));
  // Focus changes local input state only. No typing, bootstrap or app API call.
  await step('quantity', 'focus', () => driver.click('quantity'));
  // Existing hideKeyboard observes hidden state and clicks app-owned Done at
  // most once. This does not claim the keyboard appeared or that Done was used.
  await step('dismiss-keyboard', 'keyboard-dismissal-check', () => driver.hideKeyboard());
  await step('session-status', 'visibility-restore', () => driver.scrollIntoView('session-status'));
}
