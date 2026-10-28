---
"@kindgi/api": patch
"@kindgi/client": patch
---

**New read `GET /v1/runtime`: which runtime answers.** It answers `200 RuntimeInfo`:
- `version`: the runtime's release, such as `0.3.0`, or what its build gave otherwise (`dev` when it gave none);
- `hosting`: `hosted`, a runtime serving many tenants, or `self-hosted`, one serving one;
- `development`: whether it runs in development mode, which allows development-only settings.

Any caller of a tenant reads it, with no right asked. A caller who isn't signed in gets `401`, and a system key `403 system-key-on-tenant-route`, as on `GET /v1/tenant`.
- `CreateAppInput` gains an optional `runtime` (`RuntimeInfoInput`: `version` and `development`): the host says which runtime it is. `hosting` follows from `tenancy`: `multi` answers `hosted`, and `single` or none `self-hosted`. Without it, the route isn't mounted (`404`), as on a runtime that doesn't report it.
- The TypeScript client gains `runtime.get()`, and the Python client `runtime.get`.
