---
"@kindgi/handler-runtime": patch
---

`PACK_HEADERS.traceparent`'s description no longer says the runtime sends the header today: it's optional, and runtimes send it on every pack call from 0.1.5.
