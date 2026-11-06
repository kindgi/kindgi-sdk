---
"@kindgi/agents": patch
"@kindgi/capabilities": patch
---

When a turn merges its workspace's model-routing policies, it now keeps the larger `maxTokensPerCall`. That field is the smallest context window a picked model must have, so keeping the smaller value let the weaker policy win. Now a model whose context window is below either policy's isn't picked. The `TenantPolicy` docs now say what both fields check. `maxCostPerCallUsd` is the highest prompt price per 1K tokens a picked model may have, not what a call costs. `maxTokensPerCall` is the smallest context window it must have, not the tokens a call uses. When no model routes, a `capability-unsatisfiable` error's `requirement` names them the same way, for example `tenant.maxCostPerCallUsd: promptUsdPer1kTokens<=0.5` and `tenant.maxTokensPerCall: contextWindow>=100000`. The context window's message now reads "workspace minimum".
