---
"@kindgi/env-schema": patch
---

**Three server settings for the timeouts on the runtime's own database connections** (runtime 0.1.9 on). Each is in milliseconds, and 0 turns it off. Anything but a whole number up to 2147483647 stops the boot, naming the variable.
- **`KINDGI_DB_STATEMENT_TIMEOUT_MS`:** how long one statement may run (`statement_timeout`), 60000 by default. The migrations at boot, an index built `CONCURRENTLY` and the admin commands run with none.
- **`KINDGI_DB_LOCK_TIMEOUT_MS`:** how long a statement may wait for a lock (`lock_timeout`), 30000 by default. It must be shorter than the statement timeout when both are on.
- **`KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`:** how long a transaction may sit idle between statements (`idle_in_transaction_session_timeout`), 30000 by default.
