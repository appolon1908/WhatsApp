import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPhoneAuthorizer } from "../src/phone-auth.mjs";
import { loadConfig } from "../src/config.mjs";

const {privateKey,publicKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});jwk.kid="kid1";jwk.alg="RS256";jwk.use="sig";
const now=1_800_000_000;
const issuer="https://auth.codestra.co/realms/codestra";
const config={phoneAuthMode:"oidc",phoneOidcIssuer:issuer,phoneOidcAudience:"codestra-whatsapp",phoneOidcClient:"codestra-whatsapp-frontend"};
const claims={iss:issuer,aud:"codestra-whatsapp",azp:"codestra-whatsapp-frontend",
  sub:"real-operator-1",tenant_id:"CODESTRA",realm_access:{roles:["whatsapp_admin"]},exp:now+600,iat:now-5};
const token=(body=claims,header={alg:"RS256",kid:"kid1",typ:"JWT"})=>{
 const a=Buffer.from(JSON.stringify(header)).toString("base64url"),b=Buffer.from(JSON.stringify(body)).toString("base64url");
 const signature=crypto.sign("RSA-SHA256",Buffer.from(a+"."+b),privateKey).toString("base64url");
 return a+"."+b+"."+signature;
};
const make=()=>createPhoneAuthorizer(config,{
 clock:()=>now,fetcher:async(url,options)=>{
  assert.equal(url,issuer+"/protocol/openid-connect/certs");
  assert.equal(options.redirect,"error");
  return {ok:true,json:async()=>({keys:[jwk]})};
 }
});
const request=(jwt=token(),tenant="CODESTRA")=>({headers:{authorization:"Bearer "+jwt,"x-tenant-id":tenant}});
test("Keycloak RS256 operator access token grants tenant-scoped WhatsApp admin access",async()=>{
 const result=await make().authorize(request());
 assert.equal(result.tenant,"CODESTRA");
 assert.equal(result.actor,"real-operator-1");
 assert.equal(result.authMode,"oidc");
});
test("deny spoofed tenant, unsigned alg=none, invalid signature, expired token",async()=>{
 const auth=make();
 const failures=[
   [request(token({...claims,tenant_id:"TENANT2"})),"tenant_mismatch",403],
   [request(token({...claims,exp:now-120})),"token_expired",401],
   [request(token({...claims,iss:"https://evil.example/realms/codestra"})),"invalid_issuer",401],
   [request(token({...claims,aud:"wrong"})),"invalid_audience",401],
   [request(token({...claims,azp:"wrong"})),"invalid_authorized_party",401],
   [request(token({...claims,realm_access:{roles:["whatsapp_agent"]}})),"phone_admin_role_required",403],
   [request(token({...claims,tenant_id:undefined})),"tenant_claim_missing",401],
   [request(token(claims,{alg:"none",kid:"kid1"})),"invalid_access_token",401],
   [request(token(claims).slice(0,-3)+"bad"),"invalid_access_token",401]
 ];
 for(const [r,code,status] of failures){
   await assert.rejects(auth.authorize(r),e=>e.code===code&&e.status===status,code);
 }
});
test("JWKS unavailable fails closed rather than trusting browser JWT",async()=>{
 const auth=createPhoneAuthorizer(config,{clock:()=>now,fetcher:async()=>{throw Error("network fail");}});
 await assert.rejects(auth.authorize(request()),e=>e.code==="oidc_jwks_unavailable"&&e.status===503);
});
test("production refuses token bypass, memory-only storage and unapproved effects",()=>{
 assert.throws(()=>loadConfig({NODE_ENV:"production",PHONE_AUTH_MODE:"staging-token"}),/OIDC/);
 assert.throws(()=>loadConfig({NODE_ENV:"production",PHONE_AUTH_MODE:"oidc",PHONE_OIDC_ISSUER:issuer,PHONE_OIDC_CLIENT_ID:"codestra-whatsapp-frontend"}),/durable/);
 assert.throws(()=>loadConfig({NODE_ENV:"production",PHONE_AUTH_MODE:"oidc",PHONE_OIDC_ISSUER:issuer,PHONE_OIDC_CLIENT_ID:"codestra-whatsapp-frontend",PHONE_ACCOUNTS_FILE:"/data/accounts.json",PHONE_ENROLLMENT_EFFECTS_ENABLED:"true"}),/GO approval/);
 const prod=loadConfig({NODE_ENV:"production",PHONE_AUTH_MODE:"oidc",PHONE_OIDC_ISSUER:issuer,PHONE_OIDC_CLIENT_ID:"codestra-whatsapp-frontend",PHONE_ACCOUNTS_FILE:"/data/accounts.json"});
 assert.equal(prod.phoneAuthMode,"oidc");
 assert.equal(prod.productionSend,false);
 assert.equal(prod.phoneEnrollmentEnabled,false);
});
test("staging retains separate explicit enrollment admin key while production demands OIDC",async()=>{
 const auth=createPhoneAuthorizer(loadConfig({PHONE_ADMIN_TOKEN:"long-secret-012345678901234567890"}));
 const approved=await auth.authorize({headers:{"x-phone-admin-token":"long-secret-012345678901234567890","x-tenant-id":"CODESTRA"}});
 assert.equal(approved.tenant,"CODESTRA");
 await assert.rejects(auth.authorize({headers:{"x-phone-admin-token":"bad","x-tenant-id":"CODESTRA"}}),e=>e.code==="unauthorized");
});

test("message command rejects staging admin token and browser spoofed identity",async()=>{
 const {createApp}=await import("../src/server.mjs");
 const {once}=await import("node:events");
 const cfg=loadConfig({
   WHATSAPP_PRODUCTION_SEND:"true",WHATSAPP_EXTERNAL_RECIPIENTS:"true",
   MIDDLEWARE_COMMAND_TYPE:"whatsapp.message.send.v1",
   PHONE_ADMIN_TOKEN:"long-secret-012345678901234567890"
 });
 const actor={tenant:"TENANT_A",actor:"agent-123",authMode:"oidc"};
 let count=0;
 const app=createApp(cfg,{
   phoneAuthorizer:{authorize:async()=>actor},
   submitMiddlewareCommand:async(config,input,authorization)=>{
     count++;assert.equal(input.tenant_id,"TENANT_A");assert.equal(input.requested_by,"agent-123");
     assert.equal(authorization,"Bearer simulated");
     return {status:202,middleware:{operation_id:"test-op-01",state:"QUEUED"}};
   }
 });
 app.listen(0,"127.0.0.1");await once(app,"listening");
 try{
  const base="http://127.0.0.1:"+app.address().port;
  const input={recipient:"+18095550123",consent_status:"opted_in",suppressed:false,opted_out:false,
    idempotency_key:"secure-idem-123456789",message:{type:"text",text:"test only"}};
  const submit=async obj=>{
    const r=await fetch(base+"/platform/v1/whatsapp/messages",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer simulated"},body:JSON.stringify(obj)});
    return {status:r.status,data:await r.json()};
  };
  assert.equal((await submit({...input,tenant_id:"WRONG_TENANT"})).status,403);
  assert.equal((await submit({...input,requested_by:"spoofed-actor"})).status,403);
  assert.equal(count,0);
  const valid=await submit(input);
  assert.equal(valid.status,202);
  assert.equal(count,1);
  assert.equal(valid.data.command_authority,"middleware-v3");
 }finally{app.close();await once(app,"close");}
});
test("messaging never allows staging admin token to substitute for signed operator identity",async()=>{
 const {createApp}=await import("../src/server.mjs");
 const {once}=await import("node:events");
 const cfg=loadConfig({WHATSAPP_PRODUCTION_SEND:"true",WHATSAPP_EXTERNAL_RECIPIENTS:"true",
   MIDDLEWARE_COMMAND_TYPE:"whatsapp.message.send.v1",
   PHONE_ADMIN_TOKEN:"long-secret-012345678901234567890"});
 const app=createApp(cfg,{submitMiddlewareCommand:async()=>{throw Error("must never issue command");}});
 app.listen(0,"127.0.0.1");await once(app,"listening");
 try{
  const r=await fetch("http://127.0.0.1:"+app.address().port+"/platform/v1/whatsapp/messages",{
   method:"POST",
   headers:{"content-type":"application/json","x-phone-admin-token":"long-secret-012345678901234567890","x-tenant-id":"TENANT_A"},
   body:JSON.stringify({tenant_id:"TENANT_A",requested_by:"any",recipient:"+18095550123",consent_status:"opted_in",idempotency_key:"idem-00123456",message:{type:"text",text:"test"}})
  });
  assert.equal(r.status,403);
  assert.equal((await r.json()).error.code,"oidc_required_for_messaging");
 }finally{app.close();await once(app,"close");}
});
