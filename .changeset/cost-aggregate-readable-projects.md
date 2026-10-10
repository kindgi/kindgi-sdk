---
"@kindgi/api": patch
---

**The cost aggregate counts only what the caller may read.** `GET /v1/cost/aggregate` across projects (no scope, the tenant, or an org) counts only the projects the caller may read, and records with no project; a tenant admin's counts every project. Before, `read` on the tenant was enough to see every project's spend by project, agent and model.
- A `CostBinding` applies the limit in its query (`CostAggregateInput.readableProjectIds`) and says so (`aggregatesReadableProjects: true`). With a binding that doesn't, an aggregate across projects is answered for a tenant admin and refused (403 `permission-denied`, saying to ask per project) for anyone else.
- The authorizer's `listObjects` applies an API key's limits, as `filterByCan` does: a key limited to one project lists no project but its own. Other types are listed as a check decides them (a key limited to a project still reads the orgs its user reads).
- Memory reads for a key limited to a project work out what it may read by checking, never from the listing: the listing gave every org its user may read, so the key read other orgs' org-wide facts.
