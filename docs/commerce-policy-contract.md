# Commerce policy submission contract

This contract implements the narrow request/acknowledgement boundary described by
[the commerce architecture](WHATSAPP-COMMERCE-ARCHITECTURE.md), originally proposed
in [PR #23](https://github.com/appolon1908/WhatsApp/pull/23). Middleware V3 retains
authorization, durable command/idempotency storage, execution, retry, DLQ and
reconciliation authority. The Policy API never calls a provider directly.

## Request

`POST /platform/v1/whatsapp/messages` with JSON and
`Authorization: Bearer <integration-token>`:

```json
{
  "tenant_id": "22222222-2222-4222-8222-222222222222",
  "requested_by": "commerce-worker",
  "command_id": "11111111-1111-4111-8111-111111111111",
  "correlation_id": "commerce-correlation-1",
  "idempotency_key": "commerce-message-1",
  "recipient": "15550000000",
  "instance_id": "verified-account-1",
  "message": {"type": "text", "text": "Order received"},
  "consent_verified": true,
  "opted_out": false,
  "campaign_id": "approved-campaign-1",
  "business_context": {
    "source": "commerce",
    "consent_evidence": "consent-record-1"
  }
}
```

The identifiers above are test fixtures, not configured identities or campaigns.
Middleware must authenticate the token with `platform.command` scope, authorize
its tenant and campaign, and verify that `requested_by` equals the token subject.
The API forwards the token; a caller's consent or campaign field is not permission
to bypass Middleware policy.

Existing callers can use `consent_status: "opted_in"`. An explicitly supplied
canonical status always takes precedence, including null, blank, unknown and
negative statuses. Only when that property is absent does strict boolean
`consent_verified: true` supply opted-in evidence. Truthy strings do not qualify.
`suppressed: true` and `opted_out: true` independently deny the request before any
Middleware submission. The separate contacts/eligibility endpoint continues to
use canonical `consent_status`.

`campaign_id` is a required nonblank string. It is validated before the network
call and forwarded in the command's `payload.campaign_id`.
`business_context.campaign_id` does not replace it. The API preserves existing
command, correlation and idempotency references and sends matching tenant,
correlation and idempotency headers to `/platform/v1/commands`. The command type
must be configured as the reviewed/deployed `whatsapp.message.send.v1` family.

Supply command and correlation IDs before the first attempt and reuse them, along
with the same idempotency key and payload, after an ambiguous outcome. Legacy
requests may still omit command/correlation IDs and receive generated UUIDs;
commerce workers must supply their durable outbox identifiers.

## Acknowledgement and retry

HTTP 200, 201 or 202 is accepted only when the actual Middleware JSON object has
the matching submitted `command_id` and a nonblank `operation_id` string of at most
200 characters. Comparison uses the command ID actually forwarded after the
existing whitespace trimming. Hyphenated, compact hexadecimal, braced and
`urn:uuid:` UUID forms compare by value across letter casing because Middleware
serializes UUIDs in lowercase. Other references remain case-sensitive. The
top-level command ID retains the caller's original representation for compatibility.
Commerce callers should use canonical lowercase, hyphenated UUIDs. The response
exposes the actual durable operation ID at the top
level and keeps the original Middleware acknowledgement nested for existing clients:

```json
{
  "command_authority": "middleware-v3",
  "command_id": "11111111-1111-4111-8111-111111111111",
  "correlation_id": "commerce-correlation-1",
  "operation_id": "11111111-1111-4111-8111-111111111111",
  "middleware": {
    "operation_id": "11111111-1111-4111-8111-111111111111",
    "command_id": "11111111-1111-4111-8111-111111111111",
    "state": "QUEUED",
    "correlation_id": "commerce-correlation-1",
    "duplicate": false
  }
}
```

Middleware currently returns 202 for a new command and 200 for an exact duplicate.
The state comes from its ledger. Acceptance is not evidence of provider delivery.
The Policy API never derives an operation ID from the request. `Location` contains
the operation path with the actual identifier encoded as one path segment; this
service does not implement operation reads. Use the approved Middleware readback
boundary for operation status.

A missing/mismatched/malformed successful ACK, including an unsupported 2xx status,
returns HTTP 502 with `error.code: "middleware_ack_invalid"` and
`error.retryable: true`. Upstream contents are not included in that error. The
operation may already exist: retry the original identifiers and payload. Ordinary
non-success Middleware status codes and their nested response bodies are retained.
Consumers should treat 408, 429 and server errors as potentially retryable; policy
and authorization denials require correction rather than a new command identity.

## Controls and deployment dependencies

The effective Policy send controls remain `WHATSAPP_PRODUCTION_SEND=false` and
`WHATSAPP_EXTERNAL_RECIPIENTS=false`, with an empty command type also blocking
submission. This change does not alter any defaults. `WHATSAPP_BULK_SEND` and
`WHATSAPP_AI_AUTOREPLY` are loaded configuration flags but are not checked by the
current messages route. The bot separately keeps `COMMERCE_OUTBOUND_ENABLED=false`.

The loopback tests prove this request/ACK mapping and preservation of denial paths.
Before controlled staging integration, the promoted Middleware deployment still
needs the WhatsApp handler/registry, a real authorized integration identity and
campaign, durable replay/readback evidence, verified tenant/channel credentials,
and a normalized ingress bridge using the bot's Commerce HMAC and delivery
correlation contract. Provider webhook authentication must fail closed when its
signing configuration is absent.

Caller `provider` and `phone_number_id` fields are currently accepted metadata but
are not forwarded by this Policy API. The reviewed Middleware adapter selects a
global provider and the Meta adapter selects global phone credentials. Those
fields therefore cannot establish tenant isolation or select a real channel.
The separate ingress, provider routing and deployment gates remain unresolved by
this compatibility patch. No live channel, provider call or production effect is
needed for its tests.

Verification in an isolated checkout: `npm test`,
`node --check src/server.mjs`, and `node --check src/middleware.mjs`.
