---
"@kindgi/guardrails": patch
"@kindgi/agents": patch
---

LLM-judge guardrails route under the tenant policy.

- `@kindgi/guardrails`: `EvaluationBindings.tenantPolicy`. When set, the judge model is routed under it (provider / model allow and deny lists, `regionAllow`, caps), and an explicit `judgeProvider` must satisfy it too — otherwise the check fails with `judge-routing-failed`. Previously judges were routed with no tenant policy, so a tenant restricted to one region could have its run output sent to a judge model elsewhere.
- `@kindgi/agents`: the turn passes the tenant policy it was routed under (bound policy merged with the policy registry's) to guardrail evaluation; `evaluateGate` takes it as an optional fourth argument.
