---
"@kindgi/capabilities": patch
"@kindgi/agents": patch
"@kindgi/guardrails": patch
---

**A turn that can't route names the registered providers its registry couldn't set up, and why.** Before, a tenant whose only provider failed to build (its settings no longer allowed on the deployment, say) got `capability-routing-failed` with `reasons: []`, and the cause was only in the server's log.
- `ProviderRegistry.setupFailures(tenantId)` (optional): the tenant's registered providers its last `hydrate` couldn't set up, each a `ProviderSetupFailure` (`providerId`, `message`). `list` still leaves them out.
- `RouteInput.setupFailures` (optional): when nothing routes, `capability-unsatisfiable` names each under the requirement `provider set up`, by its provider id alone, with the new rejection code `provider-setup-failed`. The error's message gives the first one's why and counts the rest. A route another provider satisfies is unchanged.
- An agent turn and an `llm-judge` guardrail pass the registry's setup failures to the router. A registry without `setupFailures` routes as before.
