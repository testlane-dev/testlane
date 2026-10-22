/** Fixed metadata breadcrumbs, not native acceptance or log-access authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomBytes} from 'node:crypto';

const source=await readFile(new URL('../../../scripts/ios-proof.mjs',import.meta.url),'utf8');
function helper(text=source){
  const from='function createIosProofCheckpointEmitter() {',to='function entry()';
  assert.equal(text.split(from).length,2);assert.equal(text.split(to).length,2);
  const start=text.indexOf(from),end=text.indexOf(to);assert.ok(end>start);
  return text.slice(start,end);
}
const stages=['owned-simulator-start','device-xcode-runtime-and-pinned-tools-validated','device-owned-simulator-created',
  'device-wda-build-for-testing','device-wda-prepared','device-owned-simulator-boot-started','device-owned-simulator-booted',
  'device-private-appium-ready','app-prewarm','wda-readiness','broker-setup','positive','fault','corrected','cleanup'];
function controlled(envValue,sink){
  const lines=[];
  const create=vm.runInNewContext(helper()+'\ncreateIosProofCheckpointEmitter;',{
    process:{env:{GITHUB_ACTIONS:envValue}},console:{log:line=>{lines.push(line);sink?.(line);}},
  });
  return{create,lines,emit:create()};
}

test('only fifteen fixed notices are emitted once per proof, including restored cleanup stage',()=>{
  const {emit,lines,create}=controlled('true');
  for(const stage of [...stages,...stages.toReversed(),'positive','cleanup'])emit(stage);
  assert.deepEqual(lines,stages.map(stage=>'::notice title=Testlane iOS checkpoint::Checkpoint observed: '+stage+'; subsequent state unknown.'));
  assert.equal(lines.length,15);
  create()('positive');assert.equal(lines.length,16,'a new proof owns a fresh bounded set');
});

test('nonliteral inputs are neither coerced nor emitted and raw or encoded values stay absent',()=>{
  const canary=randomBytes(32).toString('base64')+'/%\n::error::private';
  const encoded=[canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')];
  const object=new Proxy({},{get(){throw Error('input must never be inspected');}});
  const {emit,lines}=controlled('true');
  for(const stage of [undefined,null,false,true,0,1,Symbol('positive'),new String('positive'),object,()=>{},'__proto__',
    'positive\n::error::injected','positive\r','positive\0','setup','consumer-install',...encoded])emit(stage);
  assert.deepEqual(lines,[]);
  emit('positive');const text=lines.join('\n');for(const value of encoded)assert.equal(text.includes(value),false);
});

test('GitHub Actions opt-in is exact and absent elsewhere',()=>{
  for(const value of [undefined,null,false,true,0,1,'','false','TRUE','1']){
    const {emit,lines}=controlled(value);for(const stage of stages)emit(stage);assert.deepEqual(lines,[]);
  }
});

test('a throwing notice sink is best-effort and cannot renew or replace an earlier failure',()=>{
  const {emit,lines}=controlled('true',()=>{throw Error('controlled sink failure');});
  const earlier=Error('controlled proof failure');
  assert.throws(()=>{try{throw earlier;}finally{emit('cleanup');emit('cleanup');}},error=>error===earlier);
  assert.equal(lines.length,1);
});

test('checkpoint extraction refuses missing or duplicate source anchors',()=>{
  assert.throws(()=>helper(source.replace('function createIosProofCheckpointEmitter() {','function renamed() {')));
  assert.throws(()=>helper(source+'\nfunction entry()'));
});
