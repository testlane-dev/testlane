import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createNativeDriver, NativeDriverError, readIosRequestFailure } from '../driver.mjs';
import { IOS_DEVICE_SCOPE } from '../device-scope.mjs';

const binding = () => ({ schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome: '/Users/runner',
  deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
  udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) });

const caps = () => ({ platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': 'FA001122-3344-5566-7788-9900AABBCCDD',
  'appium:bundleId': 'dev.testlane.iosproof', 'appium:simulatorDevicesSetPath': '/Users/runner/Library/Developer/CoreSimulator/Devices',
  'appium:derivedDataPath': '/private/tmp/tld-ios-abc123/derived-data', 'appium:wdaLocalPort': 8211, 'appium:wdaRemotePort': 8211, 'appium:mjpegServerPort': 8212,
  'appium:wdaBindingIP': '127.0.0.1', 'appium:wdaBaseUrl': 'http://127.0.0.1', 'appium:skipLogCapture': true,
  'appium:showIOSLog': false, 'appium:showXcodeLog': false, 'appium:printPageSourceOnFindFailure': false,
  'appium:disableAutomaticScreenshots': true, 'appium:shutdownOtherSimulators': false, 'appium:resetLocationService': false, 'appium:noReset': true });

test('fixed request facts distinguish ownership, HTTP and response deadlines with permanent pending-owner fencing', async t => {
  const originalTimer=globalThis.setTimeout,originalClear=globalThis.clearTimeout,active=new Map();
  let now=0,mode,testing=false,owners=0,entered,gate;const routes=[];
  const secret=randomBytes(32).toString('base64url'),session='session-'+randomBytes(16).toString('hex');
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>{const handle=originalTimer(callback,milliseconds,...args);active.set(handle,{callback,milliseconds});return handle;});
  t.mock.method(globalThis,'clearTimeout',handle=>{active.delete(handle);originalClear(handle);});
  t.mock.method(globalThis,'fetch',async(url)=>{
    const route=new URL(url).pathname;routes.push(route);
    if(testing&&route.endsWith('/element')){
      if(mode==='http'){entered.resolve();return gate.promise;}
      if(mode==='response')return {ok:true,status:200,body:{getReader(){entered.resolve();return {read(){return gate.promise;}};}}};
      if(mode==='command-error')return new Response(JSON.stringify({value:{error:secret,message:secret}}),{status:500});
    }
    return new Response(JSON.stringify({value:route==='/session'?{sessionId:session}:route.endsWith('/context')?'NATIVE_APP':null}));
  });
  for(mode of ['ownership','http','response','command-error','cancelled']){
    now=0;testing=false;owners=0;routes.length=0;entered=Promise.withResolvers();gate=Promise.withResolvers();
    const phase=new AbortController();
    const driver=await createNativeDriver({deviceBinding:binding(),url:'http://127.0.0.1:4723',capabilities:caps(),assertOwned:()=>{
      if(testing&&++owners===2&&['ownership','cancelled'].includes(mode)){entered.resolve();return gate.promise;}return true;
    }});
    testing=true;let failure;
    const rejected=assert.rejects(driver.withSignal(phase.signal).click('anonymous-check'),error=>{failure=error;return true;});
    if(mode!=='command-error'){
      await entered.promise;
      if(mode==='cancelled')phase.abort();
      else {const deadline=[...active.values()][0],budget=mode==='ownership'?5000:10000;assert.equal(deadline.milliseconds,budget);now+=budget+1;deadline.callback();}
    }
    await rejected;
    assert.equal(failure.code,mode==='command-error'?'NATIVE_DRIVER_COMMAND_FAILED':mode==='cancelled'?'NATIVE_DRIVER_CANCELLED':mode==='ownership'?'NATIVE_DRIVER_TIMEOUT':'NATIVE_DRIVER_ELEMENT_TIMEOUT');
    const fact=readIosRequestFailure(failure);
    assert.deepEqual(fact,{operation:'element-find',phase:['ownership','cancelled'].includes(mode)?'ownership':mode==='http'?'http':'response'});
    assert.equal(Object.isFrozen(fact),true);
    for(const value of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),session])assert.equal(JSON.stringify(fact).includes(value),false);
    if(['ownership','cancelled'].includes(mode))assert.equal(routes.some(route=>route.endsWith('/element')),false,'failed ownership cannot send the element request');
    const beforeClose=routes.length,ownerCount=owners;testing=false;
    if(['ownership','cancelled'].includes(mode)) {
      await assert.rejects(driver.close(),{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED'});
      await assert.rejects(driver.click('anonymous-check'),{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED'});
      assert.equal(routes.length,beforeClose);assert.equal(owners,ownerCount);
    } else {
      await driver.close();await driver.close();
      assert.equal(routes.length,beforeClose+1);assert.equal(routes.at(-1),'/session/'+session);
    }
    gate.resolve(mode==='http'?new Response(JSON.stringify({value:secret})):mode==='response'?{done:false,value:Buffer.from(secret)}:true);
    await Promise.resolve();await Promise.resolve();
    if(['ownership','cancelled'].includes(mode)) {
      await assert.rejects(driver.close(),{code:'NATIVE_DRIVER_OWNERSHIP_REFUSED'});
      assert.equal(owners,ownerCount,'a late ownership ACK cannot permit a fresh guard or DELETE');
    }
    assert.equal(routes.length,beforeClose+(['ownership','cancelled'].includes(mode)?0:1),'a late callback/HTTP response cannot revive the failed operation');
    assert.equal(active.size,0,'all request and owner timers are cleared');
  }
});
async function fixture() {
  const calls = [], secret = randomBytes(32).toString('base64url');
  let context = 'NATIVE_APP', keyboard = true, shown = true, failClick = false, oversized = false, malformed = false, missing = 0, clearGate;
  let dismissPending = false, persistKeyboard = false, dismissPolls = 0, keyboardReadHook;
  let snapshotAfter = 0, gestureCount = 0, gestureHook;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    calls.push({ method: request.method, path: request.url, body });
    let value = null, status = 200;
    if (request.url === '/session') value = { sessionId: 'owned-ios-session', capabilities: { private: secret } };
    else if (request.url.endsWith('/context')) value = context;
    else if (request.url.endsWith('/element')) {
      if (gestureCount < snapshotAfter || missing-- > 0) { status = 404; value = { error: 'no such element', message: secret }; }
      else value = { 'element-6066-11e4-a52e-4f735466cecf': body?.value === 'dismiss-keyboard' ? 'owned-keyboard-dismiss' : 'owned-element' };
    } else if (request.url.endsWith('/displayed')) value = shown;
    else if (request.url.endsWith('/window/rect')) value = { x: 0, y: 0, width: 400, height: 800 };
    else if (request.url.endsWith('/rect')) value = { x: 10, y: 1000, width: 200, height: 40 };
    else if (request.url.endsWith('/actions')) { shown = true; gestureCount++; gestureHook?.(); }
    else if (request.url.endsWith('/attribute/value')) value = secret;
    else if (request.url.endsWith('/text')) value = 'accessibility-identifier';
    else if (request.url.endsWith('/is_keyboard_shown')) {
      if (dismissPending && !persistKeyboard && ++dismissPolls >= 2) keyboard = false;
      value = keyboard; keyboardReadHook?.(dismissPending);
    }
    else if (request.url.endsWith('/hide_keyboard')) keyboard = false;
    else if (request.url.endsWith('/element/owned-keyboard-dismiss/click')) dismissPending = true;
    else if (request.url.endsWith('/clear') && clearGate) {
      response.once('close', clearGate.closed.resolve); clearGate.entered.resolve(); return;
    }
    else if (request.url.endsWith('/click') && oversized) value = secret.repeat(3000);
    else if (request.url.endsWith('/click') && malformed) { response.writeHead(200); response.end(secret); return; }
    else if (request.url.endsWith('/click') && failClick) { status = 500; value = { error: 'unknown error', message: secret, stacktrace: Buffer.from(secret).toString('base64') }; }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, calls, secret,
    setContext(value) { context = value; }, offscreen() { shown = false; }, failClick() { failClick = true; }, oversized() { oversized = true; }, missing(value) { missing = value; },
    malformed() { malformed = true; },
    keepKeyboardShown() { persistKeyboard = true; }, onKeyboardRead(callback) { keyboardReadHook = callback; },
    absentUntilSwipes(count) { snapshotAfter = count; }, onGesture(callback) { gestureHook = callback; },
    hangClear() { clearGate = { entered: Promise.withResolvers(), closed: Promise.withResolvers() }; return { entered: clearGate.entered.promise, closed: clearGate.closed.promise }; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('iOS driver uses exact owned Simulator caps, value observations and bounded W3C touch actions only', async () => {
  const appium = await fixture(); let checks = 0;
  try {
    const requested = caps(), driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: requested, assertOwned: () => { checks++; return true; } });
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:isHeadless'], true);
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:wdaStartupRetries'], 1);
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:wdaConnectionTimeout'], 5000);
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:forceAppLaunch'], false);
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:shouldTerminateApp'], false);
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:usePrebuiltWDA'], true);
    assert.equal(appium.calls[0].body.capabilities.alwaysMatch['appium:simulatorDevicesSetPath'], binding().deviceSetPath);
    assert.equal(JSON.stringify(appium.calls[0].body).includes('deviceBinding'), false, 'descriptor is never forwarded as an Appium capability');
    assert.equal(Object.hasOwn(requested, 'appium:isHeadless'), false, 'headless mode does not mutate caller capabilities');
    assert.equal(driver.context, 'NATIVE_APP'); assert.equal(driver.sessionId, undefined);
    assert.equal(await driver.text('request-total'), appium.secret);
    assert.equal(appium.calls.some(call => call.path.endsWith('/text')), false, 'explicit accessibility value precedes an identifier label');
    appium.offscreen(); await driver.click('create-request');
    await driver.type('quantity', '3'); await driver.hideKeyboard(); await driver.hideKeyboard(); await driver.close(); await driver.close();
    const gestures = appium.calls.filter(call => call.path.endsWith('/actions'));
    assert.equal(gestures.length, 1); assert.equal(gestures[0].body.actions[0].parameters.pointerType, 'touch');
    assert.equal(gestures[0].body.actions[0].actions.length, 5);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/hide_keyboard')).length, 1);
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 1); assert.ok(checks >= appium.calls.length);
    assert.equal(appium.calls.some(call => /screenshot|source|logcat|execute|simctl|shell/.test(call.path)), false);
  } finally { await appium.close(); }
});

test('a target absent from the initial accessibility snapshot can be found by one bounded native swipe', async () => {
  const appium = await fixture();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true });
    appium.absentUntilSwipes(1); await driver.click('anonymous-check');
    assert.equal(appium.calls.filter(call => call.path.endsWith('/actions')).length, 1);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element')).length, 2);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/click')).length, 1);
    assert.equal(appium.calls.some(call => /screenshot|source|execute|shell|logcat/.test(call.path)), false);
    await driver.close();
  } finally { await appium.close(); }
});

test('snapshot-absent search changes direction and is limited to six swipes without replaying the requested action', async () => {
  for (const count of [3, Infinity]) {
    const appium = await fixture();
    try {
      const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true });
      appium.absentUntilSwipes(count);
      if (count === Infinity) await assert.rejects(driver.click('selected-id'), { code: 'NATIVE_DRIVER_ELEMENT_TIMEOUT' });
      else await driver.click('selected-id');
      const gestures = appium.calls.filter(call => call.path.endsWith('/actions'));
      assert.equal(gestures.length, count === Infinity ? 6 : count);
      assert.deepEqual(gestures.slice(0, 3).map(call => call.body.actions[0].actions[0].y), [600, 200, 200]);
      assert.equal(appium.calls.filter(call => call.path.endsWith('/window/rect')).length, 1);
      assert.equal(appium.calls.filter(call => call.path.endsWith('/click')).length, count === Infinity ? 0 : 1);
      await driver.close();
    } finally { await appium.close(); }
  }
});

test('visibility lookup and gestures share one absolute ten-second window with five-second HTTP phases', async t => {
  let now = 0, searching = false; const calls = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname; calls.push(route);
    if (searching && route.endsWith('/context')) now += now === 0 ? 1000 : 2000;
    if (searching && route.endsWith('/element')) { now += 3000; return new Response(JSON.stringify({ value: { error: 'no such element' } }), { status: 404 }); }
    if (searching && route.endsWith('/window/rect')) now += 3000;
    if (searching && route.endsWith('/actions')) now += 1001;
    const value = route === '/session' ? { sessionId: 'owned-ios-session' } : route.endsWith('/context') ? 'NATIVE_APP' :
      route.endsWith('/window/rect') ? { x: 0, y: 0, width: 400, height: 800 } : null;
    return new Response(JSON.stringify({ value }));
  });
  const driver = await createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(), assertOwned: () => true });
  searching = true;
  await assert.rejects(driver.click('anonymous-check'), { code: 'NATIVE_DRIVER_ELEMENT_TIMEOUT' });
  assert.equal(calls.filter(route => route.endsWith('/actions')).length, 1);
  assert.equal(calls.filter(route => route.endsWith('/element')).length, 1, 'an expired visibility window cannot start another lookup');
  assert.equal(calls.some(route => route.endsWith('/click')), false);
  searching = false; await driver.close();
});

test('phase cancellation during a visibility swipe prevents another lookup and the requested action', async () => {
  const appium = await fixture(), run = new AbortController(), phase = new AbortController();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), signal: run.signal, assertOwned: () => true });
    appium.absentUntilSwipes(Infinity); appium.onGesture(() => phase.abort());
    await assert.rejects(driver.withSignal(phase.signal).click('anonymous-check'), { code: 'NATIVE_DRIVER_CANCELLED' });
    assert.equal(appium.calls.filter(call => call.path.endsWith('/actions')).length, 1);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element')).length, 1);
    assert.equal(appium.calls.some(call => call.path.endsWith('/click')), false);
    assert.equal(run.signal.aborted, false); await driver.close();
  } finally { await appium.close(); }
});

test('configured app-owned keyboard dismissal clicks exactly once then observes hidden state without the WDA hide command', async () => {
  const appium = await fixture();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true, keyboardDismissId: 'dismiss-keyboard' });
    await driver.hideKeyboard(); await driver.hideKeyboard();
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element/owned-keyboard-dismiss/click')).length, 1);
    assert.deepEqual(appium.calls.filter(call => call.path.endsWith('/element')).map(call => call.body.value), ['dismiss-keyboard']);
    assert.ok(appium.calls.filter(call => call.path.endsWith('/is_keyboard_shown')).length >= 3, 'observe delayed dismissal instead of assuming the click worked');
    assert.equal(appium.calls.some(call => call.path.endsWith('/hide_keyboard')), false);
    await driver.close();
  } finally { await appium.close(); }
});

test('a keyboard that remains visible fails within its fixed observation budget without replaying the dismissal action', async () => {
  const appium = await fixture();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true, keyboardDismissId: 'dismiss-keyboard' });
    appium.keepKeyboardShown(); const started = Date.now();
    await assert.rejects(driver.hideKeyboard(), { code: 'NATIVE_DRIVER_TIMEOUT' });
    assert.ok(Date.now() - started < 6500);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element/owned-keyboard-dismiss/click')).length, 1);
    assert.equal(appium.calls.some(call => call.path.endsWith('/hide_keyboard')), false);
    await driver.close();
  } finally { await appium.close(); }
});

test('keyboard dismissal honors cancellation before any action and during its read-only confirmation', async () => {
  const appium = await fixture(), run = new AbortController(), body = new AbortController(), alreadyStopped = new AbortController();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true,
      signal: run.signal, keyboardDismissId: 'dismiss-keyboard' });
    alreadyStopped.abort(); const before = appium.calls.length;
    await assert.rejects(driver.withSignal(alreadyStopped.signal).hideKeyboard(), { code: 'NATIVE_DRIVER_CANCELLED' });
    assert.equal(appium.calls.length, before);
    appium.onKeyboardRead(pending => { if (pending) body.abort(); });
    await assert.rejects(driver.withSignal(body.signal).hideKeyboard(), { code: 'NATIVE_DRIVER_CANCELLED' });
    assert.equal(run.signal.aborted, false);
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element/owned-keyboard-dismiss/click')).length, 1);
    assert.equal(appium.calls.some(call => call.path.endsWith('/hide_keyboard')), false);
    await driver.close();
  } finally { await appium.close(); }
});

test('invalid app-owned keyboard control identifiers are refused before HTTP', async () => {
  const appium = await fixture();
  try {
    for (const keyboardDismissId of ['', 'x'.repeat(161), 'bad\nidentifier', null, {}, 1]) {
      await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true, keyboardDismissId }),
        { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' });
    }
    assert.equal(appium.calls.length, 0);
  } finally { await appium.close(); }
});

test('real devices, global paths/lifecycle, signing, WebViews and missing privacy/ownership are refused before HTTP', async () => {
  const appium = await fixture();
  try {
    for (const mutate of [c => { c['appium:udid'] = 'a'.repeat(40); }, c => { c['appium:simulatorDevicesSetPath'] = '/Users/me/Library/Developer/CoreSimulator/Devices'; },
      c => { c['appium:derivedDataPath'] = '/tmp/elsewhere'; }, c => { c['appium:derivedDataPath'] += '/../outside'; },
      c => { c['appium:shutdownOtherSimulators'] = true; }, c => { c['appium:resetLocationService'] = true; },
      c => { c['appium:showXcodeLog'] = true; }, c => { c['appium:skipLogCapture'] = false; }, c => { c['appium:disableAutomaticScreenshots'] = false; },
      c => { c['appium:printPageSourceOnFindFailure'] = true; }, c => { c['appium:wdaBindingIP'] = '0.0.0.0'; },
      c => { c['appium:wdaRemotePort']++; }, c => { c.browserName = 'Safari'; }, c => { c['appium:autoWebview'] = true; },
      c => { c['appium:mjpegServerPort'] = c['appium:wdaLocalPort']; }, c => { c['appium:isHeadless'] = false; },
      c => { c['appium:wdaStartupRetries'] = 2; }, c => { c['appium:wdaStartupRetries'] = 0; },
      c => { c['appium:wdaConnectionTimeout'] = 30000; }, c => { c['appium:forceAppLaunch'] = true; }, c => { c['appium:shouldTerminateApp'] = true; },
      c => { c['appium:usePrebuiltWDA'] = false; }, c => { c['appium:useXctestrunFile'] = true; }, c => { c['appium:prebuiltWDAPath'] = '/arbitrary.app'; },
      c => { c['appium:webDriverAgentUrl'] = 'http://example.test'; }, c => { c['appium:keychainPath'] = '/private/keychain'; },
      c => { c['appium:processArguments'] = { args: ['private'] }; }, c => { c['appium:app'] = '/arbitrary.app'; }]) {
      const capabilities = caps(); mutate(capabilities);
      await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities, assertOwned: () => true }), { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' });
    }
    await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps() }), { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' });
    await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: 'https://example.test', capabilities: caps(), assertOwned: () => true }), { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' });
    assert.equal(appium.calls.length, 0);
  } finally { await appium.close(); }
});

test('a hosted-set descriptor must match every scoped capability and cannot replace live parent authority', async () => {
  const appium = await fixture();
  try {
    for (const deviceBinding of [undefined, { ...binding(), scope: 'arbitrary-external-set' }, { ...binding(), nonce: 'z'.repeat(24) },
      { ...binding(), udid: '12345678-1234-1234-1234-123456789ABC' }, { ...binding(), privateRoot: '/private/tmp/tld-ios-elsewhere' },
      { ...binding(), deviceSetPath: '/Users/runner/elsewhere' }, { ...binding(), extra: true }]) {
      await assert.rejects(createNativeDriver({ deviceBinding, url: appium.url, capabilities: caps(), assertOwned: () => true }), { code: 'NATIVE_DRIVER_CONFIGURATION_INVALID' });
    }
    await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => false }), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    assert.equal(appium.calls.length, 0);
  } finally { await appium.close(); }
});

test('iOS requires actual NATIVE_APP at creation/actions and still closes a refused session', async () => {
  const appium = await fixture();
  try {
    appium.setContext('WEBVIEW-private');
    await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true }), { code: 'NATIVE_DRIVER_CONTEXT_REFUSED' });
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 1);
    appium.setContext('NATIVE_APP'); const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true });
    appium.setContext('WEBVIEW-private'); await assert.rejects(driver.click('save'), { code: 'NATIVE_DRIVER_CONTEXT_REFUSED' });
    assert.equal(appium.calls.some(call => call.path.endsWith('/click')), false); await driver.close();
  } finally { await appium.close(); }
});

test('iOS setup readiness polls read-only presence while cancellation leaves independently bounded close available', async () => {
  const appium = await fixture(), controller = new AbortController();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), signal: controller.signal, assertOwned: () => true });
    appium.missing(2); await driver.waitFor('session-status');
    assert.equal(appium.calls.filter(call => call.path.endsWith('/element')).length, 3);
    assert.equal(appium.calls.some(call => call.path.endsWith('/click') || call.path.endsWith('/actions')), false);
    controller.abort(); await assert.rejects(driver.click('save'), { code: 'NATIVE_DRIVER_CANCELLED' }); await driver.close();
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 1);
  } finally { await appium.close(); }
});

async function promptly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('UNIT_PHASE_DID_NOT_SETTLE')), 2000); })]); }
  finally { clearTimeout(timer); }
}

test('an iOS body abort after semantic dispatch quarantines fresh native cleanup and session close', async () => {
  const appium = await fixture(), run = new AbortController(), body = new AbortController(), cleanup = new AbortController();
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), signal: run.signal, assertOwned: () => true });
    const active = driver.withSignal(body.signal), blocked = appium.hangClear();
    const operation = (async () => { await active.type('quantity', '3'); await active.click('create-request'); })();
    const refused = assert.rejects(operation, { code: 'NATIVE_DRIVER_CANCELLED' });
    await promptly(blocked.entered); body.abort(); await promptly(refused); await promptly(blocked.closed);
    assert.equal(run.signal.aborted, false);
    assert.equal(appium.calls.some(call => call.path.endsWith('/value') || call.path.endsWith('/click')), false);
    const count = appium.calls.length;
    await assert.rejects(active.withSignal(cleanup.signal).click('create-request'), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
    assert.equal(appium.calls.length, count, 'a nested facade cannot revive a cancelled body');
    await assert.rejects(driver.withSignal(cleanup.signal).waitFor('session-status'), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
    await assert.rejects(active.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
    assert.equal(appium.calls.length, count); assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 0);
    assert.throws(() => driver.withSignal({}), { code: 'NATIVE_DRIVER_INPUT_INVALID' });
  } finally { await appium.close(); }
});

test('iOS phase cancellation interrupts ownership inspection before it can send another command', async () => {
  const appium = await fixture(), run = new AbortController(), body = new AbortController(), owner = Promise.withResolvers(), entered = Promise.withResolvers();
  let blocked = false;
  try {
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), signal: run.signal,
      assertOwned: () => { if (!blocked) return true; entered.resolve(); return owner.promise; } });
    blocked = true;
    const count = appium.calls.length, refused = assert.rejects(driver.withSignal(body.signal).click('save'), { code: 'NATIVE_DRIVER_CANCELLED' });
    await promptly(entered.promise); body.abort(); await promptly(refused);
    assert.equal(run.signal.aborted, false); assert.equal(appium.calls.length, count);
    await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    blocked = false; owner.resolve(true); await Promise.resolve(); await Promise.resolve();
    await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    assert.equal(appium.calls.filter(call => call.method === 'DELETE').length, 0);
  } finally { owner.resolve(true); await appium.close(); }
});

test('iOS raw server and parent failures never enter fixed driver errors', async () => {
  const appium = await fixture();
  try {
    await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => { throw new Error(appium.secret); } }), { code: 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true }); appium.failClick();
    await assert.rejects(driver.click('save'), error => {
      assert.ok(error instanceof NativeDriverError); assert.equal(error.code, 'NATIVE_DRIVER_COMMAND_FAILED');
      for (const value of [appium.secret, encodeURIComponent(appium.secret), Buffer.from(appium.secret).toString('base64')]) assert.equal(String(error.stack).includes(value), false);
      return true;
    }); await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' });
  } finally { await appium.close(); }
});

test('iOS rejects oversized and malformed native responses', async () => {
  for (const mode of ['oversized', 'malformed']) {
    const appium = await fixture();
    try {
      const driver = await createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), assertOwned: () => true }); appium[mode]();
      await assert.rejects(driver.click('save'), { code: 'NATIVE_DRIVER_RESPONSE_INVALID' });
      const count = appium.calls.length; await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' }); assert.equal(appium.calls.length, count);
    } finally { await appium.close(); }
  }
});

test('iOS pre-cancelled setup does not contact Appium or the parent controller', async () => {
  const appium = await fixture(), controller = new AbortController(); controller.abort(); let calls = 0;
  try {
    await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: appium.url, capabilities: caps(), signal: controller.signal,
      assertOwned: () => { calls++; return true; } }), { code: 'NATIVE_DRIVER_CANCELLED' });
    assert.equal(appium.calls.length, 0); assert.equal(calls, 0);
  } finally { await appium.close(); }
});

test('iOS rejects a successful session response delivered after its monotonic deadline', async t => {
  let now = 0; const routes = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    routes.push(new URL(url).pathname); now = 240_001;
    return new Response(JSON.stringify({ value: { sessionId: 'late-owned-session' } }));
  });
  await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(), assertOwned: () => true }), { code: 'NATIVE_DRIVER_SESSION_TIMEOUT' });
  assert.deepEqual(routes, ['/session'], 'a late response cannot start native actions or invent an addressable session');
});

test('iOS cancellation settles even if an underlying HTTP promise ignores abort', async t => {
  const entered = Promise.withResolvers(), controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); return new Promise(() => {}); });
  const rejected = assert.rejects(createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(), signal: controller.signal, assertOwned: () => true }), { code: 'NATIVE_DRIVER_CANCELLED' });
  await promptly(entered.promise); controller.abort(); await promptly(rejected);
});

test('iOS cold WDA setup alone gets 240 seconds and fixed session/context/readiness timeouts retain no payload', async t => {
  const originalTimer = globalThis.setTimeout, originalClear = globalThis.clearTimeout, active = new Map(), calls = [];
  const secret = randomBytes(32).toString('base64url'); let hangAt;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    const handle = originalTimer(callback, milliseconds, ...args); active.set(handle, { callback, milliseconds }); return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => { active.delete(handle); originalClear(handle); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname, deadline = [...active.values()][0];
    assert.equal(active.size, 1, 'ownership timer is cleared before the bounded HTTP request');
    calls.push({ route, milliseconds: deadline.milliseconds });
    if (route.endsWith(hangAt)) return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
      queueMicrotask(deadline.callback); // Exercise the real deadline without a four-minute sleep.
    });
    const value = route === '/session' ? { sessionId: 'owned-ios-session' } : route.endsWith('/context') ? 'NATIVE_APP' :
      route.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'owned-element' } : route.endsWith('/displayed') ? true : null;
    return new Response(JSON.stringify({ value }), { headers: { 'Content-Type': 'application/json' } });
  });
  for (const [stage, code] of [['/session', 'NATIVE_DRIVER_SESSION_TIMEOUT'], ['/context', 'NATIVE_DRIVER_CONTEXT_TIMEOUT'],
    ['/element', 'NATIVE_DRIVER_READINESS_TIMEOUT'], ['/click', 'NATIVE_DRIVER_TIMEOUT']]) {
    let driver; hangAt = stage;
    const operation = async () => {
      driver = await createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(), assertOwned: () => true });
      if (stage === '/element') await driver.waitFor('session-status'); else if (stage === '/click') await driver.click('save');
    };
    try {
      await assert.rejects(operation(), error => {
        assert.equal(error.code, code);
        for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(String(error.stack).includes(value), false);
        return true;
      });
    } finally { if (driver) { if (stage === '/click') await assert.rejects(driver.close(), { code: 'NATIVE_DRIVER_REMOTE_UNSETTLED' }); else await driver.close(); } }
  }
  assert.ok(calls.some(call => call.route === '/session' && call.milliseconds > 239_900 && call.milliseconds <= 240_000));
  assert.ok(calls.some(call => call.route.endsWith('/click') && call.milliseconds > 9900 && call.milliseconds <= 10000)); assert.equal(calls.some(call => call.route !== '/session' && !/\/(click|context|element|displayed)$/.test(call.route) && call.milliseconds > 5000), false);
  assert.ok(calls.filter(call => /\/(context|element|displayed)$/.test(call.route)).every(call => call.milliseconds <= 10000));
  assert.ok(calls.find(call => call.route.endsWith('/context')).milliseconds <= 5000, 'the explicit setup-context allowance stays five seconds'); assert.equal(active.size, 0);
});

test('iOS setup accepts one seven-second logical ownership stabilization then performs a fresh ordinary context guard', async t => {
  let now = 0, owners = 0; const routes = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    const route = new URL(url).pathname; routes.push(route);
    if (route === '/session') now = 90000;
    return new Response(JSON.stringify({ value: route === '/session' ? { sessionId: 'owned-ios-session' } : route.endsWith('/context') ? 'NATIVE_APP' : null }));
  });
  const driver = await createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(),
    assertOwned: () => { if (++owners === 2) now += 7000; return true; } });
  assert.equal(owners, 3, 'initial guard, one stabilization, then a fresh context guard');
  assert.deepEqual(routes, ['/session', '/session/owned-ios-session/context']);
  await driver.close(); assert.equal(owners, 4);
});

test('iOS setup shares its original 240-second deadline and retains a known session without sending later HTTP', async t => {
  let now = 0, owners = 0; const routes = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => { routes.push(new URL(url).pathname); now = 239000;
    return new Response(JSON.stringify({ value: { sessionId: 'owned-ios-session' } })); });
  await assert.rejects(createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(),
    assertOwned: () => { if (++owners === 2) now += 1001; return true; } }), { code: 'NATIVE_DRIVER_SESSION_TIMEOUT' });
  assert.equal(owners, 2); assert.deepEqual(routes, ['/session']);
});

test('iOS failed setup stabilization permanently fences late ACKs, fresh guards and deletion', async t => {
  let now = 0, expire, routes; const originalTimer = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { if (ms === 20000) expire = fn; return originalTimer(fn, ms, ...args); });
  t.mock.method(globalThis, 'fetch', async url => { routes.push(new URL(url).pathname); return new Response(JSON.stringify({ value: { sessionId: 'owned-ios-session' } })); });
  for (const mode of ['timeout', 'cancelled', 'rejected']) {
    now = 0; routes = []; const entered = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController(); let owners = 0;
    const rejected = assert.rejects(createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(), signal: controller.signal,
      assertOwned: () => { if (++owners === 2) { entered.resolve(); return gate.promise; } return true; } }),
    { code: mode === 'cancelled' ? 'NATIVE_DRIVER_CANCELLED' : 'NATIVE_DRIVER_OWNERSHIP_REFUSED' });
    await entered.promise;
    if (mode === 'timeout') { now = 20000; expire(); } else if (mode === 'cancelled') controller.abort(); else gate.reject(Error('private-callback-value'));
    await rejected; gate.resolve(true); await Promise.resolve(); await Promise.resolve();
    assert.equal(owners, 2); assert.deepEqual(routes, ['/session']);
  }
});

test('an unconfirmed initial context guard also fences setup cleanup while its late ACK remains pending', async t => {
  const controller = new AbortController(), gate = Promise.withResolvers(), entered = Promise.withResolvers(), routes = []; let owners = 0;
  t.mock.method(globalThis, 'fetch', async url => { routes.push(new URL(url).pathname); return new Response(JSON.stringify({ value: { sessionId: 'owned-ios-session' } })); });
  const rejected = assert.rejects(createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(), signal: controller.signal,
    assertOwned: () => { if (++owners === 3) { entered.resolve(); return gate.promise; } return true; } }), { code: 'NATIVE_DRIVER_CANCELLED' });
  await entered.promise; controller.abort(); await rejected;
  gate.resolve(true); await Promise.resolve(); await Promise.resolve();
  assert.equal(owners, 3); assert.deepEqual(routes, ['/session']);
});
