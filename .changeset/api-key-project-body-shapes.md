---
"@kindgi/api": patch
---

A key or a session limited to a project is refused, `403 key-project-mismatch`, when a write's body names another project as `scopeKind: 'project'` with `scopeId` (the body that registers an MCP endpoint), or as `improve.projectId` (an Improve schedule's target), as it already was for a body's `projectId` and `scope.projectId` and for the query's `scopeKind` and `scopeId`. A runtime with an authorization store already refused these through the key's grants; one without a store now does too.
