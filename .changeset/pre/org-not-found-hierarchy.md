---
"@kindgi/platform": patch
"@kindgi/api": patch
---

Creating a project or team with an `orgId` that names no org of the tenant (one that never existed, or a deleted one), or moving one there, answers `404 org-not-found` (`No org with id "<id>"`), as `GET /v1/orgs/{id}` does, instead of a 500. `ProjectCreateOutcome`, `ProjectUpdateOutcome`, `TeamCreateOutcome` and `TeamUpdateOutcome` gain `org-not-found`, and so do `CreateProjectError` and `CreateTeamError` (the authorized path). The in-memory bindings check orgs when given `orgExists`.
