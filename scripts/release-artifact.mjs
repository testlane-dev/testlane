#!/usr/bin/env node
/** Pack once, record the bytes for review, and verify them again before staging. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'testlane-dev/testlane';
const PACKAGE_NAME = '@testlane/cli';
const TARBALL_PREFIX = 'testlane-cli-';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'dist/cli.js', 'dist/index.js', 'dist/verification.js', 'dist/browser.js', 'dist/browser.d.ts', 'dist/browser-worker.js', 'dist/browser-worker.d.ts', 'dist/provisioning/native-entry.js', 'docs/disposable-browser-accounts.md', 'docs/doctor.md', 'docs/project-install.md', 'docs/quickstart.md', 'examples/playwright/fixtures.mjs', 'docs/agent-verification.md', 'skills/testlane-verify/SKILL.md', 'skills/testlane-verify/references/harness.md', 'skills/testlane-verify/references/case-design.md', ...['run', 'authoring', 'init', 'bootstrap', 'contracts', 'reporter', 'runtime', 'render'].map(name => `examples/agent-verification/${name}.mjs`), ...['app.mjs', 'suite.mjs', 'native.mjs', 'run.mjs', 'feature.spec.mjs', 'brief.md', 'README.md'].map(name => `examples/verification-demo/${name}`)];

export function integrity(bytes) {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64');
}

export function validateInventory(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Package inventory is empty.');
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 ||
        file.path.startsWith('/') || /^[A-Za-z]:/.test(file.path) || /[\u0000-\u001f\u007f]/.test(file.path) || file.path.includes('\\') || file.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(file.path)) {
      throw new Error('Package inventory contains an invalid or duplicate path.');
    }
    seen.add(file.path);
    if (/(^|\/)(?:node_modules|tests|test-support|synthetic-fixtures|output|private|\.git|\.env(?:\.[^/]*)?)(?:\/|$)/.test(file.path) ||
        /^(?:src|scripts)\//.test(file.path) || /(?:\.dpapi|\.enc|\.tgz|real-broker-proof\.mjs)$/.test(file.path)) {
      throw new Error('Package inventory contains a development or private artifact.');
    }
  }
  for (const required of REQUIRED) if (!seen.has(required)) throw new Error('Required package entry is missing: ' + required);
}

export function validateManifest(manifest, bytes, expected = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.name !== PACKAGE_NAME || !VERSION.test(manifest.version ?? '') ||
      manifest.filename !== TARBALL_PREFIX + manifest.version + '.tgz' || !INTEGRITY.test(manifest.integrity ?? '') ||
      !Number.isSafeInteger(manifest.size) || manifest.size !== bytes.length ||
      !manifest.source || manifest.source.repository !== REPOSITORY || !COMMIT.test(manifest.source.commit ?? '') ||
      typeof manifest.source.dirty !== 'boolean') throw new Error('Release manifest is invalid.');
  validateInventory(manifest.files);
  const actual = integrity(bytes);
  if (actual !== manifest.integrity) throw new Error('Tarball does not match its release manifest.');
  if (expected.integrity !== undefined && (!INTEGRITY.test(expected.integrity) || actual !== expected.integrity)) throw new Error('Tarball does not match the reviewed SHA-512 integrity.');
  if (expected.commit !== undefined && (!COMMIT.test(expected.commit) || manifest.source.commit !== expected.commit)) throw new Error('Tarball source does not match the selected commit.');
  if (expected.tag !== undefined && expected.tag !== 'v' + manifest.version) throw new Error('Release tag must match the package version.');
  if (expected.runId !== undefined && (!/^\d+$/.test(expected.runId) || manifest.source.runId !== expected.runId)) throw new Error('Release artifact does not belong to the selected workflow run.');
  if (!expected.allowDirty && manifest.source.dirty) throw new Error('Release artifact was prepared from a dirty checkout.');
  return manifest;
}

/** npm signs GitHub's dispatch ref/SHA, not a later checkout's selected HEAD. */
export function validateTagDispatch(manifest, tag, environment = process.env) {
  if (!VERSION.test(manifest?.version ?? '') || !COMMIT.test(manifest?.source?.commit ?? '') ||
      tag !== 'v' + manifest.version || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REPOSITORY !== REPOSITORY || environment.GITHUB_REF !== 'refs/tags/' + tag ||
      environment.GITHUB_SHA !== manifest.source.commit) {
    throw new Error('Release staging must run from workflow_dispatch at the reviewed version tag and source commit.');
  }
  return manifest;
}

async function git(...args) {
  return (await execute('git', args, { cwd: ROOT, windowsHide: true })).stdout.trim();
}

async function npm(args) {
  if (process.platform !== 'win32') return execute('npm', args, { cwd: ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  // Invoke npm's JavaScript entry directly; paths never pass through cmd.exe.
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).map(p => path.join(p, 'node_modules/npm/bin/npm-cli.js'))];
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith('npm-cli.js')) continue;
    if (await access(candidate).then(() => true, () => false)) return execute(process.execPath, [candidate, ...args], { cwd: ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  }
  throw new Error('Cannot locate npm-cli.js; run this command using npm exec -- node.');
}

export async function prepare(directory, { allowDirty = false } = {}) {
  const source = { repository: process.env.GITHUB_REPOSITORY ?? REPOSITORY, commit: await git('rev-parse', 'HEAD'),
    dirty: (await git('status', '--porcelain', '--untracked-files=normal')) !== '', runId: process.env.GITHUB_RUN_ID ?? null };
  if (source.repository !== REPOSITORY) throw new Error('Release artifacts must be built in the public repository or reviewed locally.');
  if (source.dirty && !allowDirty) throw new Error('Commit all release changes before packing (local review only: --allow-dirty).');
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.name !== PACKAGE_NAME || !VERSION.test(pkg.version) || pkg.private || pkg.repository?.url !== 'git+https://github.com/testlane-dev/testlane.git') throw new Error('Public package metadata is invalid.');
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false }); // A fresh destination prevents accidental reuse.
  const packed = JSON.parse((await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory])).stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0].name !== PACKAGE_NAME || packed[0].version !== pkg.version || packed[0].filename !== TARBALL_PREFIX + pkg.version + '.tgz') throw new Error('npm pack returned an unexpected artifact.');
  const pack = packed[0];
  const bytes = await readFile(path.join(directory, pack.filename));
  const manifest = { schemaVersion: 1, name: pkg.name, version: pkg.version, filename: pack.filename, integrity: integrity(bytes), size: bytes.length,
    source, files: pack.files.map(({ path, size }) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path)) };
  if (pack.integrity !== manifest.integrity) throw new Error('npm pack reported a different integrity.');
  validateManifest(manifest, bytes, { allowDirty });
  await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function verify(directory, expected = {}) {
  const resolved = await realpath(directory);
  const manifestPath = path.join(resolved, 'release-manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Release manifest must be a regular file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!VERSION.test(manifest?.version ?? '') || manifest.filename !== TARBALL_PREFIX + manifest.version + '.tgz') throw new Error('Release tarball filename is invalid.');
  const tarball = path.join(resolved, manifest.filename);
  if (!(await lstat(tarball)).isFile()) throw new Error('Release tarball must be a regular file.');
  validateManifest(manifest, await readFile(tarball), expected);
  if (expected.requireTagDispatch) validateTagDispatch(manifest, expected.tag);
  return manifest;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--require-tag-dispatch') options.requireTagDispatch = true;
    else if (['--directory', '--integrity', '--commit', '--tag', '--run-id'].includes(arg) && argv[i + 1]) options[arg.slice(2).replace('run-id', 'runId')] = argv[++i];
    else throw new Error('Usage: release-artifact.mjs prepare|verify --directory DIR [--integrity SHA512] [--commit SHA] [--tag vVERSION] [--run-id ID] [--allow-dirty] [--require-tag-dispatch]');
  }
  if (options.requireTagDispatch && command !== 'verify') throw new Error('--require-tag-dispatch is only supported by verify.');
  if (typeof options.directory !== 'string') throw new Error('A release artifact directory is required.');
  const directory = path.resolve(options.directory);
  const manifest = command === 'prepare' ? await prepare(directory, options) : command === 'verify' ? await verify(directory, options) : null;
  if (!manifest) throw new Error('Expected prepare or verify.');
  const summary = { filename: manifest.filename, integrity: manifest.integrity, size: manifest.size, commit: manifest.source.commit, dirty: manifest.source.dirty, files: manifest.files.length };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, 'filename=' + manifest.filename + '\nintegrity=' + manifest.integrity + '\n', { flag: 'a' });
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
    return normalize(realpathSync(process.argv[1])) === normalize(realpathSync(fileURLToPath(import.meta.url)));
  } catch { return false; }
}

if (isEntryPoint()) {
  main().catch(error => { console.error('Release artifact check failed: ' + error.message); process.exitCode = 1; });
}
