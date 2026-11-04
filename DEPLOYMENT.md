# Deployment design — appolon1908/WhatsApp

This repository is classified as **product-domain-service** and remains independently deployable. It owns the WhatsApp business-policy API, including recipient eligibility and business validation; Middleware owns provider adapters and transport authority.

## Canonical integration boundary

WhatsApp message ingress follows **Caddy -> Kong -> WhatsApp policy API POST /platform/v1/whatsapp/messages -> Middleware :8095 POST /platform/v1/commands**. The application checks production-send and external-recipient switches, command registration, consent, suppression and opt-out before command submission. This repository keeps its own domain/runtime ownership and must not become a duplicate command authority or call providers directly.

## Detected deployment assets

- Dockerfile/Containerfile detected: **false**
- Compose detected: **false**
- Kubernetes/Helm detected: **false**
- Health/readiness signal detected: **true** (`GET /healthz` and `GET /readyz` in `src/server.mjs`)

The values above describe the current repository tree. They do not claim a runtime is deployed.

`/healthz` reports application and command-authority metadata. `/readyz` reports safe mode and whether a Middleware command type is configured; it does not probe Middleware or certify provider readiness. The WhatsApp command family still requires reviewed registration before sends, as described in README.md.

## Required deployment gates

1. Build from an immutable Git SHA and, where containerized, record the immutable image digest.
2. Keep provider/business effects disabled by default, including `WHATSAPP_PRODUCTION_SEND=false`, until the repository-specific production certification passes.
3. Consume secrets by OpenBao/governed references only; do not commit credentials or copy secret values into evidence.
4. Validate the implemented `/healthz` and `/readyz` endpoints in staging and separately verify dependency readiness before activation. Current status: **implemented-source-only**; deployment and provider readiness remain uncertified.
5. Keep /internal/* and /metrics private; expose public APIs only through the reviewed Caddy/Kong route.
6. Record staging deployment, API/readback, observability and rollback evidence before production promotion.
7. Rollback must identify the prior SHA/image/config and must not require provider effects to validate.
8. Cross-repo provider-changing effects must be issued through the Middleware command lifecycle with idempotency and readback/reconciliation.

## Next implementation step

This document and .codestra/deployment-contract.json are the deployment-design authority. Any missing deployment artifact (Docker/Compose/Kubernetes or deployment probe configuration) must be added in a repo-owned implementation PR only when that runtime is actually required; do not invent an unused deployment stack. Reuse the existing application health/readiness endpoints and verify their operational limits during staging certification.
