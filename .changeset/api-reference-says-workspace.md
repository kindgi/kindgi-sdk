---
"@kindgi/api": patch
"@kindgi/client": patch
---

The API reference (the OpenAPI document's summaries and descriptions) and the TypeScript client's docs call the place a workspace, as the console and the CLI do. What you match on or send keeps `tenant`: the error codes, `tenantId`, the scope value `tenant`, the schema and operation names, the tags and the paths. So do the tenant admin role (`Admin@tenant`) and the system routes, which are for the operator of a runtime that serves several workspaces.
