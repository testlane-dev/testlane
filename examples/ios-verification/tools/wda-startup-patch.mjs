/** Exact, source-bound compatibility change for one owned WDA startup request. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => new Error('IOS_WDA_STARTUP_PATCH_REFUSED');
const STARTUP = 'node_modules/appium-xcuitest-driver/build/lib/commands/wda/startup.js';
const SOURCE_SHA256 = 'c2b6b0e019075f18f778d791133836300a4523b14658f31b56b728120a138cd1';
const PROXY_FILES = Object.freeze({
  'node_modules/appium-xcuitest-driver/build/lib/commands/proxy-helper.js': '09fc30312df55fd9509e22b8a4ba252ec317094a5aee49b1f0568929c71c79ce',
  'node_modules/appium-xcuitest-driver/node_modules/@appium/base-driver/build/lib/jsonwp-proxy/proxy.js': 'e5e7eba130a4bc5c39297c43dadf985d83e28d220143acd41186900eb56d340d',
  'node_modules/appium-xcuitest-driver/node_modules/@appium/base-driver/build/lib/jsonwp-proxy/proxy-request.js': 'f7cadceb7c2beb90b33cc2c3658d7df9f31c78d24ca4dbb4571fe7e2df74d1d9',
});
const ORIGINAL = `    await driver.proxyCommand('/session', 'POST', {
        capabilities: {
            firstMatch: [wdaCaps],
            alwaysMatch: {},
        },
    });`;

// No shared timeout changes. The pinned proxy snapshots its ordinary 5000ms
// timeout in requestConfig; this lease changes exactly one HTTP request only.
export const WDA_STARTUP_BLOCK = `    const startupProxy = driver.wda.jwproxy;
    const startupRequest = startupProxy?.request;
    const startupDescriptor = startupProxy && Object.getOwnPropertyDescriptor(startupProxy, 'request');
    const startupScopeError = () => new Error('TESTLANE_WDA_STARTUP_SCOPE_REFUSED');
    if (!startupProxy || typeof startupRequest !== 'function' || startupProxy.timeout !== 5000 ||
        driver.opts.wdaConnectionTimeout !== 5000 || driver.opts.commandTimeouts != null ||
        !Array.isArray(startupProxy._activeRequests) || startupProxy._activeRequests.length !== 0) throw startupScopeError();
    const startupUrl = startupProxy.getUrlForProxy('/session', 'POST');
    const startupAddress = new URL(startupUrl);
    if (startupAddress.protocol !== 'http:' || startupAddress.hostname !== '127.0.0.1' ||
        startupAddress.pathname !== '/session' || startupAddress.search || startupAddress.hash ||
        startupAddress.username || startupAddress.password || Number(startupAddress.port) < 1024) throw startupScopeError();
    let startupAttempted = false;
    const startupGuard = function (requestConfig) {
        if (this !== startupProxy || startupAttempted || !requestConfig || requestConfig.url !== startupUrl ||
            requestConfig.method !== 'POST' || requestConfig.timeout !== 5000) throw startupScopeError();
        startupAttempted = true;
        return startupRequest.call(startupProxy, { ...requestConfig, timeout: 30000 });
    };
    Object.defineProperty(startupProxy, 'request', { value: startupGuard, configurable: true, writable: true });
    try {
        await driver.proxyCommand('/session', 'POST', {
            capabilities: { firstMatch: [wdaCaps], alwaysMatch: {} },
        });
        if (!startupAttempted || driver.wda.jwproxy !== startupProxy || startupProxy.timeout !== 5000) throw startupScopeError();
    } finally {
        const startupUnchanged = startupProxy.request === startupGuard;
        if (startupDescriptor) Object.defineProperty(startupProxy, 'request', startupDescriptor);
        else delete startupProxy.request;
        if (!startupUnchanged) throw startupScopeError();
    }`;

export function patchedWdaStartup(source) {
  if (!Buffer.isBuffer(source) || hash(source) !== SOURCE_SHA256) throw fail();
  const text = source.toString('utf8');
  if (text.split(ORIGINAL).length !== 2) throw fail();
  return Buffer.from(text.replace(ORIGINAL, WDA_STARTUP_BLOCK));
}

// Computed from the exact npm-published startup.js plus the block above. Consumers
// bind these primitive facts rather than accepting arbitrary patch descriptions.
export const WDA_STARTUP_PATCH = Object.freeze({
  schemaVersion: 1, kind: 'testlane-owned-wda-startup-transport', xcuitest: '12.19.1',
  webdriveragent: '16.16.3', baseDriver: '10.8.1', ordinaryTimeoutMs: 5000, startupTimeoutMs: 30000,
  originalSha256: SOURCE_SHA256,
  patchedSha256: '29ef200f4b2939e1cf6921ec6413c65dac9ac08168e351fd340f88691b0e119b',
});

async function boundFile(root, file) {
  const full = path.join(root, file), info = await lstat(full), actual = await realpath(full);
  if (!info.isFile() || info.isSymbolicLink() || actual !== full) throw fail();
  return full;
}
async function inspect(toolsRoot) {
  if (typeof toolsRoot !== 'string' || !path.isAbsolute(toolsRoot) || /[\r\n\0]/.test(toolsRoot)) throw fail();
  const root = await realpath(toolsRoot);
  if (root !== toolsRoot || (await lstat(root)).isSymbolicLink()) throw fail();
  for (const [file, version] of [
    ['node_modules/appium-xcuitest-driver/package.json', '12.19.1'],
    ['node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/package.json', '16.16.3'],
    ['node_modules/appium-xcuitest-driver/node_modules/@appium/base-driver/package.json', '10.8.1'],
  ]) if (JSON.parse(await readFile(await boundFile(root, file), 'utf8')).version !== version) throw fail();
  for (const [file, expected] of Object.entries(PROXY_FILES)) if (hash(await readFile(await boundFile(root, file))) !== expected) throw fail();
  return await boundFile(root, STARTUP);
}

export async function applyPinnedWdaStartupPatch({ toolsRoot } = {}) {
  try {
    const target = await inspect(toolsRoot), patched = patchedWdaStartup(await readFile(target));
    if (hash(patched) !== WDA_STARTUP_PATCH.patchedSha256) throw fail();
    await writeFile(target, patched);
    return await verifyPinnedWdaStartupPatch({ toolsRoot });
  } catch { throw fail(); }
}

export async function verifyPinnedWdaStartupPatch({ toolsRoot } = {}) {
  try {
    const target = await inspect(toolsRoot);
    if (hash(await readFile(target)) !== WDA_STARTUP_PATCH.patchedSha256) throw fail();
    return WDA_STARTUP_PATCH;
  } catch { throw fail(); }
}
