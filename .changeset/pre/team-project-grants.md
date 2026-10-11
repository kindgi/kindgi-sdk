---
"@kindgi/api": patch
"@kindgi/platform": patch
"@kindgi/client": patch
---

A team can have a role on a project. `POST /v1/projects/{projectId}/team-grants` gives one (`viewer`, `editor` or `admin`; a team never owns a project), and every member of the team then holds it there. Giving it takes `admin` on the project and `read` on the team. Adding a role the team already holds answers `201` with the existing grant; another is `409 team-grant-exists` (`details.role`). `PATCH` and `DELETE …/team-grants/{teamId}` change and remove it. `GET …/team-grants` lists a project's, and `GET /v1/teams/{teamId}/project-grants` a team's; each grant names its team and project. In TypeScript, `projects.teamGrants` and `teams.projectGrants`; in Python, `projects.team_grants` and `teams.project_grants`.

Who sees who has access: listing a project's members or team grants takes `write` on the project (its editors and admins), so a viewer no longer sees who else works there. Listing a team's members or its projects takes `admin` on the team. Everyone reads their own roles through their grants.

Re-adding a project or team member with another role is `409 membership-exists`, naming the role they hold (`details.role`), which is kept. The same role answers `201` as before. With authorization on, deleting a team takes its tuples with it (its members' roles and its project grants).

`@kindgi/platform`:
- `TeamProjectRole` is new.
- The membership add outcomes and the hierarchy's add errors gain `membership-exists`.
- `TeamProjectGrant` gains `grantedAt`, and its binding an optional `get`.
- `TenantHierarchyBinding` gains optional `addTeamProjectGrant`, `updateTeamProjectGrantRole`, `removeTeamProjectGrant` and `deleteTeam`.
