import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createNativeDriver, NativeDriverError } from '../driver.mjs';

const caps = () => ({ platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': 'emulator-5556',
  'appium:appPackage': 'com.testlane.nativeproof', 'appium:remoteAdbHost': '127.0.0.1', 'appium:adbPort': 5039, 'appium:systemPort': 8211,
  'appium:skipLogcatCapture': true, 'appium:suppressKillServer': true, 'appium:printPageSourceOnFindFailure': false });
async function fixture() {
  const calls = [], secret = randomBytes(32).toString('base64url');
  let context = 'NATIVE_APP', keyboard = true, displayed = true, failClick = false, hangClick = false, oversizedClick = false, missingFinds = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    calls.push({ method: request.method, path: request.url, body });
    let value = null, status = 200;
    if (request.url === '/session') value = { sessionId: 'owned-session', capabilities: { private: secret } };
    else if (request.url.endsWith('/context')) value = context;
    else if (request.url.endsWith('/element')) {
      if (body?.using === '-android uiautomator') displayed = true;
      if (missingFinds-- > 0) { status = 404; value = { error: 'no such element', message: secret }; }
      else value = { 'element-6066-11e4-a52e-4f735466cecf': 'owned-element' };
    }
    else if (request.url.endsWith('/displayed')) value = displayed;
    else if (request.url.endsWith('/text')) value = request.url.includes('/attribute/') ? secret : '';
    else if (request.url.endsWith('/is_keyboard_shown')) value = keyboard;
    else if (request.url.endsWith('/hide_keyboard')) keyboard = false;
    else if (request.url.endsWith('/click') && hangClick) return;
    else if (request.url.endsWith('/click') && oversizedClick) value = secret.repeat(3000);
    else if (request.url.endsWith('/click') && failClick) { status = 500; value = { error: 'unknown error', message: secret, stacktrace: Buffer.from(secret).toString('base64') }; }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, calls, secret,
    changeContext(value) { context = value; }, failClick() { failClick = true; }, hangClick() { hangClick = true; },
    oversizedClick() { oversizedClick = true; }, missingFinds(count) { missingFinds = count; },
    offscreen() { displayed = false; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('thin native driver sends owned caps and exposes only fixed native metadata and intentional UI methods', async () => {
  const appium = await fixture(); let ownershipChecks = 0;
  try {
    const capabilities = caps();
    const driver = await createNativeDriver({ url: appium.url + '/', capabilities, assertOwned: () => { ownershipChecks++; } });
    assert.equal(driver.context, 'NATIVE_APP'); assert.equal(driver.sessionId, undefined);
    assert.deepEqual(appium.calls[0].body, { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } });
    assert.equal(await driver.text('saved-total'), appium.secret);
    await driver.type('request-marker', 'owned-demo-input'); await driver.click('save-request');
    await driver.hideKeyboard(); await driver.hideKeyboard(); await driver.close(); await driver.close();
    assert.equal(appium.calls.filter(call => call.path.endsWith('/hide_keyboard')).length, 1);
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 1);
    assert.ok(ownershipChecks >= appium.calls.length);
    assert.equal(appium.calls.some(call => /screenshot|source|logcat|execute|press_keycode/.test(call.path)), false);
  } finally { await appium.close(); }
});

test('driver refuses remote URLs, unspecified devices, browser contexts and missing privacy caps before network calls', async () => {
  const appium = await fixture();
  try {
    for (const mutate of [
      c => { delete c['appium:udid']; }, c => { c.browserName = 'Chrome'; }, c => { c['appium:autoWebview'] = true; },
      c => { c['appium:skipLogcatCapture'] = false; }, c => { c['appium:suppressKillServer'] = false; },
      c => { c['appium:printPageSourceOnFindFailure'] = true; }, c => { c['appium:remoteAdbHost'] = 'example.test'; },
      c => { c['appium:options'] = {}; },
    ]) { const capabilities = caps(); mutate(capabilities); await assert.rejects(createNativeDriver({ url: appium.url, capabilities }), { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' }); }
    for (const url of ['https://example.test', appium.url + '/wd/hub', appium.url + '?private=value']) {
      await assert.rejects(createNativeDriver({ url, capabilities: caps() }), { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' });
    }
    assert.equal(appium.calls.length, 0);
  } finally { await appium.close(); }
});

test('actual native context is checked at creation and before actions', async () => {
  const appium = await fixture();
  try {
    appium.changeContext('WEBVIEW_private');
    await assert.rejects(createNativeDriver({ url: appium.url, capabilities: caps() }), { code: 'NATIVE_DRIVER_CONTEXT_REFUSED' });
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 1);
    appium.changeContext('NATIVE_APP');
    const driver = await createNativeDriver({ url: appium.url, capabilities: caps() });
    appium.changeContext('WEBVIEW_private');
    await assert.rejects(driver.click('save'), { code: 'NATIVE_DRIVER_CONTEXT_REFUSED' });
    assert.equal(appium.calls.some(call => call.path.endsWith('/click')), false);
    await driver.close();
  } finally { await appium.close(); }
});

test('server error payloads and ownership callback errors become fixed driver errors', async () => {
  const appium = await fixture();
  try {
    await assert.rejects(createNativeDriver({ url: appium.url, capabilities: caps(), assertOwned: () => { throw new Error(appium.secret); } }), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    const driver = await createNativeDriver({ url: appium.url, capabilities: caps() }); appium.failClick();
    try { await driver.click('save'); assert.fail('must refuse'); }
    catch (error) {
      assert.ok(error instanceof NativeDriverError); assert.equal(error.code, 'NATIVE_DRIVER_COMMAND_FAILED');
      for (const value of [appium.secret, Buffer.from(appium.secret).toString('base64')]) assert.equal(String(error.stack).includes(value), false);
    }
    await driver.close();
  } finally { await appium.close(); }
});

test('aborted actions stop while bounded session cleanup remains available', async () => {
  const appium = await fixture(), controller = new AbortController();
  try {
    const driver = await createNativeDriver({ url: appium.url, capabilities: caps(), signal: controller.signal });
    controller.abort();
    await assert.rejects(driver.click('save'), { code: 'NATIVE_DRIVER_CANCELLED' });
    await driver.close();
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 1);
  } finally { await appium.close(); }
});

test('missing action elements use the bounded native scroll selector without retaining server messages', async () => {
  const appium = await fixture();
  try {
    const driver = await createNativeDriver({ url: appium.url, capabilities: caps() });
    appium.missingFinds(1); await driver.click('save');
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element')).length, 2);
    assert.equal(appium.calls.filter(call => call.body?.using === '-android uiautomator').length, 1);
    await driver.close();
  } finally { await appium.close(); }
});

test('initial native readiness polls presence before any action without scrolling or clicking', async () => {
  const appium = await fixture();
  try {
    const driver = await createNativeDriver({ url: appium.url, capabilities: caps() });
    appium.missingFinds(2);
    const before = Date.now(); await driver.waitFor('session-status');
    assert.ok(Date.now() - before >= 350 && Date.now() - before < 2000);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element')).length, 3);
    assert.equal(appium.calls.some(call => call.path.endsWith('/click') || call.body?.using === '-android uiautomator'), false);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/context')).length, 2);
    await driver.close();
  } finally { await appium.close(); }
});

test('offscreen actions scroll with a fixed native template and an escaped accessibility ID', async () => {
  const appium = await fixture();
  try {
    const driver = await createNativeDriver({ url: appium.url, capabilities: caps() });
    const id = 'save\"); privateCall(\"';
    appium.offscreen(); await driver.click(id);
    const selector = appium.calls.find(call => call.body?.using === '-android uiautomator').body.value;
    assert.equal(selector, 'new UiScrollable(new UiSelector().scrollable(true)).setMaxSearchSwipes(8).scrollIntoView(new UiSelector().description(' + JSON.stringify(id) + '))');
    assert.equal(appium.calls.filter(call => call.path.endsWith('/click')).length, 1);
    await driver.close();
  } finally { await appium.close(); }
});

test('native requests reject oversized payloads and bound an unresponsive command', async () => {
  for (const kind of ['oversized', 'timeout']) {
    const appium = await fixture();
    try {
      const driver = await createNativeDriver({ url: appium.url, capabilities: caps() });
      if (kind === 'oversized') appium.oversizedClick(); else appium.hangClick();
      const before = Date.now();
      await assert.rejects(driver.click('save'), { code: kind === 'oversized' ? 'NATIVE_DRIVER_RESPONSE_INVALID' : 'NATIVE_DRIVER_TIMEOUT' });
      assert.ok(Date.now() - before < 6500);
      await driver.close();
    } finally { await appium.close(); }
  }
});

test('fixed setup timeout categories distinguish cold session, context and initial readiness without extending actions', async t => {
  const originalTimer = globalThis.setTimeout;
  let currentDeadline, hangAt, secret = randomBytes(32).toString('base64url');
  const commands = [];
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    const timer = originalTimer(callback, milliseconds, ...args);
    currentDeadline = { callback, milliseconds };
    return timer;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    commands.push({ route, method: options.method, milliseconds: currentDeadline.milliseconds });
    if (route.endsWith(hangAt)) return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
      // Exercise the real driver's abort/catch path without waiting two minutes
      // or changing its production deadlines. No Appium/device is involved.
      const expire = currentDeadline.callback; queueMicrotask(expire);
    });
    const value = route === '/session' ? { sessionId: 'owned-session' } : route.endsWith('/context') ? 'NATIVE_APP' :
      route.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'owned-element' } : route.endsWith('/displayed') ? true : null;
    return new Response(JSON.stringify({ value }), { headers: { 'Content-Type': 'application/json' } });
  });
  for (const [stage, expected] of [['/session', 'NATIVE_DRIVER_SESSION_TIMEOUT'], ['/context', 'NATIVE_DRIVER_CONTEXT_TIMEOUT'],
    ['/element', 'NATIVE_DRIVER_READINESS_TIMEOUT'], ['/click', 'NATIVE_DRIVER_TIMEOUT']]) {
    let driver; hangAt = stage;
    try {
      if (stage === '/session' || stage === '/context') await assert.rejects(createNativeDriver({ url: 'http://127.0.0.1:4723', capabilities: caps() }), { code: expected });
      else {
        driver = await createNativeDriver({ url: 'http://127.0.0.1:4723', capabilities: caps() });
        await assert.rejects(stage === '/element' ? driver.waitFor('session-status') : driver.click('save'), error => {
          assert.equal(error.code, expected);
          for (const variant of [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]) assert.equal(String(error.stack).includes(variant), false);
          return true;
        });
      }
    } finally { if (driver) await driver.close(); }
  }
  assert.ok(commands.some(item => item.route === '/session' && item.milliseconds === 120_000));
  assert.equal(commands.some(item => item.route !== '/session' && item.milliseconds > 5000), false);
});
