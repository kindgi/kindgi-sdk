---
"@kindgi/env-schema": patch
---

**`KINDGI_DB_POOL_SIZE`** (runtime 0.7.0 on): how many connections the server's database pool holds, per server process, 10 by default. A whole number from 1 to 262143 (Postgres's own ceiling on `max_connections`); anything else stops the boot, naming the variable. Its description says what has to fit under the database's `max_connections`: every server process's pool, counting the old ones during a deploy, the connections a system tenant purge and the admin commands open outside it, anything else on the same database server, and a reserve.
