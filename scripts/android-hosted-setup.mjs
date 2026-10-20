/** Explicit SDK setup for one ephemeral hosted Linux proof; never starts a device. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream, realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { confirmRetainedGroupAbsent, retainDetachedChild, stopRetainedGroup } from '../examples/android-verification/process-group.mjs';

const fail = code => new Error('ANDROID_HOSTED_' + code);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const GIB = 1024 ** 3;
export const ANDROID_HOSTED_ARCHIVES = Object.freeze([
  Object.freeze({ id: 'emulator', url: 'https://dl.google.com/android/repository/emulator-linux_x64-13610412.zip',
    bytes: 319086252, algorithm: 'sha256', digest: '2fe2b56fe93ce75e1d478a40162131381d911c355efeaedb54dd1e0d0897a5cf',
    top: 'emulator', parent: '', revision: '35.6.11' }),
  Object.freeze({ id: 'platform-tools', url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip',
    bytes: 9054187, algorithm: 'sha1', digest: '477254aa5f903c15cf51001717bdf347fb6b53e0',
    top: 'platform-tools', parent: '', revision: '37.0.1' }),
  Object.freeze({ id: 'image', url: 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip',
    bytes: 1563721130, algorithm: 'sha1', digest: 'e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7',
    top: 'x86_64', parent: 'system-images/android-34/google_apis', revision: '14' }),
]);

export function requireHostedAndroid({ platform = process.platform, architecture = process.arch, env = process.env,
  uid = process.getuid?.(), osRelease } = {}) {
  if (platform !== 'linux' || architecture !== 'x64' || uid === 0 || !Number.isSafeInteger(uid) || uid < 1 ||
    env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux' ||
    env.TESTLANE_ANDROID_PROOF_CI !== '1' || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^ID=ubuntu$/m.test(osRelease ?? '') || !/^VERSION_ID="24\.04"$/m.test(osRelease ?? '')) throw fail('HOST_REFUSED');
  return true;
}
export function officialAndroidDownloadUrl(input) {
  try {
    const value = new URL(input);
    if (value.protocol !== 'https:' || value.username || value.password || value.port ||
      !(value.hostname === 'dl.google.com' || value.hostname === 'edgedl.me.gvt1.com' || value.hostname.endsWith('.gvt1.com')) ||
      value.hash || value.search) throw Error();
    return value.href;
  } catch { throw fail('DOWNLOAD_URL_REFUSED'); }
}
export function hostedAndroidEnvironment({ root, sdk, java, node = process.execPath }) {
  if ([root, sdk, java, node].some(value => typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value))) throw fail('PATH_REFUSED');
  return Object.freeze({ HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: path.join(root, 'android'), JAVA_HOME: java,
    PATH: [path.dirname(node), path.join(java, 'bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
}
export async function requireHostedCapacity(directory, minimumBytes) {
  const info = await statfs(directory), availableBytes = info.bavail * info.bsize;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < minimumBytes) throw fail('DISK_CAPACITY_INSUFFICIENT');
  return availableBytes;
}
async function ordinaryFile(file, maximum = 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw fail('INPUT_REFUSED');
  return readFile(file);
}
async function canonicalDirectory(directory) {
  const resolved = await realpath(directory), info = await lstat(directory);
  if (resolved !== directory || !info.isDirectory() || info.isSymbolicLink()) throw fail('DIRECTORY_REFUSED');
  return resolved;
}
async function run(entry, args, { cwd, env, input, milliseconds = 120000, logFile, signal }) {
  // Setup is credential-free. Failure never advances to proof or removes the
  // partially installed tree. Every command gets its own detached process group.
  if (signal?.aborted) throw fail('SETUP_CANCELLED');
  let output = '', overflow = false;
  const child = spawn(entry, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const retained = retainDetachedChild(child);
  const append = chunk => {
    if (Buffer.byteLength(output) + chunk.length > 8 * 1024 * 1024) overflow = true;
    else output += chunk.toString('utf8');
  };
  child.stdout.on('data', append); child.stderr.on('data', append); child.stdin.on('error', () => {});
  let timer, cancel;
  const interrupted = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), milliseconds);
    cancel = () => resolve('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  let reason, commandError;
  try {
    child.stdin.end(input);
    reason = await Promise.race([retained.done.then(() => 'closed'), interrupted]);
    try {
      if (reason === 'closed') confirmRetainedGroupAbsent(retained);
      else await stopRetainedGroup(retained);
    } catch { commandError = fail('SETUP_TERMINATION_UNCONFIRMED'); }
    if (!commandError && (reason !== 'closed' || overflow || retained.code !== 0)) {
      commandError = fail(reason === 'timeout' ? 'SETUP_TIMEOUT' : reason === 'cancelled' ? 'SETUP_CANCELLED' : overflow ? 'SETUP_OUTPUT_LIMIT' : 'SETUP_COMMAND_FAILED');
    }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  if (logFile) {
    try { await writeFile(logFile, output, { flag: 'wx', mode: 0o600 }); }
    catch { commandError ??= fail('SETUP_LOG_WRITE_FAILED'); }
  }
  if (commandError) throw commandError;
  return output;
}
async function download(archive, destination, signal) {
  const bound = archive.bytes, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  try {
    let url = officialAndroidDownloadUrl(archive.url), response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || redirects === 5) throw fail('DOWNLOAD_REDIRECT_REFUSED');
        url = officialAndroidDownloadUrl(new URL(location, url).href); continue;
      }
      break;
    }
    if (response.status !== 200 || !response.body) throw fail('DOWNLOAD_FAILED');
    let bytes = 0; const official = createHash(archive.algorithm), actual = createHash('sha256');
    const guard = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > bound) { callback(fail('DOWNLOAD_SIZE_REFUSED')); return; }
      official.update(chunk); actual.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (official.digest('hex') !== archive.digest || bytes !== bound) throw fail('DOWNLOAD_DIGEST_MISMATCH');
    return Object.freeze({ id: archive.id, bytes, officialDigestAlgorithm: archive.algorithm, officialDigest: archive.digest, observedSha256: actual.digest('hex') });
  } catch (error) { throw /^ANDROID_HOSTED_[A-Z_]+$/.test(error?.message ?? '') ? error : fail('DOWNLOAD_FAILED'); }
  finally { clearTimeout(timer); }
}

// The verified archive is still untrusted as a filesystem operation. Validate
// all entries before writing any bytes; no absolute paths, links or special files.
export const ANDROID_EXTRACT_PYTHON = String.raw`import json,os,pathlib,stat,sys,zipfile
request=json.load(sys.stdin)
archive,parent,top=request['archive'],request['parent'],request['top']
assert os.path.isabs(archive) and os.path.isabs(parent) and os.path.realpath(parent)==parent
with zipfile.ZipFile(archive) as source:
 entries=source.infolist()
 assert len(entries)<=200000 and sum(x.file_size for x in entries)<=12*1024**3
 names=set()
 for item in entries:
  name=item.filename
  assert name==item.orig_filename
  parts=pathlib.PurePosixPath(name).parts
  mode=item.external_attr>>16
  assert name and chr(92) not in name and chr(0) not in name and not name.startswith('/') and parts[0]==top
  assert all(x not in ('.','..','') for x in parts) and ':' not in name and name not in names
  assert not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in (0,stat.S_IFREG,stat.S_IFDIR))
  names.add(name)
 for item in entries:
  destination=os.path.join(parent,*pathlib.PurePosixPath(item.filename).parts)
  assert os.path.commonpath([parent,destination])==parent
  if item.is_dir(): os.makedirs(destination,mode=0o700,exist_ok=True)
  else:
   os.makedirs(os.path.dirname(destination),mode=0o700,exist_ok=True)
   with source.open(item) as src,open(destination,'xb') as dst:
    while True:
     block=src.read(1024*1024)
     if not block: break
     dst.write(block)
   os.chmod(destination,0o700 if ((item.external_attr>>16)&0o111) else 0o600)
`;

export async function setupHostedAndroid({ root, sdkBase, javaHome, outputFile, signal }) {
  if (signal?.aborted) throw fail('SETUP_CANCELLED');
  requireHostedAndroid({ osRelease: await readFile('/etc/os-release', 'utf8') });
  await access('/dev/kvm', constants.R_OK | constants.W_OK);
  if (!(await lstat('/dev/kvm')).isCharacterDevice()) throw fail('KVM_REFUSED');
  const runnerTemp = await canonicalDirectory(await realpath(process.env.RUNNER_TEMP));
  const expected = path.join(runnerTemp, `testlane-android-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  if (root !== expected || !path.isAbsolute(outputFile)) throw fail('ROOT_REFUSED');
  const sdkSource = await realpath(sdkBase), java = await realpath(javaHome), node = await realpath(process.execPath);
  const sdkmanager = await realpath(path.join(sdkSource, 'cmdline-tools/latest/bin/sdkmanager'));
  if (!sdkmanager.startsWith(sdkSource + path.sep)) throw fail('SDKMANAGER_REFUSED');
  await access(path.join(java, 'bin/java'), constants.X_OK); await access(path.join(java, 'bin/javac'), constants.X_OK);
  const availableBeforeSetup = await requireHostedCapacity(runnerTemp, 12 * GIB);
  await mkdir(root, { mode: 0o700 }); await canonicalDirectory(root);
  const sdk = path.join(root, 'sdk'), env = hostedAndroidEnvironment({ root, sdk, java, node });
  for (const directory of [sdk, ...['home','tmp','cache','config','data','android','archives'].map(name => path.join(root, name))]) await mkdir(directory, { mode: 0o700 });
  const markerFile = path.join(root, 'testlane-hosted-android.json');
  const marker = JSON.stringify({ schemaVersion: 1, purpose: 'ephemeral-hosted-android-proof', nonce: randomBytes(12).toString('hex'),
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, root });
  await writeFile(markerFile, marker, { flag: 'wx', mode: 0o600 });
  async function assertOwned() {
    await canonicalDirectory(root); await canonicalDirectory(sdk);
    const info = await lstat(root);
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || (await ordinaryFile(markerFile, 32768)).toString('utf8') !== marker) throw fail('OWNERSHIP_REFUSED');
  }
  await assertOwned();
  const javaVersion = await run(path.join(java, 'bin/java'), ['-version'], { cwd: root, env, signal });
  const javacVersion = await run(path.join(java, 'bin/javac'), ['-version'], { cwd: root, env, signal });
  if (!/version "21\./.test(javaVersion) || !/^javac 21\./.test(javacVersion)) throw fail('JAVA_VERSION_REFUSED');
  const licenses = path.join(sdk, 'licenses'); await mkdir(licenses, { mode: 0o700 });
  for (const name of ['android-sdk-license', 'android-sdk-preview-license', 'google-gdk-license']) {
    try { await writeFile(path.join(licenses, name), await ordinaryFile(path.join(sdkSource, 'licenses', name), 32768), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await access(path.join(licenses, 'android-sdk-license'));
  console.log('ANDROID_HOSTED_STAGE sdk-packages');
  await assertOwned();
  await run(sdkmanager, ['--sdk_root=' + sdk, '--install', 'platforms;android-37.0', 'build-tools;37.0.0', 'ndk;27.1.12297006', 'cmake;3.22.1'],
    { cwd: root, env, signal, milliseconds: 20 * 60 * 1000, logFile: path.join(root, 'sdk-install.log') });
  const archives = [];
  for (const archive of ANDROID_HOSTED_ARCHIVES) {
    console.log('ANDROID_HOSTED_STAGE ' + archive.id);
    await requireHostedCapacity(root, archive.id === 'image' ? 6 * GIB : 3 * GIB);
    const file = path.join(root, 'archives', archive.id + '.zip');
    archives.push(await download(archive, file, signal));
    await assertOwned();
    const parent = path.join(sdk, archive.parent), target = path.join(parent, archive.top);
    await mkdir(parent, { recursive: true, mode: 0o700 }); await canonicalDirectory(parent);
    // Only this newly created SDK tree can contain an auto-installed dependency.
    try {
      const resolved = await realpath(target);
      if (resolved !== target || !resolved.startsWith(sdk + path.sep) || (await lstat(target)).isSymbolicLink()) throw fail('EXTRACTION_TARGET_REFUSED');
      await assertOwned();
      await rm(resolved, { recursive: true, force: false });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await run('/usr/bin/python3', ['-I', '-c', ANDROID_EXTRACT_PYTHON], { cwd: root, env, signal, input: JSON.stringify({ archive: file, parent, top: archive.top }), milliseconds: 5 * 60 * 1000 });
    const properties = await ordinaryFile(path.join(target, 'source.properties'));
    if (!new RegExp('^Pkg.Revision\\s*=\\s*' + archive.revision.replaceAll('.', '\\.') + '\\s*$', 'm').test(properties.toString('utf8'))) throw fail('SDK_REVISION_REFUSED');
    await assertOwned();
    if (await realpath(file) !== file || (await lstat(file)).isSymbolicLink()) throw fail('ARCHIVE_OWNERSHIP_REFUSED');
    await rm(file); // Exact verified archive beneath the newly owned root.
  }
  await access('/dev/kvm', constants.R_OK | constants.W_OK);
  if (!(await lstat('/dev/kvm')).isCharacterDevice()) throw fail('KVM_REFUSED');
  const acceleration = await run(path.join(sdk, 'emulator/emulator'), ['-accel-check'], { cwd: root, env, signal, milliseconds: 30000 });
  if (!/KVM/.test(acceleration) || !/usable|installed/i.test(acceleration)) throw fail('KVM_REFUSED');
  const report = { schemaVersion: 1, hostOS: 'linux', architecture: 'x64', ubuntu: '24.04', hostedPolicyChecked: true,
    kvm: true, javaMajor: 21, javaSha256: sha(await readFile(path.join(java, 'bin/java'))), archives,
    availableBeforeSetup, availableBeforeBuild: await requireHostedCapacity(root, 6 * GIB), node: process.version };
  await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { root, sdk, java };
}
function isEntry() { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isEntry()) {
  const [root, sdkBase, javaHome, outputFile] = process.argv.slice(2);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  if (process.argv.length !== 6) { console.error('ANDROID_HOSTED_ARGUMENTS_REFUSED'); process.exitCode = 1; }
  else setupHostedAndroid({ root, sdkBase, javaHome, outputFile, signal: controller.signal }).catch(error => {
    console.error(/^ANDROID_HOSTED_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'ANDROID_HOSTED_SETUP_FAILED'); process.exitCode = 1;
  }).finally(() => { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); });
}
