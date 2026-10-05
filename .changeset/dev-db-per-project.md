---
"@kindgi/cli": minor
---

`kindgi dev` gives each project its own database in the bundled Postgres, `kindgi_<project>`, with its own dev tenant and user. A linked git worktree gets `kindgi_<project>__<worktree>`, so branches on different Kindgi versions never share a schema.

- **The project's name:** `project` in the Kindgi config (`kindgi.config.ts`, or `project` under `[tool.kindgi]` in `pyproject.toml`), else the git repository's, the workspace root's or the pack folder's. The boot log names it.
- **A database belongs to the folder that made it:** another folder whose project has the same name is refused until it sets its own `project`. A moved folder takes its database with it.
- **`--reset` drops the project's database** after asking. `--yes` skips the question, and with no terminal to ask on it refuses. A database passed with `--database-url` is never dropped.
- **Shared:** every pack of one project shares the database and the tenant. Each keeps its own tools, pack service and env files.
- **The shared `kindgi` database** earlier releases used is left as it is. The first boot says so, once.
