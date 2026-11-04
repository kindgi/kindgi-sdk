---
"@kindgi/api": patch
---

A key or a session limited to a project is refused, `403 key-project-mismatch`, when a write's body names another project as `scopeKind: 'project'` with `scopeId` (the body that registers an MCP endpoint), or as `improve.projectId` (an Improve schedule's target), as it already was for a body's `projectId` and `scope.projectId` and for the query's `scopeKind` and `scopeId`. It's also refused, with the same code, when it sets or clears the tenant's or an org's environment order, which lists other projects. A runtime with an authorization store already refused all of these through the key's grants; one without a store now does too. With a store, the environment order's refusal for such a key now answers `key-project-mismatch` rather than `permission-denied`.
