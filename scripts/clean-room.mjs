#!/usr/bin/env node
/**
 * Clean-room consumer walkthrough, scripted.
 *
 * Acts as a stranger who only has the packed tarball: packs the repo, installs
 * it globally into a throwaway prefix, drives the installed `testlane`
 * shim from a fake consumer repo, installs each workflow
 * template's own dependencies inside the installed package, runs the
 * authenticated-smoke self-test and the feature-acceptance "no manifest"
 * fast-failure, and reproduces the two copied-template regressions
 * (`examples/workflows/authenticated-smoke/tests/copied-template.test.mjs`
 * and `examples/workflows/feature-acceptance/tests/copied-alone.test.mjs`)
 * against what actually ships in the npm package.
 *
 * Node built-ins only. Every child process is `shell:false` except npm and
 * npx, which are `.cmd` shims on Windows that Node can only spawn through a
 * shell; their arguments are always fixed constants, never interpolated
 * secrets or paths built from user input (see `runNpmLike` below and
 * `examples/demo-app/scripts/lib.mjs`'s `runNpm`, which uses the same
 * pattern). The installed `testlane` shims are also `.cmd` files
 * on Windows and are invoked the same way, by absolute path.
 *
 * No secret is ever placed in argv, an environment variable, or a log: the
 * one throwaway value this script seeds is generated with
 * `crypto.randomBytes` and passed only over the child's stdin, exactly like
 * `testlane store set` requires.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST_TIMEOUT_MS = 180_000;
const COPIED_TEMPLATE_TIMEOUT_MS = 20_000;
const FEATURE_NO_MANIFEST_TIMEOUT_MS = 30_000;
const DPAPI_CHECK_TIMEOUT_MS = 15_000;
const REQUIRED_HELP_COMMANDS = ['profiles', 'store', 'account', 'session', 'check', 'handoff', 'rotate', 'status', 'audit', 'mcp', 'serve'];
const FORBIDDEN_PACKED_PREFIXES = ['tests/', 'node_modules/', 'test-support/', 'output/', 'docs/private/'];
const REQUIRED_PACKED_PATHS = [
  'examples/workflows/authenticated-smoke/run.mjs',
  'examples/workflows/feature-acceptance/run.mjs',
  'dist/workflows/contracts.js',
  'dist/workflows/feature-contracts.js',
  'dist/workflows/primitives.js',
];

function parseArgs(argv) {
  const out = { json: false, outputDir: path.join(REPO_ROOT, 'output'), skipBrowserInstall: false };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg === '--skip-browser-install') out.skipBrowserInstall = true;
    else if (arg.startsWith('--output-dir=')) out.outputDir = path.resolve(arg.slice('--output-dir='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small process/fs helpers
// ---------------------------------------------------------------------------

/** Fresh env for a child: isolated npm config, isolated scratch home, blank legacy vars, scratch bin dir first on PATH. Never touches the real global prefix or ~/.testlane. */
function scratchEnv(root) {
  const globalPrefix = path.join(root, 'g');
  const home = path.join(root, 'home');
  const binDir = IS_WINDOWS ? globalPrefix : path.join(globalPrefix, 'bin');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  env.npm_config_prefix = globalPrefix;
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  env.TESTLANE_HOME = home;
  env.AGENT_AUTH_HOME = home;
  env.TESTLANE_PROFILES = '';
  env.AGENT_AUTH_PROFILES = '';
  env.TESTLANE_STORE = '';
  env.AGENT_AUTH_STORE = '';
  return { env, globalPrefix, home };
}

/** Children currently running, so an abort (or the final cleanup) can kill anything still alive. */
const activeChildren = new Set();

/** Run a child process, capturing stdout/stderr in memory (never echoed except in boolean assertions). */
function runChild(command, args, { cwd, env, input, timeoutMs, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' }),
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', spawnError: error });
      return;
    }
    activeChildren.add(child);
    const done = (result) => {
      activeChildren.delete(child);
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => done({ code: null, signal: null, stdout, stderr, spawnError: error }));
    child.once('close', (code, signal) => done({ code, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** npm/npx are `.cmd` shims on Windows, spawnable only through a shell. Args are always fixed constants. */
function runNpmLike(command, args, opts = {}) {
  return runChild(command, args, { ...opts, shell: IS_WINDOWS });
}

function utcStamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}`
  );
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

const results = [];
const lines = [];

function record(name, ok, reason) {
  const status = ok ? 'PASS' : 'FAIL';
  const line = ok ? `PASS ${name}` : `FAIL ${name}: ${reason}`;
  lines.push(line);
  process.stderr.write(`${line}\n`);
  results.push({ name, status: ok ? 'passed' : 'failed', reason: ok ? null : reason });
  return ok;
}

/**
 * Summarizes a workflow/feature-acceptance report's non-passed steps as
 * `id:reasonCode` pairs (plus `cleanup:reasonCode` when cleanup itself
 * failed), for use in a check failure message. `id` and `reasonCode` are
 * both closed, fixed-format enums (REQUIRED_SMOKE_STEPS/REQUIRED_FEATURE_STEPS
 * and REASON_CODES in src/workflows/primitives.ts) -- never the step's raw
 * error/exception text -- so this is always safe to print, even though
 * `report` came from a child process. Returns '' when `report` isn't a
 * parsed object with a `steps` array, or every step passed (nothing useful
 * to add).
 */
function describeStepFailures(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.steps)) return '';
  const parts = report.steps
    .filter((step) => step && typeof step === 'object' && step.status !== 'passed')
    .map((step) => `${step.id}:${step.reasonCode}`);
  if (report.cleanup && typeof report.cleanup === 'object' && report.cleanup.status === 'failed') {
    parts.push(`cleanup:${report.cleanup.reasonCode ?? 'cleanup-failed'}`);
  }
  return parts.join(', ');
}

/**
 * Run one named check; a thrown error becomes a FAIL with a fixed reason,
 * never the raw error text (set CLEAN_ROOM_DEBUG=1 to also print the local
 * script exception -- never child process output -- to stderr for local
 * debugging).
 */
async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome && outcome.ok === false) {
      record(name, false, outcome.reason ?? 'assertion failed');
      return false;
    }
    record(name, true, null);
    return true;
  } catch (error) {
    if (process.env.CLEAN_ROOM_DEBUG === '1') process.stderr.write(`${error?.stack ?? error}\n`);
    record(name, false, `unexpected error while running this check (see script source for ${name})`);
    return false;
  }
}

function fail(reason) {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(options) {
  const startedAt = new Date().toISOString();

  const distCli = path.join(REPO_ROOT, 'dist', 'cli.js');
  if (!existsSync(distCli)) {
    process.stderr.write('clean-room: dist/cli.js is missing; run "npm run build" first (not from this script).\n');
    return { exitCode: 1, startedAt, finishedAt: new Date().toISOString(), results: [], scratchRoot: null };
  }

  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;

  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'tlcr-'));
  const { env, globalPrefix, home } = scratchEnv(scratchRoot);

  let tarballPath = null;
  let globalNodeModules = null;
  let installedPackage = null;
  let testlaneBin = null;

  try {
    await mkdir(home, { recursive: true });

    // --- 2. npm pack: exactly one tarball, shipped file list matches contract ---
    await check('pack-tarball', async () => {
      const res = await runNpmLike('npm', ['pack', '--json', '--pack-destination', scratchRoot], { cwd: REPO_ROOT, env });
      if (res.code !== 0) return fail('npm pack failed');
      let info;
      try {
        info = JSON.parse(res.stdout);
      } catch {
        return fail('npm pack did not print valid JSON');
      }
      if (!Array.isArray(info) || info.length !== 1) return fail('npm pack did not produce exactly one package');
      const [entry] = info;
      if (entry.name !== '@testlane/cli' || entry.version !== version || entry.filename !== `testlane-cli-${version}.tgz`) return fail('npm pack returned an unexpected package identity or filename');
      tarballPath = path.join(scratchRoot, entry.filename);
      if (!existsSync(tarballPath)) return fail('npm pack reported a tarball that is not on disk');
      const files = (entry.files ?? []).map((f) => f.path);
      const forbidden = files.filter(
        (f) => FORBIDDEN_PACKED_PREFIXES.some((prefix) => f === prefix.slice(0, -1) || f.startsWith(prefix) || f.includes(`/${prefix}`)) || f.endsWith('real-broker-proof.mjs'),
      );
      if (forbidden.length > 0) return fail(`shipped tarball includes files that must not ship (e.g. ${forbidden[0]})`);
      const missing = REQUIRED_PACKED_PATHS.filter((p) => !files.includes(p));
      if (missing.length > 0) return fail(`shipped tarball is missing a required file (e.g. ${missing[0]})`);
      lines.push(`# pack: ${entry.filename}, ${entry.entryCount} entries`);
      return { ok: true };
    });

    if (tarballPath === null) throw new Error('CLEAN_ROOM_ABORT');

    // --- 3. Global install, version parity, --help command list ---
    await check('global-install', async () => {
      const res = await runNpmLike('npm', ['install', '-g', tarballPath], { cwd: scratchRoot, env });
      if (res.code !== 0) return fail('npm install -g of the packed tarball failed');
      const rootRes = await runNpmLike('npm', ['root', '-g'], { cwd: scratchRoot, env });
      if (rootRes.code !== 0) return fail('npm root -g failed after global install');
      globalNodeModules = rootRes.stdout.trim();
      if (!globalNodeModules) return fail('npm root -g printed nothing');
      installedPackage = path.join(globalNodeModules, '@testlane', 'cli');
      const installedMetadata = JSON.parse(await readFile(path.join(installedPackage, 'package.json'), 'utf8'));
      if (installedMetadata.name !== '@testlane/cli' || installedMetadata.version !== version) return fail('installed scoped package metadata does not match the candidate');
      testlaneBin = path.join(globalPrefix, IS_WINDOWS ? 'testlane.cmd' : path.join('bin', 'testlane'));
      if (!existsSync(testlaneBin)) return fail('installed package did not create the testlane CLI shim');
      const legacyBin = path.join(globalPrefix, IS_WINDOWS ? 'agent-auth.cmd' : path.join('bin', 'agent-auth'));
      if (existsSync(legacyBin)) return fail('installed package unexpectedly created the legacy CLI alias');
      return { ok: true };
    });

    if (testlaneBin === null) throw new Error('CLEAN_ROOM_ABORT');

    await check('version-testlane', async () => {
      const res = await runChild(testlaneBin, ['--version'], { cwd: scratchRoot, env, shell: IS_WINDOWS });
      if (res.code !== 0) return fail('testlane --version exited non-zero');
      if (res.stdout.trim() !== version) return fail('testlane --version does not match package.json version');
      return { ok: true };
    });

    await check('help-lists-commands', async () => {
      const res = await runChild(testlaneBin, ['--help'], { cwd: scratchRoot, env, shell: IS_WINDOWS });
      if (res.code !== 0) return fail('testlane --help exited non-zero');
      const missing = REQUIRED_HELP_COMMANDS.filter((cmd) => !res.stdout.includes(cmd));
      if (missing.length > 0) return fail(`testlane --help is missing a documented command (e.g. ${missing[0]})`);
      return { ok: true };
    });

    // --- 4. Consumer repo: profiles, production refusal, unconfigured check ---
    const consumerRepo = path.join(scratchRoot, 'repo');
    await mkdir(consumerRepo, { recursive: true });

    await check('consumer-profiles-copy', async () => {
      const source = path.join(installedPackage, 'examples', 'testlane.profiles.json');
      if (!existsSync(source)) return fail('installed package is missing examples/testlane.profiles.json');
      await cp(source, path.join(consumerRepo, 'testlane.profiles.json'));
      const res = await runChild(testlaneBin, ['profiles'], { cwd: consumerRepo, env, shell: IS_WINDOWS });
      if (res.code !== 0) return fail('testlane profiles exited non-zero in a fresh consumer repo');
      return { ok: true };
    });

    await check('consumer-session-production-refused', async () => {
      const res = await runChild(testlaneBin, ['session', 'acme:production'], { cwd: consumerRepo, env, shell: IS_WINDOWS });
      if (res.code !== 2) return fail(`testlane session acme:production exited ${res.code}, expected 2 (policy refusal)`);
      return { ok: true };
    });

    // Windows only: drive the real DPAPI store end to end (seed a throwaway
    // value over stdin, then a sign-in failure). This is safe because the
    // scratch TESTLANE_HOME isolates DPAPI's on-disk files completely -- it
    // is not a shared OS credential store the way the macOS Keychain and a
    // Linux Secret Service keyring are.
    //
    // macOS/Linux never seed and never look up `acme:local:admin` (or any
    // other real profile) here: `check`'s store lookup goes through
    // `selectStore()` (src/store/select.ts), which on darwin always opens
    // the developer's real macOS *login* keychain via `/usr/bin/security`,
    // and on Linux opens a real Secret Service keyring via `secret-tool`
    // when one is on PATH -- neither is scoped by TESTLANE_HOME, so that
    // path would touch a real, shared, per-user credential store outside
    // this job's control. Running `npm run check:clean-room` on a
    // contributor's own Mac or Linux desktop must never do that (see
    // stage-interfaces-v1.md section 0: "never a real vault").
    //
    // Instead, on macOS/Linux this asserts a failure that is *provably*
    // reached before any store is ever constructed: `check <profile not in
    // the registry>`. Traced in src/commands.ts's `signInForProfile`
    // (called by `checkProfile`): its first line is
    // `const profile = getProfile(deps.registry, profileName);` (in-memory
    // registry lookup only), and `getProfile` (src/profiles.ts) throws a
    // `PolicyError` synchronously for an unknown name -- before
    // `authorizeSignIn` or `loadSecrets` (the only place that reads
    // `deps.store`) ever run. `deps.store` itself
    // (`resolveCommandDeps` in src/deps.ts) is a `LazyStore`, which only
    // calls `selectStore()` -- the thing that would open a real keychain --
    // on its first `get`/`set`/`delete`/`list`/`kind` access; an unknown
    // profile never gets that far. `classify()` in src/cli.ts maps any
    // `PolicyError` to exit 2. Verified live (this Windows machine, same
    // platform-independent registry-lookup code path, no store involved):
    // `node dist/cli.js --profiles examples/testlane.profiles.json check
    // acme:does-not-exist` -> exit 2. The `profiles` and
    // `session acme:production` checks above are likewise store-free on
    // every platform: `listProfiles` (src/commands.ts) takes
    // `Pick<CommandDeps, "registry">`, so it cannot touch `deps.store` at
    // all, and production refusal throws inside `authorizeSignIn`'s
    // `assertAllowed` call, strictly before `signInForProfile`'s later
    // `loadSecrets` call.
    const UNREGISTERED_PROFILE = 'acme:clean-room-unregistered-profile';
    if (process.platform === 'win32') {
      await check('consumer-check-dpapi-signin-failure', async () => {
        // DPAPI store, isolated to the scratch TESTLANE_HOME set above. Seed
        // a throwaway random value over stdin only, then expect a sign-in
        // failure (exit 3): the profile's baseUrl (http://localhost:3000)
        // has nothing listening in this isolated environment.
        const throwaway = randomBytes(24).toString('base64url');
        const seedRes = await runChild(testlaneBin, ['store', 'set', 'acme:local:admin'], {
          cwd: consumerRepo,
          env,
          shell: IS_WINDOWS,
          input: throwaway,
          timeoutMs: DPAPI_CHECK_TIMEOUT_MS,
        });
        if (seedRes.signal !== null) return fail('testlane store set (DPAPI, scratch home) did not exit within its timeout');
        if (seedRes.code !== 0) return fail('testlane store set (DPAPI, scratch home) failed to seed a throwaway value');
        const checkRes = await runChild(testlaneBin, ['check', 'acme:local:admin'], {
          cwd: consumerRepo,
          env,
          shell: IS_WINDOWS,
          timeoutMs: DPAPI_CHECK_TIMEOUT_MS,
        });
        if (checkRes.signal !== null) return fail('testlane check acme:local:admin (DPAPI, scratch home) did not exit within its timeout');
        if (checkRes.code !== 3) return fail(`testlane check acme:local:admin exited ${checkRes.code}, expected 3 (sign-in failure, unreachable host)`);
        return { ok: true };
      });
    } else {
      await check('consumer-check-unknown-profile-refused-no-store', async () => {
        // Deliberately never touches acme:local:admin (or any registered
        // profile) here: an unregistered profile name is refused by the
        // in-memory registry lookup alone, before any secret store -- and
        // therefore before any real OS keychain -- is ever opened. See the
        // comment above this branch for the exact source trace.
        const checkRes = await runChild(testlaneBin, ['check', UNREGISTERED_PROFILE], {
          cwd: consumerRepo,
          env,
          shell: IS_WINDOWS,
          timeoutMs: 15_000,
        });
        if (checkRes.signal !== null) return fail('testlane check on an unregistered profile did not exit within its timeout');
        if (checkRes.code !== 2) return fail(`testlane check ${UNREGISTERED_PROFILE} exited ${checkRes.code}, expected 2 (unknown-profile policy refusal, no store touched)`);
        return { ok: true };
      });
    }

    // --- 5. Templates in place inside the installed package ---
    const installedSmoke = path.join(installedPackage, 'examples', 'workflows', 'authenticated-smoke');
    const installedFeature = path.join(installedPackage, 'examples', 'workflows', 'feature-acceptance');

    await check('smoke-template-deps-install', async () => {
      if (!existsSync(installedSmoke)) return fail('installed package is missing examples/workflows/authenticated-smoke');
      const res = await runNpmLike('npm', ['install', '--no-audit', '--no-fund'], { cwd: installedSmoke, env });
      if (res.code !== 0) return fail('npm install failed inside the installed authenticated-smoke template');
      return { ok: true };
    });

    await check('smoke-template-chromium-install', async () => {
      if (options.skipBrowserInstall) {
        lines.push('# smoke-template-chromium-install skipped (--skip-browser-install)');
        return { ok: true };
      }
      const res = await runNpmLike('npx', ['playwright', 'install', 'chromium'], { cwd: installedSmoke, env, timeoutMs: SELF_TEST_TIMEOUT_MS });
      if (res.code !== 0) return fail('npx playwright install chromium failed inside the installed authenticated-smoke template');
      return { ok: true };
    });

    await check('smoke-self-test', async () => {
      const outDir = path.join(scratchRoot, 'out');
      await mkdir(outDir, { recursive: true });
      const res = await runChild(process.execPath, [path.join(installedSmoke, 'run.mjs'), '--self-test', '--json', '--output-dir', outDir], {
        cwd: installedSmoke,
        env,
        timeoutMs: SELF_TEST_TIMEOUT_MS,
      });
      if (res.signal !== null) return fail('authenticated-smoke self-test did not exit within its timeout');
      // A non-zero exit still prints a valid JSON report on stdout whenever
      // the run got far enough to derive one (run.mjs exits 1 for any
      // non-"passed" verdict, not only for a crash before execution): parse
      // it before failing on the exit code alone, so the failure message
      // names which step(s) failed and why instead of just the bare code
      // (previously this returned before ever looking at stdout, discarding
      // the report and its step ids/reasonCodes -- e.g. a chromium
      // launch-failure regression here surfaced as nothing more informative
      // than "exited 1, expected 0").
      let report = null;
      try {
        report = JSON.parse(res.stdout);
      } catch {
        /* not JSON (or empty) -- handled below, per exit code */
      }
      if (res.code !== 0) {
        const detail = describeStepFailures(report);
        return fail(`authenticated-smoke self-test exited ${res.code}, expected 0${detail ? ` (${detail})` : ''}`);
      }
      if (report === null) return fail('authenticated-smoke self-test did not print a valid JSON report');
      if (report.verdict !== 'passed') return fail(`authenticated-smoke self-test verdict was "${report.verdict}", expected "passed"`);
      return { ok: true };
    });

    await check('feature-template-deps-install', async () => {
      if (!existsSync(installedFeature)) return fail('installed package is missing examples/workflows/feature-acceptance');
      const res = await runNpmLike('npm', ['install', '--no-audit', '--no-fund'], { cwd: installedFeature, env });
      if (res.code !== 0) return fail('npm install failed inside the installed feature-acceptance template');
      return { ok: true };
    });

    await check('feature-no-manifest-fails-fast', async () => {
      const res = await runChild(process.execPath, [path.join(installedFeature, 'run.mjs')], {
        cwd: installedFeature,
        env,
        timeoutMs: FEATURE_NO_MANIFEST_TIMEOUT_MS,
      });
      if (res.signal !== null) return fail('feature-acceptance with no --manifest override did not exit within its timeout');
      if (res.code !== 1) return fail(`feature-acceptance with no --manifest override exited ${res.code}, expected 1`);
      if (/\bat .+\(.*:\d+:\d+\)/.test(res.stderr)) return fail('feature-acceptance with no --manifest override printed a stack trace');
      return { ok: true };
    });

    // --- 6. Copied-template regressions, against the installed package ---
    const testingDir = path.join(consumerRepo, 'testing');
    await check('copied-authenticated-smoke-no-hang', async () => {
      const dest = path.join(testingDir, 'authenticated-smoke');
      await mkdir(dest, { recursive: true });
      await cp(installedSmoke, dest, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' });
      const startedAtMs = Date.now();
      const res = await runChild(process.execPath, [path.join(dest, 'run.mjs'), '--self-test', '--json'], {
        cwd: dest,
        env,
        timeoutMs: COPIED_TEMPLATE_TIMEOUT_MS,
      });
      const elapsedMs = Date.now() - startedAtMs;
      if (res.signal !== null) return fail('copied authenticated-smoke template hung past its hard timeout (server left listening?)');
      if (elapsedMs >= COPIED_TEMPLATE_TIMEOUT_MS / 2) return fail('copied authenticated-smoke template did not fail fast');
      if (res.code !== 1) return fail(`copied authenticated-smoke template exited ${res.code}, expected 1`);
      if (!res.stderr.includes('workflow smoke failed before execution')) return fail('copied authenticated-smoke template did not print the fixed failure message');
      return { ok: true };
    });

    await check('copied-feature-acceptance-alone', async () => {
      const dest = path.join(consumerRepo, 'alone', 'feature-acceptance');
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(installedFeature, dest, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' });
      const startedAtMs = Date.now();
      const res = await runChild(process.execPath, [path.join(dest, 'run.mjs'), '--json'], {
        cwd: dest,
        env,
        timeoutMs: COPIED_TEMPLATE_TIMEOUT_MS,
      });
      const elapsedMs = Date.now() - startedAtMs;
      if (res.signal !== null) return fail('copied feature-acceptance template (no sibling) hung past its hard timeout');
      if (elapsedMs >= COPIED_TEMPLATE_TIMEOUT_MS / 2) return fail('copied feature-acceptance template (no sibling) did not fail fast');
      if (res.code !== 1) return fail(`copied feature-acceptance template (no sibling) exited ${res.code}, expected 1`);
      const expectedMessage = 'feature acceptance failed before execution: examples/workflows/authenticated-smoke must be installed next to this template; see README\n';
      if (res.stderr !== expectedMessage) return fail('copied feature-acceptance template (no sibling) did not print the fixed friendly message');
      if (res.stderr.includes('ERR_MODULE_NOT_FOUND')) return fail('copied feature-acceptance template (no sibling) leaked the raw module-resolution error');
      return { ok: true };
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'CLEAN_ROOM_ABORT') {
      record('clean-room-script', false, 'the script itself threw outside a single check (see script source)');
    }
  } finally {
    for (const child of activeChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    // Only ever remove the directory we created ourselves above, and only
    // after re-confirming it really is that mkdtemp directory.
    const resolvedScratch = path.resolve(scratchRoot);
    const resolvedTmp = path.resolve(os.tmpdir());
    const relative = path.relative(resolvedTmp, resolvedScratch);
    const looksRight = path.basename(resolvedScratch).startsWith('tlcr-') && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (looksRight && existsSync(resolvedScratch) && statSync(resolvedScratch).isDirectory()) {
      await rm(resolvedScratch, { recursive: true, force: true });
    }
  }

  const finishedAt = new Date().toISOString();
  const passed = results.length > 0 && results.every((r) => r.status === 'passed');
  const exitCode = passed ? 0 : 1;
  return { exitCode, startedAt, finishedAt, results, scratchRoot: null, packageVersion: version };
}

async function writeEvidence(options, summary) {
  await mkdir(options.outputDir, { recursive: true });
  const base = `clean-room-${utcStamp()}-${randomBytes(3).toString('hex')}`;
  const jsonPath = path.join(options.outputDir, `${base}.json`);
  const logPath = path.join(options.outputDir, `${base}.log`);
  const exitPath = path.join(options.outputDir, `${base}.exit`);
  await writeFile(logPath, `${lines.join('\n')}\n`, { flag: 'wx' });
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  await writeFile(exitPath, `${summary.exitCode}\n`, { flag: 'wx' });
  return { jsonPath, logPath, exitPath };
}

const options = parseArgs(process.argv.slice(2));
const summary = await main(options);
const evidence = await writeEvidence(options, summary);
if (options.json) {
  process.stdout.write(`${JSON.stringify({ ...summary, evidence })}\n`);
} else {
  process.stdout.write(`${summary.exitCode === 0 ? 'clean-room: all checks passed' : 'clean-room: FAILED'} (${evidence.jsonPath})\n`);
}
process.exitCode = summary.exitCode;
