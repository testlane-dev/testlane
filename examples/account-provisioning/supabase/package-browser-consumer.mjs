/** Test-only cold consumer installation. No ambient npm configuration or network fallback. */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const PUBLIC_EXPORTS = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' },
  './browser': { types: './dist/browser.d.ts', import: './dist/browser.js', default: './dist/browser.js' },
  './browser-worker': { types: './dist/browser-worker.d.ts', import: './dist/browser-worker.js', default: './dist/browser-worker.js' },
  './*': './*',
};
export const packageBrowserShims = () => Object.freeze({
  parent: "export { runDisposableBrowserVerification, recoverDisposableBrowserVerification } from '@testlane/cli/browser';\n",
  worker: "export { loadBrowserWorkerBinding, requestBrowserRunRevocation } from '@testlane/cli/browser-worker';\n",
});
export const proofFailure = code => { const error = new Error(code); error.stack = code; return error; };
const refuse = () => proofFailure('PACKAGE_BROWSER_INSTALL_REFUSED');
export async function ordinaryBytes(file, maximum, minimum = 1) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || await realpath(file) !== file) throw refuse();
  const valid = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size >= BigInt(minimum) && info.size <= BigInt(maximum);
  const before = await lstat(file, { bigint: true }); if (!valid(before)) throw refuse();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!valid(opened) || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) throw refuse();
    const bytes = Buffer.alloc(Number(opened.size) + 1); let count = 0;
    while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); count += part.bytesRead; if (!part.bytesRead) break; }
    const ended = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (!valid(ended) || !valid(named) || count !== Number(opened.size) || opened.size !== ended.size || before.size !== named.size || opened.mtimeNs !== ended.mtimeNs || before.mtimeNs !== named.mtimeNs || opened.ctimeNs !== ended.ctimeNs || before.ctimeNs !== named.ctimeNs || named.dev !== opened.dev || named.ino !== opened.ino || await realpath(file) !== file) throw refuse();
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
export async function loadProofSupport(sourceRoot, expected) {
  try {
    if (await realpath(sourceRoot) !== sourceRoot || !expected || Object.keys(expected).sort().join(',') !== 'child,privateDirectory,workerContracts') throw refuse();
    const files = { child: 'child.js', privateDirectory: 'private-directory.js', workerContracts: 'worker-contracts.js' }, observed = {};
    for (const [key, name] of Object.entries(files)) {
      if (!HASH.test(expected[key])) throw refuse();
      observed[key] = hash(await ordinaryBytes(path.join(sourceRoot, 'dist/provisioning', name), 1048576));
      if (observed[key] !== expected[key]) throw refuse();
    }
    const directory = await import(pathToFileURL(path.join(sourceRoot, 'dist/provisioning/private-directory.js')).href);
    const child = await import(pathToFileURL(path.join(sourceRoot, 'dist/provisioning/child.js')).href);
    return Object.freeze({ create: directory.createBrowserPrivateDirectory, assertPrivate: directory.assertBrowserPrivateDirectory,
      runChild: child.runBrowserChild, hashes: Object.freeze(observed) });
  } catch { throw refuse(); }
}
export function npmArguments({ npmCLI, tarball, cache, userConfig, globalConfig }) {
  return [npmCLI, 'install', tarball, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress', '--package-lock=false',
    '--update-notifier=false', '--registry=https://registry.npmjs.org', '--cache=' + cache, '--userconfig=' + userConfig, '--globalconfig=' + globalConfig];
}
export function closedInstallerEnvironment(root, runtime = process.env) {
  const env = { HOME: root, USERPROFILE: root, TMP: root, TEMP: root, TMPDIR: root, XDG_CACHE_HOME: root,
    PATH: path.dirname(process.execPath), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', NODE_DISABLE_COMPILE_CACHE: '1' };
  if (process.platform === 'win32') {
    const system = runtime.SystemRoot;
    if (typeof system !== 'string' || !path.isAbsolute(system)) throw refuse();
    env.SystemRoot = system; env.windir = system; env.ComSpec = path.join(system, 'System32/cmd.exe'); env.PATH += path.delimiter + path.join(system, 'System32');
    env.APPDATA = root; env.LOCALAPPDATA = root;
  } else env.PATH += ':/usr/bin:/bin';
  return Object.freeze(env);
}
export async function packageTree(root) {
  const records = []; let total = 0;
  async function visit(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (item.isSymbolicLink()) throw refuse();
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.isFile()) {
        const bytes = await ordinaryBytes(file, 8 * 1024 * 1024, 0); total += bytes.length;
        if (records.length >= 10000 || total > 64 * 1024 * 1024) throw refuse();
        records.push([path.relative(root, file).replaceAll('\\', '/'), hash(bytes)]);
      } else throw refuse();
    }
  }
  await visit(root); return hash(JSON.stringify(records));
}
export async function installPackageBrowserConsumer({ directory, tarball, tarballSHA256, npmCLI, npmCLISHA256, npmCacheDirectory, support, signal }) {
  let root, identity;
  try {
    if (!HASH.test(tarballSHA256) || !HASH.test(npmCLISHA256) || path.basename(npmCLI) !== 'npm-cli.js') throw refuse();
    const archive = await ordinaryBytes(tarball, 16 * 1024 * 1024);
    if (hash(archive) !== tarballSHA256 || hash(await ordinaryBytes(npmCLI, 1048576)) !== npmCLISHA256) throw refuse();
    await support.assertPrivate(npmCacheDirectory, { signal });
    root = await support.create(directory, { signal }); identity = await lstat(root, { bigint: true });
    const userConfig = path.join(root, 'empty-user.npmrc'), globalConfig = path.join(root, 'empty-global.npmrc'), copied = path.join(root, 'reviewed-release.tgz');
    for (const config of [userConfig, globalConfig]) await writeFile(config, '', { flag: 'wx', mode: 0o600 });
    await writeFile(copied, archive, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'testlane-installed-browser-proof', private: true, type: 'module', devDependencies: { '@playwright/test': '1.64.0' } }) + '\n', { flag: 'wx', mode: 0o600 });
    const result = await support.runChild({ entry: process.execPath, args: npmArguments({ npmCLI, tarball: copied, cache: npmCacheDirectory, userConfig, globalConfig }),
      cwd: root, env: closedInstallerEnvironment(root), timeoutMs: 120000, maxOutputBytes: 128 * 1024, ...(signal ? { signal } : {}) });
    if (result.code !== 0 || hash(await ordinaryBytes(copied, 16 * 1024 * 1024)) !== tarballSHA256) throw refuse();
    const packageRoot = path.join(root, 'node_modules/@testlane/cli'), metadata = JSON.parse(await ordinaryBytes(path.join(packageRoot, 'package.json'), 65536));
    if (metadata.name !== '@testlane/cli' || Object.keys(metadata.bin).join(',') !== 'testlane' || metadata.bin.testlane !== './dist/cli.js' || !isDeepStrictEqual(metadata.exports, PUBLIC_EXPORTS)) throw refuse();
    for (const [key, name] of Object.entries({ child: 'child.js', privateDirectory: 'private-directory.js', workerContracts: 'worker-contracts.js' }))
      if (hash(await ordinaryBytes(path.join(packageRoot, 'dist/provisioning', name), 1048576)) !== support.hashes[key]) throw refuse();
    for (const name of ['@playwright/test', 'playwright']) if (JSON.parse(await ordinaryBytes(path.join(root, 'node_modules', name, 'package.json'), 65536)).version !== '1.64.0') throw refuse();
    const tree = await packageTree(packageRoot);
    return Object.freeze({ root, packageRoot, version: metadata.version, installedTreeSHA256: tree, tarballSHA256,
      async unchanged() { if (await packageTree(packageRoot) !== tree) throw refuse(); },
      async dispose() {
        const current = await lstat(root, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(root) !== root) throw refuse();
        // Only the fresh privately allocated consumer, after caller's stop/cleanup/leak gates.
        await rm(root, { recursive: true, force: false });
      } });
  } catch { throw Object.assign(refuse(), { preserveConsumer: true }); }
}
