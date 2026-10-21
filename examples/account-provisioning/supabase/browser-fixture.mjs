/** Internal source-only synthetic workspace; no provisioning or provider-token route. */
import { exact, UUID } from '../contracts.mjs';

const document = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Testlane sandbox records</title>
<h1>Sandbox records</h1><p id="session-status">Loading</p><p id="identity-email"></p><p id="identity-role"></p>
<button id="refresh-identity">Refresh identity</button><button id="check-editor">Check editor access</button>
<button id="check-reviewer">Check reviewer access</button><button id="create-record">Create record</button>
<button id="refresh-records">Refresh records</button><p id="operation-status" role="status">READY</p>
<ul id="records"></ul><script src="/workspace.js" defer></script></html>`;
const script = `const element=id=>document.getElementById(id);
function clear(){element('session-status').textContent='AUTHENTICATION_REQUIRED';element('identity-email').textContent='';element('identity-role').textContent='';element('records').replaceChildren();}
async function request(route,options={},report=true){const response=await fetch(route,{...options,redirect:'error'});if(report)element('operation-status').textContent='HTTP_'+response.status;if(response.status===401)clear();return response;}
async function identity(report=true){const response=await request('/api/me',{},report);if(response.status!==200)return;const value=await response.json();if(typeof value.email!=='string'||!['Editor','Reviewer','Control'].includes(value.role))throw Error();element('identity-email').textContent=value.email;element('identity-role').textContent=value.role;element('session-status').textContent='AUTHENTICATED';}
async function records(report=true){const response=await request('/api/records',{},report);if(response.status!==200)return;const rows=await response.json();if(!Array.isArray(rows))throw Error();const list=element('records');list.replaceChildren();for(const row of rows){const item=document.createElement('li');item.dataset.recordId=row.id;item.textContent=row.note;list.append(item);}}
function bind(id,run){element(id).addEventListener('click',()=>{run().catch(()=>{element('operation-status').textContent='REQUEST_FAILED';});});}
bind('refresh-identity',()=>identity());bind('refresh-records',()=>records());
bind('check-editor',()=>request('/api/editor-only'));bind('check-reviewer',()=>request('/api/reviewer-only'));
bind('create-record',async()=>{const response=await request('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({note:'synthetic'})});if(response.status===201)await records(false);});
identity(false).then(()=>records(false)).catch(()=>{element('operation-status').textContent='REQUEST_FAILED';});`;

export function browserAsset(route) {
  if (route === '/workspace') return { type: 'text/html; charset=utf-8', body: document };
  if (route === '/workspace.js') return { type: 'text/javascript; charset=utf-8', body: script };
  return null;
}
const failure = status => ({ status, body: { error: status === 403 ? 'ROLE_REFUSED' : 'REQUEST_INVALID' } });
function row(value, owner) {
  if (!exact(value, ['id', 'owner_id', 'note', 'created_at']) || !UUID.test(value.id ?? '') || value.owner_id !== owner ||
      value.note !== 'synthetic' || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw Error('BROWSER_RECORD_INVALID');
  return { id: value.id, owner_id: value.owner_id, note: 'synthetic', created_at: value.created_at };
}
/** rest is already bound to the current app session's provider token inside app.mjs. */
export async function browserRecordResponse({ method, route, user, readBody, rest }) {
  if (route !== '/api/records' && !/^\/api\/records\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(route)) return null;
  if (!user || !UUID.test(user.id ?? '') || !['Editor', 'Reviewer', 'Control'].includes(user.role)) return { status: 401, body: { error: 'AUTHENTICATION_REQUIRED' } };
  if (route === '/api/records' && method === 'GET') {
    const result = await rest('GET', '/proof_records');
    if (result.status !== 200 || !Array.isArray(result.body) || result.body.length > 64) return failure(400);
    return { status: 200, body: result.body.map(value => row(value, user.id)) };
  }
  if (route === '/api/records' && method === 'POST') {
    const value = await readBody();
    if (!exact(value, ['note']) || value.note !== 'synthetic') return failure(400);
    const result = await rest('POST', '/proof_records', { owner_id: user.id, note: 'synthetic' });
    if (result.status === 403) return failure(403);
    if (result.status !== 201 || !Array.isArray(result.body) || result.body.length !== 1) return failure(400);
    return { status: 201, body: row(result.body[0], user.id) };
  }
  if (route !== '/api/records' && method === 'DELETE') {
    if (user.role !== 'Editor') return failure(403);
    const result = await rest('DELETE', '/proof_records?id=eq.' + route.split('/').at(-1));
    return [200, 204].includes(result.status) ? { status: 204 } : failure(400);
  }
  return { status: 405, body: { error: 'METHOD_REFUSED' } };
}
