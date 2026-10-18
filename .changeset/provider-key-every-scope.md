---
"@kindgi/api": patch
---

**On a runtime that refuses other envs, a model provider's key can be written at a project or an org too.** A run reads a provider's key at its project, else the project's org, else the tenant, under the env the provider's `secret_ref` names. A secret at that env and name is now let through at a project or an org scope too, not only at the tenant's, so each project can hold a key of its own and rotate it. A webhook endpoint's secret is still let through at the tenant's scope only, and an MCP endpoint's at the scope recorded for it.
