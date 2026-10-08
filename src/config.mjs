import { readFileSync } from "node:fs";
﻿export function loadConfig(env = process.env) {
  return Object.freeze({
    port: Number(env.PORT || 8782),
    phoneAdminToken: env.PHONE_ADMIN_TOKEN || (env.PHONE_ADMIN_TOKEN_FILE ? readFileSync(env.PHONE_ADMIN_TOKEN_FILE,"utf8").trim() : ""),
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
