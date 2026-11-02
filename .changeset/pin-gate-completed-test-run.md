---
"@kindgi/api": patch
---

**A pin's release gate reads only a completed test run.** A comparison cancelled or failed part way can keep the summary of the cases it got through, and the gate used to check that summary as if the run had completed, so it could pass a version on part of its test cases. `POST /v1/agents/{agentId}/pinned/pin` and `…/pinned/check` now refuse, with `400 bad-input`, a `testRunId` whose run isn't completed, as they refuse a test run that isn't a comparison: "Test run <id> isn't a completed comparison: it's cancelled. Name a run that completed." Nothing is recorded. A completed run goes through the gate as before. The gate's own check, when a gate needs a test run and none is named, now asks for "a completed test run" instead of "a finished test run".
