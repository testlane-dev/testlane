/** Hosted policy and real Python archive extraction; no SDK/device/service commands. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANDROID_EXTRACT_PYTHON, ANDROID_HOSTED_ARCHIVES, hostedAndroidEnvironment,
  officialAndroidDownloadUrl, requireHostedAndroid } from '../../../scripts/android-hosted-setup.mjs';

const hosted = () => ({ platform: 'linux', architecture: 'x64', uid: 1001,
  env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    TESTLANE_ANDROID_PROOF_CI: '1', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1' }, osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n' });

test('Linux hosted proof policy refuses missing flags, root, ARM and other OS contexts before allocation', () => {
  assert.equal(requireHostedAndroid(hosted()), true);
  for (const change of [{ platform: 'win32' }, { platform: 'darwin' }, { architecture: 'arm64' }, { uid: 0 }, { uid: undefined },
    { osRelease: 'ID=ubuntu\nVERSION_ID="22.04"\n' }, { osRelease: 'ID=debian\nVERSION_ID="24.04"\n' },
    ...Object.keys(hosted().env).map(key => ({ env: { ...hosted().env, [key]: undefined } })),
    { env: { ...hosted().env, RUNNER_ENVIRONMENT: 'self-hosted' } }, { env: { ...hosted().env, GITHUB_RUN_ID: '1\n2' } }]) {
    assert.throws(() => requireHostedAndroid({ ...hosted(), ...change }), { message: 'ANDROID_HOSTED_HOST_REFUSED' });
  }
});

test('SDK download policy accepts only HTTPS official hosts without credentials, query or fragments', () => {
  for (const archive of ANDROID_HOSTED_ARCHIVES) assert.equal(officialAndroidDownloadUrl(archive.url), archive.url);
  // These malformed inputs are test values, rather than public reference links.
  const https = 'https:' + '//', http = 'http:' + '//';
  const cdn = https + 'cache.gvt1.com/edgedl/android/repository/package.zip';
  assert.equal(officialAndroidDownloadUrl(cdn), cdn);
  for (const value of [http + 'dl.google.com/a.zip', https + 'dl.google.com.evil.test/a.zip', https + 'example.test/a.zip',
    https + 'name@dl.google.com/a.zip', https + 'dl.google.com:444/a.zip', https + 'dl.google.com/a.zip?q=1', https + 'dl.google.com/a.zip#fragment', 'file:///tmp/a.zip']) {
    assert.throws(() => officialAndroidDownloadUrl(value), { message: 'ANDROID_HOSTED_DOWNLOAD_URL_REFUSED' });
  }
});

test('installer environment is constructed from explicit owned paths, without ambient credentials or injection', () => {
  const root = path.join(os.tmpdir(), 'tld-hosted-unit'), sdk = path.join(root, 'sdk'), java = path.join(root, 'java');
  const result = hostedAndroidEnvironment({ root, sdk, java });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result).sort(), ['HOME','TMPDIR','TMP','TEMP','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME',
    'ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_USER_HOME','JAVA_HOME','PATH','LANG','LC_ALL'].sort());
  for (const key of ['HOME','TMPDIR','TMP','TEMP','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','ANDROID_USER_HOME']) {
    assert.ok(result[key].startsWith(root + path.sep));
  }
  assert.equal(result.ANDROID_HOME, sdk); assert.equal(result.JAVA_HOME, java);
  assert.throws(() => hostedAndroidEnvironment({ root: '.', sdk, java }), { message: 'ANDROID_HOSTED_PATH_REFUSED' });
});

const makeZip = String.raw`import json,os,stat,sys,zipfile
request=json.load(sys.stdin)
with zipfile.ZipFile(request['archive'],'w') as output:
 for entry in request['entries']:
  item=zipfile.ZipInfo(entry['name']);item.filename=entry['name'];item.create_system=3;item.external_attr=entry.get('mode',stat.S_IFREG|0o644)<<16
  output.writestr(item,entry.get('content','synthetic fixture'))
`;
async function python(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'python' : '/usr/bin/python3', ['-I', '-c', script],
      { stdio: ['pipe','ignore','pipe'], windowsHide: true, shell: false });
    let stderr = ''; child.stderr.on('data', value => { if (stderr.length < 16384) stderr += value; });
    child.stdin.on('error', () => {}); child.once('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(Error('fixture Python timeout')); }, 10000);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stderr }); }); child.stdin.end(JSON.stringify(input));
  });
}
test('verified archive extraction validates the whole manifest before writes and rejects traversal, links and device nodes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tld-hosted-zip-'));
  try {
    const archive = path.join(root, 'fixture.zip');
    for (const entry of [{ name: '../outside' }, { name: '/absolute' }, { name: 'other/file' }, { name: 'emulator/../outside' },
      { name: 'emulator/back\\slash' }, { name: 'emulator/drive:C' }, { name: 'emulator/link', mode: 0o120777 },
      { name: 'emulator/device', mode: 0o020600 }, { name: 'emulator/good' }]) {
      assert.equal((await python(makeZip, { archive, entries: [{ name: 'emulator/good' }, entry] })).code, 0);
      assert.notEqual((await python(ANDROID_EXTRACT_PYTHON, { archive, parent: root, top: 'emulator' })).code, 0, entry.name);
      assert.deepEqual(await readdir(root), ['fixture.zip'], 'refusal writes no archive entries');
      await rm(archive);
    }
    assert.equal((await python(makeZip, { archive, entries: [{ name: 'emulator/bin/tool', content: 'public tool fixture', mode: 0o100755 },
      { name: 'emulator/source.properties', content: 'Pkg.Revision=35.6.11' }] })).code, 0);
    const extracted = await python(ANDROID_EXTRACT_PYTHON, { archive, parent: root, top: 'emulator' });
    assert.equal(extracted.code, 0, extracted.stderr);
    assert.equal(await readFile(path.join(root, 'emulator/bin/tool'), 'utf8'), 'public tool fixture');
  } finally {
    const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^tld-hosted-zip-/); await rm(resolved, { recursive: true, force: true });
  }
});
