---
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/crypto": minor
---

Webhook endpoints reference their signing secret by name instead of generating and returning one.

- `@kindgi/api`:
  - Endpoints take `secretRef: { envName, name }`, a secret in the deployment's secrets store (resolved at tenant scope), like a provider's `secret_ref`. The secret is shared with the receiver, so it lives with the deployment's other secrets: `.env` in development, the secrets store in production. Endpoints show `secretRef`; `secretHint` is gone.
  - Create and update check that the secret exists and is strong (`400 webhook-secret-not-found`, `400 webhook-secret-too-weak`). `create` returns the endpoint (no secret).
  - `POST /v1/webhook-endpoints/generate-secret` returns a strong secret to store; nothing is kept.
  - `POST /v1/webhook-endpoints/{endpointId}/rotate-secret` and `WebhookEndpointWithSecret` are removed: rotating is rotating the referenced secret (`POST /v1/secrets/{name}/rotate`), and for a day deliveries are signed with both versions.
- `@kindgi/client`: `webhookEndpoints.create` takes `secretRef` and returns the endpoint; `webhookEndpoints.generateSecret()`; `rotateSecret` is removed.
- `@kindgi/crypto`: `isStrongWebhookSecret` and `WEBHOOK_SECRET_MIN_BYTES` (24).
