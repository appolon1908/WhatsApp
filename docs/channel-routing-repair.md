# Verified channel-routing repair

## Scope and boundaries
This is a new repair of the published commerce foundation, not recovery of the unpushed SaaS candidate. Source validation is not independent approval, controller admission, staging certification, or production activation. All live effects remain off. Middleware owns authentication, durable command deduplication, retry and reconciliation; the bot owns commerce state. No direct-send fallback or new credential vault is introduced.

## Required end-to-end sender context
A command carries `tenant_id`, `channel_id`, `binding_revision`, `provider`, `instance_id` (provider account/instance), and `phone_number_id`. All identifiers are printable ASCII, 1–200 characters, and provider is `meta` or `evolution`. Middleware must verify the authenticated tenant and service subject, bind the command to this exact sender context, preserve it across durable retries, and forward it with matching tenant/command/idempotency headers to the provider adapter. Caller fields are constraints, never proof of ownership.

`binding_revision` is an opaque verified-ownership generation, not a token or provider secret. A new verification, ownership reassignment, or sender change must mint a new value. The bot's `Channel.verification_reference` and the operator-verified adapter binding must match. Reusing a revision for a different sender is forbidden.

## Remaining blocking integration work
The inspected Middleware WhatsApp adapter still selects a service-wide provider and does not preserve the full sender tuple. Its authorized owner must complete the required owner/preflight/certification workflow before changing that lane. These repairs deliberately reject missing context; deploy neither a partial sending chain nor a global-fallback workaround. The real deployed Middleware bridge, signed ingress, restart-safe deduplication, asynchronous command/operation correlation, and provider ownership still require acceptance.

## Release order
Keep bot `COMMERCE_OUTBOUND_ENABLED`, Policy `WHATSAPP_PRODUCTION_SEND` / `WHATSAPP_EXTERNAL_RECIPIENTS`, Middleware external-delivery gates, and adapter `EXTERNAL_SEND_ENABLED` false. Publish reviewed task branches through the required hierarchy. Verify every actual remote SHA and exact-head CI. Run the admitted pair/chain on isolated PostgreSQL and a verified, approved test channel. Record queued, acknowledged, delivered, and failed separately. Production remains disabled until distinct approvals, commerce backup/restore evidence and staging certification exist.
