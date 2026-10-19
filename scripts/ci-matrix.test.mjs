import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { macOSCoverage, selectRunners } from './ci-matrix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('macOS keychain and shared store changes select store and package coverage', () => {
  for (const path of ['src/store/keychain-macos.ts', 'src/store/select.ts',
    'tests/store-real-keychain.test.ts', 'src/vault.ts']) {
    assert.deepEqual(macOSCoverage(path), ['check', 'cleanRoom', 'keychain'], path);
  }
});

test('package and workflow changes select only relevant macOS jobs', () => {
  for (const path of ['package-lock.json', 'scripts/clean-room.mjs',
    '.github/workflows/publish.yml']) {
    assert.deepEqual(macOSCoverage(path), ['check', 'cleanRoom'], path);
  }
  for (const path of ['examples/workflows/feature-acceptance/run.mjs',
    'examples/playwright/fixtures.mjs', 'examples/playwright/package-lock.json',
    'examples/existing-app/verify.mjs', 'examples/agent-verification/runtime.mjs',
    'examples/verification-demo/run.mjs']) {
    assert.deepEqual(macOSCoverage(path), ['workflow', 'cleanRoom'], path);
  }
  assert.deepEqual(macOSCoverage('.github/workflows/ci.yml'),
    ['check', 'workflow', 'cleanRoom', 'keychain']);
});

test('docs and platform-specific Windows/Linux adapters do not select macOS', () => {
  for (const path of [
    'README.md',
    'docs/strategies.md',
    'src/store/dpapi.ts',
    'tests/cli-e2e-dpapi.test.ts',
    'src/store/secret-service.ts',
    'tests/store-secret-service.test.ts',
  ]) assert.deepEqual(macOSCoverage(path), [], path);
});

test('source-only account provisioning changes select cross-platform unit checks without native-store jobs', () => {
  assert.deepEqual(macOSCoverage('examples/account-provisioning/controller.mjs'), ['check']);
  assert.deepEqual(macOSCoverage('examples/account-provisioning/tests/provisioning.test.mjs'), ['check']);
  assert.deepEqual(macOSCoverage('examples/account-provisioning/README.md'), []);
  const selected = selectRunners('pull_request', ['examples/account-provisioning/controller.mjs']);
  assert.deepEqual(selected.checkOS, ['windows-latest', 'ubuntu-latest', 'macos-latest']);
  assert.deepEqual(selected.workflowOS, ['windows-latest', 'ubuntu-latest']);
  assert.deepEqual(selected.keychainOS, ['ubuntu-latest']);
});

test('ordinary pushes and PRs keep Windows DPAPI and Linux keychain coverage', () => {
  const selected = selectRunners('pull_request', ['README.md']);
  assert.deepEqual(selected.checkOS, ['windows-latest', 'ubuntu-latest']);
  assert.deepEqual(selected.workflowOS, ['windows-latest', 'ubuntu-latest']);
  assert.deepEqual(selected.cleanRoomOS, ['windows-latest', 'ubuntu-latest']);
  assert.deepEqual(selected.keychainOS, ['ubuntu-latest']);
  assert.deepEqual(selectRunners('push', ['src/store/keychain-macos.ts']).checkOS,
    ['windows-latest', 'ubuntu-latest', 'macos-latest']);
  assert.deepEqual(selectRunners('push', ['scripts/clean-room.mjs']).keychainOS,
    ['ubuntu-latest']);
});

test('weekly, manual, and unavailable-diff runs use the full matrix', () => {
  for (const event of ['schedule', 'workflow_dispatch', 'diff-unavailable']) {
    const selected = selectRunners(event, []);
    for (const os of [selected.checkOS, selected.workflowOS, selected.cleanRoomOS]) {
      assert.deepEqual(os, ['windows-latest', 'ubuntu-latest', 'macos-latest']);
    }
    assert.deepEqual(selected.keychainOS, ['ubuntu-latest', 'macos-latest']);
  }
});

// Regression for the pre-realpath entry guard: on macOS the OS tmpdir is
// itself a symlink (/var -> /private/var), so invoking the script through a
// symlinked directory reproduces the same argv[1]-vs-import.meta.url mismatch
// there. A plain path.resolve() compare silently skips main() and the
// process exits 0 with no GITHUB_OUTPUT written at all; the realpath-based
// isEntryPoint() guard must still run main() in that case.
test('running through a symlinked directory still invokes main() and writes GITHUB_OUTPUT', () => {
  let tmp;
  try {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ci-matrix-symlink-'));
  } catch (error) {
    if (error.code === 'EPERM') return; // sandboxed environment cannot create temp dirs
    throw error;
  }
  try {
    const linkDir = path.join(tmp, 'linked');
    try {
      symlinkSync(here, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return; // no symlink privilege (e.g. Windows without dev mode)
      throw error;
    }
    const githubOutput = path.join(tmp, 'github_output');
    writeFileSync(githubOutput, '');
    const scriptPath = path.join(linkDir, 'ci-matrix.mjs');
    // workflow_dispatch selects the full matrix unconditionally, so this
    // needs no git diff / CI_BASE / CI_HEAD to be meaningful.
    execFileSync(process.execPath, [scriptPath], {
      cwd: tmp,
      env: { ...process.env, CI_EVENT: 'workflow_dispatch', GITHUB_OUTPUT: githubOutput },
      encoding: 'utf8',
    });
    const output = readFileSync(githubOutput, 'utf8');
    for (const key of ['check_os=', 'workflow_os=', 'clean_room_os=', 'keychain_os=']) {
      assert.ok(output.includes(`${key}`), `expected a "${key}" line in GITHUB_OUTPUT, got: ${output}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
