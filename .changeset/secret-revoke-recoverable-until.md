---
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A hard revoke says when the secret manager kept a recoverable copy, and until when.** Azure Key Vault keeps a deleted secret recoverable for the vault's retention period when it can't be purged.
- **`DELETE /v1/secrets/{name}?hard=true`** answers `recoverableUntil` (ISO 8601) next to `revoked` and `hard`: when the secret manager purges that copy on its own. Setting the same name again before then can keep that copy, its values disabled, until the name is hard-revoked again. It's absent on a soft revoke, and when a hard revoke left nothing recoverable. It's optional, so a client that doesn't know it is unaffected.
- **The `secret-hard-revoked` record** carries `recoverableUntil` too.
- **The reference:** the `secrets.revoke` description and its `hard` parameter say what a hard revoke erases, and that `recoverableUntil` says until when a recoverable copy is kept.
- **For backends:** `SecretProviderDeleteOutput` and `SecretRevokeOutcome` gain an optional `recoverableUntil`, and `emitLifecycleEvent` takes one.
- **Clients:** the TypeScript client's `SecretRevokeOutcome` and the Python client's `SecretRevokeResult` gain the optional `recoverableUntil`.
- **`kindgi secrets revoke --hard`** prints until when your secret manager keeps the copy, and puts `recoverableUntil` in its JSON.
