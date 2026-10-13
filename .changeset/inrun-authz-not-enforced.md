---
'@kindgi/agents': patch
'@kindgi/handler': patch
'@kindgi/runtime': patch
---

**Checks inside a run are documented as not enforced in 0.1.7.** The docs of `InvokeAgentInput.principal`, `RunFlowInput.principal` and `authz`, and `NodeContext`'s `authorize`, `can` and `check` (and the agents and handler READMEs) now say that the runtime doesn't yet decide authorization checks inside a run in 0.1.7; route-level permissions apply. This is planned for 0.1.8. The agents README and `InvokeAgentInput.principal` no longer claim that an agent's tool calls are checked against its principal.
