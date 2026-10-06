---
"@kindgi/env-schema": patch
---

New server setting `KINDGI_RETENTION_SWEEP_INTERVAL_MS`, off by default: when set, the runtime purges deleted rows on its own on that interval, in every tenant it serves. It purges the tombstones past their retention policy's grace, as `POST /v1/retention/sweep` does, keeps holds (`graceSeconds: -1`), and logs what it purged. Unset, nothing purges on its own, as before. At least 60000 (one minute).
