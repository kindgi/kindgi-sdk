---
"@kindgi/api": minor
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A shared trigger can run as its project.** `runAsProject: true` on a schedule, webhook or mail trigger (or `--run-as=project`) makes its runs act as the project's own service account, made the first time and given the editor role on the project. It takes a project admin. The account has no keys, its role can't be changed, and it can't be named by id. A tenant admin may unregister it, which stops its triggers until an admin takes each over. A trigger's `owner` says `isProjectAccount: true`, and a service account says `projectId`. Deleting a project unregisters its account.

Release-decision: 0.2.0, the maintainers, 2026-10-22
