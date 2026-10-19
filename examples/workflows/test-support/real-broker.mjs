/**
 * Harness for driving the REAL built broker CLI (`dist/cli.js`) from a test
 * or proof, inside a throwaway scratch home. This is the only file in this
 * package that talks to the actual `testlane` executable; every other
 * fixture here (`broker-double.mjs`) is a stand-in.
 *
 * Platform support is deliberately narrow: a scratch `TESTLANE_HOME` isolates
 * the broker's own files (audit log, encrypted store), but it does NOT
 * isolate the OS keychains that `dpapi` (Windows) and `secret-service`
 * (Linux, via secret-tool + a keyring) ultimately depend on. So the real
 * broker may only be driven on Windows, or on Linux when the caller has
 * opted in with `TESTLANE_REAL_KEYCHAIN=1` (meaning: it is already running
 * inside an isolated `dbus-run-session` + throwaway gnome-keyring, as CI
 * does). macOS's keychain has no such isolated, scriptable equivalent here,
 * so it is always refused.
 */
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_PREFIX = 'testlane-real-broker-';
const MAX_OUTPUT = 64 * 1024;

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_OUTPUT) : '';
}

/** First absolute PATH entry holding an executable file named `command`, or null. */
function whichOnPath(command, pathVar) {
  for (const dir of (pathVar ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
    // Windows executables carry an extension PATHEXT would resolve; secret-tool
    // is POSIX-only, so no extension probing is needed here.
  }
  return null;
}

/**
 * Whether this process may drive the real broker CLI, and which secret store
 * it must use. Never returns a store the platform cannot actually back with
 * an isolated keychain.
 */
export function realBrokerSupport({ platform = process.platform, env = process.env, which } = {}) {
  const lookup = which ?? ((command) => whichOnPath(command, env.PATH ?? env.Path ?? ''));

  if (platform === 'win32') {
    return { supported: true, store: 'dpapi', reason: 'win32: DPAPI-backed store under the scratch TESTLANE_HOME' };
  }

  if (platform === 'linux') {
    if (env.TESTLANE_REAL_KEYCHAIN !== '1') {
      return {
        supported: false,
        store: null,
        reason:
          'linux: refused without TESTLANE_REAL_KEYCHAIN=1 (a scratch TESTLANE_HOME does not isolate the OS keyring; ' +
          'opt in only inside an isolated dbus-run-session + throwaway gnome-keyring, as CI does)',
      };
    }
    const secretTool = lookup('secret-tool');
    if (secretTool === null) {
      return {
        supported: false,
        store: null,
        reason: 'linux: TESTLANE_REAL_KEYCHAIN=1 is set but secret-tool is not on PATH',
      };
    }
    return { supported: true, store: 'secret-service', reason: 'linux: TESTLANE_REAL_KEYCHAIN=1 and secret-tool on PATH' };
  }

  return {
    supported: false,
    store: null,
    reason: `${platform}: no isolated path to a real, scratch-scoped keychain here (only win32 DPAPI and opted-in linux secret-service are supported)`,
  };
}

/**
 * A registry (`{version:1, profiles:{...}}`) with a writer and a reader
 * profile against a running reference app, plus any `extra` entries merged
 * in as-is. Profile names are namespaced so repeated or parallel harnesses
 * never collide in a shared keyring.
 */
export function referenceProfiles({ namespace, origin, writer, reader, extra = {} }) {
  const options = {
    loginPath: '/login',
    fields: '{"email":"{{email}}","password":"{{secret}}"}',
    sessionCookieName: 'ref_session',
    successPath: '/workspace',
    mePath: '/api/me',
  };
  const entry = (account) => ({
    app: 'testlane-reference-app',
    environment: 'testing',
    baseUrl: origin,
    strategy: 'form-post',
    account: { email: account.email, role: account.role },
    session: { ttlMinutes: 30 },
    options,
  });
  return {
    version: 1,
    profiles: {
      [`${namespace}:local:writer`]: entry(writer),
      [`${namespace}:local:reader`]: entry(reader),
      ...extra,
    },
  };
}

/** True when `root` is exactly `<os.tmpdir()>/testlane-real-broker-<suffix>` (no traversal, no symlink games via string form). */
function isVerifiedScratchRoot(root) {
  const resolved = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tmp) return false;
  return path.basename(resolved).startsWith(SCRATCH_PREFIX);
}

/**
 * A throwaway broker home + registry file, and helpers to seed secrets (over
 * stdin only), run the real CLI, read the scratch audit log, and dispose of
 * everything afterwards.
 */
export async function createRealBrokerHarness({ brokerCli, registry, support }) {
  const root = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  const profilesFile = path.join(root, 'testlane.profiles.json');
  await writeFile(profilesFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  const env = { ...process.env };
  env.TESTLANE_HOME = home;
  env.AGENT_AUTH_HOME = home;
  env.TESTLANE_PROFILES = profilesFile;
  env.AGENT_AUTH_PROFILES = '';
  env.TESTLANE_STORE = support.store;
  env.AGENT_AUTH_STORE = '';
  delete env.TESTLANE_REQUESTER;
  delete env.AGENT_AUTH_REQUESTER;

  const seededProfiles = new Set();

  /** Run the real CLI: an executable path plus an argv array, shell:false, no secret ever on argv. */
  function run(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [brokerCli, ...args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout: boundedText(stdout), stderr: boundedText(stderr) }));
      if (input !== undefined) child.stdin.end(`${input}\n`);
      else child.stdin.end();
    });
  }

  /** `testlane store set <profile>`, the secret on stdin only. Throws a fixed, secret-free message on failure. */
  async function seed(profile, secret) {
    const result = await run(['store', 'set', profile], { input: secret });
    if (result.code !== 0) {
      throw new Error(`real broker harness: failed to seed the store for a profile (exit ${result.code})`);
    }
    seededProfiles.add(profile);
  }

  async function auditText() {
    try {
      return await readFile(path.join(home, 'audit.ndjson'), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return '';
      throw err;
    }
  }

  async function dispose() {
    for (const profile of seededProfiles) {
      try {
        await run(['store', 'delete', profile]);
      } catch {
        // best-effort: the scratch root is removed regardless, taking any
        // encrypted-file store artifacts with it.
      }
    }
    if (isVerifiedScratchRoot(root)) {
      await rm(path.resolve(root), { recursive: true, force: true });
    }
  }

  return { root, home, profilesFile, env, seed, run, auditText, dispose };
}
