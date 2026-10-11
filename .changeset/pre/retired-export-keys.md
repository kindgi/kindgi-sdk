---
"@kindgi/crypto": patch
"@kindgi/env-schema": patch
---

Retired export keys: after the export signing key rotates, the old public keys can stay listed, so an export signed before still verifies with `kindgi exports verify --from-runtime`.
- **`@kindgi/crypto`:** `parseRetiredExportKeys(pemBundle)` reads one or more PEM public keys (Ed25519 or EC P-256), under the ids their signers use. A private key, another kind of block, an unreadable block or another kind of key is refused, naming the block's position. `withRetiredExportKeys(binding, keys)` lists them after the binding's own keys; the active key and `sign` stay the binding's, so a retired key never signs.
- **`@kindgi/env-schema`:** `KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS_PATH` (a file of PEM public keys) and `KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS` (its base64), at most one. The runtime reads them; `GET /v1/export-signing-keys` then lists the retired keys after the active one, with `active: false`. Its response shape doesn't change.
