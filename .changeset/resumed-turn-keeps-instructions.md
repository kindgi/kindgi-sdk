---
"@kindgi/agents": patch
---

**A turn resumed after its worker was lost keeps its instructions.** A turn whose worker was lost after its instructions were rendered, and before its first messages were built, failed on resume with `model-invocation-failed` ("build-initial-messages invoked before render-prompt completed"). It now builds them on the instructions it rendered when it started, as its run recorded them, not on a fresh render.
