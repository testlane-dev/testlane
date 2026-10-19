#!/usr/bin/env node
/** Copy only reviewed public files into a short owned build root. No device actions. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_FILES = ['package.json', 'package-lock.json', 'app.config.cjs', 'index.js', 'App.js', 'bootstrap.mjs', 'plugins/withProofBuild.cjs'];
const TEMPLATE = 'expo-template-bare-minimum@58.0.25';
const BUILD_TOOLS = '37.0.0', PLATFORM = 'android-37.0', NDK = '27.1.12297006', CMAKE = '3.22.1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function requireFiles(root, files, code) {
  try {
    for (const file of files) if (!(await stat(path.join(root, file))).isFile()) throw Error();
  } catch { throw Error(code); }
}
async function prerequisites(sdkRoot, javaHome) {
  let sdk, jdk;
  try { sdk = await realpath(sdkRoot); } catch { throw Error('ANDROID_SDK_PREREQUISITE_MISSING'); }
  try { jdk = await realpath(javaHome); } catch { throw Error('ANDROID_JAVA_PREREQUISITE_MISSING'); }
  const executable = name => name + (process.platform === 'win32' ? '.exe' : '');
  const host = { win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[process.platform];
  if (!host) throw Error('ANDROID_BUILD_PLATFORM_UNSUPPORTED');
  const aapt = path.join('build-tools', BUILD_TOOLS, executable('aapt2'));
  await requireFiles(sdk, [
    path.join('platforms', PLATFORM, 'android.jar'), path.join('platforms', PLATFORM, 'source.properties'),
    path.join('build-tools', BUILD_TOOLS, 'source.properties'), aapt,
    path.join('build-tools', BUILD_TOOLS, executable('zipalign')),
    path.join('build-tools', BUILD_TOOLS, 'lib/d8.jar'), path.join('build-tools', BUILD_TOOLS, 'lib/apksigner.jar'),
    path.join('ndk', NDK, 'source.properties'), path.join('ndk', NDK, 'build/cmake/android.toolchain.cmake'),
    path.join('ndk', NDK, 'toolchains/llvm/prebuilt', host, 'bin', executable('clang')),
    path.join('cmake', CMAKE, 'source.properties'), path.join('cmake', CMAKE, 'bin', executable('cmake')),
    path.join('cmake', CMAKE, 'bin', executable('ninja')),
  ], 'ANDROID_SDK_PREREQUISITE_MISSING');
  await requireFiles(jdk, [path.join('bin', executable('java')), path.join('bin', executable('javac'))], 'ANDROID_JAVA_PREREQUISITE_MISSING');
  const npmEntry = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!path.isAbsolute(npmEntry)) throw Error('ANDROID_NPM_CLI_UNAVAILABLE');
  let npm;
  try { npm = await realpath(npmEntry); } catch { throw Error('ANDROID_NPM_CLI_UNAVAILABLE'); }
  await requireFiles(path.dirname(npm), [path.basename(npm)], 'ANDROID_NPM_CLI_UNAVAILABLE');
  return { sdk, jdk, npm, aapt: path.join(sdk, aapt) };
}
async function stopOwnedTree(child, closed) {
  if (!child?.pid) return closed();
  let treeStopped = false;
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot ?? process.env.windir;
    if (system && path.isAbsolute(system)) treeStopped = await new Promise(resolve => {
      let killer, done = false;
      const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve(code === 0); };
      const timer = setTimeout(() => { killer?.kill(); finish(null); }, 3000);
      try {
        killer = spawn(path.join(system, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', () => finish(null)); killer.once('close', finish);
      } catch { finish(null); }
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); treeStopped = true; }
    catch (error) { treeStopped = error.code === 'ESRCH' && closed(); }
  }
  if (!treeStopped && !closed()) try { child.kill('SIGKILL'); } catch {}
  if (!closed()) await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(); };
    const timer = setTimeout(finish, 5000);
    child.once('close', finish); if (closed()) finish();
  });
  return treeStopped && closed();
}
const checkCancelled = signal => { if (signal?.aborted) throw Error('ANDROID_BUILD_CANCELLED'); };
async function run(entry, args, { cwd, env, timeoutMs, logFile, signal }) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let child, output = '', done = false, stopping = false, closed = false;
    const finish = (error, code) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      void writeFile(logFile, output, { flag: 'wx', mode: 0o600 }).then(() => error ? reject(error) : resolve({ code, output }), () => reject(Error('ANDROID_BUILD_LOG_FAILED')));
    };
    const stop = async code => {
      if (stopping || done) return; stopping = true; clearTimeout(timer);
      let confirmed = false;
      try { confirmed = await stopOwnedTree(child, () => closed); } catch {}
      if (!confirmed) { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); }
      const error = Error(confirmed ? code : 'ANDROID_BUILD_STOP_UNCONFIRMED');
      error.terminationConfirmed = confirmed; error.childPid = child?.pid;
      finish(error);
    };
    const cancel = () => { void stop('ANDROID_BUILD_CANCELLED'); };
    const timer = setTimeout(() => { void stop('ANDROID_BUILD_CHILD_STOPPED'); }, timeoutMs);
    try {
      child = spawn(entry, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
        if (Buffer.byteLength(output) + bytes.length > 8 * 1024 * 1024) void stop('ANDROID_BUILD_OUTPUT_LIMIT');
        else output += bytes.toString('utf8');
      });
      child.once('error', () => { if (!stopping) finish(Error('ANDROID_BUILD_CHILD_START_FAILED')); });
      child.once('close', code => { closed = true; if (!stopping) finish(null, code); });
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    } catch { finish(Error('ANDROID_BUILD_CHILD_START_FAILED')); }
  });
}
function zipEntries(bytes) {
  const entries = [];
  for (let offset = Math.max(0, bytes.length - 65557); offset < bytes.length - 21; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) continue;
    let current = bytes.readUInt32LE(offset + 16), count = bytes.readUInt16LE(offset + 10);
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(current) !== 0x02014b50) throw Error('APK_ZIP_INVALID');
      const size = bytes.readUInt16LE(current + 28);
      entries.push(bytes.subarray(current + 46, current + 46 + size).toString('utf8'));
      current += 46 + size + bytes.readUInt16LE(current + 30) + bytes.readUInt16LE(current + 32);
    }
    return entries;
  }
  throw Error('APK_ZIP_INVALID');
}

export async function buildAndroidProof({ outputDir, sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT,
  javaHome = process.env.JAVA_HOME, prepareOnly = false, signal } = {}) {
  checkCancelled(signal);
  if (!outputDir || !path.isAbsolute(outputDir) || !sdkRoot || !path.isAbsolute(sdkRoot) || !javaHome || !path.isAbsolute(javaHome)) throw Error('ANDROID_BUILD_INPUT_INVALID');
  const { sdk, jdk, npm, aapt } = await prerequisites(sdkRoot, javaHome), output = path.resolve(outputDir);
  checkCancelled(signal);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, '.gitignore'), '*\n', { flag: 'wx' });
  let scratch;
  try {
    checkCancelled(signal);
    const temporaryParent = await realpath(os.tmpdir()); scratch = await mkdtemp(path.join(temporaryParent, 'tl-android-build-'));
    const app = path.join(scratch, 'app'); await mkdir(app);
    const hashes = {};
    for (const file of PUBLIC_FILES) {
      checkCancelled(signal);
      const source = path.join(HERE, file), target = path.join(app, file);
      if ((await lstat(source)).isSymbolicLink()) throw Error('ANDROID_PUBLIC_SOURCE_INVALID');
      const bytes = await readFile(source); hashes[file] = digest(bytes);
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target);
    }
    const env = { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOCTOR: '1' };
    delete env.NODE_OPTIONS; delete env.DEBUG; delete env.PWDEBUG; delete env.NODE_DEBUG;
    const execute = async (stage, entry, args, cwd, timeoutMs) => {
      try {
        checkCancelled(signal);
        process.stdout.write('ANDROID_BUILD_STAGE ' + stage + '\n');
        const result = await run(entry, args, { cwd, env, timeoutMs, logFile: path.join(output, stage + '.log'), signal });
        checkCancelled(signal);
        if (result.code !== 0) throw Error('ANDROID_BUILD_STAGE_FAILED');
        return result.output;
      } catch (error) { error.stage = stage; throw error; }
    };
    await execute('npm-ci', process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], app, 15 * 60_000);
    const versions = {};
    const require = createRequire(path.join(app, 'package.json'));
    const expoRequire = createRequire(path.join(app, 'node_modules/expo/package.json'));
    for (const name of ['expo', 'react', 'react-native', 'expo-file-system', '@expo/cli', '@expo/config-plugins']) {
      const metadataFile = name === '@expo/cli' ? expoRequire.resolve(name + '/package.json') : require.resolve(name + '/package.json');
      versions[name] = JSON.parse(await readFile(metadataFile, 'utf8')).version;
    }
    await execute('expo-prebuild', process.execPath, [path.join(app, 'node_modules/expo/bin/cli'), 'prebuild', '--platform', 'android', '--no-install', '--template', TEMPLATE], app, 10 * 60_000);
    await writeFile(path.join(app, 'android/local.properties'), 'sdk.dir=' + sdk.replaceAll('\\', '/') + '\n');
    const android = path.join(app, 'android'), manifest = { schemaVersion: 1, package: 'dev.testlane.androidproof', proofOnly: true,
      debuggable: true, embeddedBundle: true, architecture: 'x86_64', template: TEMPLATE, versions, node: process.version,
      publicSourceSHA256: hashes, pluginSHA256: hashes['plugins/withProofBuild.cjs'], packageLockSHA256: hashes['package-lock.json'] };
    await writeFile(path.join(output, 'preparation.json'), JSON.stringify({ ...manifest, buildRoot: scratch }, null, 2) + '\n', { flag: 'wx' });
    checkCancelled(signal);
    if (prepareOnly) return { status: 'prepared', buildRoot: scratch, outputDirectory: output, versions };
    const java = path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    await execute('gradle-release', java, ['-classpath', path.join(android, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
      '--no-daemon', '--console=plain', '--build-cache', '--max-workers=2', '-Pandroid.builder.sdkDownload=false', '-PreactNativeArchitectures=x86_64', ':app:assembleRelease'], android, 60 * 60_000);
    const apkFile = path.join(android, 'app/build/outputs/apk/release/app-release.apk'), apkBytes = await readFile(apkFile);
    if (!zipEntries(apkBytes).includes('assets/index.android.bundle')) throw Error('ANDROID_EMBEDDED_BUNDLE_MISSING');
    const badging = await execute('apk-badging', aapt, ['dump', 'badging', apkFile], app, 30_000);
    if (!badging.includes("package: name='dev.testlane.androidproof'") || !badging.includes('application-debuggable')) throw Error('ANDROID_PROOF_MANIFEST_INVALID');
    await copyFile(apkFile, path.join(output, 'testlane-android-proof.apk'));
    await writeFile(path.join(output, 'build-manifest.json'), JSON.stringify({ ...manifest, apkSHA256: digest(apkBytes), apkBytes: apkBytes.length,
      buildTools: BUILD_TOOLS, sdkVersion: /sdkVersion:'([^']+)'/.exec(badging)?.[1], targetSdkVersion: /targetSdkVersion:'([^']+)'/.exec(badging)?.[1] }, null, 2) + '\n', { flag: 'wx' });
    checkCancelled(signal);
    if (path.dirname(scratch) !== temporaryParent || !/^tl-android-build-[a-zA-Z0-9]+$/.test(path.basename(scratch)) ||
        (await lstat(scratch)).isSymbolicLink() || await realpath(scratch) !== scratch) throw Error('ANDROID_BUILD_OWNERSHIP_INVALID');
    await rm(scratch, { recursive: true });
    return { status: 'built', outputDirectory: output, apkFile: path.join(output, 'testlane-android-proof.apk'), apkSHA256: digest(apkBytes), versions };
  } catch (error) {
    await writeFile(path.join(output, 'recovery.json'), JSON.stringify({ status: 'build-incomplete', buildRoot: scratch ?? null, stage: error.stage ?? null,
      cancelled: signal?.aborted === true, childTermination: error.terminationConfirmed === true ? 'confirmed' : error.terminationConfirmed === false ? 'unconfirmed' : 'not-requested',
      ...(error.terminationConfirmed === false ? { ownedChildPid: error.childPid ?? null } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
    const safe = Error(/^ANDROID_[A-Z_]+$/.test(error.message) ? error.message : 'ANDROID_BUILD_FAILED'); safe.buildRoot = scratch; safe.stage = error.stage; throw safe;
  }
}
async function main() {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const args = process.argv.slice(2), values = {}; let prepareOnly = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--prepare-only' && !prepareOnly) { prepareOnly = true; continue; }
      const key = { '--output-dir': 'outputDir', '--sdk-root': 'sdkRoot', '--java-home': 'javaHome' }[args[i]];
      if (!key || values[key] || !args[i + 1]) throw Error('ANDROID_BUILD_ARGUMENTS_INVALID'); values[key] = args[++i];
    }
    process.stdout.write(JSON.stringify(await buildAndroidProof({ ...values, prepareOnly, signal: controller.signal }), null, 2) + '\n');
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}
function entry() { try { const a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url)); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return false; } }
if (entry()) main().catch(error => { process.stderr.write('Android proof build: ' + (/^ANDROID_[A-Z_]+$/.test(error.message) ? error.message : 'ANDROID_BUILD_FAILED') + (error.stage ? ' (' + error.stage + ')' : '') + '\n'); if (error.buildRoot) process.stderr.write('Owned build root retained: ' + error.buildRoot + '\n'); process.exitCode = 1; });
