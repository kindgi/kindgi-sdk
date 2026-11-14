---
"@kindgi/agents": patch
---

`resumeAgentTurn` takes an optional `abortSignal`, as `invokeAgent` does: it aborts the resumed turn, and the agent's `maxWallMs` still applies, whichever comes first. A flow's agent step that resumes its turn can now pass its own signal, so the step's timeout stops the turn instead of leaving it to run on. A turn now also removes the listener it adds to the caller's signal when it returns, and a turn aborted both ways keeps the first abort's reason: a caller's abort that the wall-clock budget overtakes before the turn returns still reads `external`, not `timeout`.
