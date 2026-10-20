---
"@kindgi/agents": patch
---

**An agent's tool-call check is told the version the call runs.** `InvokeAgentBindings.authorizeToolCall` now gets `toolVersion` with `toolId`: the version the turn resolved for the agent's range, or a built-in's own. It's set on both checks, before the call and once an approval comes back. An authorizer can then apply a rule per version, as a flow's tool step is checked on the exact version it runs. The field is optional on the hook's input, so an authorizer written without it keeps working.
