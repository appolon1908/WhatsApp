import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { createPhoneStore } from "../src/phone-accounts.mjs";

const key="operator-key-longer-than-24-characters";
async function withApp(fn,{file=":memory:",enabled=false,callEnrollment=async()=>{throw Error("provider effect must not execute");}}={}){
 const env={PORT:"0",PHONE_ADMIN_TOKEN:key,PHONE_ACCOUNTS_FILE:file,PHONE_ENROLLMENT_EFFECTS_ENABLED:String(enabled),WHATSAPP_PRODUCTION_SEND:"false"};
 const config=loadConfig(env),app=createApp(config,{callEnrollment});
 app.listen(0,"127.0.0.1");await once(app,"listening");
 const base="http://127.0.0.1:"+app.address().port;
 const request=async(method,uri,body,more={})=>{
  const h={"content-type":"application/json","x-phone-admin-token":key,"x-tenant-id":"TENANT1",...more};
  const r=await fetch(base+uri,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json()};
 };
 try{await fn({base,request});}finally{app.close();await once(app,"close");}
}
const route="/internal/v1/whatsapp/phone-accounts";
const meta={tenant_id:"TENANT1",provider:"meta",label:"Meta Customer Service",number:"+18095550123",waba_id:"123456789",phone_number_id:"987654321"};
const evo={tenant_id:"TENANT1",provider:"evolution",label:"Existing WhatsApp",instance_name:"existing-session-1"};
test("registry is private and requires explicit tenant and admin credentials",async()=>{
 await withApp(async({base,request})=>{
  let res=await fetch(base+route);assert.equal(res.status,401);
 },{});
});
test("multi-number drafts are durable, tenant scoped and duplicates rejected",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"codestra-phones-")),file=path.join(dir,"accounts.json");
 try{
  let id;
  await withApp(async({request})=>{
   const created=await request("POST",route,meta);
   assert.equal(created.status,201);
   id=created.body.id;
   assert.match(id,/^[0-9a-f-]{36}$/);
   assert.equal(created.body.number,undefined);
   assert.equal(created.body.number_masked.endsWith("0123"),true);
   assert.equal((await request("POST",route,meta)).status,409);
   assert.equal((await request("POST",route,evo)).status,201);
   assert.equal((await request("GET",route)).body.items.length,2);
   assert.equal((await request("GET",route,undefined,{"x-tenant-id":"TENANT2"})).body.items.length,0);
   assert.equal((await request("PATCH",route+"/"+id,{expected_version:55,patch:{label:"bad"}})).status,409);
   assert.equal((await request("PATCH",route+"/"+id,{expected_version:1,patch:{label:"Support Updated"}})).status,200);
   const blocked=await request("POST",route+"/"+id+"/actions/request-code",{expected_version:2,input:{method:"SMS",language:"en_US"}},{"idempotency-key":"requested-code-001"});
   assert.equal(blocked.status,423);
   assert.equal(blocked.body.error.code,"phone_enrollment_disabled");
  },{file});
  await withApp(async({request})=>{
    const rows=(await request("GET",route)).body.items;
    assert.equal(rows.length,2);
    assert.equal(rows.find(x=>x.id===id).label,"Support Updated");
  },{file});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("provider state machine only invokes approved adapter actions and never saves PIN or QR",async()=>{
 const called=[];
 await withApp(async({request})=>{
  const added=await request("POST",route,meta);const id=added.body.id;
  const action=async(version,verb,input,idemp)=>request("POST",route+"/"+id+"/actions/"+verb,{expected_version:version,input},{"idempotency-key":idemp});
  const otp=await action(1,"request-code",{method:"SMS",language:"en_US"},"first-request-00001");
  assert.equal(otp.status,200);assert.equal(otp.body.account.state,"code_requested");
  const duplicate=await action(2,"request-code",{method:"SMS",language:"en_US"},"first-request-00001");
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);
  const verify=await action(2,"verify-code",{code:"123456"},"second-request-0002");
  assert.equal(verify.status,200);assert.equal(verify.body.account.state,"verified");
  const registered=await action(3,"register",{pin:"654321"},"third-request-00003");
  assert.equal(registered.status,200);assert.equal(registered.body.account.state,"registered");
  const state=(await request("GET",route)).body.items[0];
  assert.equal(Object.hasOwn(state,"code"),false);
  assert.equal(Object.hasOwn(state,"pin"),false);
  assert.equal(Object.hasOwn(state,"qr_image"),false);
  assert.deepEqual(called.map(x=>x.action),["meta.request-code","meta.verify-code","meta.register"]);
  assert.equal((await request("POST",route+"/"+id+"/actions/qr",{expected_version:4,input:{}},{"idempotency-key":"invalid-action-001"})).status,400);
 },{enabled:true,callEnrollment:async(action,input)=>{called.push({action,input});return {accepted:true};}});
});
test("unauthenticated, cross-tenant and malformed requests fail closed",async()=>{
 await withApp(async({base,request})=>{
  const r=await fetch(base+route,{headers:{"x-tenant-id":"TENANT1"}});assert.equal(r.status,401);
  assert.equal((await request("POST",route,{...meta,tenant_id:"TENANT2"})).status,403);
  assert.equal((await request("POST",route,{...meta,number:"nope"})).status,400);
  assert.equal((await request("POST",route,{...evo,instance_name:"../admin"})).status,400);
 },{});
});

test("provider rejection cannot falsely advance a phone registration",async()=>{
 await withApp(async({request})=>{
  const account=await request("POST",route,meta);
  const result=await request("POST",route+"/"+account.body.id+"/actions/request-code",
    {expected_version:1,input:{method:"SMS",language:"en_US"}},{"idempotency-key":"negative-provider-001"});
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,"provider_reconciliation_required");
  const after=await request("GET",route+"/"+account.body.id);
  assert.equal(after.body.state,"draft");
  assert.equal(after.body.version,1);
  assert.equal(after.body.needs_reconciliation,true);
 },{enabled:true,callEnrollment:async()=>({accepted:false})});
});

test("failed provider effects remain write-ahead-blocked across server restart",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"codestra-provider-crash-")),file=path.join(dir,"accounts.json");
 let id,calls=0;
 try{
  await withApp(async({request})=>{
   const created=await request("POST",route,meta);id=created.body.id;
   const attempt=await request("POST",route+"/"+id+"/actions/request-code",
      {expected_version:1,input:{method:"SMS",language:"en_US"}},{"idempotency-key":"single-attempt-0000001"});
   assert.equal(attempt.status,503);
   assert.equal(attempt.body.error.code,"provider_reconciliation_required");
   assert.equal(calls,1);
  },{file,enabled:true,callEnrollment:async()=>{calls++;throw new Error("connection lost after request");}});
  await withApp(async({request})=>{
   const state=await request("GET",route+"/"+id);
   assert.equal(state.body.needs_reconciliation,true);
   assert.equal(state.body.state,"draft");
   const retry=await request("POST",route+"/"+id+"/actions/request-code",
      {expected_version:1,input:{method:"SMS",language:"en_US"}},{"idempotency-key":"single-attempt-0000001"});
   assert.equal(retry.status,423);
   assert.equal(retry.body.error.code,"provider_reconciliation_required");
   assert.equal(calls,1);
  },{file,enabled:true,callEnrollment:async()=>{calls++;return {accepted:true};}});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("Meta ownership verification and registration cannot skip required lifecycle state",async()=>{
 await withApp(async({request})=>{
  const created=await request("POST",route,meta);
  const verify=await request("POST",route+"/"+created.body.id+"/actions/verify-code",
     {expected_version:1,input:{code:"123456"}},{"idempotency-key":"transition-verify-001"});
  assert.equal(verify.status,409);
  assert.equal(verify.body.error.code,"invalid_account_transition");
  const register=await request("POST",route+"/"+created.body.id+"/actions/register",
     {expected_version:1,input:{pin:"123456"}},{"idempotency-key":"transition-register-001"});
  assert.equal(register.status,409);
 },{enabled:true,callEnrollment:async()=>{throw new Error("must not call");}});
});
