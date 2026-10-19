// Test-only broker: controlled failures after writing a generated session.
// Uses private IPC in runtime tests; CLI tests pass a throwaway fixture path.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function execute(config) {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('-'));
  if (command === 'profiles') return process.stdout.write(JSON.stringify({ profiles: config.profiles }));
  const name = args[args.indexOf(command) + 1];
  const profile = config.profiles.find((entry) => entry.name === name);
  if (!profile) throw new Error('unknown test profile');
  if (command === 'check') return process.stdout.write(JSON.stringify({ ok: true, email: profile.email, role: profile.role }));
  if (command !== 'session') throw new Error('unknown test command');
  const file = args[args.indexOf('--out') + 1];
  const session = config.sessions[name];
  const fault = config.faultProfile === name ? config.fault : null;
  await writeFile(file, fault === 'invalid-state' ? '{' : JSON.stringify({ cookies: [{ name: session.cookieName, value: session.cookieValue, domain: new URL(config.origin).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  if (config.observer) await fetch(config.observer, { method: 'POST', body: JSON.stringify({ root: path.dirname(file), profile: name }) });
  if (fault === 'failed') throw new Error('test issuance failed after writing');
  if (fault === 'cancelled') return new Promise(() => setInterval(() => {}, 1000));
  process.stdout.write('wrote storage-state session\n');
}

async function run(config) {
  try { await execute(config); process.exit(0); }
  catch { process.exit(1); }
}

if (process.env.TESTLANE_FEATURE_TEST_CONFIG) {
  await run(JSON.parse(await readFile(process.env.TESTLANE_FEATURE_TEST_CONFIG, 'utf8')));
} else {
  process.once('message', (message) => { if (message?.type === 'config') void run(message.config); });
}
