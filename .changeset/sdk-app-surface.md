---
"@kindgi/sdk": minor
---

An application lists `@kindgi/sdk` and `@kindgi/cli` (dev) and needs no other `@kindgi/*` package:

- `@kindgi/sdk/client` re-exports `subscribeToRun` and `followRun` (with `SubscribeToRunOptions`, `FollowRunOptions`, `RunProgressEvent`, `RunProgress`), so a browser page follows a run from the sdk.
- New `@kindgi/sdk/webhooks` (server only): `verifyWebhook`, `generateWebhookSecret`, `isStrongWebhookSecret`, `signWebhook`, `webhookHeaders` and the webhook constants and types, re-exported from `@kindgi/crypto`. It stays out of the flat barrel, since it uses `node:crypto`.

The run-events doc and the flows and guardrails skills import from the sdk.
