---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Per-deployment routing's system routes, on a runtime serving many tenants.** Whatever runs each deployment's own pack service (an orchestrator, holding a `system:deployments` key) learns which deployments need one or should lose theirs, and records where each runs. No tenant input ever names a pack's URL.
- **`GET /v1/system/deployments?endpoint=missing|retire`:** across tenants, oldest first, ids and the image only: the tenant, the deployment, its pack (`packId`) and, when the deploy was scoped to one, its project. Each `retire` entry says why: `superseded`, `tenant-closing`, `tenant-suspended`, `project-suspended` or `pack-suspended`.
- **Registration hands a binding what routing needs:** `DeploymentRegisterInput` gains the optional `packId` (the image index's) and `packChecks` (the check ids its pack service runs, not built-ins a guardrail merely names).
- **`PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint`** `{ url, auth, token }`, which checks:
  - the URL is `https://<host>` (`endpoint-url-invalid`);
  - its host is on the operator's allowlist (`endpoint-host-not-allowed`);
  - its host names the deployment's own service, `packServiceName(tenantId, deploymentId)` then `-` or `.` (`endpoint-name-mismatch`; skipped when the operator's names setting is `any`);
  - the image is in the tenant's repository (`image-not-allowed`);
  - the pack service answers as this deployment (`endpoint-unreachable`, `endpoint-info-mismatch`).

  Each refusal is also recorded as the endpoint's `problem`, which the tenant sees as a code. It's refused for a closing or suspended tenant, project or pack. No answer or access record carries the URL or the token.
- **`DELETE …/endpoint`:** clears it, for a closing tenant too, so calls fail closed.
- **`PUT …/endpoint/problem`** `{ code }`: why a pending deployment has no pack service yet, one of `DEPLOYMENT_ENDPOINT_PROBLEM_CODES`.
- **`PUT …/deployments/{deploymentId}/suspended`** `{ suspended, reason? }`: suspends or restores a pack. It takes `system:suspend`, which the orchestrator's key doesn't hold.

Every route checks its scope before reading a body. `createApp` takes them as `systemDeployments` (with `systemTenantDirectory`), and `@kindgi/api` exports the binding's types. The TypeScript client gains `client.systemDeployments`, and the Python client the same operations.
