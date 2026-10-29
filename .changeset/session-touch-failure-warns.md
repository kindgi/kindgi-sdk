---
"@kindgi/api": patch
---

**A session's activity that the store couldn't record is now a warning, and the next request records it again.** The auth middleware records a session's activity (`touch`, for the inactivity timeout) at most once a minute, without holding the request. A `touch` that rejected used to be dropped without a word, and the session waited out the minute before its activity was recorded again. It's now logged as a warn under `http` with the request's ids, `tenantId` and `err`, never the session id: `the session's activity wasn't recorded: its inactivity timeout still counts from the touch before, and its next request touches again`. A failed query in `err` is logged as `A database query failed.`, without its SQL or values. The session's next request touches again. The request is answered as before.

The binding interfaces now say that a store write that fails rejects, and that the route answers 500. That covers the agent, flow, tool and eval-suite `unregister` and `reinstateVersion`, the eval-suite `publish`, the env `delete`, and the MCP endpoint and reviewer `unregister`. `touch` rejects too, but it has no route: its failure is the warning above. `touched: false`, `unregistered: false`, `deleted: false` and `not-found` say what's there, never a write that failed.
