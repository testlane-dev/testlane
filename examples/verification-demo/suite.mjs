/** Prepare new app-owned demonstration files using the installed canonical helpers. */
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const profile = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$/;
export async function prepareDemoSuite({ projectRoot, packageRoot, origin, editorProfile, reviewerProfile, editor, reviewer }) {
  const project = await realpath(projectRoot), installed = await realpath(packageRoot), url = new URL(origin);
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(packageRoot) || url.origin !== origin || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' ||
      !profile.test(editorProfile ?? '') || !profile.test(reviewerProfile ?? '') || editorProfile === reviewerProfile ||
      typeof editor?.email !== 'string' || typeof reviewer?.email !== 'string' || editor.email === reviewer.email) throw new Error('DEMO_SUITE_INPUT_INVALID');
  createRequire(path.join(project, 'package.json')).resolve('@playwright/test/cli');
  const parent = path.join(project, 'e2e');
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)) !== parent || (await lstat(parent)).isSymbolicLink()) throw new Error('DEMO_SUITE_PATH_INVALID');
  const directory = path.join(parent, 'testlane-demo');
  await mkdir(directory, { mode: 0o700 }); // Existing suites are never overwritten.
  const role = (account, name) => ({ email: account.email, role: name });
  const config = `import {createRequire} from 'node:module';\nimport {createTestlaneTest,expect} from './fixtures.mjs';\nconst require=createRequire(import.meta.url);\nexport const projectRoot=${JSON.stringify(project)};\nexport const editorIdentity=${JSON.stringify(role(editor, 'Editor'))};\nexport const reviewerIdentity=${JSON.stringify(role(reviewer, 'Reviewer'))};\nexport const test=createTestlaneTest({cliPath:${JSON.stringify(path.join(installed, 'dist', 'cli.js'))},baseURL:${JSON.stringify(origin)},roles:{editor:[${JSON.stringify(editorProfile)}],reviewer:[${JSON.stringify(reviewerProfile)}]}});\nexport {expect};\n`;
  const cases = [
    ['editor-browser-total', 'Editor saves the expected 4200-cent total', ['Browser creation saves three items at 1400 cents each', 'Fresh API state matches all nine fields and a total of 4200 cents']],
    ['editor-cannot-approve', 'Editor cannot approve its request', ['Editor approval receives 403', 'All nine stored fields remain identical after denial']],
    ['reviewer-approves', 'Reviewer approves exactly the saved request', ['Distinct live Reviewer approves through the browser', 'Fresh reads preserve the owned 4200-cent record and set the approver/version once']],
    ['duplicate-approval-unchanged', 'Repeat approval cannot change the record', ['First approval succeeds, repeated approval receives 409', 'Full saved ID/owner/amount/status/approver/version state remains unchanged']],
    ['anonymous-denied', 'Anonymous API access is refused', ['An empty browser context receives 401 from the protected API']],
  ].map(([id, title, expected]) => ({ id, title, spec: 'e2e/testlane-demo/feature.spec.mjs', expected,
    cleanup: { required: id !== 'anonymous-denied', description: id === 'anonymous-denied' ? 'Read-only anonymous context closes; no app data created' : 'Delete only this case\'s journaled owned record, assert 404 and remove its recovery journal' } }));
  const plan = { schemaVersion: 1, status: 'reviewed', title: 'Disposable request approval verification', projectDir: '../..',
    target: { baseUrl: origin, environment: 'testing' }, evidence: { screenshots: 'off' }, cases };
  await Promise.all([
    copyFile(path.join(installed, 'examples', 'playwright', 'fixtures.mjs'), path.join(directory, 'fixtures.mjs')),
    copyFile(path.join(installed, 'examples', 'agent-verification', 'authoring.mjs'), path.join(directory, 'testlane-authoring.mjs')),
    copyFile(path.join(HERE, 'feature.spec.mjs'), path.join(directory, 'feature.spec.mjs')),
    copyFile(path.join(HERE, 'brief.md'), path.join(directory, 'brief.md')),
    writeFile(path.join(directory, 'test.mjs'), config, { flag: 'wx', mode: 0o600 }),
    writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 }),
    writeFile(path.join(directory, '.gitattributes'), 'testlane-authoring.mjs text eol=lf\n', { flag: 'wx', mode: 0o600 }),
    writeFile(path.join(directory, '.gitignore'), 'brief.md\noutput/\n', { flag: 'wx', mode: 0o600 }),
  ]);
  // Parse the written plan as a final preparation check; execution is separate.
  JSON.parse(await readFile(path.join(directory, 'plan.json'), 'utf8'));
  return { planFile: path.join(directory, 'plan.json'), specFile: path.join(directory, 'feature.spec.mjs') };
}
