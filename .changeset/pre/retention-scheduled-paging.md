---
"@kindgi/client": patch
"@kindgi/api": patch
---

`GET /v1/retention/scheduled` pages like the other lists. `limit` caps the rows per domain, and the page now says `hasMore` when some domain has more than it returned, with a `nextCursor` to pass back as `cursor` when the runtime can continue. Both clients take `cursor`, so Python's `paginate(client.retention.scheduled, …)` pages through. Against a runtime that doesn't page yet, the API derives `hasMore` from whether a domain filled `limit`, and the TypeScript client from whether a `nextCursor` came.
