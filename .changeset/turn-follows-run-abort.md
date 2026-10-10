---
"@kindgi/agents": patch
"@kindgi/env-schema": patch
---

An agent turn stops when its run is stopped. The runtime aborts a step's `abortSignal` when its run ends from outside: a cancel, or a shutdown that interrupts the runs it was executing. A turn's own work (its model call, its tool calls) listened only to the turn's abort, so a call in flight ran on until it answered.

- **Now:** each step of a turn links the step's `abortSignal` to the turn's, so a call in flight is aborted at once, and the turn ends as aborted from outside (`agent-turn-aborted`, reason `external`).
- **A wall-clock timeout keeps its own reason** (`timeout`).
- **No API change.**
- **`@kindgi/env-schema`** lists `KINDGI_RUN_ENDED_CHECK_MS`: how often a server stops the runs it executes that were ended from outside, so a step that writes nothing for a while, such as a long model call, stops within this time of a cancel. Default 5000 ms; at least 1000.
