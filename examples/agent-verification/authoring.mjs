/** Copy verbatim into the app. The callbacks and their assertions are trusted app code. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTHORING_VERSION = '1';
const selfHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const active = new WeakMap();
function fail(code) { return new Error('Testlane verification: ' + code); }
function control() {
  try {
    const file = process.env.TESTLANE_VERIFICATION_CONTROL;
    if (!file || !path.isAbsolute(file)) throw fail('CONTROL_REQUIRED');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.cases) || !path.isAbsolute(data.artifactDir)) throw fail('CONTROL_REQUIRED');
    return data;
  } catch { throw fail('CONTROL_REQUIRED'); }
}
function annotate(info, type, description) { info.annotations.push({ type, description }); }

/** Cleanup must assert the app-owned state was removed; callback completion alone cannot prove it. */
export async function runCase(testInfo, id, { run, cleanup } = {}) {
  const settings = control();
  const item = settings.cases.find(value => value.id === id);
  const markers = testInfo.annotations.filter(value => value.type === 'testlane-case');
  if (!item || markers.length !== 1 || markers[0].description !== id || active.has(testInfo) ||
      typeof run !== 'function' || (cleanup !== undefined && typeof cleanup !== 'function')) throw fail('CASE_CONTRACT');
  if (item.cleanupRequired && !cleanup) throw fail('CLEANUP_REQUIRED');
  const state = { id, settings, captures: 0, open: true };
  active.set(testInfo, state);
  annotate(testInfo, 'testlane-helper', AUTHORING_VERSION + ':' + selfHash);
  annotate(testInfo, 'testlane-started', id);
  let result, originalError, failed = false;
  try {
    result = await run();
    annotate(testInfo, 'testlane-body', 'completed');
  } catch (error) {
    failed = true;
    originalError = error;
    annotate(testInfo, 'testlane-body', 'failed');
  } finally {
    try {
      if (cleanup) { await cleanup(); annotate(testInfo, 'testlane-cleanup', 'completed'); }
      else annotate(testInfo, 'testlane-cleanup', 'not-required');
    } catch {
      annotate(testInfo, 'testlane-cleanup', 'failed');
      if (!failed) { failed = true; originalError = fail('CLEANUP_FAILED'); }
    } finally { state.open = false; }
  }
  if (failed) throw originalError;
  return result;
}

/** Explicit screenshot opt-in. Contents remain private and unreviewed until someone inspects them. */
export async function captureScreenshot(testInfo, page, label) {
  const state = active.get(testInfo);
  if (!state?.open || state.settings.screenshots !== 'manual' ||
      typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(label) || state.captures >= 5) throw fail('SCREENSHOT_NOT_ALLOWED');
  if (new URL(page.url()).origin !== state.settings.origin) throw fail('SCREENSHOT_ORIGIN');
  const parent = realpathSync(state.settings.artifactDir);
  const filename = 'screenshot-' + randomUUID() + '.png';
  const output = path.join(parent, filename);
  state.captures++;
  try {
    await page.screenshot({ path: output, fullPage: false, timeout: 10000, animations: 'disabled' });
    const info = lstatSync(output);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) throw fail('SCREENSHOT_LIMIT');
    annotate(testInfo, 'testlane-screenshot', state.id + ':' + filename);
    return 'artifacts/' + filename;
  } catch {
    try { unlinkSync(output); } catch (error) { if (error.code !== 'ENOENT') throw fail('SCREENSHOT_CLEANUP_FAILED'); }
    throw fail('SCREENSHOT_FAILED');
  }
}
