---
"@kindgi/api": patch
---

OpenAPI descriptions (`openapi.json`, tag and operation text) now describe what each route does and nothing outside the package: corrected status codes and pagination notes (e.g. deployment secret sync answers `404 secret-not-found`; tenant `GET /config` returns a single page; identity-provider registration is not idempotent), no runtime-internal tables, bridges or adapters, and no roadmap notes. Paths, operations, schemas and status codes are unchanged.
