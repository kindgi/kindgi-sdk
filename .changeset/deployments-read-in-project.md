---
"@kindgi/api": patch
---

**A deployment is read in the project it serves.** With authorization on, a deployments route asks `read` on the deployment's own project as well as on the tenant. A deployment that names no project is the Default project's.
- **`GET /v1/deployments`** lists only the deployments in projects the caller reads, so a page can hold fewer than `limit` with `hasMore` true: page by `nextCursor`, not by count. `?projectId=` needs `read` on that project, else `403`. One that isn't there is `403` too, the tenant admin's included (before, `200` with no rows), so the list tells no one which projects exist.
- **`GET /v1/deployments/{deploymentId}`, `/pack-env`, `/values` and `POST …/secrets`** answer a deployment in a project the caller doesn't read as one that isn't there: `404 deployment-not-found`, with nothing read or written.
- **A deployment's secrets sync asks `admin` where it writes,** as `/v1/secrets` does: on the deployment's project, else the tenant. Before, it asked for the tenant's admin. So a project admin's `kindgi deploy --project <id> --sync-secrets` now completes: before, the deploy registered and then the sync was refused `403`.
- **A tenant admin reads every deployment, as before,** and a member reads those in the projects where they have a role.
