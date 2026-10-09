import { readFileSync } from "node:fs";
﻿export function loadConfig(env = process.env) {
  const mode=env.PHONE_AUTH_MODE || (env.NODE_ENV==="production"?"oidc":"staging-token");
  if(!["oidc","staging-token"].includes(mode))throw new Error("PHONE_AUTH_MODE invalid");
  if(env.NODE_ENV==="production" && mode!=="oidc")throw new Error("production requires OIDC operator authentication");
  if(env.NODE_ENV==="production" && (env.PHONE_ACCOUNTS_FILE||":memory:")===":memory:")
    throw new Error("production requires durable phone account storage");
  if(env.NODE_ENV==="production" && (!env.PHONE_OIDC_ISSUER || !env.PHONE_OIDC_CLIENT_ID))
    throw new Error("production OIDC issuer and client must be configured");
  if(env.NODE_ENV==="production" && (env.PHONE_ENROLLMENT_EFFECTS_ENABLED==="true" || env.WHATSAPP_PRODUCTION_SEND==="true" || env.WHATSAPP_EXTERNAL_RECIPIENTS==="true") && env.PRODUCTION_GO!=="YES")
    throw new Error("production effects require explicit separate GO approval");
  return Object.freeze({
    port: Number(env.PORT || 8782),
    phoneAdminToken: env.PHONE_ADMIN_TOKEN || (env.PHONE_ADMIN_TOKEN_FILE ? readFileSync(env.PHONE_ADMIN_TOKEN_FILE,"utf8").trim() : ""),
    phoneAuthMode: env.PHONE_AUTH_MODE || (env.NODE_ENV==="production"?"oidc":"staging-token"),
    phoneOidcIssuer: env.PHONE_OIDC_ISSUER || "",
    phoneOidcAudience: env.PHONE_OIDC_AUDIENCE || "codestra-whatsapp",
    phoneOidcClient: env.PHONE_OIDC_CLIENT_ID || "codestra-whatsapp-frontend",
    phoneProductionGo: env.PRODUCTION_GO === "YES",
    phoneBackupVerified: env.PHONE_BACKUP_VERIFIED === "true",
    phoneAccountsFile: env.PHONE_ACCOUNTS_FILE || ":memory:",
    phoneEnrollmentEnabled: String(env.PHONE_ENROLLMENT_EFFECTS_ENABLED || "false").toLowerCase() === "true",
    adapterEnrollmentUrl: env.ADAPTER_ENROLLMENT_URL || "http://evolution-adapter:8781",
    adapterServiceKey: env.ADAPTER_SERVICE_KEY || (env.ADAPTER_SERVICE_KEY_FILE ? readFileSync(env.ADAPTER_SERVICE_KEY_FILE,"utf8").trim() : ""),
    productionSend: String(env.WHATSAPP_PRODUCTION_SEND || "false").toLowerCase() === "true",
    bulkSend: String(env.WHATSAPP_BULK_SEND || "false").toLowerCase() === "true",
    aiAutoreply: String(env.WHATSAPP_AI_AUTOREPLY || "false").toLowerCase() === "true",
    externalRecipients: String(env.WHATSAPP_EXTERNAL_RECIPIENTS || "false").toLowerCase() === "true",
    middlewareBaseUrl: env.MIDDLEWARE_BASE_URL || "http://middleware-integration-api:8095",
    middlewareCommandPath: env.MIDDLEWARE_COMMAND_PATH || "/platform/v1/commands",
    middlewareCommandType: env.MIDDLEWARE_COMMAND_TYPE || "",
    middlewareTarget: env.MIDDLEWARE_TARGET || "",
    middlewareCapability: env.MIDDLEWARE_CAPABILITY || ""
  });
}
