---
"@kindgi/api": patch
---

**A deployment's digest identity now includes its project, and a deployment records the one it was promoted from.** `DeploymentGetByImageDigestInput` takes an optional `projectId`: a digest is looked up within that project, or — absent — among the tenant-wide deployments (the tenant's Default project). A deployment that names no project and one that names the tenant's Default by its id are the same project for this lookup and for `register`'s idempotency check, so the same signed image is registered once per project however the Default is named. The same signed image can still be registered in more than one project, so a later environment can take it by promotion rather than a fresh build. `Deployment` gains an optional `promotedFromDeploymentId`: when a deployment was created by promoting another, the source deployment's id; absent for one registered directly.
