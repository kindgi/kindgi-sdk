---
"@kindgi/api": patch
"@kindgi/client": patch
---

An API key can be minted to only read: `POST /v1/tokens` takes `readOnly: true`. Every request such a key makes, other than a `GET` or a `HEAD`, is refused with `403 read-only-key` before any route runs. The one exception is a pin gate's check, which writes nothing. The rule holds on a runtime with no authorization store too, and the authorizer holds such a key to `read` as well. The key mints and revokes no keys, its own included, and opens no console session. The key's record carries `readOnly`. The permissions answer (`key.readOnly`) and whoami (`readOnly`) say whether the caller's key only reads; a key that only reads shows as a viewer on each of its projects. If a runtime's key store doesn't keep the field, the key is revoked at once and the mint answers `501 read-only-unsupported`, so a full key is never handed out in its place.

In the TypeScript client, `tokens.create` takes `readOnly`, a key read with `tokens.get` or `tokens.list` carries `readOnly: true` when it only reads, and `users.me()` carries `readOnly` beside a key's id.
