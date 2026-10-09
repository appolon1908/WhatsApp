import crypto from "node:crypto";
import { PhoneAccountError, parseAdminIdentity } from "./phone-accounts.mjs";

const safeText = value => typeof value === "string" && value.length > 0 && value.length <= 256;
function deny(code,status=401){throw new PhoneAccountError(code,status);}
function jwtPart(raw){
 if (!/^[A-Za-z0-9_-]+$/.test(raw)||raw.length>10000)deny("invalid_access_token");
 try{return JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));}catch{deny("invalid_access_token");}
}
export function createPhoneAuthorizer(config,{fetcher=fetch,clock=()=>Math.floor(Date.now()/1000)}={}) {
 let cached={at:0,keys:[]};
 async function jwks(){
   const now=clock();
   if(cached.keys.length && now-cached.at<300)return cached.keys;
   if(!config.phoneOidcIssuer?.startsWith("https://") ||
      !/^https:\/\/[^/?#]+\/realms\/[A-Za-z0-9_-]+$/.test(config.phoneOidcIssuer))deny("oidc_issuer_invalid",503);
   let response;
   try{
     const uri=config.phoneOidcIssuer+"/protocol/openid-connect/certs";
     response=await fetcher(uri,{headers:{accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(6000)});
   }catch{deny("oidc_jwks_unavailable",503);}
   if(!response.ok)deny("oidc_jwks_unavailable",503);
   let body;try{body=await response.json();}catch{deny("oidc_jwks_invalid",503);}
   if(!Array.isArray(body.keys) || body.keys.length>40)deny("oidc_jwks_invalid",503);
   const rsa=body.keys.filter(x=>x.kty==="RSA" && x.use!=="enc" && (!x.alg||x.alg==="RS256") &&
      typeof x.kid==="string"&&x.kid.length<=128&&x.n&&x.e);
   if(!rsa.length)deny("oidc_jwks_invalid",503);
   cached={at:now,keys:rsa};return rsa;
 }
 async function authorize(req){
   if(config.phoneAuthMode==="staging-token")return parseAdminIdentity(req,config);
   if(config.phoneAuthMode!=="oidc")deny("phone_auth_not_configured",503);
   const header=String(req.headers.authorization||"");
   if(!/^Bearer [A-Za-z0-9_\-.]+$/.test(header)||header.length>9000)deny("bearer_required");
   const raw=header.slice(7),parts=raw.split(".");
   if(parts.length!==3)deny("invalid_access_token");
   const jwtHeader=jwtPart(parts[0]),claims=jwtPart(parts[1]);
   if(jwtHeader.alg!=="RS256"||!safeText(jwtHeader.kid))deny("invalid_access_token");
   const key=(await jwks()).find(j=>j.kid===jwtHeader.kid);
   if(!key)deny("jwt_signing_key_unknown");
   let verified=false;
   try{
     const publicKey=crypto.createPublicKey({key,format:"jwk"});
     verified=crypto.verify("RSA-SHA256",Buffer.from(parts[0]+"."+parts[1]),publicKey,Buffer.from(parts[2],"base64url"));
   }catch{deny("invalid_access_token");}
   if(!verified)deny("invalid_access_token");
   const now=clock(),skew=30;
   if(claims.iss!==config.phoneOidcIssuer)deny("invalid_issuer");
   if(!Number.isInteger(claims.exp)||claims.exp<=now-skew)deny("token_expired");
   if(!Number.isInteger(claims.iat)||claims.iat>now+skew)deny("invalid_token_time");
   if(claims.nbf!==undefined&&(!Number.isInteger(claims.nbf)||claims.nbf>now+skew))deny("token_not_active");
   if(!(Array.isArray(claims.aud)?claims.aud.includes(config.phoneOidcAudience):claims.aud===config.phoneOidcAudience))deny("invalid_audience");
   if(claims.azp!==config.phoneOidcClient)deny("invalid_authorized_party");
   if(!safeText(claims.sub))deny("invalid_subject");
   const tenant=claims.tenant_id;
   if(!safeText(tenant)||!/^[-_A-Za-z0-9]{2,64}$/.test(tenant))deny("tenant_claim_missing");
   const supplied=req.headers["x-tenant-id"];
   if(supplied!==undefined && supplied!==tenant)deny("tenant_mismatch",403);
   const realm=Array.isArray(claims.realm_access?.roles)?claims.realm_access.roles:[];
   const clientRoles=Array.isArray(claims.resource_access?.[config.phoneOidcClient]?.roles)?claims.resource_access[config.phoneOidcClient].roles:[];
   const roles=new Set([...realm,...clientRoles]);
   if(!roles.has("whatsapp_admin")&&!roles.has("codestra_super_admin"))deny("phone_admin_role_required",403);
   return {tenant,actor:claims.sub,authMode:"oidc"};
 }
 return {authorize};
}
