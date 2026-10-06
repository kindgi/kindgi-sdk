---
"@kindgi/api": patch
"@kindgi/audit-events": patch
"@kindgi/audit-events-inmemory": patch
"@kindgi/client": patch
---

`GET /v1/audit/authz` takes `?order=asc|desc`. `asc` (the default, as before) lists the oldest decisions first; `desc` lists the newest first, and `nextCursor` continues in the same order. Any other value is `400 bad-input`. The TypeScript client's `audit.authz.list({ order })` and the Python client's `audit.authz.list(order=…)` send it. `AuditEventBinding.query` takes an optional `order` (`AuditEventOrder`); the in-memory binding implements it, and a binding that doesn't pages oldest first.
