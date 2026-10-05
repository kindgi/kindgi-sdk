---
"@kindgi/sdk": patch
---

The getting-started skills (TypeScript and Python) say how an app reads what a run cost: one record per model call for the run and its agent steps (`cost.usage.query({ rootRunId })` / `cost.records.list(root_run_id=)`), one customer's month by org (`cost.usage.summary` / `cost.aggregate`), and the total in `run.finished`'s `data.run.usage`.
