---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A deployment waiting for its pack service again, once a suspension is lifted, says why it has none yet.** Restoring a tenant, project or pack lists its `cleared` deployments as needing a pack service again (`GET /v1/system/deployments?endpoint=missing`). Such a deployment's status stays `cleared` while it waits, and now:
- **takes a problem:** `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint/problem` records why it has none yet, as for a `pending` one, and a refused `PUT …/endpoint` records its reason the same way. A `cleared` deployment that isn't listed as needing one (superseded, or its tenant, project or pack suspended) is still refused, `409 endpoint-not-pending`, with a message that says it isn't waiting for a pack service;
- **shows it:** `problem` is on a `cleared` endpoint too, wherever a deployment's endpoint is returned (`GET /v1/deployments`, `GET /v1/deployments/{id}`, and the system routes). A `ready` one has none, and setting the endpoint clears it.

The descriptions of `DeploymentEndpoint.problem`, `DeploymentEndpointProblem` and the problem route say so, in `@kindgi/api` and both clients.
