---
"@kindgi/cli": patch
---

`kindgi doctor` checks whether this machine and folder are ready to run Kindgi. Each check says what it found and, when it fails, the exact command or step that fixes it, as the folder runs it (`pnpm exec kindgi …`, `npx --no kindgi …`, or `npx @kindgi/cli@<version> …` outside a project). Any failed check exits 1.

The checks, in order:
- Node (22.12 or later) and npm;
- Python (3.11 or later) and uv, required in a Python project and otherwise reported as installed or not;
- Docker running, and pull access to the pinned runtime image;
- the project (`kindgi.config.ts`, or a `pyproject.toml` with `[tool.kindgi]`; `.kindgirc.json`) and its dependencies;
- a model key in `.env` or `.env.local`, named with its file and never its value;
- the runtime `kindgi dev` runs, answering `/health`;
- a model provider registered there (`dev-echo` alone fails, since it isn't a model).

Outside a project the project's checks are skipped, saying why. `--json` prints `{ ok, cliVersion, project, checks: [{ id, status: 'pass' | 'fail' | 'skip', message, fix? }] }` for a coding agent. `--path` checks another folder. A malformed `.kindgirc.json` no longer stops `doctor` from running; it reports it.
