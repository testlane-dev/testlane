/**
 * Test-only broker double: a small IPC child that stands in for the real
 * `testlane` CLI in unit tests, the same way
 * `examples/workflows/authenticated-smoke/fake-broker.mjs` does for that
 * package's self-test. It is launched with `fork(BROKER_DOUBLE_PATH, args, {
 * silent: true })` exactly like `runtime.mjs`'s `brokerCall` launches the
 * real CLI, and its configuration (including every session cookie) arrives
 * only over the private child IPC channel, never through argv, environment
 * or a fixture file.
 *
 * This module is dual-purpose: importing it (for `BROKER_DOUBLE_PATH` /
 * `brokerDoubleConfig`) must not itself start listening for IPC messages, so
 * the listener is only installed when this file is the forked child's entry
 * point (mirrors the `isMainModule` guard in `authenticated-smoke/run.mjs`).
 *
 * This double is NOT evidence that the real broker works; it exists only so
 * `examples/workflows/**` fixtures can unit-test workflow runners quickly,
 * without a browser or the real broker. `real-broker.mjs` is the harness
 * that exercises the actual built CLI.
 */
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const BROKER_DOUBLE_PATH = fileURLToPath(import.meta.url);

/**
 * Build an IPC config for `profiles` (each `{name,email,role,environment,
 * baseUrl,strategy}`) against a running reference app: mints one session per
 * profile via `app.mintSession(email)` so `session <profile> --format
 * storage-state --out <file>` can hand back a real, working cookie.
 */
export function brokerDoubleConfig({ app, profiles }) {
  const sessions = {};
  for (const profile of profiles) {
    sessions[profile.name] = { cookieName: 'ref_session', cookieValue: app.mintSession(profile.email) };
  }
  return { origin: app.origin, profiles, sessions };
}

function findProfile(config, name) {
  return (config.profiles ?? []).find((candidate) => candidate?.name === name);
}

async function execute(args, config) {
  const json = args.includes('--json');
  const command = args.find((arg) => !arg.startsWith('-'));
  if (config === undefined || typeof command !== 'string') throw new Error('bad test invocation');

  if (command === 'profiles') {
    process.stdout.write(JSON.stringify({ profiles: config.profiles ?? [] }));
    return;
  }

  if (command === 'check') {
    const profileName = args[args.indexOf('check') + 1];
    const profile = findProfile(config, profileName);
    if (profile === undefined) throw new Error('unknown profile');
    const check = config.checks?.[profileName] ?? { ok: true, email: profile.email, role: profile.role };
    process.stdout.write(JSON.stringify({ profile: profileName, ...check }));
    return;
  }

  if (command === 'session') {
    const profileName = args[args.indexOf('session') + 1];
    const profile = findProfile(config, profileName);
    const session = config.sessions?.[profileName];
    if (profile === undefined || session === undefined) throw new Error('unknown profile');
    const outIndex = args.indexOf('--out');
    const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
    if (out === undefined) throw new Error('missing --out');
    const hostname = new URL(config.origin).hostname;
    const state = {
      cookies: [
        {
          name: session.cookieName,
          value: session.cookieValue,
          domain: hostname,
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    };
    await writeFile(out, JSON.stringify(state));
    process.stdout.write(json ? JSON.stringify({ path: out }) : 'wrote storage-state session\n');
    return;
  }

  throw new Error('unsupported test command');
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): a fork()'d child under a symlinked tmpdir (e.g. macOS's
// /var -> /private/var) could otherwise get argv[1] that never string-equals
// BROKER_DOUBLE_PATH, silently leaving the IPC listener uninstalled.
function isForkedEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = realpathSync(entry);
    const b = realpathSync(BROKER_DOUBLE_PATH);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isForkedEntryPoint()) {
  let config;
  process.on('message', async (message) => {
    if (message?.type !== 'config') return;
    config = message.config;
    try {
      await execute(process.argv.slice(2), config);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
}
