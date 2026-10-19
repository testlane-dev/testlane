import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = path.join(repo, 'examples/existing-app');
// Reuse the optional browser test dependency; the broker runtime stays browser-free.
const playwright = path.join(repo, 'examples/workflows/authenticated-smoke/node_modules/playwright');

function run(script, config, state, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, config, state], {
      cwd, shell: false, windowsHide: true, timeout: 45_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('copied existing-app check verifies observations and refuses false passes', { timeout: 120_000 }, async (t) => {
  const tempParent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempParent, 'testlane-existing-app-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), tempParent);
    assert.ok(path.basename(resolved).startsWith('testlane-existing-app-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const tools = path.join(root, 'tools/testlane');
  await fs.mkdir(tools, { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(playwright, path.join(root, 'node_modules/playwright'), 'junction');
  const script = path.join(tools, 'verify.mjs');
  const configFile = path.join(tools, 'verify.json');
  const stateFile = path.join(root, 'session.json');
  await fs.copyFile(path.join(source, 'verify.mjs'), script);
  const sample = JSON.parse(await fs.readFile(path.join(source, 'verify.json'), 'utf8'));
  const token = randomBytes(32).toString('base64url');
  let mode = 'happy';
  let origin;
  let externalOrigin;
  let releaseNavigation;
  let anonymousResponse;
  let lateEscapeObserved = false;

  const server = http.createServer((req, res) => {
    const signedIn = req.headers.cookie === 'shop_session=' + token;
    if (req.url === '/api/me') {
      res.setHeader('content-type', 'application/json');
      if (!signedIn && mode === 'late-navigation') {
        anonymousResponse = res;
        releaseNavigation?.();
        // Bound a broken fixture; the external request below normally releases this.
        setTimeout(() => { if (!res.writableEnded) { res.writeHead(401); res.end('{}'); } }, 1500).unref();
        return;
      }
      if (!signedIn && mode !== 'public-identity') {
        res.writeHead(401); res.end('{}'); return;
      }
      const email = mode === 'reflected-identity' ? token : sample.expectedEmail;
      res.end(JSON.stringify({ email, role: sample.expectedRole }));
      return;
    }
    if (req.url === '/wait-for-anonymous' && mode === 'late-navigation') {
      releaseNavigation = () => res.end('continue');
      if (anonymousResponse) releaseNavigation();
      return;
    }
    if (req.url === '/late-redirect' && mode === 'late-navigation') {
      res.writeHead(302, { location: externalOrigin + '/dashboard' }); res.end(); return;
    }
    if (req.url === '/dashboard' && signedIn && mode.includes('redirect')) {
      const location = mode === 'same-origin-redirect' ? '/dashboard?complete=1' : externalOrigin + '/dashboard';
      res.writeHead(302, { location }); res.end(); return;
    }
    if (req.url?.startsWith('/dashboard') && signedIn) {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><h1>Dashboard</h1>' + (mode === 'late-navigation' ? '<script>fetch("/wait-for-anonymous").then(() => { location.href = "/late-redirect"; });</script>' : ''));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  origin = 'http://127.0.0.1:' + server.address().port;
  const external = http.createServer((req, res) => {
    if (mode === 'late-navigation') {
      lateEscapeObserved = true;
      setTimeout(() => { if (anonymousResponse && !anonymousResponse.writableEnded) { anonymousResponse.writeHead(401); anonymousResponse.end('{}'); } }, 50).unref();
    }
    if (mode === 'returning-redirect') { res.writeHead(302, { location: origin + '/dashboard?complete=1' }); res.end(); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>Dashboard</h1>');
  });
  external.listen(0, '127.0.0.1');
  await once(external, 'listening');
  externalOrigin = 'http://127.0.0.1:' + external.address().port;
  t.after(() => new Promise((resolve) => { external.closeAllConnections(); external.close(resolve); }));
  const cookie = {
    name: 'shop_session', value: token, domain: '127.0.0.1', path: '/',
    expires: Math.floor(Date.now() / 1000) + 300,
    httpOnly: true, secure: false, sameSite: 'Lax',
  };
  const cases = [
    ['happy', 'happy', 0, {}],
    ['repeated run', 'happy', 0, {}],
    ['same-origin server redirect remains supported', 'same-origin-redirect', 0, {}],
    ['same-path external server redirect cannot pass', 'external-redirect', 1, {}],
    ['external redirect returning to app cannot pass', 'returning-redirect', 1, {}],
    ['navigation observed during the later anonymous check cannot pass', 'late-navigation', 1, {}],
    ['reflected identity', 'reflected-identity', 1, {}],
    ['missing protected page', 'happy', 1, { protectedPath: '/missing' }],
    ['anonymous route is public', 'public-identity', 1, {}],
    ['missing session cookies', 'unsigned', 1, {}],
  ];
  for (const [name, nextMode, exit, change] of cases) {
    await t.test(name, async () => {
      mode = nextMode;
      releaseNavigation = undefined; anonymousResponse = undefined; lateEscapeObserved = false;
      await fs.writeFile(configFile, JSON.stringify({ ...sample, baseUrl: origin, ...change }));
      await fs.writeFile(stateFile, JSON.stringify({ cookies: mode === 'unsigned' ? [] : [cookie], origins: [] }));
      const result = await run(script, configFile, stateFile, root);
      assert.equal((result.stdout + result.stderr).includes(token), false, 'session material must stay out of output');
      if (mode === 'late-navigation') {
        assert.equal(lateEscapeObserved, true, 'escape must happen after the protected-page check');
        assert.ok(result.stdout.includes('PASS protected page heading'));
        assert.ok(result.stdout.includes('PASS anonymous API denial'));
        assert.equal(result.stderr, 'FAIL protected page navigation\n');
      }
      assert.equal(result.code, exit);
      assert.equal(result.stdout.includes('PASS existing-app checks; browser closed'), exit === 0);
      if (exit === 0) assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('PASS ')).length, 4);
      else assert.ok(result.stderr.startsWith('FAIL '));
      // The caller owns cleanup, as documented; the example must not delete its input.
      assert.equal((await fs.stat(stateFile)).isFile(), true);
      await fs.unlink(stateFile);
    });
  }
});
