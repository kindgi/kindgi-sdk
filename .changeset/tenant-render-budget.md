---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/bounds": patch
"@kindgi/client": patch
"@kindgi/guardrails": patch
"@kindgi/schema": patch
"@kindgi/sdk": patch
---

**An agent turn whose work its tenant's budget refuses fails with `rate-limit-exceeded`, not `model-invocation-failed`,** on a server with budgets kept per tenant (Kindgi Cloud). The error names the budget in `details.limit` (`template-render-time` or `schema-compile-time`), with `details.budgetMs`, and says when the tenant is under it again. `POST /v1/runs` answers it as `429`, with `Retry-After` and `details.runId`, and the run reads as failed with that code. The OpenAPI document lists the 429 on `POST /v1/runs`.
- New: the tenant input bounds' `templateRenderBudgetMs`, the time a tenant's instructions templates may spend rendering in any 60 seconds. Once a tenant has spent it, its next render is refused before it starts. A self-hosted server has none.
- `TenantBudgetError` (`@kindgi/bounds`) is what each budget's refusal is: `SchemaCompileBudgetError` and the new `TemplateRenderBudgetError` (`@kindgi/agents`) extend it, with `limit`, `budgetMs` and `retryAfterMs`. The API answers any of them thrown from a route as `429 rate-limit-exceeded`.
- A guardrail check, or a tenant's approval policy, whose schema compile the budget refuses no longer fails as `check-failed` or `tenant-policy-unavailable`: the turn fails as above.
- A failed run's `failure` has `details` for a code that has them. For `rate-limit-exceeded` that's `limit` and `budgetMs`, never the wait, which is stale once read back. The `run.finished` webhook's run can carry `failure` beside `failureMessage`. It's absent from a runtime that doesn't send it yet. `parseEvent` (`@kindgi/sdk/webhooks`) reads it, and reads a failure's `cause` as any JSON value.
