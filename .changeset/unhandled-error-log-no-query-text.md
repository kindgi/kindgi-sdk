---
"@kindgi/api": patch
---

**A thrown error's log line no longer carries a failed database query's SQL, its parameters, or a value the server quotes as rejected.**

A 500's body already said only `A database query failed.`. But its `unhandled error` log line wrote the thrown error's message and stack, and its causes'. Two of those messages carry a request's values:
- Drizzle's wrapper around a failed query has the message `Failed query: <sql> params: <values>`, a person's email or address among them.
- A Postgres data exception (SQLSTATE class 22) quotes the value it rejected: `invalid input syntax for type uuid: "…"`, `invalid input value for enum …: "…"`.

A read's `database busy` warn line wrote them the same way. Both lines now write:
- **such a wrapper** as `A database query failed.`. That entry keeps the wrapper's name, code and stack frames (where the query ran), and its cause, the database driver's error.
- **a data exception** as what it means plus its SQLSTATE, for example `invalid input for its type (22P02)`, with its name, code and stack frames.

This holds for the thrown error itself and for each cause the line writes, three deep. Every other error keeps its name, message, code and stack, including the driver's error when it isn't a data exception. An error with neither among those causes is logged exactly as before, and the thrown errors themselves aren't changed.
