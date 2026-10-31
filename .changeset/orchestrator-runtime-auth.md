---
"@kindgi/env-schema": patch
---

**`KINDGI_ORCHESTRATOR_RUNTIME_AUTH`**, for a runtime behind Cloud Run IAM. Set to `google-id-token`, each of the pack orchestrator's calls also carries its own Google ID token for the runtime's URL (its `run.app` URL, or a custom audience the service sets), in `X-Serverless-Authorization`, beside the system key. Its account needs `roles/run.invoker` on the runtime. Unset, the system key alone. Any other value stops the orchestrator, naming the setting.
