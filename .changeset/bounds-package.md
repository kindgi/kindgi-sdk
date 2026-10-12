---
"@kindgi/bounds": patch
---

**New package: `@kindgi/bounds`,** the limits a Kindgi server puts on what a tenant sends it, so that one tenant's input can't stall the server for the others: a pattern's length and engine, a schema's size and depth (and how many compiled ones are kept), a template's limits, the size and idle time of a body read from an endpoint a tenant names, and a request body's size and JSON depth.
- `TenantInputBounds`, `SELF_HOSTED_BOUNDS` (today's behaviour, with generous caps) and `HOSTED_BOUNDS` (patterns on linear-time RE2, and tight limits).
- `configureTenantInputBounds(bounds)` sets the process's bounds once, at boot; a second call throws. `tenantInputBounds()` reads them; self-hosted until set.
- `@kindgi/bounds/testing`'s `overrideTenantInputBounds` runs a test with other bounds.
