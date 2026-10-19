/**
 * Test-only broker double. Configuration, including the generated cookie, is
 * delivered over the private child IPC channel and never through argv/env or
 * a fixture file. It intentionally implements only profiles/check/session.
 */
import { writeFile } from 'node:fs/promises';

let config;
process.on('message', async (message) => {
  if (message?.type !== 'config') return;
  config = message.config;
  try { await execute(process.argv.slice(2)); process.exit(0); }
  catch { process.exit(1); }
});

async function execute(args) {
  const json = args.includes('--json');
  const command = args.find((arg) => !arg.startsWith('-'));
  if (!config || typeof command !== 'string') throw new Error('bad test invocation');
  if (command === 'profiles') {
    process.stdout.write(JSON.stringify({ profiles: config.profiles ?? [config.profile] }));
    return;
  }
  if (command === 'check') {
    process.stdout.write(JSON.stringify({ profile: config.profile.name, ok: true, email: config.profile.email, role: config.profile.role }));
    return;
  }
  if (command === 'session') {
    const outIndex = args.indexOf('--out');
    const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
    if (!out) throw new Error('missing out');
    await writeFile(out, JSON.stringify({ cookies: [{ name: 'smoke_session', value: config.cookie, domain: new URL(config.origin).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
    process.stdout.write(json ? JSON.stringify({ path: out }) : `wrote storage-state session\n`);
    return;
  }
  throw new Error('unsupported test command');
}
