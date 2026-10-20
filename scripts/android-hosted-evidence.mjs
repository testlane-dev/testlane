/** Validate and project the nine public JSON artifacts; private logs are never eligible. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeNativeReport, validateNativePlan } from '../examples/android-verification/contracts.mjs';
import { APPROVAL_REQUIREMENTS } from '../examples/android-verification/proof-cases.mjs';
import { NATIVE_PROOF_BUDGETS } from '../examples/android-verification/budgets.mjs';
import { ANDROID_HOSTED_ARCHIVES } from './android-hosted-setup.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));
const fail = () => Error('ANDROID_HOSTED_EVIDENCE_REFUSED');
export function publicAndroidReadiness(value) {
  assert.ok(exact(value, ['schemaVersion','purpose','runner','installedDriver','sessionCreated','nativeContextVerified','appReadinessObserved','sessionCleanup','sessionSetupMs','readinessMs']));
  assert.equal(value.schemaVersion, 1); assert.equal(value.purpose, 'credential-free-native-readiness'); assert.equal(value.runner, 'android-uiautomator2');
  for (const key of ['installedDriver','sessionCreated','nativeContextVerified','appReadinessObserved']) assert.equal(value[key], true);
  assert.equal(value.sessionCleanup, 'deleted'); assert.ok(count(value.sessionSetupMs)); assert.ok(count(value.readinessMs)); return value;
}
export function publicAndroidPreflight(value) {
  assert.ok(exact(value, ['schemaVersion','hostOS','architecture','ubuntu','hostedPolicyChecked','kvm','javaMajor','javaSha256','archives','availableBeforeSetup','availableBeforeBuild','node']));
  assert.equal(value.schemaVersion, 1); assert.equal(value.hostOS, 'linux'); assert.equal(value.architecture, 'x64'); assert.equal(value.ubuntu, '24.04');
  assert.equal(value.hostedPolicyChecked, true); assert.equal(value.kvm, true); assert.equal(value.javaMajor, 21); assert.ok(hash(value.javaSha256));
  assert.ok(/^v22\.[0-9]+\.[0-9]+$/.test(value.node)); assert.ok(count(value.availableBeforeSetup)); assert.ok(count(value.availableBeforeBuild));
  assert.ok(Array.isArray(value.archives)); assert.equal(value.archives.length, ANDROID_HOSTED_ARCHIVES.length);
  for (let i = 0; i < value.archives.length; i++) {
    const row = value.archives[i], pin = ANDROID_HOSTED_ARCHIVES[i];
    assert.ok(exact(row, ['id','bytes','officialDigestAlgorithm','officialDigest','observedSha256']));
    assert.equal(row.id, pin.id); assert.equal(row.bytes, pin.bytes); assert.equal(row.officialDigestAlgorithm, pin.algorithm);
    assert.equal(row.officialDigest, pin.digest); assert.ok(hash(row.observedSha256));
    if (pin.algorithm === 'sha256') assert.equal(row.observedSha256, pin.digest);
  }
  return value;
}
export function publicAndroidPhase(report, plan, phase) {
  const clean = sanitizeNativeReport(report, plan), fault = phase === 'fault';
  assert.ok(['positive','fault','corrected'].includes(phase)); assert.equal(clean.verdict, fault ? 'failed' : 'passed'); assert.deepEqual(clean.reasonCodes, []);
  const expected = fault ? [11,16,14,17,7] : [14,16,18,17,7];
  for (let index = 0; index < clean.cases.length; index++) {
    const row = clean.cases[index], failed = fault && [0,2].includes(index);
    assert.equal(row.attempts, 1); assert.equal(row.bodyAssertionsObserved, expected[index]);
    assert.equal(row.status, failed ? 'failed' : 'passed'); assert.equal(row.reason, failed ? 'NATIVE_ASSERTION_FAILED' : 'NATIVE_CASE_PASSED');
    assert.equal(row.cleanup.status, index === 4 ? 'not-required' : 'completed'); assert.equal(row.cleanupAssertionsObserved, index === 4 ? 0 : 7);
  }
  return clean;
}
async function readJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw fail();
  const bytes = await readFile(file); return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}
export async function verifyAndroidEvidenceFiles({ receipt, planBytes, buildBytes, apkFile, specFile }) {
  assert.equal(receipt.planSha256, sha(planBytes)); assert.equal(receipt.buildManifestSha256, sha(buildBytes));
  const apkInfo = await lstat(apkFile), specInfo = await lstat(specFile);
  assert.ok(apkInfo.isFile() && !apkInfo.isSymbolicLink() && apkInfo.size > 0 && apkInfo.size <= 512 * 1024 * 1024);
  assert.ok(specInfo.isFile() && !specInfo.isSymbolicLink() && specInfo.size <= 1024 * 1024);
  const apkHash = createHash('sha256');
  for await (const chunk of createReadStream(apkFile)) apkHash.update(chunk);
  assert.equal(receipt.apkSha256, apkHash.digest('hex'));
  assert.equal(receipt.specSha256, sha(await readFile(specFile)));
}
async function sourceBinding() {
  const head = process.env.REVIEWED_HEAD, execution = process.env.GITHUB_SHA, runId = process.env.GITHUB_RUN_ID, runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (![head, execution].every(value => /^[a-f0-9]{40}$/.test(value ?? '')) || ![runId, runAttempt].every(value => /^[1-9][0-9]*$/.test(value ?? ''))) throw fail();
  execFileSync('git', ['diff','--exit-code','--quiet',head,execution,'--','.'], { stdio: 'ignore' });
  execFileSync('git', ['diff','--exit-code','--quiet',execution,'--','.'], { stdio: 'ignore' });
  const files = ['.github/workflows/android-emulator-proof.yml','scripts/android-proof.mjs','scripts/native-proof-support.mjs',
    'scripts/android-hosted-setup.mjs','scripts/android-hosted-runtime.mjs','scripts/android-hosted-evidence.mjs',
    'examples/android-verification/device.mjs','examples/android-verification/environment.mjs','examples/android-verification/process-group.mjs',
    'examples/android-verification/driver.mjs','examples/android-verification/proof-cases.mjs','examples/android-verification/contracts.mjs',
    'examples/android-verification/readiness.mjs','examples/android-verification/budgets.mjs','examples/android-verification/tools/package-lock.json','package-lock.json'];
  const blobs = {};
  for (const file of files) blobs[file] = execFileSync('git', ['rev-parse', execution + ':' + file], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  assert.ok(Object.values(blobs).every(value => /^[a-f0-9]{40}$/.test(value)));
  return { reviewedHead: head, executionCommit: execution, runId, runAttempt, gitBlobs: blobs };
}
export async function stageAndroidEvidence({ root, proof, output, preflight }) {
  const planInput = await readJson(path.join(proof, 'plan.json')), plan = validateNativePlan(planInput.value);
  assert.equal(plan.runner, 'android-uiautomator2'); assert.equal(plan.status, 'reviewed'); assert.equal(plan.title, 'Synthetic native approval proof');
  assert.deepEqual(plan.cases.map(({ cleanup, ...row }) => row), APPROVAL_REQUIREMENTS);
  assert.equal(plan.target.environment, 'testing'); assert.equal(plan.app.package, 'dev.testlane.androidproof');
  const receiptInput = await readJson(path.join(proof, 'receipt.json')), receipt = receiptInput.value;
  for (const key of ['passed','proofOnly','cleanupVerified','credentialLeakScanPassed']) assert.equal(receipt[key], true);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.runner, plan.runner); assert.equal(receipt.context, 'NATIVE_APP'); assert.equal(receipt.nativeStore, 'secret-service');
  for (const key of ['packageTreeSha256','apkSha256','buildManifestSha256','planSha256','specSha256']) assert.ok(hash(receipt[key]));
  assert.equal(receipt.planSha256, sha(planInput.bytes)); assert.equal(receipt.apkSha256, plan.app.apkSha256); assert.deepEqual(receipt.budgets, NATIVE_PROOF_BUDGETS);
  assert.deepEqual(receipt.runs, ['positive','fault','corrected'].map(phase => ({ phase, verdict: phase === 'fault' ? 'failed' : 'passed',
    passed: phase === 'fault' ? 3 : 5, failed: phase === 'fault' ? 2 : 0, recordsRemaining: 0 })));
  const readiness = publicAndroidReadiness((await readJson(path.join(proof, 'readiness.json'))).value);
  assert.deepEqual(receipt.androidReadiness, readiness);
  const buildInput = await readJson(path.join(root, 'build/build-manifest.json')), build = buildInput.value;
  assert.equal(sha(buildInput.bytes), receipt.buildManifestSha256); assert.equal(build.apkSHA256, receipt.apkSha256);
  await verifyAndroidEvidenceFiles({ receipt, planBytes: planInput.bytes, buildBytes: buildInput.bytes,
    apkFile: path.join(root, 'build/testlane-android-proof.apk'), specFile: 'examples/android-verification/proof-cases.mjs' });
  const publicFiles = ['package.json','package-lock.json','app.config.cjs','index.js','App.js','bootstrap.mjs','plugins/withProofBuild.cjs'];
  assert.deepEqual(Object.keys(build.publicSourceSHA256).sort(), [...publicFiles].sort()); assert.deepEqual(build.publicSourceSHA256, receipt.publicAppSourceSha256);
  for (const file of publicFiles) assert.equal(build.publicSourceSHA256[file], sha(await readFile(path.join('examples/mobile-approval-app', file))));
  const linux = (await readJson(path.join(proof, 'linux-runtime-cleanup.json'))).value;
  const cleanupKeys = ['schemaVersion','privateBusStopped','keyringStopped','processGroupsAbsent','runtimeStorageRemoved','canaryRemoved','unlockSecretLeakScanPassed','proofExitCode'];
  assert.ok(exact(linux, cleanupKeys)); assert.equal(linux.schemaVersion, 1); assert.equal(linux.proofExitCode, 0);
  for (const key of cleanupKeys.filter(key => !['schemaVersion','proofExitCode'].includes(key))) assert.equal(linux[key], true);
  const source = await sourceBinding(), staged = {
    'android-preflight.json': publicAndroidPreflight((await readJson(preflight)).value), 'readiness.json': readiness,
    'plan.json': { schemaVersion: 1, purpose: 'public-plan-projection', originalPlanSha256: receipt.planSha256,
      runner: plan.runner, environment: plan.target.environment, app: { package: 'dev.testlane.androidproof', apkSha256: receipt.apkSha256 }, cases: APPROVAL_REQUIREMENTS },
    'receipt.json': { schemaVersion: 1, purpose: 'public-receipt-projection', originalReceiptSha256: sha(receiptInput.bytes), passed: true,
      runner: plan.runner, context: 'NATIVE_APP', proofOnly: true, nativeStore: 'secret-service', source,
      packageTreeSha256: receipt.packageTreeSha256, apkSha256: receipt.apkSha256, buildManifestSha256: receipt.buildManifestSha256,
      planSha256: receipt.planSha256, specSha256: receipt.specSha256, publicAppSourceSha256: receipt.publicAppSourceSha256,
      budgets: NATIVE_PROOF_BUDGETS, runs: receipt.runs, cleanupVerified: true, credentialLeakScanPassed: true },
    'build-manifest.json': { schemaVersion: 1, purpose: 'public-build-projection', originalBuildManifestSha256: receipt.buildManifestSha256,
      package: 'dev.testlane.androidproof', apkSha256: receipt.apkSha256, publicSourceSha256: build.publicSourceSHA256 }, 'linux-runtime-cleanup.json': linux,
  };
  for (const phase of ['positive','fault','corrected']) staged[phase + '.json'] = publicAndroidPhase((await readJson(path.join(proof, phase + '.json'))).value, plan, phase);
  const parent = await realpath(path.dirname(output)); assert.equal(parent, path.dirname(output)); await mkdir(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(staged)) await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function isEntry() { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isEntry()) {
  const [root, proof, output, preflight] = process.argv.slice(2);
  if (process.argv.length !== 6) { console.error('ANDROID_HOSTED_EVIDENCE_REFUSED'); process.exitCode = 1; }
  else stageAndroidEvidence({ root, proof, output, preflight }).catch(() => { console.error('ANDROID_HOSTED_EVIDENCE_REFUSED'); process.exitCode = 1; });
}
