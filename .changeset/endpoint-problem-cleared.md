---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A cleared deployment says whether its pack service comes back, and why it isn't back yet.** Restoring a tenant, project or pack lists its `cleared` deployments as needing a pack service again (`GET /v1/system/deployments?endpoint=missing`). Such a deployment's status stays `cleared` while it waits. Before, a client couldn't tell it from one that's gone for good, and nothing said why it was still waiting.
- **`waiting` or `retired` on every `cleared` endpoint** (`DeploymentEndpoint`, wherever a deployment's endpoint is returned: `GET /v1/deployments`, `GET /v1/deployments/{id}`, `POST /v1/deployments`, and the system routes). `waiting: true` means a pack service is wanted for it again, so one is on its way. `retired` says why none is wanted now, as the orchestrator is told to retire one:
  - `superseded` is for good: no call reaches it again, as when a later deploy shipped every tool version and check this one did;
  - `tenant-closing`, `tenant-suspended`, `project-suspended` and `pack-suspended` last until the tenant, project or pack is restored.

  A `cleared` endpoint carries one of the two, and no other endpoint carries either. Both are optional: an older server sends neither. `retired` is a string, so a later reason doesn't break a client. `SYSTEM_DEPLOYMENT_RETIRE_REASONS` and `SystemDeploymentRetireReason` now come from `@kindgi/api`'s deployment types, with the same names.
- **A problem while it waits:** `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint/problem` records why a `waiting` deployment has no pack service yet, as for a `pending` one, and a refused `PUT …/endpoint` records its reason the same way. A `cleared` deployment that isn't waiting is still refused, `409 endpoint-not-pending`, with a message that says it isn't waiting for a pack service. `problem` shows while a deployment waits (`pending`, or `cleared` and `waiting`): never on a `ready` one, nor on a `retired` one.
- **`kindgi deploy --hosted` waits for a `waiting` one** as it waits for a pending one: `… cleared, waiting for its pack service again`, with the problem's line when there is one. On a `retired` one it stops at once and says why, e.g. on a repeat deploy of a superseded image: `The deployment's pack service was taken down (cleared, superseded): a later deploy ships every tool version and check this one does, so no call reaches it again.` From a server that sends neither, it stops as before, now saying only that the pack service was taken down (cleared), no longer "before it was ready".

The descriptions of `DeploymentEndpoint`, its `problem`, `DeploymentEndpointProblem` and the problem route say so, in `@kindgi/api` and both clients.
