import { createPhoneStore, PhoneAccountError } from "./phone-accounts.mjs";
import { createPhoneAuthorizer } from "./phone-auth.mjs";
import { pathToFileURL } from "node:url";
﻿import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "./config.mjs";
import { DomainError, evaluateEligibility, requireString, validateCampaign } from "./domain.mjs";
import { submitMiddlewareCommand } from "./middleware.mjs";

const MAX_BODY = 1024 * 1024;

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new DomainError("payload_too_large", "request body exceeds 1 MiB", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new DomainError("invalid_json", "request body must be valid JSON", 400);
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function createApp(config = loadConfig(), dependencies = {}) {
  const phoneStore = dependencies.phoneStore || createPhoneStore(config.phoneAccountsFile);
  const authorizer = dependencies.phoneAuthorizer || createPhoneAuthorizer(config,dependencies.authOptions);
  async function callEnrollment(action,input) {
    if(dependencies.callEnrollment)return dependencies.callEnrollment(action,input);
    if(!config.adapterServiceKey)throw new PhoneAccountError("adapter_auth_not_configured",503);
    const url=new URL("/internal/v1/whatsapp/enrollment/execute",config.adapterEnrollmentUrl);
    let response;
    try{
      response=await fetch(url.toString(),{method:"POST",headers:{"content-type":"application/json","x-enrollment-service-key":config.adapterServiceKey},
        body:JSON.stringify({action,input}),signal:AbortSignal.timeout(12000)});
    }catch{throw new PhoneAccountError("enrollment_adapter_unreachable",503);}
    let body;try{body=await response.json();}catch{throw new PhoneAccountError("enrollment_adapter_invalid",503);}
    if(!response.ok)throw new PhoneAccountError(body?.error?.code||"enrollment_adapter_rejected",response.status);
    return body.result;
  }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, {
          status: "ok",
          service: "codestra-whatsapp-app",
          command_authority: "middleware-v3",
          middleware_base_url: config.middlewareBaseUrl
        });
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        return json(res, 200, {
          status: "ready",
          safe_mode: !config.productionSend,
          middleware_command_type_configured: Boolean(config.middlewareCommandType),
          registry_dependency: config.middlewareCommandType ? null : "Middleware V3 WhatsApp command family must be registered before sends"
        });
      }

      if (req.method === "POST" && url.pathname === "/platform/v1/whatsapp/contacts/eligibility") {
        const body = await readJson(req);
        return json(res, 200, evaluateEligibility(body));
      }

      if (req.method === "POST" && url.pathname === "/platform/v1/whatsapp/campaigns/validate") {
        const body = await readJson(req);
        const result = validateCampaign(body);
        return json(res, result.valid ? 200 : 422, result);
      }

      if(req.method==="GET" && url.pathname==="/internal/v1/whatsapp/phone-auth-config") {
        res.setHeader("cache-control","no-store");
        return json(res,200,{mode:config.phoneAuthMode,
          issuer:config.phoneAuthMode==="oidc"?config.phoneOidcIssuer:null,
          client_id:config.phoneAuthMode==="oidc"?config.phoneOidcClient:null,
          audience:config.phoneAuthMode==="oidc"?config.phoneOidcAudience:null,
          production_go:false});
      }
      if(req.method==="GET" && url.pathname==="/internal/v1/whatsapp/phone-readiness") {
        await authorizer.authorize(req);
        res.setHeader("cache-control","no-store");
        const gates={
          oidc_required:config.phoneAuthMode==="oidc",
          durable_store:config.phoneAccountsFile!==":memory:",
          backup_certified:config.phoneBackupVerified,
          middleware_command_configured:Boolean(config.middlewareCommandType),
          messaging_off:!config.productionSend&&!config.externalRecipients&&!config.bulkSend&&!config.aiAutoreply,
          enrollment_effects_off:!config.phoneEnrollmentEnabled
        };
        return json(res,200,{status:Object.values(gates).every(Boolean)?"ready_for_staged_activation":"blocked",
          production_approved:false,gates});
      }
      const accountRoot="/internal/v1/whatsapp/phone-accounts";
      if(url.pathname===accountRoot || url.pathname.startsWith(accountRoot+"/")) {
        // Always authorize before parsing or revealing account existence.
        const identity=await authorizer.authorize(req);
        res.setHeader("cache-control","no-store");
        res.setHeader("x-content-type-options","nosniff");
        if(url.pathname===accountRoot) {
          if(req.method==="GET")return json(res,200,{items:await phoneStore.list(identity.tenant)});
          if(req.method==="POST") {
            const body=await readJson(req);
            if(body.tenant_id!==identity.tenant)throw new PhoneAccountError("tenant_mismatch",403);
            const item=await phoneStore.create(body,identity.actor);
            return json(res,201,item);
          }
          return json(res,405,{error:{code:"method_not_allowed"}});
        }
        const suffix=url.pathname.slice(accountRoot.length+1);
        const parts=suffix.split("/");
        if(!/^[0-9a-f-]{36}$/.test(parts[0]))return json(res,404,{error:{code:"not_found"}});
        if(parts.length===1){
          if(req.method==="GET")return json(res,200,await phoneStore.get(parts[0],identity.tenant));
          if(req.method==="PATCH"){
            const body=await readJson(req);
            const expected=Number(body.expected_version);
            if(!Number.isInteger(expected))throw new PhoneAccountError("expected_version_required",400);
            return json(res,200,await phoneStore.update(parts[0],identity.tenant,expected,body.patch||{},identity.actor));
          }
          return json(res,405,{error:{code:"method_not_allowed"}});
        }
        if(parts.length===3&&parts[1]==="actions"&&req.method==="POST"){
          const body=await readJson(req),v=Number(body.expected_version);
          if(!Number.isInteger(v))throw new PhoneAccountError("expected_version_required",400);
          const result=await phoneStore.action(parts[0],identity.tenant,v,req.headers["idempotency-key"],parts[2],
             body.input||{},identity.actor,callEnrollment,config.phoneEnrollmentEnabled);
          return json(res,200,result);
        }
        return json(res,404,{error:{code:"not_found"}});
      }

      if (req.method === "POST" && url.pathname === "/platform/v1/whatsapp/messages") {
        const body = await readJson(req);
        if (!config.productionSend) {
          return json(res, 423, {
            error: { code: "whatsapp_production_send_disabled", message: "External WhatsApp effects are disabled by default", retryable: false }
          });
        }
        if (!config.externalRecipients) {
          return json(res, 423, {
            error: { code: "external_recipients_disabled", message: "External recipients are disabled", retryable: false }
          });
        }
        if (!config.middlewareCommandType) {
          return json(res, 503, {
            error: { code: "middleware_whatsapp_command_unregistered", message: "Set MIDDLEWARE_COMMAND_TYPE only after the V3 registry entry is reviewed and deployed", retryable: false }
          });
        }

        // Never accept browser-supplied tenant or actor as command authority.
        const operator=await authorizer.authorize(req);
        if(operator.authMode!=="oidc")
          throw new PhoneAccountError("oidc_required_for_messaging",403);
        if(body.tenant_id && body.tenant_id!==operator.tenant)
          throw new PhoneAccountError("tenant_mismatch",403);
        if(body.requested_by && body.requested_by!==operator.actor)
          throw new PhoneAccountError("actor_mismatch",403);
        body.tenant_id=operator.tenant;
        body.requested_by=operator.actor;

        const eligibility = evaluateEligibility({
          recipient: body.recipient,
          consent_status: body.consent_status,
          suppressed: body.suppressed,
          opted_out: body.opted_out
        });
        if (!eligibility.eligible) {
          return json(res, 403, { error: { code: "recipient_not_eligible", reasons: eligibility.reasons, retryable: false } });
        }

        requireString(body.tenant_id, "tenant_id");
        requireString(body.requested_by, "requested_by");
        requireString(body.idempotency_key, "idempotency_key", 8);
        requireString(body.recipient, "recipient");

        body.command_id ||= crypto.randomUUID();
        body.correlation_id ||= crypto.randomUUID();
        if (!body.message || typeof body.message !== "object") throw new DomainError("invalid_request", "message is required", 400);

        const authorization = req.headers.authorization;
        const result = await (dependencies.submitMiddlewareCommand || submitMiddlewareCommand)(config, body, authorization);
        return json(res, result.status, {
          command_authority: "middleware-v3",
          command_id: body.command_id,
          correlation_id: body.correlation_id,
          middleware: result.middleware
        }, { location: result.middleware?.operation_id ? `/platform/v1/operations/${result.middleware.operation_id}` : "" });
      }

      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : error instanceof PhoneAccountError ? error.status : 500;
      return json(res, status, {
        error: {
          code: error.code || "internal_error",
          message: error instanceof PhoneAccountError ? error.code : error.message,
          retryable: false
        }
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  createApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ service: "codestra-whatsapp-app", port: config.port, production_send: config.productionSend }));
  });
}
