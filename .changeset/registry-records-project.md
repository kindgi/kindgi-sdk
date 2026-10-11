---
"@kindgi/api": patch
---

**An agent, flow, tool, test set or guardrail says which project it's in.** Reading one (`GET /v1/agents`, `/v1/flows`, `/v1/tools`, `/v1/eval-suites`, `/v1/guardrails`: by id, in lists, and as versions) carries `projectId` when the registry records it, so a client can tell a record of another project opened under this one's address. It's optional in the schemas (`Agent`, `Flow`, `Tool`, `ToolVersionRow`, `EvalSuite`, `Guardrail`): a pack `kindgi dev` serves from disk has none, and neither does a runtime before 0.1.6.
- The bindings' read types say so: `AgentRegistryBinding.get` and `AgentPage` items are `AgentVersionRecord`; `FlowRegistryBinding.get` and `FlowPage` items are `FlowVersionRecord`; `ToolRegistryBinding.get`/`getVersion` and `ToolPage` items are the new `ToolRecord`; `EvalSuiteRegistryBinding.get`/`getVersion` and `EvalSuitePage` items are the new `EvalSuiteRecord`; `GuardrailRegistryBinding.get` and `GuardrailPage` items are the new `GuardrailRecord`. Each is the definition plus an optional `projectId`, so an implementation that doesn't set it still fits.
- A deploy (of an agent or a flow) and an agent version derived from edited pins compare a registered version's definition without what the registry sets (`projectId`, `unregisteredAt`), so a registry that reads the project back doesn't make every deploy register a new version.
