---
"@kindgi/api": patch
"@kindgi/cli": patch
---

A schedule, webhook trigger or mail trigger registered without a `projectId` by an API key or session limited to a project goes in that project, not the workspace's default project. With an authorization store, such a registration was refused unless the default project was the key's own; it now succeeds in the key's project. Keys and sessions limited to no project still register in the default project. On a runtime without an authorization store, a key or session limited to a project is refused, `403 key-project-mismatch` (`details.keyProjectId`, `details.projectId`), any change to another project's schedule, webhook trigger or mail trigger by its id: updating, pausing, resuming, unregistering, running a schedule now, or taking a trigger over. A runtime with a store is unchanged and still answers `permission-denied`. Reading another project's trigger by its id stays as it was without a store. The CLI's `--project` help for `schedules`, `webhooks` and `mail-triggers` registration says where a trigger goes without it.
