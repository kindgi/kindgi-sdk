---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A deploy can go into a named project, one per client.**
- **`POST /v1/deployments` takes an optional `projectId`.** The deployment's agents, flows, tools and guardrails are registered in that project, and the deployment records it (`projectId`), so its secret sync writes there too.
  - It needs admin on that project. An API key limited to another project is `403 key-project-mismatch`.
  - An id that isn't a project id is `400`; one of no project of the tenant is `404 project-not-found`.
  - Without it, a deploy is tenant-wide, into the Default project, as before.
  - Nothing deploys into a suspended project (the named one, or the Default): `409 project-suspended`, before anything is written, where the app is given `projectSuspended`.
  - `Deployment.projectId` and `DeploymentRegisterInput.projectId` carry it to a binding.
- **A deploy whose ids already live in another project** is `409` (`tool-project-mismatch` and the like) as before. The message now names the fix: one pack per client, a copy made with `kindgi init`, whose ids carry its own pack id.
- **Where pack check calls are routed by id** (a runtime that wires `systemDeployments`), a deploy refuses a pack check whose id doesn't start with its pack's id (`<packId>.`), as `400 deployment-validation-failed`, naming the fix. Elsewhere the build's warning stays the only word.
- **`kindgi deploy --project <id or slug>`.** A slug is looked up among the tenant's projects; one that names none, or several (two orgs may share a slug), is refused before anything is sent, naming the ids. The `Idempotency-Key` follows the project.
- **The WooCommerce template's README** says one project and one pack per client.
