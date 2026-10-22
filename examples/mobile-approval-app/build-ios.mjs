#!/usr/bin/env node
/** Embedded-bundle iOS Simulator build without Apple signing credentials. Never boots a device. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = 'dev.testlane.iosproof', PRODUCT = 'TestlaneIOSProof', TEMPLATE = 'expo-template-bare-minimum@58.0.25';
const TEMPLATE_URL = 'https://registry.npmjs.org/expo-template-bare-minimum/-/expo-template-bare-minimum-58.0.25.tgz';
const TEMPLATE_INTEGRITY = 'sha512-VvSVJSG5emwfmwK4FT3x4satQ3Xt7XCzY9pmQqBW4tKiVM2KyNlfmFOowDhfRh7SGACiYIiTUhwjeC3miI9xwA==';
const SOURCES = Object.freeze({ 'package.json': 'package.json', 'package-lock.json': 'package-lock.json',
  'app.ios.config.cjs': 'app.config.cjs', 'index.js': 'index.js', 'App.js': 'App.js', 'bootstrap.mjs': 'bootstrap.mjs',
  'plugins/withIosProofBuild.cjs': 'plugins/withIosProofBuild.cjs' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cancelled = signal => { if (signal?.aborted) throw Error('IOS_BUILD_CANCELLED'); };
const contained = (parent, child) => { const value = path.relative(parent, child); return value !== '' && !value.startsWith('..' + path.sep) && value !== '..' && !path.isAbsolute(value); };
const safeError = error => Error(/^IOS_[A-Z_]+$/.test(error?.message) ? error.message : 'IOS_BUILD_FAILED');

export function simulatorSignature(output) {
  if (typeof output !== 'string' || /^Authority=/m.test(output)) throw Error('IOS_BUILD_APP_SIGNATURE_INVALID');
  if (/code object is not signed at all/.test(output) && !/^Signature=/m.test(output)) return 'none';
  if (/^Signature=adhoc\r?$/m.test(output) && /^TeamIdentifier=not set\r?$/m.test(output) &&
      /^CodeDirectory .*flags=0x[0-9a-f]+\([^\r\n]*\blinker-signed\b/m.test(output)) return 'linker-ad-hoc';
  throw Error('IOS_BUILD_APP_SIGNATURE_INVALID');
}

/** Hash every entry; preserve relative internal symlinks without traversing them. */
export async function hashIosTree(directory, { signal } = {}) {
  try {
  cancelled(signal);
  const root = await realpath(directory);
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || root !== path.resolve(directory)) throw Error('IOS_BUILD_TREE_INVALID');
  const entries = []; let totalBytes = 0;
  const visit = async (absolute, relative) => {
    cancelled(signal);
    if (entries.length >= 50_000) throw Error('IOS_BUILD_TREE_LIMIT');
    const before = await lstat(absolute), mode = before.mode & 0o777;
    if (before.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (!target || target.length > 4096 || path.isAbsolute(target) || target.includes('\\')) throw Error('IOS_BUILD_TREE_LINK_INVALID');
      const resolved = await realpath(absolute);
      if (resolved !== root && !contained(root, resolved)) throw Error('IOS_BUILD_TREE_LINK_INVALID');
      entries.push({ path: relative, type: 'symlink', mode, target });
    } else if (before.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode });
      const names = (await readdir(absolute)).sort();
      for (const name of names) {
        if (name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) throw Error('IOS_BUILD_TREE_INVALID');
        await visit(path.join(absolute, name), relative ? relative + '/' + name : name);
      }
    } else if (before.isFile()) {
      totalBytes += before.size;
      if (totalBytes > 2 * 1024 ** 3) throw Error('IOS_BUILD_TREE_LIMIT');
      const hash = createHash('sha256'); let observed = 0;
      for await (const bytes of createReadStream(absolute, { signal })) { observed += bytes.length; hash.update(bytes); }
      const after = await lstat(absolute);
      if (!after.isFile() || after.size !== before.size || observed !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw Error('IOS_BUILD_TREE_CHANGED');
      entries.push({ path: relative, type: 'file', mode, bytes: before.size, sha256: hash.digest('hex') });
    } else throw Error('IOS_BUILD_TREE_INVALID');
  };
  await visit(root, '');
  return { schemaVersion: 1, sha256: digest(JSON.stringify(entries)), totalBytes, entries };
  } catch (error) {
    cancelled(signal);
    throw /^IOS_BUILD_TREE_/.test(error?.message) ? error : Error('IOS_BUILD_TREE_INVALID');
  }
}

/** The owner token is created by this invocation, outside the copied app source. */
export async function createIosBuildRoot(temporaryParent = os.tmpdir()) {
  const parent = await realpath(temporaryParent), root = await mkdtemp(path.join(parent, 'tl-ios-build-')), token = randomUUID();
  await writeFile(path.join(root, '.testlane-ios-build-owner.json'), JSON.stringify({ schemaVersion: 1, token }) + '\n', { flag: 'wx', mode: 0o600 });
  return Object.freeze({ parent, root, token });
}
export async function removeIosBuildRoot(owner) {
  try {
    if (!owner || !path.isAbsolute(owner.parent) || !path.isAbsolute(owner.root) || path.dirname(owner.root) !== owner.parent ||
      !/^tl-ios-build-[A-Za-z0-9]+$/.test(path.basename(owner.root)) || !/^[a-f0-9-]{36}$/.test(owner.token) ||
      await realpath(owner.parent) !== owner.parent || (await lstat(owner.root)).isSymbolicLink() || await realpath(owner.root) !== owner.root) throw Error();
    const marker = path.join(owner.root, '.testlane-ios-build-owner.json');
    if (!(await lstat(marker)).isFile() || (await lstat(marker)).isSymbolicLink()) throw Error();
    const value = JSON.parse(await readFile(marker, 'utf8'));
    if (Object.keys(value).length !== 2 || value.schemaVersion !== 1 || value.token !== owner.token) throw Error();
  } catch { throw Error('IOS_BUILD_OWNERSHIP_INVALID'); }
  await rm(owner.root, { recursive: true });
}

async function stopTree(child, closed) {
  if (!child?.pid) return closed();
  let stopped = false;
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot ?? process.env.windir;
    if (system && path.isAbsolute(system)) stopped = await new Promise(resolve => {
      let killer, done = false;
      const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve(code === 0); };
      const timer = setTimeout(() => { killer?.kill(); finish(null); }, 3000);
      try {
        killer = spawn(path.join(system, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => finish(null)); killer.once('close', finish);
      } catch { finish(null); }
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); stopped = true; }
    catch (error) { stopped = error.code === 'ESRCH' && closed(); }
  }
  if (!stopped && !closed()) try { child.kill('SIGKILL'); } catch {}
  if (!closed()) await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(); };
    const timer = setTimeout(finish, 5000); child.once('close', finish); if (closed()) finish();
  });
  return stopped && closed();
}

/** Exported for fixture checks; no shell expansion, downloads or Apple API implicit. */
export async function runIosBuildChild(entry, args, { cwd, env = process.env, timeoutMs, logFile, signal } = {}) {
  cancelled(signal);
  if (!path.isAbsolute(entry) || !Array.isArray(args) || args.some(value => typeof value !== 'string') ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90 * 60_000 || (logFile && !path.isAbsolute(logFile))) throw Error('IOS_BUILD_CHILD_INPUT_INVALID');
  return new Promise((resolve, reject) => {
    let child, output = '', bytes = 0, done = false, stopping = false, closed = false;
    const finish = (error, code) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const saved = logFile ? writeFile(logFile, output, { flag: 'wx', mode: 0o600 }) : Promise.resolve();
      void saved.then(() => error ? reject(error) : resolve({ code, output }), () => reject(Error('IOS_BUILD_LOG_FAILED')));
    };
    const stop = async code => {
      if (done || stopping) return; stopping = true; clearTimeout(timer);
      let confirmed = false;
      try { confirmed = await stopTree(child, () => closed); } catch {}
      if (!confirmed) { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); }
      const error = Error(confirmed ? code : 'IOS_BUILD_STOP_UNCONFIRMED');
      error.terminationConfirmed = confirmed; error.childPid = child?.pid; finish(error);
    };
    const cancel = () => { void stop('IOS_BUILD_CANCELLED'); };
    const timer = setTimeout(() => { void stop('IOS_BUILD_CHILD_TIMEOUT'); }, timeoutMs);
    try {
      child = spawn(entry, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', value => {
        bytes += value.length;
        if (bytes > 16 * 1024 ** 2) void stop('IOS_BUILD_OUTPUT_LIMIT'); else output += value.toString('utf8');
      });
      child.once('error', () => { if (!stopping) finish(Error('IOS_BUILD_CHILD_START_FAILED')); });
      child.once('close', code => { closed = true; if (!stopping) finish(null, code); });
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    } catch { finish(Error('IOS_BUILD_CHILD_START_FAILED')); }
  });
}

async function existingFile(file, code) {
  try { const canonical = await realpath(file); if (!(await stat(canonical)).isFile()) throw Error(); return canonical; }
  catch { throw Error(code); }
}
function atLeast(version, major, minor) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  return match && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
}
async function preflight(signal, onStage) {
  cancelled(signal);
  if (process.platform !== 'darwin') throw Error('IOS_BUILD_MACOS_REQUIRED');
  if (!['arm64', 'x64'].includes(process.arch)) throw Error('IOS_BUILD_ARCHITECTURE_UNSUPPORTED');
  const tools = {};
  for (const name of ['xcodebuild', 'xcrun', 'xcode-select', 'plutil', 'ditto', 'codesign', 'which']) tools[name] = await existingFile('/usr/bin/' + name, 'IOS_BUILD_TOOL_UNAVAILABLE');
  const npmCandidates = process.env.npm_execpath ? [process.env.npm_execpath] : [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  let npm;
  for (const candidate of npmCandidates) {
    if (!path.isAbsolute(candidate)) throw Error('IOS_BUILD_NPM_UNAVAILABLE');
    try { npm = await existingFile(candidate, 'IOS_BUILD_NPM_UNAVAILABLE'); break; } catch {}
  }
  if (!npm) throw Error('IOS_BUILD_NPM_UNAVAILABLE');
  const env = { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOCTOR: '1', COCOAPODS_DISABLE_STATS: 'true', RCT_NO_LAUNCH_PACKAGER: '1', FORCE_BUNDLING: '1', NODE_BINARY: process.execPath };
  for (const name of ['NODE_OPTIONS', 'DEBUG', 'NODE_DEBUG', 'PWDEBUG', 'SKIP_BUNDLING', 'BUNDLE_GEMFILE', 'BUNDLE_BIN_PATH', 'RUBYOPT']) delete env[name];
  const logs = {};
  const inspect = async (stage, entry, args) => {
    onStage?.(stage); const result = await runIosBuildChild(entry, args, { env, timeoutMs: 30_000, signal });
    if (result.code !== 0) throw Error('IOS_BUILD_PREFLIGHT_FAILED'); logs[stage] = result.output; return result.output.trim();
  };
  const xcodeText = await inspect('xcode-version', tools.xcodebuild, ['-version']);
  const xcodeVersion = /^Xcode (\d+\.\d+(?:\.\d+)?)/m.exec(xcodeText)?.[1], xcodeBuild = /^Build version (\S+)/m.exec(xcodeText)?.[1];
  if (!atLeast(xcodeVersion ?? '', 26, 4) || !xcodeBuild) throw Error('IOS_BUILD_XCODE_UNSUPPORTED');
  const developerDirectory = await inspect('xcode-selection', tools['xcode-select'], ['-p']);
  if (!path.isAbsolute(developerDirectory)) throw Error('IOS_BUILD_PREFLIGHT_FAILED');
  const sdkVersion = await inspect('simulator-sdk', tools.xcrun, ['--sdk', 'iphonesimulator', '--show-sdk-version']);
  if (!atLeast(sdkVersion, 26, 4)) throw Error('IOS_BUILD_SDK_UNSUPPORTED');
  await inspect('xcode-first-launch', tools.xcodebuild, ['-checkFirstLaunchStatus']);
  const podLocation = await inspect('pod-location', tools.which, ['pod']);
  if (!path.isAbsolute(podLocation) || /[\r\n]/.test(podLocation)) throw Error('IOS_BUILD_PODS_UNAVAILABLE');
  const pod = await existingFile(podLocation, 'IOS_BUILD_PODS_UNAVAILABLE');
  const cocoaPodsVersion = await inspect('pod-version', pod, ['--version']);
  if (!/^\d+\.\d+\.\d+$/.test(cocoaPodsVersion)) throw Error('IOS_BUILD_PODS_UNAVAILABLE');
  return { tools, npm, pod, env, logs, xcodeVersion, xcodeBuild, developerDirectory, sdkVersion, cocoaPodsVersion };
}
async function templateArchive(file, signal) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(TEMPLATE_URL, { redirect: 'error', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    if (!response.ok || !response.body) throw Error();
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 8 * 1024 ** 2) throw Error(); chunks.push(Buffer.from(chunk)); }
    const archive = Buffer.concat(chunks);
    if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== TEMPLATE_INTEGRITY) throw Error();
    await writeFile(file, archive, { flag: 'wx', mode: 0o600 }); return digest(archive);
  } catch { cancelled(signal); throw Error('IOS_BUILD_TEMPLATE_UNAVAILABLE'); }
  finally { clearTimeout(timer); }
}

export async function buildIosProof({ outputDir, signal, onStage } = {}) {
  cancelled(signal);
  if (!outputDir || !path.isAbsolute(outputDir) || (onStage !== undefined && typeof onStage !== 'function')) throw Error('IOS_BUILD_INPUT_INVALID');
  const prerequisites = await preflight(signal, onStage); cancelled(signal);
  const output = path.resolve(outputDir), parent = path.dirname(output);
  try {
    if (await realpath(parent) !== parent || (await lstat(parent)).isSymbolicLink()) throw Error();
    await mkdir(output, { mode: 0o700 });
  } catch { throw Error('IOS_BUILD_OUTPUT_INVALID'); }
  await writeFile(path.join(output, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  let owner;
  try {
    cancelled(signal); owner = await createIosBuildRoot();
    const app = path.join(owner.root, 'app'); await mkdir(app, { mode: 0o700 });
    const publicSourceSHA256 = {};
    for (const [sourceName, targetName] of Object.entries(SOURCES)) {
      cancelled(signal);
      const source = path.join(HERE, sourceName), target = path.join(app, targetName);
      if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink() || await realpath(source) !== source) throw Error('IOS_BUILD_SOURCE_INVALID');
      publicSourceSHA256[sourceName] = digest(await readFile(source));
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target);
    }
    const sourceTree = await hashIosTree(app, { signal });
    for (const [stage, log] of Object.entries(prerequisites.logs)) await writeFile(path.join(output, stage + '.log'), log, { flag: 'wx', mode: 0o600 });
    const execute = async (stage, entry, args, cwd, timeoutMs, accepted = [0]) => {
      try {
        cancelled(signal); onStage?.(stage);
        const result = await runIosBuildChild(entry, args, { cwd, env: prerequisites.env, timeoutMs, signal, logFile: path.join(output, stage + '.log') });
        cancelled(signal); if (!accepted.includes(result.code)) throw Error('IOS_BUILD_STAGE_FAILED'); return result.output;
      } catch (error) { error.stage = stage; throw error; }
    };
    onStage?.('template-download');
    const archive = path.join(owner.root, 'expo-template-bare-minimum-58.0.25.tgz'), templateSHA256 = await templateArchive(archive, signal);
    await execute('npm-ci', process.execPath, [prerequisites.npm, 'ci', '--no-audit', '--no-fund'], app, 15 * 60_000);
    const versions = {}, require = createRequire(path.join(app, 'package.json')), expoRequire = createRequire(path.join(app, 'node_modules/expo/package.json'));
    for (const name of ['expo', 'react', 'react-native', 'expo-file-system', '@expo/cli', '@expo/config-plugins']) {
      const file = (name === '@expo/cli' ? expoRequire : require).resolve(name + '/package.json');
      versions[name] = JSON.parse(await readFile(file, 'utf8')).version;
    }
    await execute('expo-prebuild', process.execPath, [path.join(app, 'node_modules/expo/bin/cli'), 'prebuild', '--platform', 'ios', '--no-install', '--template', archive], app, 10 * 60_000);
    const ios = path.join(app, 'ios');
    await execute('pod-install', prerequisites.pod, ['install', '--project-directory=' + ios], app, 20 * 60_000);
    const workspace = path.join(ios, PRODUCT + '.xcworkspace');
    if (!(await lstat(workspace)).isDirectory() || (await lstat(workspace)).isSymbolicLink()) throw Error('IOS_BUILD_PROJECT_INVALID');
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    await execute('xcode-release', prerequisites.tools.xcodebuild, ['-quiet', '-workspace', workspace, '-scheme', PRODUCT,
      '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', path.join(owner.root, 'derived-data'), 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=', 'DEVELOPMENT_TEAM=', 'PROVISIONING_PROFILE_SPECIFIER=', 'ARCHS=' + architecture, 'ONLY_ACTIVE_ARCH=YES', 'build'], ios, 60 * 60_000);
    const builtApp = path.join(owner.root, 'derived-data/Build/Products/Release-iphonesimulator', PRODUCT + '.app');
    const info = JSON.parse(await execute('app-plist', prerequisites.tools.plutil, ['-convert', 'json', '-o', '-', path.join(builtApp, 'Info.plist')], app, 30_000));
    const ats = info.NSAppTransportSecurity, exceptions = ats?.NSExceptionDomains, local = exceptions?.['127.0.0.1'];
    if (info.CFBundleIdentifier !== BUNDLE || info.CFBundleExecutable !== PRODUCT || info.DTPlatformName !== 'iphonesimulator' ||
      JSON.stringify(info.CFBundleSupportedPlatforms) !== JSON.stringify(['iPhoneSimulator']) || ats?.NSAllowsArbitraryLoads !== false ||
      Object.keys(ats).some(key => !['NSAllowsArbitraryLoads', 'NSExceptionDomains'].includes(key)) || Object.keys(exceptions ?? {}).length !== 1 ||
      local?.NSExceptionAllowsInsecureHTTPLoads !== true || local?.NSIncludesSubdomains !== false || Object.keys(local).length !== 2) throw Error('IOS_BUILD_APP_METADATA_INVALID');
    const bundled = await lstat(path.join(builtApp, 'main.jsbundle'));
    if (!bundled.isFile() || bundled.isSymbolicLink() || bundled.size < 1) throw Error('IOS_BUILD_EMBEDDED_BUNDLE_MISSING');
    const binary = path.join(builtApp, PRODUCT);
    const actualArchitecture = (await execute('app-architecture', prerequisites.tools.xcrun, ['lipo', '-archs', binary], app, 30_000)).trim();
    if (actualArchitecture !== architecture) throw Error('IOS_BUILD_ARCHITECTURE_INVALID');
    const nativeMetadata = await execute('app-platform', prerequisites.tools.xcrun, ['vtool', '-show-build', binary], app, 30_000);
    if (!/platform\s+IOSSIMULATOR\b/.test(nativeMetadata)) throw Error('IOS_BUILD_APP_PLATFORM_INVALID');
    const signature = simulatorSignature(await execute('app-signature', prerequisites.tools.codesign, ['-dv', builtApp], app, 30_000, [0, 1]));
    const builtTree = await hashIosTree(builtApp, { signal }), appDirectory = path.join(output, PRODUCT + '.app');
    await execute('app-copy', prerequisites.tools.ditto, [builtApp, appDirectory], app, 30_000);
    const appTree = await hashIosTree(appDirectory, { signal });
    if (appTree.sha256 !== builtTree.sha256) throw Error('IOS_BUILD_COPY_CHANGED');
    const manifest = { schemaVersion: 1, platform: 'ios-simulator', package: BUNDLE, proofOnly: true, configuration: 'Release', unsigned: signature === 'none', signature,
      codeSigningAllowed: false, embeddedBundle: true, architecture, appDirectory: PRODUCT + '.app', appSHA256: appTree.sha256,
      template: TEMPLATE, templateIntegrity: TEMPLATE_INTEGRITY, templateSHA256, versions, node: process.version,
      xcodeVersion: prerequisites.xcodeVersion, xcodeBuild: prerequisites.xcodeBuild, simulatorSdkVersion: prerequisites.sdkVersion, cocoaPodsVersion: prerequisites.cocoaPodsVersion,
      publicSourceSHA256, sourceDestinations: SOURCES, pluginSHA256: publicSourceSHA256['plugins/withIosProofBuild.cjs'], packageLockSHA256: publicSourceSHA256['package-lock.json'],
      podfileLockSHA256: digest(await readFile(path.join(ios, 'Podfile.lock'))), builderSHA256: digest(await readFile(fileURLToPath(import.meta.url))), sourceTree, appTree };
    const manifestFile = path.join(output, 'build-manifest.json');
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    cancelled(signal); await removeIosBuildRoot(owner);
    return { status: 'built', outputDirectory: output, appDirectory, appSHA256: appTree.sha256, manifestFile, versions };
  } catch (error) {
    await writeFile(path.join(output, 'recovery.json'), JSON.stringify({ status: 'build-incomplete', buildRoot: owner?.root ?? null, stage: error.stage ?? null,
      cancelled: signal?.aborted === true, childTermination: error.terminationConfirmed === true ? 'confirmed' : error.terminationConfirmed === false ? 'unconfirmed' : 'not-requested',
      ...(error.terminationConfirmed === false ? { ownedChildPid: error.childPid ?? null } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
    const safe = signal?.aborted && error.terminationConfirmed !== false ? Error('IOS_BUILD_CANCELLED') : safeError(error);
    safe.buildRoot = owner?.root; safe.stage = error.stage; throw safe;
  }
}

async function main() {
  const controller = new AbortController(), cancel = () => controller.abort(); process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output-dir') throw Error('IOS_BUILD_ARGUMENTS_INVALID');
    const result = await buildIosProof({ outputDir: args[1], signal: controller.signal, onStage: stage => process.stdout.write('IOS_BUILD_STAGE ' + stage + '\n') });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
function entry() { try { const a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url)); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return false; } }
if (entry()) main().catch(error => { process.stderr.write('iOS proof build: ' + safeError(error).message + (error.stage ? ' (' + error.stage + ')' : '') + '\n'); if (error.buildRoot) process.stderr.write('Owned build root retained: ' + error.buildRoot + '\n'); process.exitCode = 1; });
