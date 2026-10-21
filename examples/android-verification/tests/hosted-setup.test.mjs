/** Hosted policy and real Python archive extraction; no SDK/device/service commands. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANDROID_EXTRACT_PYTHON, ANDROID_HOSTED_ARCHIVES, ANDROID_HOSTED_BUILD_PACKAGES, hostedAndroidEnvironment,
  officialAndroidDownloadUrl, requireHostedAndroid } from '../../../scripts/android-hosted-setup.mjs';

const hosted = () => ({ platform: 'linux', architecture: 'x64', uid: 1001,
  env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    TESTLANE_ANDROID_PROOF_CI: '1', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1' }, osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n' });

test('the explicit hosted SDK pins both app and library-default Build Tools revisions', () => {
  assert.equal(Object.isFrozen(ANDROID_HOSTED_BUILD_PACKAGES), true);
  assert.deepEqual(ANDROID_HOSTED_BUILD_PACKAGES, ['platforms;android-37.0', 'build-tools;36.0.0', 'build-tools;37.0.0',
    'ndk;27.1.12297006', 'cmake;3.22.1']);
});

test('Linux hosted proof policy refuses missing flags, root, ARM and other OS contexts before allocation', () => {
  assert.equal(requireHostedAndroid(hosted()), true);
  for (const change of [{ platform: 'win32' }, { platform: 'darwin' }, { architecture: 'arm64' }, { uid: 0 }, { uid: null },
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
function fixtureChild(executable, args, input) {
  let result;
  try {
    // Fixed stdlib-only fixture commands create no descendants. spawnSync waits
    // for child closure; 10s is the kill-signal deadline, not OS preemption.
    result = spawnSync(executable, args, { input: JSON.stringify(input), encoding: 'utf8',
      stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: false, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 16384 });
  } catch {
    throw Object.assign(Error('fixture child outcome unconfirmed'), { preserveFixtureRoot: true });
  }
  const exited = Number.isInteger(result.status) && result.status >= 0;
  const signalled = Number.isInteger(result.pid) && result.pid > 0 && typeof result.signal === 'string' && Object.hasOwn(os.constants.signals, result.signal);
  const neverStarted = result.pid === 0 && ['ENOENT','EACCES','EPERM','EINVAL','ENOTDIR'].includes(result.error?.code);
  if (result.error || result.signal !== null || !exited) {
    const error = Error(result.error?.code === 'ETIMEDOUT' ? 'fixture child timeout' : 'fixture child failed');
    if (!exited && !signalled && !neverStarted) error.preserveFixtureRoot = true;
    throw error;
  }
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}
async function python(script, input) {
  // Use the configured interpreter on macOS rather than a fixed system path.
  // This fixture choice does not alter the Linux production installer.
  return fixtureChild(process.platform === 'win32' ? 'python' : process.platform === 'darwin' ? 'python3' : '/usr/bin/python3',
    ['-I', '-c', script], input);
}
async function extractionInput(archive, parent) {
  // Windows hosted TEMP can be an alias, and Python and Node can report different
  // canonical spelling. Supply the extractor's own canonical path convention
  // without weakening its production Linux directory check.
  const canonical = await python("import json,os,sys\nr=json.load(sys.stdin)\nr['archive']=os.path.realpath(r['archive'])\nr['parent']=os.path.realpath(r['parent'])\nprint(json.dumps(r))", { archive, parent, top: 'emulator' });
  assert.equal(canonical.code, 0, canonical.stderr);
  const input = JSON.parse(canonical.stdout);
  assert.equal(await realpath(input.parent), await realpath(parent));
  assert.equal(await realpath(input.archive), await realpath(archive));
  return input;
}
test('verified archive extraction validates the whole manifest before writes and rejects traversal, links and device nodes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tld-hosted-zip-'));
  let preserveRoot = false;
  try {
    const archive = path.join(root, 'fixture.zip');
    for (const entry of [{ name: '../outside' }, { name: '/absolute' }, { name: 'other/file' }, { name: 'emulator/../outside' },
      { name: 'emulator/back\\slash' }, { name: 'emulator/drive:C' }, { name: 'emulator/link', mode: 0o120777 },
      { name: 'emulator/device', mode: 0o020600 }, { name: 'emulator/good' }]) {
      assert.equal((await python(makeZip, { archive, entries: [{ name: 'emulator/good' }, entry] })).code, 0);
      assert.notEqual((await python(ANDROID_EXTRACT_PYTHON, await extractionInput(archive, root))).code, 0, entry.name);
      assert.deepEqual(await readdir(root), ['fixture.zip'], 'refusal writes no archive entries');
      await rm(archive);
    }
    assert.equal((await python(makeZip, { archive, entries: [{ name: 'emulator/bin/tool', content: 'public tool fixture', mode: 0o100755 },
      { name: 'emulator/source.properties', content: 'Pkg.Revision=35.6.11' }] })).code, 0);
    const extracted = await python(ANDROID_EXTRACT_PYTHON, await extractionInput(archive, root));
    assert.equal(extracted.code, 0, extracted.stderr);
    assert.equal(await readFile(path.join(root, 'emulator/bin/tool'), 'utf8'), 'public tool fixture');
  } catch (error) {
    preserveRoot = error?.preserveFixtureRoot === true; throw error;
  } finally {
    if (!preserveRoot) {
      const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.match(path.basename(resolved), /^tld-hosted-zip-/); await rm(resolved, { recursive: true, force: true });
    }
  }
});

test('fixture timeout settles its exact child before owned directory removal and never counts as an extractor refusal', async () => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'tld-fixture-child-'));
  const handshake = path.join(root, 'ready.json'); let preserveRoot = true;
  const script = `import {writeFileSync} from 'node:fs';let input='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',part=>{input+=part;});process.stdin.on('end',()=>{
      const request=JSON.parse(input);writeFileSync(request.handshake,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
      setInterval(()=>{},1000);
    });`;
  try {
    let failure;
    try { fixtureChild(process.execPath, ['--input-type=module', '-e', script], { handshake }); }
    catch (error) { failure = error; }
    assert.equal(failure?.message, 'fixture child timeout'); assert.notEqual(failure?.preserveFixtureRoot, true);
    const child = JSON.parse(await readFile(handshake, 'utf8'));
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'retained direct child is absent before cleanup');
    preserveRoot = false;
    assert.equal(fixtureChild(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(2));"], {}).code, 2,
      'only an actual numeric exit can represent an intentional refusal');
  } catch (error) {
    preserveRoot ||= error?.preserveFixtureRoot === true; throw error;
  } finally {
    if (!preserveRoot) {
      assert.equal(await realpath(root), root); assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^tld-fixture-child-/);
      await rm(root, { recursive: true, force: true });
      await assert.rejects(readFile(handshake), { code: 'ENOENT' });
    }
  }
});
