import fs from "node:fs/promises";
import path from "node:path";
import crypto, { timingSafeEqual } from "node:crypto";

export class PhoneAccountError extends Error {
 constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
const VALID_PROVIDER=new Set(["meta","evolution"]);
const VALID_STATE=new Set(["draft","code_requested","verified","registered","awaiting_qr","linked","disconnected","disabled"]);
const required=(v,label,re)=>{if(typeof v!=="string"||!re.test(v))throw new PhoneAccountError("invalid_"+label);return v;};
const e164=(s)=>typeof s==="string"&&/^\+[1-9]\d{7,14}$/.test(s);
export function fixedTimeSecret(actual,expected) {
 const a=Buffer.from(String(actual||"")),b=Buffer.from(String(expected||""));
 return b.length>=24&&a.length===b.length&&timingSafeEqual(a,b);
}
export function maskNumber(value) {
 return value ? value.slice(0,2)+"•".repeat(Math.max(0,value.length-6))+value.slice(-4) : null;
}
export function sanitizeAccount(account) {
 const {number,history,last_idempotency,...safe}=account;
 return {...safe,number_masked:maskNumber(number),history_count:Array.isArray(history)?history.length:0};
}
function validate(input) {
 if(!input||typeof input!=="object"||Array.isArray(input))throw new PhoneAccountError("invalid_account");
 const provider=input.provider;
 if(!VALID_PROVIDER.has(provider))throw new PhoneAccountError("invalid_provider");
 const tenant_id=required(input.tenant_id,"tenant_id",/^[A-Za-z0-9_-]{2,64}$/);
 const label=required(input.label,"label",/^[\p{L}\p{N} _.-]{2,100}$/u).trim();
 const number=input.number||null;
 if(number&&!e164(number))throw new PhoneAccountError("invalid_phone_number");
 const campaign_id=input.campaign_id?required(input.campaign_id,"campaign_id",/^[a-zA-Z0-9_-]{2,64}$/):null;
 const waba_id=provider==="meta"?required(input.waba_id,"waba_id",/^\d{5,32}$/):null;
 const phone_number_id=provider==="meta"?required(input.phone_number_id,"phone_number_id",/^\d{5,32}$/):null;
 const instance_name=provider==="evolution"?required(input.instance_name,"instance_name",/^[a-z0-9][a-z0-9_-]{2,62}$/):null;
 if(provider==="meta"&&!number)throw new PhoneAccountError("meta_number_required");
 return {provider,tenant_id,label,number,campaign_id,waba_id,phone_number_id,instance_name};
}
export function createPhoneStore(filename,{now=()=>new Date().toISOString()}={}) {
 let lock=Promise.resolve(),state=null;
 async function load() {
  if(state)return state;
  if(filename===":memory:")return state={schema:1,accounts:[],audit:[]};
  try{
   const raw=await fs.readFile(filename,"utf8");
   const obj=JSON.parse(raw);
   if(obj.schema!==1||!Array.isArray(obj.accounts)||!Array.isArray(obj.audit))throw Error("invalid version");
   state=obj;return state;
  }catch(e){if(e.code==="ENOENT")return state={schema:1,accounts:[],audit:[]};throw new PhoneAccountError("account_storage_corrupted",503);}
 }
 async function persist(){
  if(filename===":memory:")return;
  const dir=path.dirname(filename);
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const tmp=filename+"."+crypto.randomUUID()+".tmp";
  let file;
  try{
   file=await fs.open(tmp,"wx",0o600);
   await file.writeFile(JSON.stringify(state)+"\n");
   await file.sync();await file.close();file=null;
   await fs.rename(tmp,filename);
   const folder=await fs.open(dir,"r");try{await folder.sync();}finally{await folder.close();}
  }finally{if(file)await file.close();await fs.rm(tmp,{force:true}).catch(()=>{});}
 }
 function sequential(callback){
  const current=lock.then(async()=>{await load();return callback();});
  lock=current.catch(()=>{});
  return current;
 }
 function record(account,action,actor){
  const event={at:now(),account_id:account.id,tenant_id:account.tenant_id,action,actor};
  account.history.push(event);if(account.history.length>50)account.history.shift();
  state.audit.push(event);if(state.audit.length>500)state.audit.shift();
  account.updated_at=event.at;account.version++;
 }
 return {
  list(tenant){return sequential(()=>state.accounts.filter(a=>a.tenant_id===tenant).map(sanitizeAccount));},
  get(id,tenant){return sequential(()=>{const a=state.accounts.find(x=>x.id===id&&x.tenant_id===tenant);if(!a)throw new PhoneAccountError("account_not_found",404);return sanitizeAccount(a);});},
  create(input,actor){
   return sequential(async()=>{
    const data=validate(input);
    if(state.accounts.some(a=>a.provider===data.provider&&((data.number&&a.number===data.number)||(a.instance_name&&a.instance_name===data.instance_name)||(a.phone_number_id&&a.phone_number_id===data.phone_number_id))))
      throw new PhoneAccountError("phone_already_registered",409);
    if(state.accounts.length>=500)throw new PhoneAccountError("account_capacity_reached",409);
    const time=now(),a={...data,id:crypto.randomUUID(),state:"draft",version:1,created_at:time,updated_at:time,history:[],last_idempotency:null};
    state.accounts.push(a);state.audit.push({at:time,account_id:a.id,tenant_id:a.tenant_id,action:"draft_created",actor});
    await persist();return sanitizeAccount(a);
   });
  },
  update(id,tenant,expectedVersion,patch,actor) {
   return sequential(async()=>{
    const a=state.accounts.find(x=>x.id===id&&x.tenant_id===tenant);
    if(!a)throw new PhoneAccountError("account_not_found",404);
    if(a.version!==expectedVersion)throw new PhoneAccountError("stale_version",409);
    if(patch&&Object.keys(patch).some(x=>!["label","campaign_id","disabled"].includes(x)))throw new PhoneAccountError("unsafe_update_field");
    if(patch.label!==undefined)a.label=required(patch.label,"label",/^[\p{L}\p{N} _.-]{2,100}$/u).trim();
    if(patch.campaign_id!==undefined)a.campaign_id=patch.campaign_id?required(patch.campaign_id,"campaign_id",/^[a-zA-Z0-9_-]{2,64}$/):null;
    if(patch.disabled===true)a.state="disabled";
    record(a,"account_updated",actor);await persist();return sanitizeAccount(a);
   });
  },
  async action(id,tenant,version,key,action,input,actor,providerCall,enabled) {
   // Single-process serialization prevents duplicate provider effects in a concurrent request window.
   return sequential(async()=>{
    const a=state.accounts.find(x=>x.id===id&&x.tenant_id===tenant);
    if(!a)throw new PhoneAccountError("account_not_found",404);
    if(a.version!==version)throw new PhoneAccountError("stale_version",409);
    if(!/^[a-zA-Z0-9_.:-]{12,128}$/.test(String(key||"")))throw new PhoneAccountError("idempotency_key_required");
    if(a.last_idempotency===key)return {account:sanitizeAccount(a),duplicate:true};
    if(a.state==="disabled")throw new PhoneAccountError("account_disabled",423);
    const actions={
      meta:["request-code","verify-code","register"],
      evolution:["create-instance","qr","status"]
    };
    if(!actions[a.provider].includes(action))throw new PhoneAccountError("invalid_provider_action");
    if(!enabled && action!=="status")throw new PhoneAccountError("phone_enrollment_disabled",423);
    const mapped={"request-code":"meta.request-code","verify-code":"meta.verify-code","register":"meta.register","create-instance":"evolution.create","qr":"evolution.qr","status":"evolution.status"}[action];
    const payload={...input,phone_number_id:a.phone_number_id,waba_id:a.waba_id,instance_name:a.instance_name};
    // Never persist PIN, SMS/voice code, pairing secret or QR image.
    const result=await providerCall(mapped,payload);
    const next={ "request-code":"code_requested","verify-code":"verified","register":"registered","create-instance":"awaiting_qr","qr":"awaiting_qr"}[action];
    if(next)a.state=next;
    if(action==="status")a.state=result.state==="open"?"linked":result.state==="close"?"disconnected":a.state;
    a.last_idempotency=key;record(a,"provider_"+action,actor);await persist();
    return {account:sanitizeAccount(a),result,duplicate:false};
   });
  }
 };
}
export function parseAdminIdentity(req,config) {
 if(!fixedTimeSecret(req.headers["x-phone-admin-token"],config.phoneAdminToken))
   throw new PhoneAccountError(config.phoneAdminToken?"unauthorized":"phone_admin_not_configured",config.phoneAdminToken?401:503);
 const tenant=required(req.headers["x-tenant-id"],"tenant_id",/^[a-zA-Z0-9_-]{2,64}$/);
 return {tenant,actor:"phone-console-admin"};
}
export function safeError(error) {
 if(error instanceof PhoneAccountError)return {status:error.status,code:error.code};
 return {status:503,code:"phone_account_service_unavailable"};
}
