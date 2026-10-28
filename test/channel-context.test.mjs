import test from 'node:test';
import assert from 'node:assert/strict';
import { submitMiddlewareCommand } from '../src/middleware.mjs';
const input = { tenant_id:'tenant-a', requested_by:'worker', command_id:'command-a', correlation_id:'correlation-a',
  idempotency_key:'key-123456', campaign_id:'approved', provider:'meta', instance_id:'account-a',
  phone_number_id:'phone-a', channel_id:'channel-a', binding_revision:'proof-1',
  recipient:'fixture', message:{type:'text',text:'fixture only'} };
const config = {middlewareCommandType:'whatsapp.message.send.v1',middlewareBaseUrl:'http://127.0.0.1:1',middlewareCommandPath:'/platform/v1/commands'};
async function intercept(fn) {
 const old=globalThis.fetch; const seen=[];
 globalThis.fetch=async (url,options) => {seen.push(JSON.parse(options.body));return new Response(JSON.stringify({command_id:'command-a',operation_id:'operation-a'}),{status:202});};
 try {await fn(seen);} finally {globalThis.fetch=old;}
}
test('preserves full channel identity, without forwarding caller credentials',async()=>{
 await intercept(async seen=>{
  await submitMiddlewareCommand(config,{...input,access_token:'must-not-forward',credential_env:'must-not-forward'},'Bearer fixture');
  for(const k of ['provider','instance_id','phone_number_id','channel_id','binding_revision']) assert.equal(seen[0].payload[k],input[k]);
  assert.equal(seen[0].payload.access_token,undefined);assert.equal(seen[0].payload.credential_env,undefined);
 });
});
for(const field of ['provider','instance_id','phone_number_id','channel_id','binding_revision']) {
 for(const value of [undefined,null,'','   ','a\nb',{},[], 'x'.repeat(201)]) {
  test(`rejects invalid ${field} ${JSON.stringify(value)?.slice(0,15)}`,async()=>{
   await intercept(async seen=>{await assert.rejects(submitMiddlewareCommand(config,{...input,[field]:value},'Bearer fixture'));assert.equal(seen.length,0);});
  });
 }
}
test('rejects unsupported provider before upstream I/O',async()=>{
 await intercept(async seen=>{await assert.rejects(submitMiddlewareCommand(config,{...input,provider:'unregistered'},'Bearer fixture'));assert.equal(seen.length,0);});
});
