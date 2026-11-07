---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

The corrections and test-case words say which run can be corrected: one that completed with an output. They said a finished run, but a run that failed, was cancelled, or completed with no output is finished too, and is refused with `409 run-not-finished`. The descriptions of `POST /v1/corrections`, `POST /v1/agents/{agentId}/test-set/cases` and the corrections tag say so, as do `kindgi corrections add`'s help, the TypeScript client's `corrections` docs and the Correct a run's output guide. What you pass or read doesn't change.
