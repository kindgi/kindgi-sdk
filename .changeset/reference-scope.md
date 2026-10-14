---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/tools": patch
"@kindgi/handler": patch
"@kindgi/runtime": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A deployment can keep what a project's flows, agents, triggers and runs name within that project's reach.**
- **`CreateAppInput.referenceScope?`** (a `ReferenceScopeBinding`, `reachable(tenantId, fromProjectId, ref)`) is asked before each write that makes a reference live:
  - publishing a flow (its tool, agent and subflow steps) or an agent (its tools, guardrails and data blocks), and reinstating a retired version of either;
  - registering a deployment (what its agents and flows name, besides what it brings itself);
  - registering a guardrail with a pack check;
  - registering a schedule or a webhook trigger, and changing a schedule's target;
  - starting an eval run (its suite, and its agent or flow), and starting a run filed under a named `projectId`;
  - opening a conversation (its agent);
  - promoting an agent into a project or a segment, directly or through an improvement proposal;
  - drafting an improvement proposal (its scope and block), evaluating one, and starting an improvement pass (its suite and scope).
- **The refusal:** an item the project doesn't reach is refused with `reference-out-of-scope` (400), naming each one at its path. An item that doesn't exist gets the same answer. Without the binding, nothing changes.
- **A conversation opened without `projectId` is filed under its agent's own project,** as a run is. Before, it went to the tenant's Default project; an agent filed under no project still goes there.
- **Tool metadata:** `POST /v1/tools` and deployments refuse a tool `metadata` key under `kindgi.`, which is the runtime's own.
- **`ToolRegistry.forProject?`** (`@kindgi/tools`): the tools a run in a project may reach. An agent's turn resolves its tools on it when it's there.
- **`BlockReader`'s reads take the turn's `projectId`** (`@kindgi/agents`).
- **`InvokeAgentBindings.authorizeToolCall?`** (`@kindgi/agents`) is asked before each of a turn's tool calls, before any approval.
  - A denied call runs nothing. Its result tells the model (`{ status: 'denied', reason }`), and the turn goes on.
  - A call approved by a reviewer is asked again right before it runs. Denied then, it runs nothing.
  - Each decision is recorded with the call, so a resumed turn keeps it. An authorizer that throws fails the step.
  - A built-in tool is asked only when what it touches reaches beyond the turn's project: `kindgi_remember` for a tenant-wide fact.
- **The docs of `NodeContext`'s `authorize`, `can` and `check`, `RunFlowInput.principal` and `authz`, and `InvokeAgentInput.principal` and `authz`** (with the agents and handler READMEs) describe runtime 0.1.8: these checks are decided for every run and turn a person or a key starts.
