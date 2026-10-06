---
"@kindgi/client": patch
---

The published types export each name once. Sixteen names (`ConversationMessage`, `EvaluationResult`, `Fact`, `GeneratedWebhookSecret`, `MessageRole`, `ProvidersClient`, `ReviewerRole`, `RevokeSigningKeyResult`, `RunFinishedEvent`, `TrustedSigningKey`, and the `Webhook*` types `WebhookDelivery`, `WebhookDeliveryStatus`, `WebhookEndpoint`, `WebhookEvent`, `WebhookSecretRef` and `WebhookTestEvent`) were exported twice, beside an internal type of the same name. With `skipLibCheck: false`, an app no longer gets `TS2484`; with it on, `ConversationMessage`, `EvaluationResult`, `Fact` and `ProvidersClient` now mean the client's own types, where they could resolve to the internal ones.
