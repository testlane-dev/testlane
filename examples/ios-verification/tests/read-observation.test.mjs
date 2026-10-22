import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNativeDriver, readIosRequestFailure, readIosRequestProgress } from '../driver.mjs';
import { IOS_DEVICE_SCOPE } from '../device-scope.mjs';

const binding = () => ({ schemaVersion: 1, scope: IOS_DEVICE_SCOPE, nativeHome: '/Users/runner',
  deviceSetPath: '/Users/runner/Library/Developer/CoreSimulator/Devices', privateRoot: '/private/tmp/tld-ios-abc123',
  udid: 'FA001122-3344-5566-7788-9900AABBCCDD', nonce: 'a'.repeat(24) });
const caps = () => ({ platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': binding().udid,
  'appium:bundleId': 'dev.testlane.iosproof', 'appium:simulatorDevicesSetPath': binding().deviceSetPath,
  'appium:derivedDataPath': binding().privateRoot + '/derived-data', 'appium:wdaLocalPort': 8211,
  'appium:wdaRemotePort': 8211, 'appium:mjpegServerPort': 8212, 'appium:wdaBindingIP': '127.0.0.1',
  'appium:wdaBaseUrl': 'http://127.0.0.1', 'appium:skipLogCapture': true, 'appium:showIOSLog': false,
  'appium:showXcodeLog': false, 'appium:printPageSourceOnFindFailure': false, 'appium:disableAutomaticScreenshots': true,
  'appium:shutdownOtherSimulators': false, 'appium:resetLocationService': false, 'appium:noReset': true });

function harness(t) {
  let now = 0, ownerHook, httpHook, ownerCount = 0;
  const routes = [], timers = new Map(), durations = [], session = 'session-' + randomBytes(12).toString('hex');
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    const handle = {}; timers.set(handle, { callback, milliseconds }); durations.push(milliseconds); return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => timers.delete(handle));
  const json = (value, status = 200) => new Response(JSON.stringify({ value }), { status });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname; routes.push({ route, method: options.method });
    const changed = httpHook?.(route, options); if (changed !== undefined) return changed;
    return json(route === '/session' ? { sessionId: session } : route.endsWith('/context') ? 'NATIVE_APP' :
      route.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'owned-element' } :
      route.endsWith('/displayed') ? true : null);
  });
  return { routes, timers, durations, json,
    advance(value) { now += value; }, now: () => now,
    owner(hook) { ownerHook = hook; }, http(hook) { httpHook = hook; }, ownerCount: () => ownerCount,
    expire() { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
    create(options = {}) { return createNativeDriver({ deviceBinding: binding(), url: 'http://127.0.0.1:4723', capabilities: caps(),
      assertOwned: () => { ownerCount++; return ownerHook ? ownerHook() : true; }, ...options }); },
  };
}

import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('read lookup observes a valid response after five seconds using only its remaining ten-second window', async t => {
  const h=harness(t),driver=await h.create();let owners=0,budget;
  h.owner(()=>{if(++owners===2)h.advance(445);return true;});
  h.http(route=>{if(route.endsWith('/element')){budget=[...h.timers.values()][0].milliseconds;h.advance(5200);}});
  await driver.scrollIntoView('approve-request');
  assert.equal(budget,9555);assert.equal(h.now(),5645);assert.equal(owners,3);
  assert.equal(h.routes.filter(row=>row.route.endsWith('/element')).length,1);
  assert.equal(h.routes.some(row=>/\/(click|clear|value|actions)$/.test(row.route)),false);
  await driver.close();
});

test('a delayed parsed proxy error is observed as command failure without raw text or a replay', async t => {
  const h=harness(t),driver=await h.create(),canary=randomBytes(24).toString('base64url');
  h.http(route=>{if(route.endsWith('/element')){h.advance(5200);return h.json({error:'unknown error',message:canary},500);}});
  await assert.rejects(driver.scrollIntoView('approve-request'),error=>{
    assert.equal(error.code,'NATIVE_DRIVER_COMMAND_FAILED');assert.deepEqual(readIosRequestFailure(error),{operation:'element-find',phase:'response'});
    assert.equal(readIosRequestProgress(error).responseHeadersObserved,true);assert.equal(String(error.stack).includes(canary),false);return true;
  });
  assert.equal(h.routes.filter(row=>row.route.endsWith('/element')).length,1);assert.equal(h.routes.some(row=>row.route.endsWith('/actions')),false);
  h.http(undefined);await driver.close();
});

test('slow settled ownership reduces the remaining read body allowance instead of granting a fresh ten seconds', async t => {
  const h=harness(t),driver=await h.create();let owners=0,budget;
  h.owner(()=>{if(++owners===4)h.advance(4700);return true;});
  h.http(route=>{if(route.endsWith('/attribute/value')){budget=[...h.timers.values()][0].milliseconds;h.advance(5299.999);return h.json('observed');}});
  assert.equal(await driver.text('selected-id'),'observed');assert.equal(budget,5300);assert.equal(h.now(),9999.999);
  await driver.close();
});

test('fractional late read headers and body reject at the unchanged aggregate without fallback reads', async t => {
  const h=harness(t);
  for(const mode of ['headers','body']){
    h.http(undefined);const driver=await h.create();
    h.http(route=>{if(!route.endsWith('/attribute/value'))return;
      if(mode==='headers'){h.advance(10000.001);return h.json('late');}
      return {ok:true,status:200,body:{getReader:()=>({read:async()=>{h.advance(10000.001);return {done:false,value:Buffer.from('{"value":"late"}')};}})}};
    });
    const routes=h.routes.length;await assert.rejects(driver.text('selected-id'),error=>{
      assert.equal(error.code,'NATIVE_DRIVER_TIMEOUT');assert.deepEqual(readIosRequestFailure(error),{operation:'value-read',phase:mode==='headers'?'http':'response'});
      const progress=readIosRequestProgress(error);assert.equal(progress.effectiveHttpBudgetMs,10000);assert.equal(progress.budgetSource,'request-total');assert.equal(progress.responseHeadersObserved,true);return true;
    });
    assert.equal(h.routes.slice(routes).filter(row=>row.route.endsWith('/attribute/value')).length,1);assert.equal(h.routes.slice(routes).some(row=>row.route.endsWith('/text')),false);
    h.http(undefined);await driver.close();
  }
});

test('a read after earlier visibility work is clipped by that original outer deadline and starts no next action', async t => {
  const h=harness(t),driver=await h.create();let owners=0,allowance;
  h.owner(()=>{if(++owners===2)h.advance(500);return true;});
  h.http(route=>{if(route.endsWith('/context'))h.advance(6000);if(route.endsWith('/element')){allowance=[...h.timers.values()][0].milliseconds;h.advance(3500.001);}});
  await assert.rejects(driver.click('approve-request'),error=>{
    assert.equal(error.code,'NATIVE_DRIVER_ELEMENT_TIMEOUT');assert.deepEqual(readIosRequestFailure(error),{operation:'element-find',phase:'http'});
    assert.equal(readIosRequestProgress(error).budgetSource,'caller-outer');return true;
  });
  assert.equal(allowance,3500);assert.equal(h.routes.filter(row=>row.route.endsWith('/element')).length,1);
  assert.equal(h.routes.some(row=>/\/(displayed|actions|click)$/.test(row.route)),false);
  h.owner(undefined);h.http(undefined);await driver.close();
});

test('cancelled read observation ignores a late response without adding queries or quarantining a semantic mutation', async t => {
  const h=harness(t),driver=await h.create(),phase=new AbortController(),entered=Promise.withResolvers(),gate=Promise.withResolvers();let failure;
  h.http(route=>{if(route.endsWith('/element')){entered.resolve();return gate.promise;}});
  const rejected=assert.rejects(driver.withSignal(phase.signal).scrollIntoView('approve-request'),error=>{failure=error;return error.code==='NATIVE_DRIVER_CANCELLED';});
  await entered.promise;h.advance(6000);phase.abort();await rejected;const routes=h.routes.length,owners=h.ownerCount(),snapshot=readIosRequestProgress(failure);
  assert.equal(snapshot.effectiveHttpBudgetMs,10000);assert.equal(snapshot.responseHeadersObserved,false);
  gate.resolve(h.json({'element-6066-11e4-a52e-4f735466cecf':'late-element'}));await Promise.resolve();await Promise.resolve();
  assert.equal(h.routes.length,routes);assert.equal(h.ownerCount(),owners);assert.deepEqual(readIosRequestProgress(failure),snapshot);
  h.http(undefined);await driver.close();assert.equal(h.routes.length,routes+1);assert.equal(h.routes.at(-1).method,'DELETE');
});

test('malformed delayed read bodies fail closed without retaining private payload text', async t => {
  const h=harness(t),driver=await h.create(),canary=randomBytes(24).toString('base64url');
  h.http(route=>{if(route.endsWith('/element')){h.advance(5200);return new Response(canary);}});
  await assert.rejects(driver.scrollIntoView('approve-request'),error=>{assert.equal(error.code,'NATIVE_DRIVER_RESPONSE_INVALID');assert.equal(String(error.stack).includes(canary),false);return true;});
  assert.equal(h.routes.filter(row=>row.route.endsWith('/element')).length,1);h.http(undefined);await driver.close();
});

test('a delayed strict server missing response remains bounded search and cannot become a found or displayed element', async t => {
  const h=harness(t);
  for(const mode of ['missing','later-found']){
    h.http(undefined);const driver=await h.create();let lookups=0;
    h.http(route=>{
      if(route.endsWith('/element')){if(++lookups===1)h.advance(5200);if(mode==='missing'||lookups===1)return h.json({error:'no such element'},404);}
      if(route.endsWith('/rect')&&!route.includes('/element/'))return h.json({x:0,y:0,width:300,height:600});
    });
    const routes=h.routes.length;
    if(mode==='missing')await assert.rejects(driver.scrollIntoView('approve-request'),{code:'NATIVE_DRIVER_ELEMENT_TIMEOUT'});
    else await driver.scrollIntoView('approve-request');
    const calls=h.routes.slice(routes);assert.equal(lookups,mode==='missing'?7:2);assert.equal(calls.filter(row=>row.route.endsWith('/actions')).length,mode==='missing'?6:1);
    assert.equal(calls.filter(row=>row.route.endsWith('/displayed')).length,mode==='missing'?0:1);assert.equal(calls.some(row=>/\/(click|clear|value)$/.test(row.route)),false);
    h.http(undefined);await driver.close();
  }
});

test('the actual private operation catalog admits only eight read routes and excludes mutations gestures DELETE and unknown routes', async () => {
  const source=await readFile(new URL('../driver.mjs',import.meta.url),'utf8');const begin="const ELEMENT =",end='export class NativeDriverError';
  assert.equal(source.split(begin).length,2);assert.equal(source.split(end).length,2);
  const extracted=vm.runInNewContext(source.slice(source.indexOf(begin),source.indexOf(end))+';({read:[...READ_OPERATIONS],operation:requestOperation});');
  assert.deepEqual(Array.from(extracted.read),['native-context','element-find','element-displayed','element-rect','window-rect','keyboard-state','text-read','value-read']);
  for(const [method,suffix,expected] of [['GET','/context','native-context'],['POST','/element','element-find'],['GET','/element/e/displayed','element-displayed'],['GET','/element/e/rect','element-rect'],['GET','/window/rect','window-rect'],['GET','/appium/device/is_keyboard_shown','keyboard-state'],['GET','/element/e/text','text-read'],['GET','/element/e/attribute/value','value-read']])assert.equal(extracted.operation(method,'/session/s'+suffix),expected);
  for(const [method,suffix] of [['POST','/element/e/click'],['POST','/element/e/clear'],['POST','/element/e/value'],['POST','/actions'],['POST','/appium/device/hide_keyboard'],['DELETE',''],['GET','/unknown']])assert.equal(extracted.read.includes(extracted.operation(method,'/session/s'+suffix)),false);
});

test('actual explicit setup keyboard-confirmation fallback and DELETE bounds stay five seconds', async t => {
  const h=harness(t);let setup=true,hidden=false;const budgets=[];
  h.http(route=>{
    const milliseconds=[...h.timers.values()][0].milliseconds;budgets.push({route,milliseconds});
    if(route==='/session')assert.equal(milliseconds,240000);
    if(setup&&route.endsWith('/context'))assert.equal(milliseconds,5000);
    if(route.endsWith('/hide_keyboard')){assert.equal(milliseconds,5000);hidden=true;return h.json(null);}
    if(route.endsWith('/is_keyboard_shown')){assert.equal(milliseconds,hidden?5000:10000);return h.json(!hidden);}
  });
  const driver=await h.create();setup=false;await driver.hideKeyboard();await driver.close();
  assert.equal(budgets.at(-1).milliseconds,5000);assert.equal(h.routes.at(-1).method,'DELETE');assert.equal(h.routes.filter(row=>row.route.endsWith('/hide_keyboard')).length,1);
});
