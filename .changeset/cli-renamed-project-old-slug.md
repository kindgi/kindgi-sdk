---
"@kindgi/cli": patch
---

**A command that names a project by a slug it had before it was renamed is refused, and the refusal names the new slug and where to change it.** That's `kindgi deploy --project`, `kindgi deployments list --project`, `kindgi promote` (`--from` and `--to` outside a pack, and the pack's environments in one), `kindgi environments set` (`--projects`, and the pack's environments), and `kindgi secrets` and `kindgi env` under a pack environment (`--env`). A slug one project has and another had before a rename is refused as naming two projects: pass the id. On a runtime that keeps no old slugs, nothing changes.
