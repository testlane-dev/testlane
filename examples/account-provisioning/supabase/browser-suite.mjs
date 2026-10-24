/** Copies the installed, canonical fixture/helper; no account authority is copied. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function prepareBrowserSuite(consumer, origin) {
  const directory = path.join(consumer.root, 'e2e', 'provisioning'); await mkdir(directory, { mode: 0o700 });
  for (const [source, destination] of [
    [path.join(consumer.packageRoot, 'examples/playwright/fixtures.mjs'), 'fixtures.mjs'],
    [path.join(consumer.packageRoot, 'examples/agent-verification/authoring.mjs'), 'testlane-authoring.mjs'],
    [path.join(HERE, 'browser.spec.mjs'), 'browser.spec.mjs'], [path.join(HERE, 'browser-gate.mjs'), 'browser-gate.mjs'],
  ]) await copyFile(source, path.join(directory, destination));
  const plan = { schemaVersion: 1, status: 'reviewed', title: 'Created account browser lifecycle', projectDir: '../..',
    target: { baseUrl: origin, environment: 'testing' }, evidence: { screenshots: 'off' }, cases: [{ id: 'provisioned-browser-lifecycle',
      title: 'Created accounts reach browser roles and revoke in the same live app', spec: 'e2e/provisioning/browser.spec.mjs',
      expected: ['Created Editor and Reviewer identities and role allow/deny controls are verified in the DOM',
        'Editor-owned persisted records are deleted and verified absent even after the injected assertion failure',
        'The original browser contexts are refused after account revocation while the same app remains live'],
      cleanup: { required: true, description: 'Delete the exact owned record, verify absence, revoke accounts through the local controller, prove old browser rejection and close the original contexts' } }] };
  const planFile = path.join(directory, 'plan.json'); await writeFile(planFile, JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, planFile, specFile: path.join(directory, 'browser.spec.mjs') };
}
