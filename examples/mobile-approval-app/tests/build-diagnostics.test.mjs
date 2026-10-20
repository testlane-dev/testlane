import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyAndroidBuildOutput, createAndroidBuildFailure, readAndroidBuildFailure, validateAndroidBuildFailure } from '../build-diagnostics.mjs';

async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tl-build-diagnostic-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^tl-build-diagnostic-[A-Za-z0-9]+$/);
    assert.equal((await lstat(root)).isSymbolicLink(), false); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
  });
  return root;
}

test('common Android build failures project only ordered fixed categories, never matching log values', () => {
  const secret = randomBytes(32).toString('base64'), encoded = encodeURIComponent(secret), base64 = Buffer.from(secret).toString('base64');
  const samples = [
    ['No space left on device', 'BUILD_DISK_CAPACITY'],
    ['java.lang.OutOfMemoryError: Java heap space', 'BUILD_MEMORY_EXHAUSTED'],
    ['Process finished with non-zero exit value 137', 'BUILD_PROCESS_KILLED'],
    ['Gradle build daemon disappeared unexpectedly', 'BUILD_DAEMON_DISAPPEARED'],
    ['CMake Error at CMakeLists.txt:20', 'BUILD_NATIVE_TOOLCHAIN'],
    ['Compilation error. See log for more details', 'BUILD_COMPILATION'],
    ['Could not resolve all files for configuration', 'BUILD_DEPENDENCY_RESOLUTION'],
    ['Could not GET the requested dependency', 'BUILD_DOWNLOAD'],
    ['javax.net.ssl.SSLHandshakeException: PKIX path building failed', 'BUILD_TLS'],
    ['Failed to find target with hash string android-37.0', 'BUILD_SDK_PACKAGE_MISSING'],
    ['Failed to find Build Tools revision 37.0.0', 'BUILD_TOOLS_MISSING'],
    ['License for package Android SDK Build-Tools 37 not accepted', 'BUILD_LICENSE'],
    ['Unsupported class file major version 70', 'BUILD_JAVA'],
    ['Unable to resolve module from the entry file', 'BUILD_JS_BUNDLE'],
    ['Android resource linking failed', 'BUILD_ANDROID_RESOURCES'],
    ['Permission denied', 'BUILD_PERMISSION'],
  ];
  for (const [message, category] of samples) {
    const projection = createAndroidBuildFailure({ stage: 'gradle-release', code: 'ANDROID_BUILD_STAGE_FAILED',
      output: [secret, encoded, base64, message, secret].join('\n'), exitCode: 1 });
    assert.deepEqual(projection.categories, [category]);
    assert.deepEqual(validateAndroidBuildFailure(projection), projection);
    const json = JSON.stringify(projection);
    for (const value of [secret, encoded, base64, message]) assert.equal(json.includes(value), false);
  }
});

test('multiple hints are deduplicated in catalog order and process facts are constrained', () => {
  const projection = createAndroidBuildFailure({ stage: 'gradle-release', code: 'ANDROID_BUILD_STAGE_FAILED',
    output: 'Permission denied\nCould not GET dependency\nNo space left on device\nNo space left on device', exitCode: 137, signal: 'SIGKILL' });
  assert.deepEqual(projection.categories, ['BUILD_DISK_CAPACITY', 'BUILD_PROCESS_KILLED', 'BUILD_DOWNLOAD', 'BUILD_PERMISSION']);
  assert.equal(projection.exitCode, 137); assert.equal(projection.signal, 'SIGKILL');
  assert.deepEqual(classifyAndroidBuildOutput('ordinary unknown build failure'), ['BUILD_UNCLASSIFIED']);
  assert.deepEqual(classifyAndroidBuildOutput('x'.repeat(8 * 1024 * 1024 + 1) + 'No space left on device'), ['BUILD_UNCLASSIFIED']);
  const secret = randomBytes(32).toString('hex');
  const invalid = createAndroidBuildFailure({ stage: secret, code: secret, output: secret, exitCode: secret, signal: secret });
  assert.equal(invalid.stage, 'preparation'); assert.equal(invalid.code, 'ANDROID_BUILD_FAILED');
  assert.equal(invalid.exitCode, null); assert.equal(invalid.signal, null); assert.equal(JSON.stringify(invalid).includes(secret), false);
});

test('public projection rejects arbitrary fields, values, duplicate/reordered categories and malformed process facts', () => {
  const valid = createAndroidBuildFailure({ stage: 'gradle-release', code: 'ANDROID_BUILD_STAGE_FAILED', output: 'No space left on device', exitCode: 1 });
  const secret = randomBytes(32).toString('hex');
  for (const value of [null, [], { ...valid, message: secret }, { ...valid, status: 'passed' }, { ...valid, code: secret },
    { ...valid, stage: secret }, { ...valid, categories: [secret] }, { ...valid, categories: [] },
    { ...valid, categories: ['BUILD_DISK_CAPACITY', 'BUILD_DISK_CAPACITY'] },
    { ...valid, categories: ['BUILD_DOWNLOAD', 'BUILD_DISK_CAPACITY'] },
    { ...valid, categories: ['BUILD_DISK_CAPACITY', 'BUILD_UNCLASSIFIED'] }, { ...valid, exitCode: -1 },
    { ...valid, exitCode: Infinity }, { ...valid, exitCode: 1.5 }, { ...valid, signal: secret }, { ...valid, signal: 'SIGKILL\n' }]) {
    assert.throws(() => validateAndroidBuildFailure(value), { message: 'ANDROID_BUILD_DIAGNOSTIC_INVALID' });
  }
  assert.deepEqual(validateAndroidBuildFailure(Object.fromEntries(Object.entries(valid).reverse())), valid);
});

test('projection reader refuses malformed, oversized and non-file input without copying private text', async t => {
  const root = await fixture(t), secret = randomBytes(32).toString('base64url'), file = path.join(root, 'failure.json');
  const valid = createAndroidBuildFailure({ stage: 'gradle-release', code: 'ANDROID_BUILD_STAGE_FAILED', output: 'CMake Error', exitCode: 1 });
  await writeFile(file, JSON.stringify(valid)); assert.deepEqual(await readAndroidBuildFailure(file), valid);
  for (const bytes of [secret, JSON.stringify({ ...valid, message: secret }), ' '.repeat(32769)]) {
    await writeFile(file, bytes);
    await assert.rejects(readAndroidBuildFailure(file), error => error.message === 'ANDROID_BUILD_DIAGNOSTIC_INVALID' && !error.message.includes(secret));
  }
  await assert.rejects(readAndroidBuildFailure(root), { message: 'ANDROID_BUILD_DIAGNOSTIC_INVALID' });
});

test('the actual workflow failure projector retains only a verified projection or a fixed unavailable status', async t => {
  const root = await fixture(t), source = await readFile(new URL('../../../.github/workflows/android-emulator-proof.yml', import.meta.url), 'utf8');
  const section = source.split('name: Write a fixed failure stage without logs or private payloads')[1];
  const inline = /node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/.exec(section)?.[1].replace(/^ {10}/gm, '');
  assert.equal(typeof inline, 'string');
  await mkdir(path.join(root, 'examples/mobile-approval-app'), { recursive: true });
  await copyFile(new URL('../build-diagnostics.mjs', import.meta.url), path.join(root, 'examples/mobile-approval-app/build-diagnostics.mjs'));
  const proofRoot = path.join(root, 'owned-proof'), build = path.join(proofRoot, 'build'); await mkdir(build, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  const valid = createAndroidBuildFailure({ stage: 'gradle-release', code: 'ANDROID_BUILD_STAGE_FAILED', output: 'OutOfMemoryError ' + secret, exitCode: 1 });
  for (const candidate of [valid, { ...valid, message: secret }]) {
    await writeFile(path.join(build, 'build-failure.json'), JSON.stringify(candidate));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', inline], { cwd: root,
      env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), ANDROID_PROOF_ROOT: proofRoot,
        BUILD_OUTCOME: 'failure', SDK_OUTCOME: 'success', TOOLS_OUTCOME: 'success', PROOF_OUTCOME: 'skipped', EVIDENCE_OUTCOME: 'skipped' },
      timeout: 5000, maxBuffer: 4096, windowsHide: true });
    assert.equal(stdout, ''); assert.equal(stderr, '');
    const result = JSON.parse(await readFile(path.join(root, 'output/android-hosted-failure.json'), 'utf8'));
    assert.equal(result.stage, 'build'); assert.equal(result.status, 'failed');
    assert.equal(JSON.stringify(result).includes(secret), false);
    if (candidate === valid) { assert.deepEqual(result.buildDiagnostic, valid); assert.equal(result.buildDiagnosticStatus, undefined); }
    else { assert.equal(result.buildDiagnostic, undefined); assert.equal(result.buildDiagnosticStatus, 'unavailable'); }
    await rm(path.join(root, 'output/android-hosted-failure.json'));
  }
});
