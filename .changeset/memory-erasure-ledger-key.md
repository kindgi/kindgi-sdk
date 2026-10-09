---
"@kindgi/env-schema": patch
"@kindgi/api": patch
"@kindgi/cli": patch
---

Memory erasure (T273 M-5): the erasure ledger has its own key, `KINDGI_ERASURE_LEDGER_KEY_PATH` or `KINDGI_ERASURE_LEDGER_KEY` (32 bytes, the same form as the secrets AAD key), read whatever the secrets backend. It replaces the secrets AAD key as the source of the ledger's keyed hash: set it to make erasures replayable after a backup restore. `erasure-unmatchable` and `kindgi doctor`'s `erasures` check name it.
