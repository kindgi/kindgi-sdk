---
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A hard revoke says when the secret manager kept a recoverable copy, and until when.** Azure Key Vault keeps a deleted secret recoverable for the vault's retention period when it can't be purged.
- **`DELETE /v1/secrets/{name}?hard=true`** answers `recoverableUntil` (ISO 8601) next to `revoked` and `hard`: when the secret manager purges that copy on its own. It's absent when nothing recoverable is left, which is every other case. It's optional, so a client that doesn't know it is unaffected.
- **The `secret-hard-revoked` record** carries `recoverableUntil` too.
- **For backends:** `SecretProviderDeleteOutput` and `SecretRevokeOutcome` gain an optional `recoverableUntil`, and `emitLifecycleEvent` takes one.
- **Clients:** the TypeScript client's `SecretRevokeOutcome` and the Python client's `SecretRevokeResult` gain the optional `recoverableUntil`.
- **`kindgi secrets revoke --hard`** prints until when your secret manager keeps the copy, and puts `recoverableUntil` in its JSON.
