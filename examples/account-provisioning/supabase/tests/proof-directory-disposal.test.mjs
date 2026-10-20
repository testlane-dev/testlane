/** Actual permissions and bounded verifier children; no broker or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {lstat,readFile,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareProvisioningProofDirectories} from '../../proof.mjs';
import {disposePrivateProofDirectories} from '../proof.mjs';
import {fixture} from '../../tests/private-proof-fixture.mjs';
const keys=['TMP','TEMP','TMPDIR','NODE_DISABLE_COMPILE_CACHE'];
const environment=()=>keys.map(key=>[key,Object.hasOwn(process.env,key),process.env[key]]);

test('provider disposal settles every private permission verifier before deleting leased TMP',async()=>{
  const before=environment(),f=await fixture();let storage;
  try{
    storage=await prepareProvisioningProofDirectories(path.join(f.parent,'proof'));
    assert.equal(await realpath(os.tmpdir()),storage.scratchRoot);
    await disposePrivateProofDirectories([storage.scratchRoot,storage.sessionRoot]);
    // The old verify/remove/verify/remove order recreated scratch while the
    // second Windows verifier inherited TMP. Both children have now settled.
    await assert.rejects(lstat(storage.scratchRoot),{code:'ENOENT'});
    await assert.rejects(lstat(storage.sessionRoot),{code:'ENOENT'});
  }finally{storage?.restore();assert.deepEqual(environment(),before);await f.close();}
});
test('a nonempty second directory preserves both directories and its generated data',async()=>{
  const before=environment(),f=await fixture();let storage;
  try{
    storage=await prepareProvisioningProofDirectories(path.join(f.parent,'proof'));
    const canary=randomBytes(32).toString('base64url'),file=path.join(storage.sessionRoot,'synthetic-canary');
    await writeFile(file,canary,{flag:'wx',mode:0o600});
    await assert.rejects(disposePrivateProofDirectories([storage.scratchRoot,storage.sessionRoot]));
    assert.equal(await realpath(storage.scratchRoot),storage.scratchRoot);
    assert.equal(await readFile(file,'utf8'),canary);
    await unlink(file);await disposePrivateProofDirectories([storage.scratchRoot,storage.sessionRoot]);
    await assert.rejects(lstat(storage.scratchRoot),{code:'ENOENT'});
    await assert.rejects(lstat(storage.sessionRoot),{code:'ENOENT'});
  }finally{storage?.restore();assert.deepEqual(environment(),before);await f.close();}
});
