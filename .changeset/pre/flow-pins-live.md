---
"@kindgi/api": patch
---

Publishing a flow (`POST /v1/flows`, or a deploy) pins each agent step that names no version to what a run in the flow's project would get: the agent's live version there (project, then its org, then the tenant), else its latest. Before, it pinned the latest, so in a tenant with promotions a new flow ran a version that was never let go live. A step's own `config.version` still wins; without live versions, pins are the latest as before.
