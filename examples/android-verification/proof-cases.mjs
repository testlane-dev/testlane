/** App-owned native examples. These are prewritten cases, not agent-authorship evidence. */
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeVerificationError} from './contracts.mjs';

export const APPROVAL_REQUIREMENTS = [
  {id:'editor-native-total',title:'Editor creates the exact total in the native app',expected:['Native creation saves three items at 1400 cents for exactly 4200 cents','Fresh backend state matches every saved field']},
  {id:'editor-cannot-approve',title:'Editor approval is denied without mutation',expected:['Native approval attempt returns 403','All nine stable saved fields remain unchanged']},
  {id:'reviewer-native-approval',title:'Reviewer approves the saved request in the native app',expected:['A distinct live Reviewer approves once through native controls','The owned 4200-cent request records its approver and version exactly once']},
  {id:'duplicate-approval-unchanged',title:'Repeated native approval preserves the entire record',expected:['The repeated approval returns 409','Every stable field remains identical to the approved baseline']},
  {id:'anonymous-denied',title:'Anonymous native and API access is refused',expected:['The native app and an anonymous API client receive 401']},
];
const endpoint = id => '/api/requests/'+encodeURIComponent(id);
// Every phase gets an immutable view of the shared session. A body timeout must
// cancel its remaining UI commands without poisoning the fresh cleanup signal.
const phaseContext = ctx => ({...ctx,driver:ctx.driver.withSignal(ctx.signal)});
async function wait(ctx,id,value) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) {
    ctx.signal?.throwIfAborted();
    if(await ctx.driver.text(id)===value)return;
    await delay(Math.min(75,Math.max(1,deadline-Date.now())),undefined,{signal:ctx.signal});
  }
  throw new NativeVerificationError('NATIVE_UI_SETTLEMENT_TIMEOUT');
}
function expected(owned,editor,reviewer,{approved=false,totalCents=4200}={}) {
  return {id:owned.id,marker:owned.marker,ownerEmail:editor.email,quantity:3,unitPriceCents:1400,totalCents,
    status:approved?'approved':'draft',approverEmail:approved?reviewer.email:null,version:approved?2:1};
}
async function identity(ctx,role) {
  await ctx.loadRole(role,ctx.signal);
  await wait(ctx,'session-status','ready');
  ctx.check(await ctx.driver.text('session-status'),'ready');
  ctx.check(await ctx.driver.text('identity-email'),ctx.identities[role].email);
  ctx.check(await ctx.driver.text('identity-role'),ctx.identities[role].role);
  const result=await ctx.api(role,'GET','/api/me',undefined,ctx.signal);
  ctx.check(result.status,200);
  ctx.check(result.body,{email:ctx.identities[role].email,role:ctx.identities[role].role});
}
async function prepare(ctx,owned,id) {
  await ctx.ownership.intent(id,owned.marker);
}
async function capture(ctx,owned,id) {
  // Resolve ownership independently of UI assertions, including after a partial
  // native create. The private intent journal already identifies this exact marker.
  const result=await ctx.api('editor','GET','/api/requests',undefined,ctx.signal);
  const matches=Array.isArray(result.body)?result.body.filter(row=>row.marker===owned.marker):[];
  if(matches.length===1&&typeof matches[0].id==='string') {
    owned.id=matches[0].id;
    await ctx.ownership.record(id,owned.marker,owned.id);
  }
  ctx.check(result.status,200);ctx.check(matches.length,1);ctx.check(typeof owned.id,'string');
  return matches[0];
}
async function create(ctx,owned,id) {
  const result=await ctx.api('editor','POST','/api/requests',{marker:owned.marker,quantity:3,unitPriceCents:1400},ctx.signal);
  await capture(ctx,owned,id);ctx.check(result.status,201);
}
async function read(ctx,role,owned) {
  const result=await ctx.api(role,'GET',endpoint(owned.id),undefined,ctx.signal);
  ctx.check(result.status,200);return result.body;
}
async function select(ctx,owned) {
  await ctx.driver.type('selected-id',owned.id);await ctx.driver.hideKeyboard();await ctx.driver.click('load-request');
  await wait(ctx,'request-id',owned.id);await wait(ctx,'operation-status','HTTP_200');
  ctx.check(await ctx.driver.text('api-status'),'200');
  ctx.check(await ctx.driver.text('request-id'),owned.id);
}
async function cleanup(ctx,owned,id) {
  // A failed UI action can occur after the server committed creation. Recover by
  // this case's unique marker before deciding there is nothing to remove.
  const listed=await ctx.api('editor','GET','/api/requests',undefined,ctx.signal);
  ctx.check(listed.status,200);ctx.check(Array.isArray(listed.body),true);
  const matches=listed.body.filter(row=>row.marker===owned.marker);
  ctx.check(matches.length<=1,true);
  if(!owned.id&&matches.length===1) {
    owned.id=matches[0].id;await ctx.ownership.record(id,owned.marker,owned.id);
  }
  if(owned.id) {
    const result=await ctx.api('editor','DELETE',endpoint(owned.id),undefined,ctx.signal);
    ctx.check([204,404].includes(result.status),true);
    const absent=await ctx.api('editor','GET',endpoint(owned.id),undefined,ctx.signal);ctx.check(absent.status,404);
  } else ctx.check(matches.length,0);
  const after=await ctx.api('editor','GET','/api/requests',undefined,ctx.signal);
  ctx.check(after.status,200);ctx.check(after.body.filter(row=>row.marker===owned.marker),[]);
  await ctx.ownership.remove(id);
}

export function createApprovalCases() {
  const build=(id,body)=>{
    const owned={marker:'native-proof-'+randomUUID(),id:null};
    return {id,run:async input=>{const ctx=phaseContext(input);await prepare(ctx,owned,id);await body(ctx,owned,id);},cleanup:ctx=>cleanup(phaseContext(ctx),owned,id)};
  };
  return [
    build('editor-native-total',async(ctx,owned,id)=>{
      await identity(ctx,'editor');
      await ctx.driver.type('run-marker',owned.marker);await ctx.driver.type('quantity','3');await ctx.driver.type('unit-price','1400');
      await ctx.driver.hideKeyboard();
      await ctx.driver.click('create-request');
      await wait(ctx,'operation-status','HTTP_201');
      const row=await capture(ctx,owned,id);
      ctx.check(await ctx.driver.text('api-status'),'201');ctx.check(await ctx.driver.text('request-id'),owned.id);
      ctx.check(await ctx.driver.text('request-total'),'4200');
      ctx.check(row,expected(owned,ctx.identities.editor,ctx.identities.reviewer));
      ctx.check(await read(ctx,'editor',owned),expected(owned,ctx.identities.editor,ctx.identities.reviewer));
    }),
    build('editor-cannot-approve',async(ctx,owned,id)=>{
      await create(ctx,owned,id);await identity(ctx,'editor');await select(ctx,owned);
      const before=await read(ctx,'editor',owned);
      ctx.check(before,expected(owned,ctx.identities.editor,ctx.identities.reviewer,{totalCents:before.totalCents}));
      await ctx.driver.click('approve-request');await wait(ctx,'operation-status','HTTP_403');ctx.check(await ctx.driver.text('api-status'),'403');
      ctx.check(await read(ctx,'editor',owned),before);
    }),
    build('reviewer-native-approval',async(ctx,owned,id)=>{
      await create(ctx,owned,id);await identity(ctx,'reviewer');await select(ctx,owned);
      await ctx.driver.click('approve-request');await wait(ctx,'request-status','approved');await wait(ctx,'operation-status','HTTP_200');ctx.check(await ctx.driver.text('api-status'),'200');
      ctx.check(await ctx.driver.text('request-status'),'approved');ctx.check(await ctx.driver.text('request-total'),'4200');
      ctx.check(await read(ctx,'reviewer',owned),expected(owned,ctx.identities.editor,ctx.identities.reviewer,{approved:true}));
      ctx.check(await read(ctx,'editor',owned),expected(owned,ctx.identities.editor,ctx.identities.reviewer,{approved:true}));
    }),
    build('duplicate-approval-unchanged',async(ctx,owned,id)=>{
      await create(ctx,owned,id);await identity(ctx,'reviewer');await select(ctx,owned);
      await ctx.driver.click('approve-request');await wait(ctx,'request-status','approved');await wait(ctx,'operation-status','HTTP_200');ctx.check(await ctx.driver.text('api-status'),'200');
      const before=await read(ctx,'reviewer',owned);
      ctx.check(before,expected(owned,ctx.identities.editor,ctx.identities.reviewer,{approved:true,totalCents:before.totalCents}));
      await ctx.driver.click('approve-request');await wait(ctx,'operation-status','HTTP_409');ctx.check(await ctx.driver.text('api-status'),'409');
      ctx.check(await read(ctx,'reviewer',owned),before);
    }),
    {id:'anonymous-denied',run:async input=>{
      const ctx=phaseContext(input);
      // Establish this case's approved local origin independently; the native
      // anonymous-check operation deliberately omits the loaded cookie.
      await identity(ctx,'editor');
      await ctx.driver.click('anonymous-check');await wait(ctx,'operation-status','ANONYMOUS_HTTP_401');ctx.check(await ctx.driver.text('api-status'),'401');
      const result=await ctx.api(null,'GET','/api/requests',undefined,ctx.signal);ctx.check(result.status,401);
    }},
  ];
}
