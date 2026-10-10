---
"@kindgi/api": patch
---

**No `/v1` answer is kept by a browser or a proxy.** Every `/v1` response, data and errors alike, says `Cache-Control: no-store`. A `410` is cacheable by default, and a browser kept one through a reload for a flow that had since been reinstated; and an answer is one tenant's data, which no shared cache should hold. A route's own header (an event stream's `no-cache`) gives way to it. Outside `/v1` (the console's assets, the docs, `/health`), the server's own caching stands.
