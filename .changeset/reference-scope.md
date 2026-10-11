---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/tools": patch
---

**A deployment can keep what a project's flows, agents, triggers and runs name within that project's reach.**
- **`CreateAppInput.referenceScope?`** (a `ReferenceScopeBinding`, `reachable(tenantId, fromProjectId, ref)`) is asked before these write:
  - publishing a flow (its tool, agent and subflow steps) or an agent (its tools, guardrails and data blocks);
  - registering a schedule or a webhook trigger (what it runs);
  - starting an eval run (its agent or flow), and starting a run filed under a named `projectId`;
  - promoting an agent into a project.
- **The refusal:** an item the project doesn't reach is refused with `reference-out-of-scope` (400), naming each one at its path. An item that doesn't exist gets the same answer. Without the binding, nothing changes.
- **Tool metadata:** `POST /v1/tools` and deployments refuse a tool `metadata` key under `kindgi.`, which is the runtime's own.
- **`ToolRegistry.forProject?`** (`@kindgi/tools`): the tools a run in a project may reach. An agent's turn resolves its tools on it when it's there.
- **`BlockReader`'s reads take the turn's `projectId`** (`@kindgi/agents`).
- **`InvokeAgentBindings.authorizeToolCall?`** (`@kindgi/agents`) is asked before each of a turn's tool calls, before any approval.
  - A denied call runs nothing. Its result tells the model (`{ status: 'denied', reason }`), and the turn goes on.
  - The decision is recorded with the call, so a resumed turn keeps it.
