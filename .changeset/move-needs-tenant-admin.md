---
"@kindgi/api": patch
---

**Moving a project or a team into or out of an org takes a tenant admin.** This tightens who may move one: before, a project's admins, its owner among them, or a team's admins could. A move changes which org's admins run it, so it now needs what making one in an org needs.

- A `PATCH /v1/projects/{projectId}` or `PATCH /v1/teams/{teamId}` whose body names `orgId`, even the current org or `null`, also takes admin on the tenant. Without it, the answer is `403 permission-denied` naming `admin` on the tenant, and nothing changes, the other fields in the body included.
- A body without `orgId` takes admin on the project or the team, as before.
