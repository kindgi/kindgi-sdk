---
"@kindgi/api": patch
---

`GET /v1/tenant/config` needs admin on the workspace, like `/v1/env` and `/v1/secrets` reads. A caller without it gets `403 permission-denied`, as on those routes. So does a `member` API key, or a key limited to a project, even when its holder is an admin.
