---
"@kindgi/api": patch
---

Publishing an existing agent, flow, tool or eval suite keeps it in its project, as blocks already do (`409 block-project-mismatch`).
- **The rule:** each of these belongs to the project its first version was published into, and never moves. Publishing a version under another project's `projectId` is refused, even for an admin of both projects. Nothing is written.
- **The refusal:** `409 agent-project-mismatch`, `flow-project-mismatch`, `tool-project-mismatch` or `eval-suite-project-mismatch`. `details` carries the id. The answer doesn't name the project the id belongs to, since the caller may not be able to read it; the request's log does.
- **Same project, or a new id:** unchanged. The same project still needs `admin` there.
- **Where it applies:** the four publish routes, deriving an agent version (`POST /v1/agents/{agentId}/versions`), building a suite from judgments (`POST /v1/eval-suites/{suiteId}/versions/from-judgments`), and deployments. A deployment with a tool, agent or flow that belongs to another project answers its `<kind>-project-mismatch`, with `details.primitive` and `details.id`, and deploys nothing. That holds even when the agent or flow is unchanged.
- **Bindings:** `AgentRegistryBinding`, `FlowRegistryBinding`, `ToolRegistryBinding` and `EvalSuiteRegistryBinding` gain a `project-mismatch` publish outcome, with `projectId` (the project the id belongs to) for the log. A registry returns it when the id's versions live in another project, and writes nothing; a registry that doesn't return it publishes as before.
- **Unchanged deploys:** `FlowVersionRecord` gains an optional `projectId`, as `AgentVersionRecord` has. A deployment reads it to refuse an unchanged agent or flow of another project; with a registry that doesn't record it, only a write is refused.
