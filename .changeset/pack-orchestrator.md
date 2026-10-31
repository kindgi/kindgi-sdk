---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/env-schema": patch
"@kindgi/cli": patch
---

**The pack orchestrator's settings.** `@kindgi/env-schema` describes what `kindgi-runtime packs orchestrate` reads: `KINDGI_ORCHESTRATOR_RUNTIME_URL`, `KINDGI_ORCHESTRATOR_SYSTEM_KEY`, `KINDGI_ORCHESTRATOR_PROJECT`, `KINDGI_ORCHESTRATOR_REGION`, `KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT`, and `KINDGI_ORCHESTRATOR_PACK_SERVICE` (JSON: how each pack service runs). They're grouped in the environment variables reference.

**Why a deployment has no pack service yet, in the orchestrator's list.** Each entry of `GET /v1/system/deployments?endpoint=missing` carries the last `problem` recorded for it (`code` and `since`), and has none until one is recorded. `since` is when that code was first recorded, since recording the same code again keeps it, so an orchestrator can space its tries. `SystemDeploymentMissing` is the entry's type, and the clients read the field as optional.

**`pack-env-name-too-long`** is a new problem code, both on a deployment waiting for its pack service (`problem`) and on a ready one (`packEnvProblem`). It means a name set as a secret is too long for the secret it's kept in, which is named after the pack service. `kindgi deploy` and `kindgi deployments get` say to shorten the name in the pack. As with the other codes, treat one you don't know as a reason not yet named.
