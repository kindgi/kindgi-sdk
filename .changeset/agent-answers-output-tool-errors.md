---
"@kindgi/api": patch
---

Agent answers carry the agent's `output` and `toolErrors`. The `Agent` schema lists both, and a published agent's typed result and its tool-error retries were applied, but `GET /v1/agents`, `/v1/agents/{id}`, `/versions` and `/versions/{version}`, and the answer to `POST /v1/agents/{id}/versions`, left them out. Each is now in the answer when the agent sets it, as published, and absent when it doesn't. The schema and the clients' types don't change.
