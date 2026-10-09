# Production identity, messaging and registry safeguards

Production requires NODE_ENV=production, PHONE_AUTH_MODE=oidc, a durable PHONE_ACCOUNTS_FILE, PHONE_OIDC_ISSUER, PHONE_OIDC_AUDIENCE, PHONE_OIDC_CLIENT_ID, and explicit PRODUCTION_GO before any external effect. Startup rejects staging-token mode and unapproved production effects.

Operator phone-account endpoints accept a signed Keycloak RS256 bearer token with nonexpired exp, valid iat/nbf, exact issuer, audience and authorized party, trusted tenant_id, subject and whatsapp_admin/codestra_super_admin role. Callers cannot choose another tenant using the X-Tenant-Id header. JWKS is refreshed on unknown key IDs; unavailable keys fail closed. Tests use locally generated RSA keys, not production credentials.

The WhatsApp message-command endpoint requires the same signed operator identity before effects; the tenant and requested_by fields are derived from token claims, not arbitrary input. Provider effects remain OFF in all deployed environments.

Before any real enrollment action the account store writes a non-secret pending-effect marker to durable storage. A timeout or uncertain provider response leaves needs_reconciliation=true and refuses automatic retries; confirmation and reconciled operator disposition are required before resuming. Successful operations persist a bounded, SHA256-fingerprinted idempotency history (no raw token or PIN). Meta actions require request-code before verify-code before register. No verification code, two-factor PIN or QR image is persisted.

Storage is a single-process file-backed registry, not a horizontally scalable HA database. Atomic file writes and fsync provide local durability, not multi-server locking or disaster recovery. Use scripts/phone-registry-backup.mjs backup SOURCE DESTINATION and verify BACKUPFILE to create/verify mode-0600 snapshots. Offsite encrypted restore certification is still required before promotion.

Production blockers: Keycloak public client is not registered; public Caddy currently strips Authorization (must be replaced with verified OIDC proxy/session model), private Docker network cannot reach public JWKS, no approved Middleware send command, no certified offsite restore, no provider credentials and no production GO.

All sensitive configuration must use protected server secrets; never publish credentials to GitHub, frontend, PR logs or this chat.
