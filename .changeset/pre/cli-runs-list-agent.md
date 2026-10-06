---
"@kindgi/cli": patch
---

`kindgi runs list` takes `--agent=<agent-id>`: only that agent's turns, at any version, including the turns its steps start inside flows (`GET /v1/runs?agentId=`, which the clients already take as `agentId` / `agent_id`). It combines with `--replays`, `--eval-run`, `--limit` and `--cursor`.
