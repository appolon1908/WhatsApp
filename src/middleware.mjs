import { DomainError, requireString } from "./domain.mjs";

// Routing identifiers are hints; only the adapter-owned verified binding authorizes a sender.
function channelContext(input) {
  const result = {};
  for (const name of ["provider", "instance_id", "phone_number_id", "channel_id", "binding_revision"]) {
    if (typeof input[name] !== "string" || !/^[\x21-\x7e]{1,200}$/.test(input[name])) {
      throw new DomainError("invalid_channel_context", "Complete channel context is required", 400);
    }
    result[name] = input[name];
  }
  if (!["meta", "evolution"].includes(result.provider)) {
    throw new DomainError("invalid_channel_context", "Unsupported channel provider", 400);
  }
  return result;
}

export async function submitMiddlewareCommand(config, input, authorization) {
  const commandType = requireString(config.middlewareCommandType, "MIDDLEWARE_COMMAND_TYPE");
  const tenantId = requireString(input.tenant_id, "tenant_id");
  const requestedBy = requireString(input.requested_by, "requested_by");
  const idempotencyKey = requireString(input.idempotency_key, "idempotency_key", 8);
  const correlationId = requireString(input.correlation_id, "correlation_id");
  const commandId = requireString(input.command_id, "command_id");
  const campaignId = requireString(input.campaign_id, "campaign_id");
  requireString(authorization, "Authorization");
  const routing = channelContext(input);

  const envelope = {
    command_id: commandId,
    command_type: commandType,
    command_version: "1.0",
    tenant_id: tenantId,
    requested_by: requestedBy,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    payload: {
      channel: "whatsapp",
      campaign_id: campaignId,
      recipient: input.recipient,
      ...routing,
      message: input.message,
      business_context: input.business_context ?? {}
    }
  };
  if (config.middlewareTarget) envelope.target = config.middlewareTarget;
  if (config.middlewareCapability) envelope.capability = config.middlewareCapability;

  const url = new URL(config.middlewareCommandPath, config.middlewareBaseUrl).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "x-correlation-id": correlationId,
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(10000)
  });

  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

  return {
    ok: response.ok,
    status: response.status,
    envelope,
    middleware: body
  };
}
