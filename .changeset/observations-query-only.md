---
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**`client.observations` has `query` only.** `recordRun` and `patterns` are gone. Both threw `not-yet-wired`: the API has no route to record an observation, since the runtime records them itself, and none to aggregate them. With them goes `PatternsInput`. Read observations with `client.observations.query`, which calls `GET /v1/observations`.
