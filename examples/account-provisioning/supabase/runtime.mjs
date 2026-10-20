/** Owned local provider experiment. No hosted target/key or raw SQL interface. */
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {lstat,readFile,readdir,realpath,rmdir,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,exact,ProvisionError,UUID,validOwner} from '../contracts.mjs';
import {localDocker,runOwnedCommand} from './tools/process.mjs';
import {createPrivateRuntimeDirectory,assertPrivateRuntimeDirectory} from './tools/private-directory.mjs';

export const PG_VERSION='8.23.1';
export const SUPABASE_IMAGES=Object.freeze({
  auth:Object.freeze({version:'v2.197.0',reference:'supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b'}),
  database:Object.freeze({version:'17.6.1.136',reference:'supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00'}),
  rest:Object.freeze({version:'v14.18',reference:'postgrest/postgrest@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf'}),
  gateway:Object.freeze({version:'22.23.3-bookworm-slim',reference:'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'}),
});
// Public, fixed-purpose TCP transport only. The only destinations are the three
// owned backend IP/port pairs supplied before startup, never request input.
const GATEWAY_SOURCE=`const net=require('node:net');
const routes=JSON.parse(process.argv[1]);
if(!Array.isArray(routes)||routes.length!==3||routes.some((r,i)=>r.listen!==[15432,19999,13000][i]||r.port!==[5432,9999,3000][i]||!/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(r.host)))process.exit(1);
const sockets=new Set();
for(const route of routes){const host=route.host,port=route.port;net.createServer(inbound=>{const outbound=net.connect({host,port});
sockets.add(inbound);sockets.add(outbound);const stop=()=>{inbound.destroy();outbound.destroy();sockets.delete(inbound);sockets.delete(outbound);};
inbound.on('error',stop);outbound.on('error',stop);inbound.on('close',stop);outbound.on('close',stop);inbound.pipe(outbound);outbound.pipe(inbound);
}).listen(route.listen,'0.0.0.0');}
process.on('SIGTERM',()=>{for(const socket of sockets)socket.destroy();process.exit(0);});`;
const HERE=path.dirname(fileURLToPath(import.meta.url)),LABEL='dev.testlane.supabase-owner',registered=new WeakSet();
export const isOwnedSupabaseRuntime=value=>registered.has(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const fail=code=>Object.assign(new Error(code),{code});
const ID=/^[a-f0-9]{64}$/,token=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\r\n\0]/.test(value);
const safePassword=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(value);
const CONTAINER_FORMAT='{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"portBindings":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}},"user":{{json .Config.User}},"privileged":{{json .HostConfig.Privileged}},"readOnlyRoot":{{json .HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"sysctls":{{json (index .HostConfig "Sysctls")}}}';
export function privateSubnetAddresses(subnet){
  if(typeof subnet!=='string'||!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(subnet))throw fail('SUPABASE_NETWORK_REFUSED');
  const [address,prefix]=subnet.split('/'),octets=address.split('.').map(Number),bits=Number(prefix);
  if(octets.some(value=>value>255)||bits<16||bits>28||!(octets[0]===10||octets[0]===172&&octets[1]>=16&&octets[1]<=31||octets[0]===192&&octets[1]===168))throw fail('SUPABASE_NETWORK_REFUSED');
  const number=octets.reduce((value,octet)=>(value<<8n)+BigInt(octet),0n),mask=(0xffffffffn<<BigInt(32-bits))&0xffffffffn;
  if((number&mask)!==number)throw fail('SUPABASE_NETWORK_REFUSED');
  const ip=offset=>[24n,16n,8n,0n].map(shift=>Number(((number+BigInt(offset))>>shift)&255n)).join('.');
  return {database:ip(2),auth:ip(3),rest:ip(4),gateway:ip(5)};
}
export function validRestRequest(method,route,body) {
  if(!['GET','POST','DELETE'].includes(method)||typeof route!=='string')return false;
  if(route==='/rpc/whoami')return ['GET','POST'].includes(method)&&(body===undefined||(method==='POST'&&exact(body,[])));
  if(route==='/proof_records')return method==='GET'?body===undefined:method==='POST'&&exact(body,['owner_id','note'])&&UUID.test(body.owner_id??'')&&body.note==='synthetic';
  if(method==='DELETE')return /^\/proof_records\?id=eq\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(route)&&body===undefined;
  return method==='GET'&&/^\/proof_records\?owner_id=eq\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(route)&&body===undefined;
}
export function validateResourceProof({nonce,id,labels}) {
  if(!/^[a-f0-9]{32}$/.test(nonce??'')||!ID.test(id??'')||labels?.[LABEL]!==nonce||labels?.['dev.testlane.purpose']!=='local-account-proof')throw fail('SUPABASE_OWNERSHIP_REFUSED');
  return true;
}
const newDirectory=(requested,signal)=>createPrivateRuntimeDirectory(requested,{signal});
async function loadPg(requested) {
  if(typeof requested!=='string'||!path.isAbsolute(requested))throw fail('SUPABASE_TOOLS_REQUIRED');
  const root=path.resolve(requested);
  try{
    if(!same(await realpath(root),root)||(await lstat(root)).isSymbolicLink())throw fail();
    const marker=JSON.parse(await readFile(path.join(root,'supabase-tools.json'),'utf8'));
    if(marker.schemaVersion!==1||marker.complete!==true||marker.pgVersion!==PG_VERSION||canonical(marker.images)!==canonical(SUPABASE_IMAGES))throw fail();
    for(const file of ['package.json','package-lock.json'])if(hash(await readFile(path.join(root,file)))!==hash(await readFile(path.join(HERE,'tools',file)))||
      marker.packageSha256?.[file]!==hash(await readFile(path.join(root,file))))throw fail();
    const pgFile=path.join(root,'node_modules/pg/package.json');
    if(!same(await realpath(pgFile),pgFile)||JSON.parse(await readFile(pgFile,'utf8')).version!==PG_VERSION)throw fail();
    const require=createRequire(path.join(root,'package.json'));return require('pg').Pool;
  }catch{throw fail('SUPABASE_TOOLS_REQUIRED');}
}
const BOOTSTRAP_SQL=`
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOINHERIT LOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOINHERIT LOGIN CREATEROLE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 EXECUTE format('ALTER ROLE authenticator PASSWORD %L',current_setting('testlane.bootstrap_password'));
 EXECUTE format('ALTER ROLE supabase_auth_admin PASSWORD %L',current_setting('testlane.bootstrap_password'));
END $$;
GRANT anon,authenticated,service_role TO authenticator;
ALTER ROLE supabase_auth_admin SET statement_timeout='5s';
ALTER ROLE supabase_auth_admin SET lock_timeout='3s';
ALTER ROLE supabase_auth_admin SET idle_in_transaction_session_timeout='5s';
ALTER ROLE authenticator SET statement_timeout='5s';
ALTER ROLE authenticator SET lock_timeout='3s';
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
`;
const LEDGER_SQL=Object.freeze({
  bind:'SELECT testlane_private.bind($1::jsonb) AS value',reserve:'SELECT testlane_private.reserve($1::jsonb) AS value',
  inspect:'SELECT testlane_private.inspect($1::jsonb) AS value',delivery:'SELECT testlane_private.delivery($1::jsonb,$2::boolean) AS value',
  revoke:'SELECT testlane_private.revoke($1::jsonb) AS value',identity:'SELECT testlane_private.identity($1::uuid) AS value',
});
export async function startOwnedSupabase({outputDir,toolsRoot,signal,onStage=()=>{}}={}) {
  if(signal?.aborted)throw fail('SUPABASE_CANCELLED');
  if(typeof onStage!=='function')throw fail('SUPABASE_INPUT_REFUSED');let stage='prerequisites';const at=value=>{if(!ready&&signal?.aborted)throw fail('SUPABASE_CANCELLED');stage=value;onStage(value);};
  const Pool=await loadPg(toolsRoot),docker=await localDocker({cwd:HERE,signal});
  if(signal?.aborted)throw fail('SUPABASE_CANCELLED');
  const root=await newDirectory(outputDir,signal),nonce=randomBytes(16).toString('hex'),targetId=randomUUID();
  const prefix='tld-supa-'+nonce,markerFile=path.join(root,'owner.json');
  const names={network:prefix+'-net',gatewayNetwork:prefix+'-host',volume:prefix+'-data',database:prefix+'-db',auth:prefix+'-auth',rest:prefix+'-rest',gateway:prefix+'-gateway'};
  const resources={network:null,gatewayNetwork:null,volume:false,database:null,auth:null,rest:null,gateway:null},attempted=new Set(),files=new Set(['.gitignore','owner.json']);
  const secrets=new Set(),secret=()=>{const value=randomBytes(32).toString('base64url');secrets.add(value);return value;};
  const password=secret(),jwtSecret=secret(),controlPassword=secret();
  const issued=new Set(),imageIds={};let captured='',pool,authOrigin,restOrigin,controlId,closed=false,closing=false,closeResult,unknownChild=false,ready=false,createRequests=0,startDiagnostic,backendIps,gatewayPorts;
  const env={...process.env,DEBUG:'',NODE_DEBUG:'',DOCKER_CLI_HINTS:'false'};delete env.NODE_OPTIONS;
  const live=()=>{if(closed||closing)throw fail('SUPABASE_RUNTIME_CLOSED');};
  const marker=()=>({schemaVersion:1,nonce,targetId,ownerPid:process.pid,context:docker.context,names,resources});
  const durable=()=>writeFile(markerFile,JSON.stringify(marker(),null,2)+'\n',{mode:0o600});
  async function command(args,{timeoutMs=30000,acceptFailure=false}={}) {
    try{
      const result=await runOwnedCommand('docker',['--context',docker.context,...args],{cwd:root,env,timeoutMs,signal:!ready&&!closing?signal:undefined});
      captured+=result.stdout+result.stderr;if(Buffer.byteLength(captured)>2*1024*1024)throw fail('SUPABASE_CAPTURE_LIMIT');
      if(result.code!==0&&!acceptFailure)throw fail('SUPABASE_DOCKER_COMMAND_FAILED');return result;
    }catch(error){
      const mutation=args[0]==='run'||['create','rm'].includes(args[1]);
      if(error.code==='SUPABASE_COMMAND_STOP_UNCONFIRMED'||mutation&&['SUPABASE_COMMAND_TIMEOUT','SUPABASE_COMMAND_OUTPUT_LIMIT','SUPABASE_CANCELLED'].includes(error.code))unknownChild=true;
      throw fail(/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_DOCKER_COMMAND_FAILED');
    }
  }
  async function assertRoot() {
    if(!same(await realpath(root),root)||(await lstat(root)).isSymbolicLink())throw fail('SUPABASE_OWNERSHIP_REFUSED');
    const actual=JSON.parse(await readFile(markerFile,'utf8'));
    if(canonical(actual)!==canonical(marker()))throw fail('SUPABASE_OWNERSHIP_REFUSED');
  }
  const labelArgs=['--label',LABEL+'='+nonce,'--label','dev.testlane.purpose=local-account-proof'];
  async function inspectContainer(kind) {
    const result=await command(['container','inspect',resources[kind]??names[kind],'--format',CONTAINER_FORMAT]);
    let inspected;try{inspected=JSON.parse(result.stdout);}catch{throw fail('SUPABASE_OWNERSHIP_REFUSED');}
    validateResourceProof({nonce,id:inspected.id,labels:inspected.labels});
    if(resources[kind]&&resources[kind]!==inspected.id)throw fail('SUPABASE_OWNERSHIP_REFUSED');
    if(inspected.imageRef!==SUPABASE_IMAGES[kind].reference||inspected.imageId!==imageIds[kind]||inspected.privileged)throw fail('SUPABASE_IMAGE_PREREQUISITE_FAILED');
    const expectedNetworks=kind==='gateway'?[names.network,names.gatewayNetwork]:[names.network];
    if(canonical(Object.keys(inspected.networks??{}).sort())!==canonical(expectedNetworks.sort())||inspected.networks[names.network].IPAddress!==backendIps[kind])throw fail('SUPABASE_NETWORK_REFUSED');
    if((inspected.mounts??[]).some(mount=>mount.Type!=='volume'||mount.Name!==names.volume||mount.Destination!=='/var/lib/postgresql/data'))throw fail('SUPABASE_MOUNT_REFUSED');
    if(kind!=='database'&&(inspected.mounts??[]).length)throw fail('SUPABASE_MOUNT_REFUSED');
    for(const bindings of Object.values(inspected.ports??{}))if(bindings?.some(binding=>binding.HostIp!=='127.0.0.1'||!/^\d{1,5}$/.test(binding.HostPort)))throw fail('SUPABASE_PORT_REFUSED');
    if(kind!=='gateway'&&Object.values(inspected.ports??{}).some(value=>value?.length))throw fail('SUPABASE_PORT_REFUSED');
    if(kind==='gateway'&&gatewayPorts&&canonical(inspected.ports)!==canonical(gatewayPorts))throw fail('SUPABASE_PORT_REFUSED');
    if(kind==='gateway'&&(inspected.user!=='1000:1000'||inspected.privileged||inspected.readOnlyRoot!==true||!inspected.capDrop?.some(value=>value.toUpperCase()==='ALL')||
      !inspected.securityOpt?.some(value=>value==='no-new-privileges:true'||value==='no-new-privileges')||inspected.sysctls?.['net.ipv4.ip_forward']!=='0'||inspected.sysctls?.['net.ipv6.conf.all.forwarding']!=='0'))throw fail('SUPABASE_GATEWAY_POLICY_REFUSED');
    return inspected;
  }
  async function assertOwned() {
    live();await assertRoot();
    const network=JSON.parse((await command(['network','inspect',resources.network,'--format','{{json .}}'])).stdout);
    validateResourceProof({nonce,id:network.Id,labels:network.Labels});
    if(!network.Internal||Object.values(network.Containers??{}).some(row=>!Object.values(resources).includes(row.Name)&&!Object.values(names).includes(row.Name)))throw fail('SUPABASE_NETWORK_REFUSED');
    const hostNetwork=JSON.parse((await command(['network','inspect',resources.gatewayNetwork,'--format','{{json .}}'])).stdout);
    validateResourceProof({nonce,id:hostNetwork.Id,labels:hostNetwork.Labels});
    if(hostNetwork.Internal||Object.values(hostNetwork.Containers??{}).some(row=>row.Name!==names.gateway))throw fail('SUPABASE_NETWORK_REFUSED');
    const volume=JSON.parse((await command(['volume','inspect',names.volume,'--format','{{json .Labels}}'])).stdout);
    if(volume?.[LABEL]!==nonce||volume?.['dev.testlane.purpose']!=='local-account-proof')throw fail('SUPABASE_OWNERSHIP_REFUSED');
    for(const kind of ['database','auth','rest','gateway'])if(resources[kind])if(!(await inspectContainer(kind)).running)throw fail('SUPABASE_SERVICE_STOPPED');
    if(ready){const bound=await query('SELECT target_id::text FROM testlane_private.target WHERE singleton');if(bound.rows.length!==1||bound.rows[0].target_id!==targetId)throw fail('SUPABASE_TARGET_REFUSED');}
  }
  async function envFile(kind,values) {
    await assertPrivateRuntimeDirectory(root,{signal:!ready&&!closing?signal:undefined});
    const file=kind+'.env';files.add(file);
    const contents=Object.entries(values).map(([key,value])=>{if(/[\r\n\0]/.test(String(value)))throw fail('SUPABASE_CONFIG_REFUSED');return key+'='+value;}).join('\n')+'\n';
    await writeFile(path.join(root,file),contents,{flag:'wx',mode:0o600});return path.join(root,file);
  }
  async function startContainer(kind,port,values,extra=[]) {
    const config=await envFile(kind,values);attempted.add(kind);await durable();
    const image=SUPABASE_IMAGES[kind==='database'?'database':kind];
    const run=await command(['run','--detach','--pull=never','--name',names[kind],...labelArgs,'--network',resources.network,
      '--network-alias',kind==='database'?'db':kind,'--ip',backendIps[kind],'--env-file',config,'--log-driver','none',
      '--restart','no','--security-opt','no-new-privileges:true',...extra,image.reference,
      ...(kind==='database'?['postgres','-c','config_file=/etc/postgresql/postgresql.conf','-c','log_min_messages=fatal']:[])]);
    if(!ID.test(run.stdout.trim())){unknownChild=true;throw fail('SUPABASE_CONTAINER_START_UNKNOWN');}resources[kind]=run.stdout.trim();await durable();
    const inspected=await inspectContainer(kind);
    startDiagnostic={service:kind,running:inspected.running===true,exitCode:Number.isSafeInteger(inspected.exitCode)?inspected.exitCode:-1};
    if(!inspected.running)throw fail('SUPABASE_SERVICE_STOPPED');
  }
  async function startGateway(){
    attempted.add('gateway');await durable();
    const routes=[{listen:15432,host:backendIps.database,port:5432},{listen:19999,host:backendIps.auth,port:9999},{listen:13000,host:backendIps.rest,port:3000}];
    const result=await command(['run','--detach','--pull=never','--name',names.gateway,...labelArgs,
      '--network',resources.gatewayNetwork,'--network','name='+resources.network+',ip='+backendIps.gateway,
      '--publish','127.0.0.1::15432','--publish','127.0.0.1::19999','--publish','127.0.0.1::13000',
      '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--read-only',
      '--sysctl','net.ipv4.ip_forward=0','--sysctl','net.ipv6.conf.all.forwarding=0','--log-driver','none','--restart','no',
      SUPABASE_IMAGES.gateway.reference,'node','-e',GATEWAY_SOURCE,JSON.stringify(routes)]);
    if(!ID.test(result.stdout.trim())){unknownChild=true;throw fail('SUPABASE_CONTAINER_START_UNKNOWN');}resources.gateway=result.stdout.trim();await durable();
    const inspected=await inspectContainer('gateway'),origin=port=>{const bindings=inspected.ports?.[port+'/tcp'];if(bindings?.length!==1)throw fail('SUPABASE_PORT_REFUSED');return 'http://127.0.0.1:'+bindings[0].HostPort;};
    gatewayPorts=structuredClone(inspected.ports);
    if(!inspected.running)throw fail('SUPABASE_SERVICE_STOPPED');return {database:origin(15432),auth:origin(19999),rest:origin(13000)};
  }
  async function jsonRequest(origin,method,route,body,bearer,representation=false) {
    if(!origin||!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw fail('SUPABASE_TARGET_REFUSED');
    const timed=AbortSignal.timeout(8000),operationSignal=!ready&&!closing&&signal?AbortSignal.any([timed,signal]):timed;
    const response=await fetch(origin+route,{method,redirect:'error',signal:operationSignal,
      headers:{...(bearer?{Authorization:'Bearer '+bearer}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(representation?{Prefer:'return=representation'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const reader=response.body?.getReader();let length=0;const chunks=[];
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>256*1024){await reader.cancel();throw fail('SUPABASE_RESPONSE_LIMIT');}chunks.push(Buffer.from(value));}
    let decoded=null;if(length)try{decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{if(response.ok)throw fail('SUPABASE_RESPONSE_INVALID');}
    return {status:response.status,body:decoded};
  }
  const signedAdmin=()=>{
    const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),body=Buffer.from(JSON.stringify({role:'service_role',iss:'supabase',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
    const value=head+'.'+body+'.'+createHmac('sha256',jwtSecret).update(head+'.'+body).digest('base64url');secrets.add(value);return value;
  };
  async function admin(method,route,body){try{return await jsonRequest(authOrigin,method,route,body,signedAdmin());}
    catch(error){throw fail(/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_AUTH_REQUEST_FAILED');}}
  async function query(text,values=[],name) {
    try{return await pool.query({text,values,...(name?{name}:{})});}catch{throw fail('SUPABASE_DATABASE_FAILED');}
  }
  async function ledger(operation,payload,pending) {
    if(!Object.hasOwn(LEDGER_SQL,operation)||operation==='delivery'&&typeof pending!=='boolean')throw new ProvisionError('PROVISION_INPUT_REFUSED');
    if(operation==='identity'){if(typeof payload!=='string'||!UUID.test(payload))throw new ProvisionError('PROVISION_INPUT_REFUSED');}
    else if(operation!=='bind'&&(!validOwner(payload)||payload.targetId!==targetId))throw new ProvisionError('PROVISION_OWNERSHIP_REFUSED');
    await assertOwned();
    try{const result=await pool.query({name:'proof-'+operation,text:LEDGER_SQL[operation],values:operation==='delivery'?[payload,pending]:[payload]});return result.rows[0]?.value??null;}
    catch(error){const recognized=new ProvisionError(error.message);if(recognized.code!==error.message)throw fail('SUPABASE_DATABASE_FAILED');throw recognized;}
  }
  function tokens(response) {
    if(response.status!==200)return {status:response.status};
    const value=response.body;if(!token(value?.access_token)||!token(value?.refresh_token)||!UUID.test(value.user?.id??'')||typeof value.user?.email!=='string')throw fail('SUPABASE_RESPONSE_INVALID');
    issued.add(value.access_token);issued.add(value.refresh_token);return {status:200,accessToken:value.access_token,refreshToken:value.refresh_token,user:{id:value.user.id,email:value.user.email}};
  }
  async function signIn(email,passwordValue) {
    if(typeof email!=='string'||email.length>254||/[\r\n\0]/.test(email)||!safePassword(passwordValue))throw new ProvisionError('PROVISION_INPUT_REFUSED');
    await assertOwned();secrets.add(passwordValue);
    try{return tokens(await jsonRequest(authOrigin,'POST','/token?grant_type=password',{email,password:passwordValue}));}catch(error){throw fail(/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_AUTH_REQUEST_FAILED');}
  }
  function assertNoLeaks(text) {
    if(typeof text!=='string')throw fail('SUPABASE_PRIVACY_SCAN_FAILED');
    for(const value of [...secrets,...issued])for(const variant of [value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('base64url')])if(text.includes(variant))throw fail('SUPABASE_PRIVACY_SCAN_FAILED');
    return true;
  }
  async function summaryCounts(){
    const result=await query(`SELECT
      (SELECT count(*)::int FROM testlane_private.reservations AS entry JOIN auth.users AS account ON account.id=entry.user_id) AS "ownedAccounts",
      (SELECT count(*)::int FROM testlane_private.reservations WHERE NOT revoked) AS "activeReservations",
      (SELECT count(*)::int FROM testlane_private.reservations WHERE delivery_pending) AS "pendingDeliveries",
      EXISTS(SELECT 1 FROM testlane_private.control_grant AS control JOIN auth.users AS account ON account.id=control.user_id WHERE account.id=$1::uuid) AS "controlPresent",
      (SELECT count(*)::int FROM testlane_private.reservations) AS reservations,
      (SELECT count(*)::int FROM testlane_api.proof_records) AS "proofRecords"`,[controlId]);return result.rows[0];
  }
  async function close({preserveData=false}={}) {
    if(typeof preserveData!=='boolean')throw fail('SUPABASE_INPUT_REFUSED');
    if(closed)return closeResult;if(closing)throw fail('SUPABASE_CLEANUP_INCOMPLETE');closing=true;
    let refused=false;
    try{
      await assertRoot();
      if(unknownChild){preserveData=true;refused=true;}
      if(ready&&!preserveData){try{const summary=await summaryCounts();if(summary.ownedAccounts!==0||summary.activeReservations!==0||summary.pendingDeliveries!==0||summary.proofRecords!==0||summary.controlPresent!==true){preserveData=true;refused=true;}}
        catch{preserveData=true;refused=true;}}
      if(pool){let timer;try{await Promise.race([pool.end(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('SUPABASE_DATABASE_STOP_UNCONFIRMED')),10000);})]);pool=undefined;}finally{clearTimeout(timer);}}
      for(const kind of ['gateway','rest','auth','database'])if(attempted.has(kind)){
        const exists=await command(['container','inspect',resources[kind]??names[kind],'--format',CONTAINER_FORMAT],{acceptFailure:true});
        if(exists.code===0){const proof=JSON.parse(exists.stdout);validateResourceProof({nonce,id:proof.id,labels:proof.labels});if(resources[kind]&&proof.id!==resources[kind])throw fail('SUPABASE_OWNERSHIP_REFUSED');
          await command(['container','rm','--force',proof.id]);}
        const absent=await command(['container','ls','--all','--filter','name=^/'+names[kind]+'$','--format','{{.ID}}']);
        if(absent.stdout.trim()!=='')throw fail('SUPABASE_CLEANUP_INCOMPLETE');
      }
      if(attempted.has('volume')&&!preserveData){
        const existing=await command(['volume','inspect',names.volume,'--format','{{json .Labels}}'],{acceptFailure:true});
        if(existing.code===0){const labels=JSON.parse(existing.stdout);if(labels?.[LABEL]!==nonce)throw fail('SUPABASE_OWNERSHIP_REFUSED');await command(['volume','rm',names.volume]);}
        const absent=await command(['volume','ls','--filter','name='+names.volume,'--format','{{.Name}}']);if(absent.stdout.trim()!=='')throw fail('SUPABASE_CLEANUP_INCOMPLETE');
      }
      for(const kind of ['gatewayNetwork','network'])if(attempted.has(kind)){
        const existing=await command(['network','inspect',resources[kind]??names[kind],'--format','{{json .}}'],{acceptFailure:true});
        if(existing.code===0){const proof=JSON.parse(existing.stdout);validateResourceProof({nonce,id:proof.Id,labels:proof.Labels});if(Object.keys(proof.Containers??{}).length)throw fail('SUPABASE_OWNERSHIP_REFUSED');await command(['network','rm',proof.Id]);}
        const absent=await command(['network','ls','--filter','name=^'+names[kind]+'$','--format','{{.ID}}']);if(absent.stdout.trim()!=='')throw fail('SUPABASE_CLEANUP_INCOMPLETE');
      }
      if(unknownChild)throw fail('SUPABASE_CLEANUP_INCOMPLETE');await assertRoot();
      if(preserveData){await writeFile(path.join(root,'recovery.json'),JSON.stringify({...marker(),status:'data-preserved'})+'\n',{mode:0o600});
        closed=true;closeResult={cleanupVerified:false,preserved:true};if(refused)throw fail('SUPABASE_CLEANUP_INCOMPLETE');return closeResult;}
      const entries=await readdir(root);if(entries.some(file=>!files.has(file)))throw fail('SUPABASE_CLEANUP_INCOMPLETE');
      for(const file of entries){const candidate=path.join(root,file),info=await lstat(candidate);if(!info.isFile()||info.isSymbolicLink()||!same(await realpath(candidate),candidate))throw fail('SUPABASE_OWNERSHIP_REFUSED');}
      for(const file of entries)await unlink(path.join(root,file));await rmdir(root);
      if(await lstat(root).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw fail('SUPABASE_CLEANUP_INCOMPLETE');
      closed=true;closeResult={cleanupVerified:true};return closeResult;
    }catch{await writeFile(path.join(root,'recovery.json'),JSON.stringify({...marker(),status:'cleanup-incomplete'})+'\n',{mode:0o600}).catch(()=>{});throw fail('SUPABASE_CLEANUP_INCOMPLETE');}
  }
  try{
    await writeFile(path.join(root,'.gitignore'),'*\n',{flag:'wx',mode:0o600});await durable();
    for(const [kind,image] of Object.entries(SUPABASE_IMAGES)){
      const inspected=await command(['image','inspect',image.reference,'--format','{"id":{{json .Id}},"digests":{{json .RepoDigests}}}']);
      const proof=JSON.parse(inspected.stdout);
      if(!proof.digests.includes(image.reference)||!/^sha256:[a-f0-9]{64}$/.test(proof.id))throw fail('SUPABASE_IMAGE_PREREQUISITE_FAILED');imageIds[kind]=proof.id;
    }
    at('owned-network');attempted.add('network');const network=await command(['network','create','--internal',...labelArgs,names.network]);
    if(!ID.test(network.stdout.trim())){unknownChild=true;throw fail('SUPABASE_NETWORK_CREATE_UNKNOWN');}resources.network=network.stdout.trim();await durable();
    const networkConfig=JSON.parse((await command(['network','inspect',resources.network,'--format','{{json .IPAM.Config}}'])).stdout);
    if(networkConfig.length!==1)throw fail('SUPABASE_NETWORK_REFUSED');backendIps=privateSubnetAddresses(networkConfig[0].Subnet);
    attempted.add('gatewayNetwork');const hostNetwork=await command(['network','create',...labelArgs,names.gatewayNetwork]);
    if(!ID.test(hostNetwork.stdout.trim())){unknownChild=true;throw fail('SUPABASE_NETWORK_CREATE_UNKNOWN');}resources.gatewayNetwork=hostNetwork.stdout.trim();await durable();
    attempted.add('volume');await command(['volume','create',...labelArgs,names.volume]);resources.volume=true;await durable();
    at('database-start');await startContainer('database',5432,{POSTGRES_USER:'supabase_admin',POSTGRES_PASSWORD:password,PGPASSWORD:password,POSTGRES_DB:'postgres',PGDATABASE:'postgres',PGPORT:'5432',POSTGRES_PORT:'5432',JWT_EXP:'600'},['--mount','type=volume,source='+names.volume+',target=/var/lib/postgresql/data']);
    at('gateway-start');const origins=await startGateway();authOrigin=origins.auth;restOrigin=origins.rest;
    pool=new Pool({host:'127.0.0.1',port:Number(new URL(origins.database).port),database:'postgres',user:'supabase_admin',password,max:3,
      connectionTimeoutMillis:5000,query_timeout:7000,statement_timeout:5000,idle_in_transaction_session_timeout:5000,
      options:'-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=5000'});pool.on('error',()=>{});
    let dbReady=false;const dbUntil=Date.now()+120000;
    while(Date.now()<dbUntil){if(signal?.aborted)throw fail('SUPABASE_CANCELLED');try{await query('SELECT 1');dbReady=true;break;}catch{await sleep(500);}}
    if(!dbReady)throw fail('SUPABASE_DATABASE_READY_TIMEOUT');
    at('database-bootstrap');const connection=await pool.connect();try{await connection.query("SELECT set_config('testlane.bootstrap_password',$1,false)",[password]);await connection.query(BOOTSTRAP_SQL);}finally{connection.release();}
    at('auth-start');await startContainer('auth',9999,{GOTRUE_API_HOST:'0.0.0.0',GOTRUE_API_PORT:'9999',API_EXTERNAL_URL:authOrigin,
      GOTRUE_SITE_URL:'http://127.0.0.1',GOTRUE_DB_DRIVER:'postgres',GOTRUE_DB_DATABASE_URL:'postgres://supabase_auth_admin:'+password+'@db:5432/postgres',
      GOTRUE_DISABLE_SIGNUP:'true',GOTRUE_JWT_ADMIN_ROLES:'service_role',GOTRUE_JWT_AUD:'authenticated',GOTRUE_JWT_DEFAULT_GROUP_NAME:'authenticated',
      GOTRUE_JWT_EXP:'600',GOTRUE_JWT_SECRET:jwtSecret,GOTRUE_EXTERNAL_EMAIL_ENABLED:'true',GOTRUE_MAILER_AUTOCONFIRM:'true',
      GOTRUE_EXTERNAL_PHONE_ENABLED:'false',GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED:'false',GOTRUE_SMS_AUTOCONFIRM:'false',LOG_LEVEL:'error'});
    let authReady=false;const authUntil=Date.now()+90000;
    while(Date.now()<authUntil){if(signal?.aborted)throw fail('SUPABASE_CANCELLED');try{if((await jsonRequest(authOrigin,'GET','/health')).status===200){authReady=true;break;}}catch{}await sleep(400);}
    if(!authReady)throw fail('SUPABASE_AUTH_READY_TIMEOUT');
    at('control-seed');const control=await admin('POST','/admin/users',{email:'foreign-control@example.test',password:controlPassword,email_confirm:true,role:'authenticated',app_metadata:{testlane_foreign_control:nonce}});
    if(control.status!==200||!UUID.test(control.body?.id??''))throw fail('SUPABASE_CONTROL_CREATE_FAILED');controlId=control.body.id;
    at('ledger-migration');await query(await readFile(path.join(HERE,'ledger.sql'),'utf8'));
    await query('INSERT INTO testlane_private.target(target_id) VALUES($1::uuid)',[targetId]);
    await query("WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at) INSERT INTO testlane_private.control_grant(user_id,email,created_at,expires_at) SELECT $1::uuid,'foreign-control@example.test',at,at+interval '1 hour' FROM stamp",[controlId]);
    at('rest-start');await startContainer('rest',3000,{PGRST_DB_URI:'postgres://authenticator:'+password+'@db:5432/postgres',PGRST_DB_SCHEMAS:'testlane_api',PGRST_DB_ANON_ROLE:'anon',PGRST_DB_MAX_ROWS:'100',PGRST_JWT_SECRET:jwtSecret,PGRST_DB_USE_LEGACY_GUCS:'false',PGRST_SERVER_HOST:'0.0.0.0',PGRST_SERVER_PORT:'3000',PGRST_LOG_LEVEL:'crit'});
    let restReady=false;const restUntil=Date.now()+30000;
    while(Date.now()<restUntil){if(signal?.aborted)throw fail('SUPABASE_CANCELLED');try{if((await jsonRequest(restOrigin,'GET','/')).status===200){restReady=true;break;}}catch{}await sleep(300);}
    if(!restReady)throw fail('SUPABASE_REST_READY_TIMEOUT');await assertOwned();if(signal?.aborted)throw fail('SUPABASE_CANCELLED');ready=true;
    const runtime=Object.freeze({targetId,authOrigin,restOrigin,
      metadata:Object.freeze({composeRevision:'b46b645c6d74316dd5ec0be92bc0f94125917e9b',images:SUPABASE_IMAGES,resolvedImageIds:Object.freeze({...imageIds}),pg:PG_VERSION,docker:docker.version,internalNetwork:true,loopbackOnly:true,gatewayCodeSha256:hash(GATEWAY_SOURCE),fixedGatewayTargets:3,backendEgress:false,
        privacy:Object.freeze({type:process.platform==='win32'?'windows-dacl':'posix-mode',currentUserOnly:true,immediateParentVerified:true})}),
      ledger,
      async createOwnedUser(owner,passwordValue){
        if(!validOwner(owner)||owner.targetId!==targetId||!safePassword(passwordValue))throw new ProvisionError('PROVISION_OWNERSHIP_REFUSED');
        await assertOwned();secrets.add(passwordValue);
        const reserved=await query("SELECT owner=$1::jsonb AND user_id IS NULL AS allowed FROM testlane_private.reservations WHERE operation_id=(($1::jsonb)->>'operationId')::uuid",[owner]);
        if(reserved.rows.length!==1||reserved.rows[0].allowed!==true)throw new ProvisionError('PROVISION_REPLAY_REFUSED');
        let rejectedStatus;
        try{createRequests++;const response=await admin('POST','/admin/users',{email:owner.email,password:passwordValue,email_confirm:true,role:'authenticated',app_metadata:{testlane_owner:owner}});
          if(response.status!==200){rejectedStatus=response.status;throw fail();}
          if(!UUID.test(response.body?.id??'')||response.body.email!==owner.email)throw fail();
          const inspected=await ledger('inspect',owner);if(!inspected.present||inspected.id!==response.body.id)throw fail();return {id:response.body.id};
        }catch{const failure=new ProvisionError('PROVISION_CREATE_UNKNOWN');if(Number.isSafeInteger(rejectedStatus)&&rejectedStatus>=400&&rejectedStatus<=599)failure.httpStatus=rejectedStatus;throw failure;}
      },
      async deleteOwnedUser(owner){
        const inspected=await ledger('inspect',owner);
        if(!inspected.revoked||inspected.deliveryPending)throw new ProvisionError('PROVISION_OWNERSHIP_REFUSED');
        if(inspected.id===null){if(inspected.present)throw new ProvisionError('PROVISION_OWNERSHIP_REFUSED');return {deleted:true,absent:true};}
        if(!UUID.test(inspected.id??''))throw new ProvisionError('PROVISION_OWNERSHIP_REFUSED');
        const user=await admin('GET','/admin/users/'+inspected.id);
        if(user.status===404&&!inspected.present)return {deleted:true,absent:true};
        if(user.status!==200||user.body?.id!==inspected.id||user.body.email!==owner.email||canonical(user.body.app_metadata?.testlane_owner)!==canonical(owner))throw new ProvisionError('PROVISION_OWNERSHIP_REFUSED');
        const removed=await admin('DELETE','/admin/users/'+inspected.id);
        if(![200,204].includes(removed.status)||(await ledger('inspect',owner)).present)throw new ProvisionError('PROVISION_CLEANUP_INCOMPLETE');return {deleted:true,absent:true};
      },
      signIn,signInControl:()=>signIn('foreign-control@example.test',controlPassword),
      async refresh(refreshToken){if(!token(refreshToken))throw new ProvisionError('PROVISION_INPUT_REFUSED');await assertOwned();
        try{return tokens(await jsonRequest(authOrigin,'POST','/token?grant_type=refresh_token',{refresh_token:refreshToken}));}catch(error){throw fail(/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_AUTH_REQUEST_FAILED');}},
      async getUser(accessToken){if(!token(accessToken))throw new ProvisionError('PROVISION_INPUT_REFUSED');await assertOwned();
        try{const response=await jsonRequest(authOrigin,'GET','/user',undefined,accessToken);if(response.status!==200)return {status:response.status};
          if(!UUID.test(response.body?.id??'')||typeof response.body.email!=='string')throw fail('SUPABASE_RESPONSE_INVALID');return {status:200,user:{id:response.body.id,email:response.body.email}};
        }catch(error){throw fail(/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_AUTH_REQUEST_FAILED');}},
      async rest(method,route,accessToken,body){if(!validRestRequest(method,route,body)||(accessToken!==undefined&&accessToken!==null&&!token(accessToken)))throw new ProvisionError('PROVISION_INPUT_REFUSED');await assertOwned();
        try{const response=await jsonRequest(restOrigin,method,route,body,accessToken,method==='POST'&&route==='/proof_records');return {status:response.status,
          body:response.status<400?response.body:response.body?.code==='42501'?{code:'42501'}:null};}catch(error){throw fail(/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_REST_REQUEST_FAILED');}},
      async summary(){await assertOwned();return summaryCounts();},
      requestCounts:()=>({authCreate:createRequests}),assertNoLeaks,capturedText:()=>captured,close,
    });
    registered.add(runtime);at('ready');return runtime;
  }catch(error){
    let code=/^SUPABASE_[A-Z_]+$/.test(error.code??'')?error.code:'SUPABASE_RUNTIME_START_FAILED';try{await close();}catch{code='SUPABASE_CLEANUP_INCOMPLETE';}
    const failure=fail(code);Object.defineProperty(failure,'capturedText',{value:()=>captured});Object.defineProperty(failure,'recoveryRoot',{value:root});failure.stage=stage;if(startDiagnostic)failure.diagnostic=startDiagnostic;throw failure;
  }
}
