---
"@kindgi/platform": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A deleted project is kept, and a workspace admin can restore it.** `DELETE /v1/projects/{projectId}` no longer erases the project: from then on it's gone from every read, and nobody can reach what's in it, but nothing in it is erased.
- **Gone:** fetching or changing it answers `404 project-not-found`, and it's out of `GET /v1/projects`, a person's projects, and its members' and team grants' lists. Deleting it again answers `204` and keeps the time of the first delete.
- **Kept:** what's in it, its members and team grants, the keys limited to it, and its own account (a delete no longer unregisters the account). They reach nothing while it's deleted, and come back with a restore.
- **Its slugs stay its own,** old and current: creating a project, or changing one's slug, onto one of them answers `409 slug-conflict` with a new optional `details.deletedProject: true`.
- **The workspace's default project can't be deleted:** `409 project-is-default` (`details.projectId`).
- **`POST /v1/projects/{projectId}/restore`** brings a deleted project back as it was and answers the project; a project that isn't deleted answers unchanged, and an unknown one `404 project-not-found`. **`GET /v1/projects/deleted`** lists the workspace's deleted projects, newest first, a page at a time (the new `DeletedProject` schema: `id`, `tenantId`, `orgId`, `name`, `slug`, `formerSlugs`, `deletedAt`). Both are for workspace admins, and anyone else is refused `403`. A runtime that can't restore projects answers both `501 project-restore-unsupported`.
- **A webhook delivery to a deleted project** is answered `202` with `skipped: 'project-deleted'`, and nothing is kept. `createApp` takes a new optional `projectDeleted(tenantId, projectId)` that says whether a project is deleted.
- **A system deployment retired because its project was deleted** says `reason: 'project-deleted'`.
- **`ProjectBinding`:** `delete` keeps the project, marked deleted, and answers `project-is-default` for the workspace's default; `get`, `list`, `getDefault` and `update` treat a deleted project as gone, and `create` and `update` answer `slug-conflict` with `deletedProject: true` onto its slugs. New optional `restore` (`ProjectRestoreOutcome`) and `listDeleted` (`DeletedProject`). The in-memory binding does all of it, and the conformance suite checks a deleted project's rules, and, with `restore: true`, the restore and the list.
- **Clients:** `projects.restore(projectId)` and `projects.listDeleted()` in the TypeScript client, `projects.restore` and `projects.list_deleted` in the Python client, and the same methods in the Java client.
