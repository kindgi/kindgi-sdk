---
"@kindgi/api": patch
---

**A 500 whose cause carries a database error says `A database query failed.`** An unhandled exception's 500 used to say it only when the thrown error was itself Drizzle's wrapper around a failed query. It now says it when a database error is the thrown error or anywhere down its `cause` chain, up to 16 errors deep counting the thrown error. A database error is any of these:

- Drizzle's wrapper around a failed query.
- A Postgres server error: a SQLSTATE `code` with a `severity`, as postgres.js's `PostgresError` carries.
- An error postgres.js made when a connection failed, timed out or ended: `CONNECT_TIMEOUT`, `CONNECTION_CLOSED`, `CONNECTION_DESTROYED` or `CONNECTION_ENDED`.

So a storage failure that wraps the driver's error in its own now says `A database query failed.`, where it said `Unhandled server error`. A socket's own error, such as `ECONNREFUSED`, still says `Unhandled server error`, because an HTTP client throws those too. The status, the code and the log line are unchanged, and a read the database was too busy for still answers `503 database-busy`.
