---
'@kindgi/api': patch
'@kindgi/platform': patch
---

**A create made with a key that has no person behind it, such as a service account's, no longer makes the all-zeros id `00000000-0000-0000-0000-000000000000` its creator.** It makes no one its creator, as publishing a flow, a tool, a guardrail or an eval suite already did. That covers creating an org, a team or a project, publishing an agent, and deriving an agent version (by hand, or from a proposal). The tenant's admins reach what it made through its parent, as before. A person's key still makes them the project's or agent's owner, or the org's or team's admin.
- `TenantHierarchyBinding`'s `CreateOrgParams`, `CreateTeamParams` and `CreateProjectParams` take `creatorUserId` as optional. When it's absent, no one is made the org's or team's admin or the project's owner.
