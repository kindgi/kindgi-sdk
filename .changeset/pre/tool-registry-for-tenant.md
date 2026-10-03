---
"@kindgi/tools": minor
"@kindgi/agents": minor
---

Tool lookups are bound to one tenant: `ToolRegistry.forTenant(tenantId)` replaces `hydrate`.

- `@kindgi/tools`: `ToolRegistry.hydrate?(tenantId): Promise<void>` is replaced by a required `forTenant(tenantId): Promise<ToolRegistry>` that returns a registry answering for that tenant only. With `hydrate` followed by the tenant-less `resolve`, a multi-tenant implementation had to keep a shared "current tenant", so two tenants' concurrent agent turns could resolve each other's tools. `createToolRegistry` (single-tenant) returns itself; `invalidate(tenantId)` is unchanged. Implementations must add `forTenant` (breaking for custom `ToolRegistry` implementations).
- `@kindgi/agents`: each turn resolves its tools through `toolRegistry.forTenant(tenantId)` (`resolveTurnTools`).
