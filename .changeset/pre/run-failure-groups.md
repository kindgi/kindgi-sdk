---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/client": patch
---

`GET /v1/runs/failures`: a project's failed runs over a window, grouped by cause and version, from the server's counts. A console can show error groups and which version started failing without counting the pages it loaded.

- **Each group:** the failure's `code`, the agent or flow (`subject`), the `version`, how many runs failed, when the first and the latest failed in the window (`firstSeen`, `lastSeen`), and the latest run (`exampleRunId`).
- **People's decisions come apart:** `hitl-*` codes (an approval rejected, cancelled or timed out), with their `reason`, are `outcomes`, never failures.
- **Runs that failed before their cause was recorded** come back as `unrecorded`, by subject and version only.
- **The query:** `projectId`, `from` and `to` are required, with a window of at most 90 days. Optionally `agentId` or `flowId` (not both), `groupBy` (`code`, `version`, or both, the default) and `limit` (1 to 200, 50 by default). It needs `read` on the project.
- **Not counted:** replays, eval runs' runs and dry runs. A child run counts under its own agent or flow.
- **`RunBinding.failureGroups`** is optional. Without it, the route answers `501 run-failures-not-supported`.
- **The clients:** TypeScript `runs.failures(query)`; Python `runs.failures(...)`.
