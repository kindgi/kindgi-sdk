---
"@kindgi/api": patch
"@kindgi/agents": patch
---

**A request that publishes schemas compiles them all before it writes anything,** and on the hosted bounds each compile counts against its tenant's compile budget.
- `POST` of flows, blocks, agents (and `/v1/agents/{agentId}/versions`), tools, guardrails, MCP endpoints and deployments, and `POST /v1/proposals/{proposalId}/evaluate`, run as their tenant's work with every compile counted (`runAsTenant`, `{ compiles: 'all' }`).
- `POST /v1/deployments` pins its agents' data blocks before it registers any tool, so a model-settings check can no longer fail after a write.
- Evaluating a proposal checks a model-settings block's new values before it publishes the block version; values that aren't model settings are refused with `400 validation-failed`, and nothing is stored.
- `modelSettingsIssues(values)` (`@kindgi/agents`) checks model settings against `MODEL_SETTINGS_SCHEMA`, compiled once in a process.
