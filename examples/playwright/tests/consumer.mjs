/** A consumer project using only files from the packed npm installation. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
export const repo = fileURLToPath(new URL('../../../', import.meta.url));
const prefix = 'testlane-playwright-consumer-';

export async function consumerProject({ tarball: suppliedTarball } = {}) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, prefix));
  const npm = process.env.npm_execpath;
  assert.ok(npm && path.isAbsolute(npm), 'run through npm run test:playwright or proof:playwright-real-broker');
  const e2e = path.join(root, 'e2e');
  const packageRoot = path.join(root, 'node_modules', '@testlane', 'cli');
  const brokerCli = path.join(packageRoot, 'dist', 'cli.js');
  const runner = path.join(root, 'node_modules/@playwright/test/cli.js');
  const childEnv = { ...process.env, DEBUG: '', PWDEBUG: '', NODE_DEBUG: '', npm_config_update_notifier: 'false' };
  const runNpm = (args, cwd) => execute(process.execPath, [npm, ...args], {
    cwd, env: childEnv, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  async function dispose() {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith(prefix));
    await rm(resolved, { recursive: true, force: true });
  }
  try {
    let tarball;
    if (suppliedTarball) {
      tarball = 'reviewed-release.tgz';
      await copyFile(path.resolve(suppliedTarball), path.join(root, tarball));
    } else {
      const pack = await runNpm(['pack', repo, '--ignore-scripts', '--json', '--pack-destination', root], root);
      const manifest = JSON.parse(pack.stdout)[0];
      const packed = manifest.files.map(file => file.path);
      for (const file of ['fixtures.mjs', 'app.spec.mjs', 'playwright.config.mjs', 'README.md']) {
        assert.ok(packed.includes('examples/playwright/' + file), 'copyable fixture file ships');
      }
      assert.equal(packed.some(file => file.startsWith('examples/playwright/tests/') || file.startsWith('examples/playwright/node_modules/')), false);
      assert.ok(packed.includes('docs/compatibility.md'), 'compatibility guide ships');
      tarball = manifest.filename;
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'testlane-fixture-consumer', private: true, type: 'module',
      devDependencies: { '@playwright/test': '1.64.0' },
    }));
    await runNpm(['install', path.join(root, tarball), '--ignore-scripts', '--no-audit', '--no-fund'], root);
    const installedMetadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(installedMetadata.name, '@testlane/cli', 'the scoped package is installed');
    assert.deepEqual(Object.keys(installedMetadata.bin), ['testlane'], 'the executable remains testlane');
    const localCli = await runNpm(['exec', '--offline', '--no', '--', 'testlane', '--version'], root);
    assert.equal(localCli.stdout.trim(), installedMetadata.version, 'the local testlane executable resolves from the scoped install');
    await mkdir(e2e);
    const sessionTemp = path.join(root, 'private-temp');
    await mkdir(sessionTemp, { mode: 0o700 });
    await cp(path.join(packageRoot, 'examples', 'playwright', 'fixtures.mjs'), path.join(e2e, 'fixtures.mjs'));
    await writeFile(path.join(root, 'playwright.config.mjs'), `export default {
      testDir: './e2e', testMatch: '*.spec.mjs', workers: 2, retries: 0,
      reporter: 'line', timeout: 30000, outputDir: './results',
      use: { trace: 'off', video: 'off', screenshot: 'off' }
    };\n`);
    return {
      root, e2e, packageRoot, brokerCli, sessionTemp, dispose,
      async spec(name, text) { await writeFile(path.join(e2e, name + '.spec.mjs'), text); },
      async config(config) { await writeFile(path.join(root, 'fixture-config.json'), JSON.stringify(config)); },
      async run(args = [], env = {}) {
        try {
          const result = await execute(process.execPath, [runner, 'test', ...args], {
            cwd: root, env: { ...childEnv, ...env, TMP: sessionTemp, TEMP: sessionTemp, TMPDIR: sessionTemp }, timeout: 90_000,
            maxBuffer: 1024 * 1024, windowsHide: true,
          });
          return { code: 0, ...result };
        } catch (error) {
          return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
        }
      },
    };
  } catch (error) { await dispose(); throw error; }
}

export function assertNoLeaks(text, values) {
  for (const value of values) {
    for (const variant of [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) {
      assert.equal(text.includes(variant), false, 'generated credential must stay out of output/artifacts');
    }
  }
}

export async function publicArtifacts(root) {
  const { readdir } = await import('node:fs/promises');
  let text = '';
  const walk = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) text += await readFile(file, 'utf8');
    }
  };
  try { await walk(path.join(root, 'results')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return text;
}
