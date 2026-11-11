---
"@kindgi/api": patch
---

Under a project-only key scope, `POST /v1/deployments` takes only a build made for the body's project: its signed `builtFrom` names that project, it's marked promote-only (`productionEntry`) and signed by a trusted key whose id starts with `kindgi-promote-only:`, and whoever asked for it (`builtFrom.requestedBy`, a user) holds `write` on the project, as the server's own authorizer answers for them, whatever the caller's own rights. Anything else is refused with `403 permission-denied`, and nothing is deployed. A project in production refuses the build with `409 promote-only-build`, as it refuses every promote-only build. A server with no authorizer refuses a deploy under the scope with `500 internal-server-error`. Without the scope, nothing changes.
