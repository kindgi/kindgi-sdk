---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**`GET /v1/deployments/{deploymentId}/values` lists what a deployment needs set in a project, names only.** Each entry is a `DeploymentValue`:
- **What it lists:** each tool's secrets and env values with no default, a model key for each agent version the deployment ships or carries, and the pack service's own env.
- **How each is read:** where a run in that project reads it, under the env the runtime serves. `foundAt` says where it's set, the project, its org or the tenant, and `problem` says why it isn't ready. It never returns a value.
- **`?projectId=`:** names the project. Without it, it's the deployment's own project, or the tenant's Default project for a tenant-wide deployment.
- **Its own project:** a value counts wherever it's set.
- **Another project, the one a promotion would take it to:** a tool's secret counts only at a scope the caller administers, as a promotion by the caller would record it. So the list says what that promotion's check would.
- **Access:** it needs `admin` on the project, as listing secrets there does, and `read` on the tenant, as every deployments route does.
- **Errors:**
  - `404 deployment-not-found` for an unknown deployment;
  - `404 project-not-found` for a `projectId` that names no project of this tenant;
  - `400 bad-input` for a `projectId` that isn't a project id.
- `@kindgi/cli`: `kindgi exports create` leaves the route out, as it's computed from records an export already holds.
- `@kindgi/client`: `deployments.values.list(deploymentId, { projectId })`. Without `projectId`, the deployment's own project.
