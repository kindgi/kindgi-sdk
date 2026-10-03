---
"@kindgi/env-schema": patch
"@kindgi/guardrails": patch
"@kindgi/agents": patch
"@kindgi/provenance": patch
"@kindgi/runtime": patch
---

Messages and variable descriptions no longer point at internal components: `KINDGI_API_PORT` / `KINDGI_OPENFGA_API_URL` / `KINDGI_SECRETS_BACKEND` descriptions say what the runtime does; the `external` guardrail strategy's error says to register an execution strategy; the payload-version error reads "Unsupported payload version N (this reader handles version M)" — it was worded "newer than this reader" also for older versions.
