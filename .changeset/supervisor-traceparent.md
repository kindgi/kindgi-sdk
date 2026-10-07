---
"@kindgi/handler-runtime": patch
---

The pack-service supervisor's front (what `kindgi dev` runs pack code behind) passes the caller's `traceparent` header on to the pack service, as the pack protocol says a pack service gets it. It dropped the header before, so a pack service under `kindgi dev` never saw the run's trace, while the same service called by the runtime directly did.
