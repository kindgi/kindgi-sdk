---
"@kindgi/api": patch
---

**A system-deployment entry's `projectId` is described as the deployment's own project.** In `GET /v1/system/deployments`, the OpenAPI description of `SystemDeploymentEntry.projectId`, the `SystemDeploymentEntry.projectId` doc and the Python client's model now say that it's the project the deployment named, else the tenant's Default, and that it's absent only when the tenant has no Default project. They no longer say it's absent for a tenant-wide deploy. No shape changes.
