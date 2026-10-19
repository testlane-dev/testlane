import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REFERENCE_ROLES, startReferenceApp } from '../reference-app.mjs';
import { BROKER_DOUBLE_PATH, brokerDoubleConfig } from '../broker-double.mjs';

function brokerCall(args, config) {
  return new Promise((resolve, reject) => {
    const child = fork(BROKER_DOUBLE_PATH, args, { silent: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.send({ type: 'config', config });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.once('error', reject);
  });
}

async function withHarness(fn) {
  const writer = { email: 'writer@example.test', role: REFERENCE_ROLES.writer, password: 'writer-secret' };
  const reader = { email: 'reader@example.test', role: REFERENCE_ROLES.reader, password: 'reader-secret' };
  const app = await startReferenceApp({ accounts: [writer, reader], buildId: 'b', environment: 'testing', runId: 'r', dataScope: 's' });
  const profiles = [
    { name: 'ns:local:writer', email: writer.email, role: writer.role, environment: 'testing', baseUrl: app.origin, strategy: 'form-post' },
    { name: 'ns:local:reader', email: reader.email, role: reader.role, environment: 'testing', baseUrl: app.origin, strategy: 'form-post' },
  ];
  const config = brokerDoubleConfig({ app, profiles });
  try {
    await fn({ app, profiles, config });
  } finally {
    await app.close();
  }
}

test('BROKER_DOUBLE_PATH points at this module and importing it does not start an IPC listener', () => {
  assert.equal(path.basename(BROKER_DOUBLE_PATH), 'broker-double.mjs');
  assert.equal(process.listenerCount('message'), 0);
});

test('--json profiles returns exactly the configured profiles array', async () => {
  await withHarness(async ({ profiles, config }) => {
    const result = await brokerCall(['--json', 'profiles'], config);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { profiles });
  });
});

test('--json check <profile> reports ok/email/role from profile metadata by default', async () => {
  await withHarness(async ({ config }) => {
    const result = await brokerCall(['--json', 'check', 'ns:local:writer'], config);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { profile: 'ns:local:writer', ok: true, email: 'writer@example.test', role: REFERENCE_ROLES.writer });
  });
});

test('--json check <profile> honours an explicit checks override, including a negative outcome', async () => {
  await withHarness(async ({ app, profiles }) => {
    const config = brokerDoubleConfig({ app, profiles });
    config.checks = { 'ns:local:writer': { ok: false, email: 'writer@example.test', role: 'wrong-role' } };
    const result = await brokerCall(['--json', 'check', 'ns:local:writer'], config);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { profile: 'ns:local:writer', ok: false, email: 'writer@example.test', role: 'wrong-role' });
  });
});

test('session <profile> --format storage-state --out <file> writes a real working cookie for that profile', async () => {
  await withHarness(async ({ config }) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'broker-double-session-'));
    try {
      const outFile = path.join(tmp, 'state.json');
      const result = await brokerCall(['session', 'ns:local:reader', '--format', 'storage-state', '--out', outFile], config);
      assert.equal(result.code, 0);
      const state = JSON.parse(await readFile(outFile, 'utf8'));
      assert.equal(state.cookies.length, 1);
      assert.equal(state.cookies[0].name, 'ref_session');
      assert.equal(state.cookies[0].domain, '127.0.0.1');
      assert.deepEqual(state.origins, []);

      const cookie = `${state.cookies[0].name}=${state.cookies[0].value}`;
      const meRes = await fetch(`${config.origin}/api/me`, { headers: { cookie } });
      assert.equal(meRes.status, 200);
      assert.deepEqual(await meRes.json(), { email: 'reader@example.test', role: REFERENCE_ROLES.reader });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('an unknown profile exits 1 for check and for session', async () => {
  await withHarness(async ({ config }) => {
    const checkResult = await brokerCall(['--json', 'check', 'ns:local:ghost'], config);
    assert.equal(checkResult.code, 1);

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'broker-double-unknown-'));
    try {
      const sessionResult = await brokerCall(['session', 'ns:local:ghost', '--format', 'storage-state', '--out', path.join(tmp, 'x.json')], config);
      assert.equal(sessionResult.code, 1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('an unknown command exits 1', async () => {
  await withHarness(async ({ config }) => {
    const result = await brokerCall(['--json', 'rotate', 'ns:local:writer'], config);
    assert.equal(result.code, 1);
  });
});
