---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/capabilities": patch
"@kindgi/env-schema": patch
"@kindgi/guardrails": patch
"@kindgi/provenance": patch
"@kindgi/schema": patch
---

The server's messages call the place a workspace, as the console and the CLI do. Among them are the lookups that find nothing in it, the slug conflicts, its limits and policies (the model router's reasons among them), its render and compile budgets, and the pack service's `KINDGI_PACK_TENANT_ID` checks. What you match on keeps `tenant`: the error codes, `tenantId`, the scope value `tenant` and the paths. So do the tenant admin role and the system routes' messages, which are for the operator of a runtime that serves several workspaces. A rename's answer follows its route: `PATCH /v1/tenant` says workspace, and the operator's `PATCH /v1/system/tenants/{tenantId}` says tenant.
