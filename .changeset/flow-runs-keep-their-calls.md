---
"@kindgi/api": patch
"@kindgi/client": patch
---

A judged flow run keeps what it did, so it can be replayed later. At a flow run's first judgment, its run copy's `context.flow` keeps:
- every tool call the run made, with its result: at its tool nodes (per loop iteration), in its agent steps' turns, and in its sub-flows (at most 500, with `truncated`);
- its agent steps (each turn's agent, version and what it retrieved).

`createApp` passes its `flowRegistry` to the judgments routes to tell tool nodes apart. The capture is best effort: a part that can't be read is left out, and the judgment never fails over it. Judging a run needs `write` on the run's project (the route's own description now says so).
