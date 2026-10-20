/** File-binding and projection contracts only; these bytes do not represent native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publicAndroidPreflight, publicAndroidReadiness, verifyAndroidEvidenceFiles } from '../../../scripts/android-hosted-evidence.mjs';
import { ANDROID_HOSTED_ARCHIVES } from '../../../scripts/android-hosted-setup.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('mixed or stale APK, case, plan and manifest bytes cannot acquire current-source evidence binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tld-evidence-bind-'));
  const apkFile = path.join(root, 'fixture.apk'), specFile = path.join(root, 'fixture.mjs');
  const apk = randomBytes(40), spec = randomBytes(50), planBytes = randomBytes(60), buildBytes = randomBytes(70);
  const receipt = { apkSha256: sha(apk), specSha256: sha(spec), planSha256: sha(planBytes), buildManifestSha256: sha(buildBytes) };
  const options = { receipt, apkFile, specFile, planBytes, buildBytes };
  try {
    await writeFile(apkFile, apk); await writeFile(specFile, spec);
    await verifyAndroidEvidenceFiles(options);
    await writeFile(apkFile, randomBytes(41)); await assert.rejects(verifyAndroidEvidenceFiles(options));
    await writeFile(apkFile, apk); await writeFile(specFile, randomBytes(51)); await assert.rejects(verifyAndroidEvidenceFiles(options));
    await writeFile(specFile, spec);
    await assert.rejects(verifyAndroidEvidenceFiles({ ...options, planBytes: randomBytes(61) }));
    await assert.rejects(verifyAndroidEvidenceFiles({ ...options, buildBytes: randomBytes(71) }));
  } finally {
    const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^tld-evidence-bind-/); await rm(resolved, { recursive: true, force: true });
  }
});
test('public readiness refuses unknown payloads and incomplete cleanup acknowledgements', () => {
  const good = { schemaVersion: 1, purpose: 'credential-free-native-readiness', runner: 'android-uiautomator2', installedDriver: true,
    sessionCreated: true, nativeContextVerified: true, appReadinessObserved: true, sessionCleanup: 'deleted', sessionSetupMs: 20, readinessMs: 30 };
  assert.deepEqual(publicAndroidReadiness(good), good);
  for (const change of [{ privatePayload: randomBytes(24).toString('hex') }, { sessionCleanup: 'unknown' },
    { nativeContextVerified: false }, { readinessMs: -1 }, { sessionSetupMs: Infinity }]) {
    assert.throws(() => publicAndroidReadiness({ ...good, ...change }));
  }
});
test('public preflight binds exact official pin metadata and rejects unknown fields or substituted archives', () => {
  const good = { schemaVersion: 1, hostOS: 'linux', architecture: 'x64', ubuntu: '24.04', hostedPolicyChecked: true, kvm: true,
    javaMajor: 21, javaSha256: sha(randomBytes(30)), availableBeforeSetup: 20 * 1024 ** 3, availableBeforeBuild: 10 * 1024 ** 3, node: 'v22.23.3',
    archives: ANDROID_HOSTED_ARCHIVES.map(pin => ({ id: pin.id, bytes: pin.bytes, officialDigestAlgorithm: pin.algorithm,
      officialDigest: pin.digest, observedSha256: pin.algorithm === 'sha256' ? pin.digest : sha(randomBytes(20)) })) };
  assert.deepEqual(publicAndroidPreflight(good), good);
  for (const change of [{ arbitraryPath: randomBytes(18).toString('hex') }, { kvm: false }, { javaMajor: 22 },
    { node: randomBytes(18).toString('hex') }, { archives: good.archives.map((row, index) => index ? row : { ...row, officialDigest: sha(randomBytes(20)) }) }]) {
    assert.throws(() => publicAndroidPreflight({ ...good, ...change }));
  }
});
