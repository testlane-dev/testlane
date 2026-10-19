/** Copied into an app-owned suite by prepareDemoSuite; never run against a real app. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, editorIdentity, reviewerIdentity, projectRoot } from './test.mjs';
import { runCase } from './testlane-authoring.mjs';

const keys = ['approverEmail', 'id', 'marker', 'ownerEmail', 'quantity', 'status', 'totalCents', 'unitPriceCents', 'version'];
const same = (actual, expected) => JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(keys) &&
  keys.every(key => actual[key] === expected[key]);
const endpoint = id => '/api/requests/' + encodeURIComponent(id);
async function identity(role, expected) {
  role.assertFresh(); const response = await role.context.request.get('/api/me');
  expect(response.status() === 200, 'live identity status').toBe(true);
  const body = await response.json();
  expect(body.email === expected.email && body.role === expected.role, 'live identity and role').toBe(true);
}
function expectedRow(owned, { totalCents = 4200, approved = false } = {}) {
  return { id: owned.id, marker: owned.marker, ownerEmail: editorIdentity.email, quantity: 3,
    unitPriceCents: 1400, totalCents, status: approved ? 'approved' : 'draft',
    approverEmail: approved ? reviewerIdentity.email : null, version: approved ? 2 : 1 };
}
async function read(role, id) {
  role.assertFresh(); const response = await role.context.request.get(endpoint(id));
  expect(response.status() === 200, 'saved resource is readable').toBe(true); return response.json();
}
function ownership(caseId) {
  return { id: null, marker: 'testlane-demo-' + randomUUID(),
    journal: path.join(projectRoot, 'output', 'testlane-demo-recovery', caseId + '-' + randomUUID() + '.json') };
}
async function capture(owned, response, caseId) {
  // Capture ownership before checking status or any business value. A failing total
  // assertion must not prevent the finally callback from finding its exact record.
  const body = await response.json();
  if (typeof body.id === 'string' && /^[a-f0-9-]{36}$/.test(body.id)) {
    owned.id = body.id;
    await mkdir(path.dirname(owned.journal), { recursive: true, mode: 0o700 });
    await writeFile(owned.journal, JSON.stringify({ caseId, id: owned.id, marker: owned.marker }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  expect(response.status() === 201 && owned.id !== null, 'owned creation status and identifier').toBe(true);
  return body;
}
async function create(editor, owned, caseId) {
  editor.assertFresh(); return capture(owned, await editor.context.request.post('/api/requests', {
    data: { marker: owned.marker, quantity: 3, unitPriceCents: 1400 },
  }), caseId);
}
async function cleanup(editor, owned) {
  if (!owned.id) return;
  editor.assertFresh(); const removed = await editor.context.request.delete(endpoint(owned.id));
  expect(removed.status() === 204, 'delete only the owned resource').toBe(true);
  editor.assertFresh(); const absent = await editor.context.request.get(endpoint(owned.id));
  expect(absent.status() === 404, 'owned resource is absent after deletion').toBe(true);
  await unlink(owned.journal);
}
async function guarded(run) {
  // Generic fixed errors avoid sending raw browser/HTTP exception text to reporters.
  try { return await run(); } catch { throw new Error('DEMO_CASE_FAILED'); }
}

test('Editor saves the independently expected total through the browser', { annotation: { type: 'testlane-case', description: 'editor-browser-total' } }, async ({ testlane }, info) => {
  let editor; const owned = ownership('editor-browser-total');
  await runCase(info, 'editor-browser-total', { run: () => guarded(async () => {
    editor = await testlane.open('editor'); await identity(editor, editorIdentity); editor.assertFresh();
    await editor.page.goto('/'); await editor.page.getByLabel('Run marker', { exact: true }).fill(owned.marker);
    await editor.page.getByLabel('Quantity', { exact: true }).fill('3');
    await editor.page.getByLabel('Unit price (cents)', { exact: true }).fill('1400');
    const pending = editor.page.waitForResponse(response => response.url() === new URL('/api/requests', editor.page.url()).href && response.request().method() === 'POST')
      .then(response => capture(owned, response, 'editor-browser-total'));
    // Settle both operations before cleanup, including a browser action failure
    // after the server has already created the record and returned its identifier.
    const [created, clicked] = await Promise.allSettled([pending,
      editor.page.getByRole('button', { name: 'Create request', exact: true }).click()]);
    if (created.status !== 'fulfilled' || clicked.status !== 'fulfilled') throw new Error('DEMO_CREATION_FAILED');
    const body = created.value;
    expect(same(body, expectedRow(owned)), 'three items at 1400 cents save exactly 4200 cents').toBe(true);
    expect(same(await read(editor, owned.id), expectedRow(owned)), 'fresh read matches all nine saved fields').toBe(true);
    await expect(editor.page.getByRole('status')).toHaveText('Request saved: 4200 cents');
  }), cleanup: () => guarded(() => cleanup(editor, owned)) });
});

test('Editor approval is denied without changing any saved field', { annotation: { type: 'testlane-case', description: 'editor-cannot-approve' } }, async ({ testlane }, info) => {
  let editor; const owned = ownership('editor-cannot-approve');
  await runCase(info, 'editor-cannot-approve', { run: () => guarded(async () => {
    editor = await testlane.open('editor'); await identity(editor, editorIdentity); await create(editor, owned, 'editor-cannot-approve');
    const before = await read(editor, owned.id); editor.assertFresh();
    const response = await editor.context.request.post(endpoint(owned.id) + '/approve');
    expect(response.status() === 403, 'Editor cannot approve').toBe(true);
    expect(same(before, expectedRow(owned, { totalCents: before.totalCents })), 'baseline identifies all owned draft fields').toBe(true);
    expect(same(await read(editor, owned.id), before), 'denied approval preserves all nine saved fields').toBe(true);
  }), cleanup: () => guarded(() => cleanup(editor, owned)) });
});

test('Reviewer approves the same request once through the browser', { annotation: { type: 'testlane-case', description: 'reviewer-approves' } }, async ({ testlane }, info) => {
  let editor; const owned = ownership('reviewer-approves');
  await runCase(info, 'reviewer-approves', { run: () => guarded(async () => {
    editor = await testlane.open('editor'); const reviewer = await testlane.open('reviewer');
    await identity(editor, editorIdentity); await identity(reviewer, reviewerIdentity); await create(editor, owned, 'reviewer-approves');
    reviewer.assertFresh(); await reviewer.page.goto('/');
    await reviewer.page.locator('article[data-request-id="' + owned.id + '"]').getByRole('button', { name: 'Approve request', exact: true }).click();
    await expect(reviewer.page.getByRole('status')).toHaveText('Request approved');
    expect(same(await read(reviewer, owned.id), expectedRow(owned, { approved: true })), 'approval preserves exact 4200-cent record and records Reviewer once').toBe(true);
    expect(same(await read(editor, owned.id), expectedRow(owned, { approved: true })), 'Editor reads the same exact approved state').toBe(true);
  }), cleanup: () => guarded(() => cleanup(editor, owned)) });
});

test('Repeated approval returns conflict and preserves the entire record', { annotation: { type: 'testlane-case', description: 'duplicate-approval-unchanged' } }, async ({ testlane }, info) => {
  let editor; const owned = ownership('duplicate-approval-unchanged');
  await runCase(info, 'duplicate-approval-unchanged', { run: () => guarded(async () => {
    editor = await testlane.open('editor'); const reviewer = await testlane.open('reviewer');
    await identity(editor, editorIdentity); await identity(reviewer, reviewerIdentity); await create(editor, owned, 'duplicate-approval-unchanged');
    reviewer.assertFresh(); const initial = await reviewer.context.request.post(endpoint(owned.id) + '/approve');
    expect(initial.status() === 200, 'first approval succeeds').toBe(true);
    const before = await read(reviewer, owned.id);
    expect(same(before, expectedRow(owned, { totalCents: before.totalCents, approved: true })), 'baseline identifies every approved field').toBe(true);
    reviewer.assertFresh(); const repeat = await reviewer.context.request.post(endpoint(owned.id) + '/approve');
    expect(repeat.status() === 409, 'repeat approval is a conflict').toBe(true);
    expect(same(await read(reviewer, owned.id), before), 'conflict preserves all nine fields including ID owner approver and version').toBe(true);
  }), cleanup: () => guarded(() => cleanup(editor, owned)) });
});

test('Anonymous API access is denied', { annotation: { type: 'testlane-case', description: 'anonymous-denied' } }, async ({ browser }, info) => {
  await runCase(info, 'anonymous-denied', { run: () => guarded(async () => {
    const context = await browser.newContext({ baseURL: info.project.use.baseURL, serviceWorkers: 'block' });
    try { const response = await context.request.get('/api/requests'); expect(response.status() === 401, 'anonymous request receives 401').toBe(true); }
    finally { await context.close(); }
  }) });
});
