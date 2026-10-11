---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

`run.finished` names the agent of an agent's run: `data.run.agent` (`id`, `version`, `conversationId`), as `GET /v1/runs/{runId}` shows it, since an agent run's `flowId` is `agent.turn`. It's optional, absent on a flow's run and from a runtime that doesn't send it yet; the Python `FinishedRun` model has it as `agent: RunAgent | None`. `kindgi runs list --table` shows an agent run by its agent (`acme.desk@1.2.0`) in a `FLOW / AGENT` column, and the flow otherwise.
