---
"@kindgi/cli": patch
"@kindgi/env-schema": patch
---

**`kindgi deploy` and `KINDGI_PACK_ROUTING` say a call goes to the newest deployment in the run's project.** With a pack service for each deployment, the deploy banner said each tool call from a run already in flight goes to "the newest deployment that shipped the version it names", and the setting's description said the same of `per-deployment`. That reads as the tenant's newest. A call goes to the newest deployment in the run's project that shipped what it names, and both now say so.
