---
"@kindgi/env-schema": patch
---

**`KINDGI_ERASURE_LEDGER_EXPORT`** (runtime 0.1.10 on): each copy also names every tenant marked purged, by id and when it was created, and a new one is written when that changes too. After a restore, `kindgi-runtime tenants repurge` reads the newest copy here by default and purges those tenants again, even one whose purge record is gone.
