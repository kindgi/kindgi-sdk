---
"@kindgi/types": patch
"@kindgi/tools": patch
"@kindgi/audit-events": patch
"@kindgi/sdk": patch
"@kindgi/guardrails": patch
"@kindgi/dev-echo-provider": patch
---

**The docs and the code comments name their examples the way the naming rules say.** The docs site's example agents and flows are named for their role and their job, and each page keeps its own pack id. The `ToolId`, `ToolManifest` and `GuardrailId` comments, the audit events' actor example, the tools README and the tools skills use `acme.fetch-order`, `acme.response-not-empty`, `agent:acme.brief-writer` and `acme.echo` in place of the `demo` and `shop` examples. The `ToolManifest` comment says what `defineTool` checks: that the id isn't empty and doesn't start with `kindgi_`. The guardrail scope example names `acme.support-desk`. The dev-echo provider's README says what it does when a call declares no tools: it answers at once with the last user message.
