---
"@kindgi/cli": patch
---

`kindgi key trust <keyId>` adds a local key's public key to the runtime's trust list in one step, and `kindgi key revoke <keyId> [--reason]` removes it. Trusting no longer takes a shell pipeline: the runtime wants the 32 raw bytes, which `trust` sends, not the SPKI form `kindgi key export --format=base64` prints (unchanged). A refusal because the id is bound to another key, or was revoked, says to trust a key under a new id.
