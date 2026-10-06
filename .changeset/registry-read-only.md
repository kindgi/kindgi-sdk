---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.

- **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
- **What's refused:** every write to a registry that sets it, before the binding is called:
  - publish, unregister and reinstate;
  - deriving an agent version;
  - a deployment that would publish into it.
- **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
- **Clients:** both read `registry-read-only` as a conflict, its code the reason.
- **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
