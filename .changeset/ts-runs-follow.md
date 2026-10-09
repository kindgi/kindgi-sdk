---
"@kindgi/client": patch
---

**`runs.follow(runId)` and `runs.followProgress(runId)`: the TypeScript client follows a run to its end under the same names as Python and Java.**
- **What they do:** reconnect with `Last-Event-Id` after a drop or the server's 5-minute limit, through to `run.completed`, `run.failed` or `run.cancelled`. This is what `runs.stream` and `runs.streamProgress` do today.
- **`runs.stream` and `runs.streamProgress` are deprecated.** Use `runs.follow`, which does the same. In a later minor release, announced in advance, `runs.stream` becomes the plain call, as in Python and Java: it ends when the server closes the stream. Until then it still follows the run to its end.
- **The CLI's `kindgi runs stream`, the README and the guides** use `follow`.
