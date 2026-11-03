---
"@kindgi/specs": patch
"@kindgi/flow": patch
"@kindgi/tools": patch
"@kindgi/capabilities": patch
"@kindgi/guardrails": patch
"@kindgi/provenance": patch
"@kindgi/handler-runtime": patch
"@kindgi/types": patch
"@kindgi/agents": patch
"@kindgi/compliance": patch
"@kindgi/audit-events": patch
"@kindgi/memory": patch
---

The spec schemas' descriptions, the doc text of the types a pack author reads, and the indexer's `check-id-unprefixed` warning call the place a workspace, as the console does. The policy spec's title is Workspace policy. What you type keeps `tenant`: `tenantId`, the `kindgi-tenant-id` header, `KINDGI_PACK_TENANT_ID`, the scope and context-slot value `tenant`, and error codes such as `pack-tenant-mismatch`. So does the multi-tenant text: a cross-tenant call is still refused by that name.
