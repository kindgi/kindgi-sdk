---
"@kindgi/api": patch
---

**A key limited to a project never acts as the operator.** On a runtime serving one tenant, minting a key that is limited to a project and holds `kindgi:system` is now refused, `403 capability-not-mintable` (`details.capabilities`), as it already was on a runtime serving many tenants. A key or session limited to a project that already holds `kindgi:system` keeps its project's access but not the operator's: `GET /v1/license` answers it as any key of its workspace, never with the operator's fields, and `GET /v1/license/usage` refuses it, `403 license-operator-only`. The runtime logs a warning naming such a key on each request (`system-capability-dropped`, with its `projectId`): revoke it, and mint its replacement without `kindgi:system` or without the project. Keys and sessions not limited to a project, and the runtime's own token, are unchanged.
