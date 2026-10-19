import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrity, validateInventory, validateManifest, validateTagDispatch, verify } from './release-artifact.mjs';

const bytes = Buffer.from('reviewed tarball bytes');
const required = ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'dist/cli.js', 'dist/index.js', 'dist/verification.js', 'docs/doctor.md', 'docs/project-install.md', 'docs/quickstart.md', 'examples/playwright/fixtures.mjs', 'docs/agent-verification.md', 'skills/testlane-verify/SKILL.md', 'skills/testlane-verify/references/harness.md', 'skills/testlane-verify/references/case-design.md', ...['run', 'authoring', 'init', 'bootstrap', 'contracts', 'reporter', 'runtime', 'render'].map(name => `examples/agent-verification/${name}.mjs`)];
function manifest() { return { schemaVersion: 1, name: '@testlane/cli', version: '0.6.0', filename: 'testlane-cli-0.6.0.tgz', integrity: integrity(bytes), size: bytes.length, source: { repository: 'testlane-dev/testlane', commit: 'a'.repeat(40), dirty: false, runId: '123' }, files: required.map(path => ({ path, size: 1 })) }; }

test('reviewed bytes match package identity, tag, commit and producing run', () => {
  const value = manifest();
  assert.equal(validateManifest(value, bytes, { integrity: integrity(bytes), commit: 'a'.repeat(40), tag: 'v0.6.0', runId: '123' }), value);
});
test('only the selected scope and npm flattened tarball basename are accepted', () => {
  for (const name of ['testlane', '@testlane/testlane', '@other/cli']) {
    assert.throws(() => validateManifest({ ...manifest(), name }, bytes), /Release manifest is invalid/);
  }
  for (const filename of ['testlane-0.6.0.tgz', 'cli-0.6.0.tgz', '@testlane/cli-0.6.0.tgz', 'testlane-cli-0.5.1.tgz']) {
    assert.throws(() => validateManifest({ ...manifest(), filename }, bytes), /Release manifest is invalid/);
  }
  const prerelease = { ...manifest(), version: '0.6.0-rc.1', filename: 'testlane-cli-0.6.0-rc.1.tgz' };
  assert.equal(validateManifest(prerelease, bytes, { tag: 'v0.6.0-rc.1' }), prerelease);
});

test('verification rejects a wrong or escaping basename before reading any tarball', async () => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'testlane-release-binding-'));
  try {
    const value = manifest();
    await writeFile(path.join(directory, value.filename), bytes);
    await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(value));
    assert.deepEqual(await verify(directory, { tag: 'v0.6.0' }), value);
    for (const filename of ['testlane-0.6.0.tgz', 'other-cli-0.6.0.tgz', '../testlane-cli-0.6.0.tgz', 'nested/testlane-cli-0.6.0.tgz', 'C:/testlane-cli-0.6.0.tgz']) {
      await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify({ ...value, filename }));
      await assert.rejects(verify(directory), /Release tarball filename is invalid/);
    }
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('testlane-release-binding-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('changed bytes and each incorrect review binding fail closed', () => {
  for (const options of [{ integrity: integrity(Buffer.from('other')) }, { integrity: 'malformed' }, { commit: 'b'.repeat(40) }, { tag: 'v0.5.3' }, { runId: '124' }]) assert.throws(() => validateManifest(manifest(), bytes, options));
  assert.throws(() => validateManifest(manifest(), Buffer.from('changed tarball bytes')));
});
test('dirty checkouts require an explicit local review override', () => {
  const value = manifest(); value.source.dirty = true;
  assert.throws(() => validateManifest(value, bytes));
  assert.equal(validateManifest(value, bytes, { allowDirty: true }), value);
});
test('unsafe names, duplicate inventory, private artifacts and missing entrypoints fail', () => {
  for (const file of ['../secret', '/absolute', 'C:/outside', 'C:relative', 'dist/control\u0000name', 'dist/../secret', 'dist\\secret', 'docs/private/notes.md', 'output/state.json', 'examples/playwright/tests/fixture.mjs', 'examples/playwright/node_modules/index.js', '.env.local', 'src/cli.ts']) {
    assert.throws(() => validateInventory([...manifest().files, { path: file, size: 0 }]));
  }
  assert.throws(() => validateInventory([...manifest().files, manifest().files[0]]));
  assert.throws(() => validateInventory(manifest().files.slice(1)));
  for (const entry of required.filter(name => /verification|testlane-verify/.test(name))) {
    assert.throws(() => validateInventory(manifest().files.filter(file => file.path !== entry)), /Required package entry is missing/);
  }
  const value = manifest(); value.filename = '../testlane-cli-0.6.0.tgz'; assert.throws(() => validateManifest(value, bytes));
});

function dispatchEnvironment() {
  return { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'testlane-dev/testlane',
    GITHUB_REF: 'refs/tags/v0.6.0', GITHUB_SHA: 'a'.repeat(40) };
}

test('a dispatch from the reviewed version tag and source commit is accepted', () => {
  const value = manifest();
  assert.equal(validateTagDispatch(value, 'v0.6.0', dispatchEnvironment()), value);
});

test('a default-branch dispatch fails even when its commit equals the candidate', () => {
  assert.throws(() => validateTagDispatch(manifest(), 'v0.6.0', { ...dispatchEnvironment(), GITHUB_REF: 'refs/heads/main' }), /reviewed version tag and source commit/);
});

test('a dispatch with a different commit, tag, event or repository fails closed', () => {
  for (const override of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_SHA: undefined },
    { GITHUB_REF: 'refs/tags/v0.5.3' }, { GITHUB_REF: 'refs/heads/v0.6.0' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'example/fork' }]) {
    assert.throws(() => validateTagDispatch(manifest(), 'v0.6.0', { ...dispatchEnvironment(), ...override }));
  }
  assert.throws(() => validateTagDispatch(manifest(), undefined, dispatchEnvironment()));
  assert.throws(() => validateTagDispatch(manifest(), 'v0.5.3', dispatchEnvironment()));
});

test('the explicit verification flag enforces dispatch provenance while local verification stays available', async () => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'testlane-release-binding-'));
  try {
    const value = manifest();
    await writeFile(path.join(directory, value.filename), bytes);
    await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(value));
    const script = fileURLToPath(new URL('./release-artifact.mjs', import.meta.url));
    const args = [script, 'verify', '--directory', directory, '--tag', 'v0.6.0'];
    const childOptions = { env: { ...process.env, ...dispatchEnvironment(), GITHUB_OUTPUT: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    assert.equal(JSON.parse(execFileSync(process.execPath, [...args, '--require-tag-dispatch'], childOptions).toString()).commit, value.source.commit);
    const mainBranch = { ...childOptions, env: { ...childOptions.env, GITHUB_REF: 'refs/heads/main' } };
    assert.throws(() => execFileSync(process.execPath, [...args, '--require-tag-dispatch'], mainBranch), /reviewed version tag and source commit/);
    assert.equal(JSON.parse(execFileSync(process.execPath, args, mainBranch).toString()).commit, value.source.commit);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('testlane-release-binding-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
