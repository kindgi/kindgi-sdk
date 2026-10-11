---
"@kindgi/api": patch
"@kindgi/client": patch
---

Who has access to a project, and how: `GET /v1/projects/{projectId}/access` lists everyone the authorization store lets in, people and service accounts, each with their effective role (the highest any way in gives) and every way in. The ways in are:
- `direct`, the principal's own role, with `joinedAt` when a membership stands behind it;
- `team`, a team's grant;
- `org-admin`, an admin of the project's org;
- `tenant-admin`.

Reading it takes `write` on the project (its editors and admins), and emails show to its admins only. It's ordered by role (owner first), then by name, and paged by a cursor. A runtime without an authorization store answers `501 project-access-unsupported`. In TypeScript, `projects.access.list`; in Python, `projects.access.list`. The new optional `ProjectAccessBinding` is what a runtime implements.
