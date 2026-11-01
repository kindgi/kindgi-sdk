---
"@kindgi/runtime": patch
---

**A new single-tenant runtime names its workspace "Default workspace", with a `workspace-…` slug.** Before, it was "Default tenant", with a `tenant-…` slug.

- A workspace that already exists keeps its name and slug. To rename it, use `kindgi tenant rename --name=<name> --slug=<slug>`, Rename on the workspace's home page in the console, or `PATCH /v1/tenant`.
- That includes a `kindgi dev` project's workspace. With the bundled Postgres, `kindgi dev --reset` starts the project on a new database, whose workspace gets the new name.
