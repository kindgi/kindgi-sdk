---
"@kindgi/tools": minor
---

`precondition-failed`: a runtime that refuses to run a tool — a secret the tool declares couldn't be resolved, say — throws `ToolPreconditionError(reason, message)` from its handler wrapper, and `invokeTool` reports `{ code: 'precondition-failed', reason }` instead of `handler-error … handler threw`, since the tool's code never ran. `isToolPreconditionError` recognizes one from any copy of the package.
