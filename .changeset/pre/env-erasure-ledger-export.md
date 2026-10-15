---
"@kindgi/env-schema": patch
---

**Three runtime settings, for keeping and using a backup's erasures:**
- **`KINDGI_ERASURE_LEDGER_EXPORT`:** `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`. The server writes the erasure ledger of every tenant it serves there (keyed hashes only, never whom an erasure names), so erasures can be replayed after a backup restore. It writes a new file when the ledger changes, and at least one a day, and never overwrites or deletes one.
- **`KINDGI_ERASURE_LEDGER_EXPORT_INTERVAL_MS`:** how often it writes. Default an hour, at least a minute, and it needs `KINDGI_ERASURE_LEDGER_EXPORT`.
- **`KINDGI_PASSIVE`:** `on` boots a server that does nothing on its own, for looking at a restored backup before anyone uses it. No background work starts and no email goes out. Requests are still served, so keep a passive server where only you can reach it.

The runtime's `--help` lists them.
