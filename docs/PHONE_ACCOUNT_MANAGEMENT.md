# Codestra WhatsApp phone-account control plane (staging)

The **WhatsApp** repository owns authoritative phone-account registry state, tenant scoping, revisions and audit events. The provider adapter owns remote Meta and Evolution HTTP translations. The frontend **never** calls provider APIs directly.

## Internal API contract

All endpoints are private behind a separate `X-Phone-Admin-Token` and a validated `X-Tenant-Id` (independent of Caddy Basic Auth). Never commit, echo or store that token in the browser. Configuration loads a mounted, restricted `PHONE_ADMIN_TOKEN_FILE` from the host, or test-only `PHONE_ADMIN_TOKEN`.

- `GET /internal/v1/whatsapp/phone-accounts`: tenant-scoped list, masked phone numbers.
- `POST /internal/v1/whatsapp/phone-accounts`: create draft (`provider=meta|evolution`, label, tenant ID, optional campaign ID, Meta WABA/phone IDs or Evolution instance name).
- `GET /internal/v1/whatsapp/phone-accounts/:id`: scoped read.
- `PATCH /internal/v1/whatsapp/phone-accounts/:id`: restricted label/campaign update or disable, with `expected_version`. Cannot mark an account linked manually.
- `POST /internal/v1/whatsapp/phone-accounts/:id/actions/:action`: request-code, verify-code, register (Meta) or create-instance, qr, status (Evolution), with `expected_version` and `Idempotency-Key`. External enrollment calls are denied with HTTP 423 unless `PHONE_ENROLLMENT_EFFECTS_ENABLED=true` **and** the private adapter `PROVIDER_ENROLLMENT_ENABLED=true`.

Successful registry changes are fsync-backed and atomically written under `PHONE_ACCOUNTS_FILE`. Records include UUID, tenant, provider, non-secret IDs, state, version, timestamps and bounded audit history. Phone numbers are masked in API responses; verification codes, two-factor PINs, Meta tokens, Evolution keys and QR images are **never persisted**. Duplicate number/instance/Meta ID registration is rejected; stale writes return 409. Unknown tenant gets no records.

## Deployment

`/opt/codestra-whatsapp-phone-preview` on Server 3 hosts a separate release candidate, leaving the previous staging stack untouched for rollback. Secret files are mounted read-only inside the API and adapter, and the phone registry uses a dedicated writable data mount. Never place credentials in Compose source or container environment values. Use restrictive directory permissions and a container-readable, root-group protected secret file. No other Codestra services or databases are modified.

The HTTPS frontend gateway only exposes `/api/phone-accounts` and its descendants with strict method allowlists and limits, always protected by the separate administrator token. It does not expose provider or message effect routes.

**No production authorization.** Real Meta Embedded Signup and phone ownership verification must be completed by the business. Official Meta API enrollment additionally requires an approved Meta app/system-user access token, WABA/Phone Number IDs and an operator-provided verification code / six-digit PIN. Evolution QR pairing additionally requires a trusted upstream Evolution API and physical scanning in WhatsApp Linked Devices. The use of the unofficial Evolution/Baileys channel has platform-compliance risks; prefer official Meta for business messaging.

Staging has `WHATSAPP_PRODUCTION_SEND=false`, `WHATSAPP_BULK_SEND=false`, `WHATSAPP_EXTERNAL_RECIPIENTS=false`, `WHATSAPP_AI_AUTOREPLY=false`, `PHONE_ENROLLMENT_EFFECTS_ENABLED=false`. Testing registration code and QR actions therefore returns HTTP 423. Even if an account is later linked, **sending must remain disabled** until Middleware V3 authorization, provider configuration, Keycloak RBAC, webhook validation and production release gates are independently approved.

## Verification

Run `node --test` for the unit and state-machine tests, plus frontend browser acceptance. Verify wrong admin tokens receive 401, cross-tenant reads are empty, duplicate numbers receive 409, stale revisions receive 409, and both provider-effect paths receive 423 in staging. Restart the business API and verify recorded drafts persist. Do not validate using a real user's number or send messages.
