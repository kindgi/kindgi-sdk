---
"@kindgi/agents": minor
---

`AgentStepOutput` and `agentStepOutput()`: what an agent step in a flow outputs, projected from its turn's `AgentTurnResult`.

- `output`: the parsed answer, when the agent declares `output`.
- `text`: the final answer's text.
- `runId` and `conversationId`: the step's turn, a child run of the flow run.
- `usage`.
- `violations`: the non-blocking guardrail findings, as `guardrailId`, `severity` and `action`.

Nodes after the step read the typed answer as `nodeOutputs.<step>.output.<field>`.
