---
"@kindgi/api": patch
---

**A key or session limited to a project can read the default project when it's that project.** `GET /v1/projects/default` names no project in its path, so the limit no longer reads `default` as a project id there. The route answers a limited caller the default project only when it's the caller's own. Otherwise the caller gets the same `403 key-project-mismatch` as before, naming `default` and never the project behind it, with an authorization store or without one, and when the workspace has no default project. Every other request that names a project is checked as before, `default` in an id's place included: `/v1/projects/default/…`, or a change to `/v1/projects/default`.
