---
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/crypto": minor
"@kindgi/types": minor
---

Outbound webhooks: endpoints that receive a signed `run.finished` event when a top-level run completes, fails or is cancelled.

- `@kindgi/api`:
  - `WebhookEndpointBinding` (caller-plugged) and `/v1/webhook-endpoints`: create (the response carries the signing secret, once), list, get, update, `unregister`, `rotate-secret`, the delivery log (`/deliveries`, with a status filter), `redeliver`, and `test` (queues a `webhook.test` event).
  - Endpoint filter: `projectId`, `flowIds`, `includeDryRuns`. Child runs never produce `run.finished`.
  - Event bodies (`RunFinishedEvent`, `WebhookTestEvent`) carry the run's identity and outcome (`FinishedRun`), never its input or output. The OpenAPI document describes them under `webhooks`.
  - Error codes: `webhook-endpoint-not-found`, `webhook-delivery-not-found` (404), `webhook-url-refused` (400).
- `@kindgi/crypto`: Standard Webhooks signatures (`v1`, HMAC-SHA256): `signWebhook`, `webhookHeaders`, `verifyWebhook` (timestamp tolerance, several signatures during a secret rotation, constant-time comparison) and `generateWebhookSecret` (`whsec_…`). Checked against the reference implementation both ways.
- `@kindgi/client`: `client.webhookEndpoints`. The unused outbound shapes `Webhook`, `WebhookSpec`, `WebhookSecret`, `WebhookDelivery`, `WebhookVerifyResult` and the `WebhookId` / `WebhookDeliveryId` brands are replaced by the generated wire types and `WebhookEndpointId`; `SubscriptionSpec`'s webhook target is `{ kind: 'webhook', endpoint }`.
- `@kindgi/types`: `WebhookEndpointId` and `WebhookEventId`. `WebhookId` is documented as what it is: the routable id of an inbound webhook trigger.
