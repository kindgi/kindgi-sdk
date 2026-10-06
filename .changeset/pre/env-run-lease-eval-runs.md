---
"@kindgi/env-schema": patch
---

`KINDGI_RUN_LEASE_MS` and `KINDGI_RUN_SWEEP_INTERVAL_MS` say they cover eval runs too: a running eval run holds the same executor lease, and when its server stops without a shutdown, the sweep ends it `failed`, interrupted, with its finished cases kept.
