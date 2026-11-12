---
"@kindgi/types": patch
---

`@kindgi/types` exports `UUID_RE`, the one check of a UUID id's shape: 8-4-4-4-12 hex digits, any version, either case. The API's id checks, the CLI's project and connection references, the calendar tools' event ids, `KINDGI_PACK_TENANT_ID`'s check and the SDK's webhook event `uuid` format now all use it, and each accepts exactly what it accepted before. `@kindgi/env-schema` now depends on `@kindgi/types` for it, and `@kindgi/types` has no dependencies.
