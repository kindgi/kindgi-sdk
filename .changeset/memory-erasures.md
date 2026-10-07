---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/runtime": patch
---

Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. An erasure clears, in the background, a person's (or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`.
