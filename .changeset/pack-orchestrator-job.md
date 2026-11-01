---
"@kindgi/env-schema": patch
---

**`KINDGI_PACK_ORCHESTRATOR_JOB`** names the pack orchestrator's Cloud Run Job by its full name (`projects/<project>/locations/<region>/jobs/<name>`). With per-deployment routing, a runtime from `<x>` starts that Job right after a deploy or promotion whose deployment still needs a pack service, so the deployment needn't wait for the Job's next scheduled run. Its account needs `roles/run.invoker` on the Job. The Cloud Run module sets it, and grants that role on its Job alone.
