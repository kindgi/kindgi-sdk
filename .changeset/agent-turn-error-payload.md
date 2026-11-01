---
"@kindgi/agents": patch
---

**The agent turn's iteration output type says what it carries.** It no longer has an `errorPayload` field, which no step ever set: a turn's failures are thrown, and reach the caller as the run's failure. The `agent.turn` 1.1.0 flow and its loop's output schema are unchanged, so a run started before this change resumes after it.
